// src/services/graphUpdater.ts
import { openai } from "./llmClient.js";
import { config } from "../server/config.js";
import type { CDG, GraphPatch, Severity, Strength } from "../core/graph.js";
import { sanitizeGraphPatchStrict } from "./patchGuard.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][graph]", ...args);
}

const PATCH_START = "<<<PATCH_JSON>>>";
const PATCH_END = "<<<END_PATCH_JSON>>>";

// 你可以给建图单独指定模型（更稳/更便宜都行）
const GRAPH_MODEL = process.env.CI_GRAPH_MODEL || config.model;

const RISK_HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|老人|老年|儿童|行动不便|不能爬山|不能久走|危险|安全|急救|摔倒|health|medical|heart|cardiac|safety|risk/i;
const HARD_CONSTRAINT_RE = /不能|不宜|避免|禁忌|必须|只能|不要|不可|不得|无法|不方便|不能够/i;

function cleanStatement(s: any, maxLen = 180) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(用户任务|任务|用户补充)[:：]\s*/i, "")
    .trim()
    .slice(0, maxLen);
}

function inferRiskMeta(statement: string): { severity: Severity; importance: number; tags: string[] } | null {
  const s = cleanStatement(statement, 300);
  if (!s) return null;
  if (!RISK_HEALTH_RE.test(s)) return null;

  const critical = /心脏|冠心|心血管|急救|cardiac|heart/i.test(s);
  return {
    severity: critical ? "critical" : "high",
    importance: 0.9,
    tags: ["health"],
  };
}

function inferFallbackNodeType(userText: string): "constraint" | "fact" {
  const s = cleanStatement(userText, 300);
  if (HARD_CONSTRAINT_RE.test(s) || RISK_HEALTH_RE.test(s)) return "constraint";
  return "fact";
}

function mergeTags(a?: string[], b?: string[]) {
  const set = new Set<string>([...(a || []), ...(b || [])].map((x) => String(x).trim()).filter(Boolean));
  return set.size ? Array.from(set).slice(0, 8) : undefined;
}

function enrichNodeRisk(node: any) {
  if (!node || typeof node !== "object") return node;

  const statement = cleanStatement(node.statement);
  if (!statement) return node;

  const out: any = { ...node, statement };
  const risk = inferRiskMeta(statement);

  if (risk) {
    out.severity = out.severity || risk.severity;
    out.importance = out.importance != null ? Math.max(Number(out.importance) || 0, risk.importance) : risk.importance;
    out.tags = mergeTags(out.tags, risk.tags);
  }

  if (out.type === "constraint" && HARD_CONSTRAINT_RE.test(statement) && !out.strength) {
    out.strength = "hard";
  }

  return out;
}

function enrichPatchRiskAndText(patch: GraphPatch): GraphPatch {
  const ops = (patch.ops || []).map((op: any) => {
    if (op?.op === "add_node" && op.node) {
      return { ...op, node: enrichNodeRisk(op.node) };
    }
    if (op?.op === "update_node" && op.patch && typeof op.patch === "object") {
      const p = { ...op.patch };
      if (typeof p.statement === "string") p.statement = cleanStatement(p.statement);
      const risk = inferRiskMeta(p.statement);
      if (risk) {
        p.severity = p.severity || risk.severity;
        p.importance = p.importance != null ? Math.max(Number(p.importance) || 0, risk.importance) : risk.importance;
        p.tags = mergeTags(p.tags, risk.tags);
      }
      if (p.statement && HARD_CONSTRAINT_RE.test(p.statement) && !p.strength) p.strength = "hard";
      return { ...op, patch: p };
    }
    return op;
  });

  return { ...patch, ops };
}

function normalizeForMatch(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^用户任务[:：]\s*/g, "")
    .replace(/^任务[:：]\s*/g, "")
    .replace(/[“”"]/g, "")
    .toLowerCase();
}

function pickRootGoalId(graph: CDG): string | null {
  const goals = (graph.nodes || []).filter((n: any) => n?.type === "goal");
  if (!goals.length) return null;
  const locked = goals.find((g: any) => g.locked);
  if (locked) return locked.id;
  const confirmed = goals.find((g: any) => g.status === "confirmed");
  if (confirmed) return confirmed.id;
  return goals[0].id;
}

function extractBetween(text: string, start: string, end: string): string | null {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < 0 || e <= s) return null;
  return text.slice(s + start.length, e).trim();
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function makeTempId(prefix: string) {
  return `t_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function fallbackPatch(graph: CDG, userText: string, reason: string): GraphPatch {
  const root = pickRootGoalId(graph);
  const short = cleanStatement(userText, 140);

  if (!root) {
    return {
      ops: [
        {
          op: "add_node",
          node: {
            id: makeTempId("n"),
            type: "goal",
            statement: short || "未提供任务",
            status: "proposed",
            confidence: 0.55,
          },
        },
      ],
      notes: [`fallback_patch:${reason}`],
    };
  }

  const nid = makeTempId("n");
  const nodeType = inferFallbackNodeType(short);
  const risk = inferRiskMeta(short);
  return {
    ops: [
      {
        op: "add_node",
        node: {
          id: nid,
          type: nodeType,
          statement: short || "未提供补充信息",
          status: "proposed",
          confidence: 0.55,
          strength: (nodeType === "constraint" ? "hard" : undefined) as Strength | undefined,
          severity: risk?.severity,
          importance: risk?.importance,
          tags: risk?.tags,
        },
      },
      {
        op: "add_edge",
        edge: {
          id: makeTempId("e"),
          from: nid,
          to: root,
          type: nodeType === "constraint" ? "constraint" : "enable",
          confidence: 0.55,
        },
      },
    ],
    notes: [`fallback_patch:${reason}`],
  };
}

/** 后处理：去重 + 自动补边 + 限制 op 数量 */
function postProcessPatch(graph: CDG, patch: GraphPatch): GraphPatch {
  const enriched = enrichPatchRiskAndText(patch);
  const existingByStmt = new Map<string, string>();
  for (const n of graph.nodes || []) {
    const key = normalizeForMatch(n.statement);
    if (key) existingByStmt.set(key, n.id);
  }

  const root = pickRootGoalId(graph);
  const newStmt = new Set<string>();
  const newNodes: Array<{ id: string; type: string }> = [];
  const kept: any[] = [];

  for (const op of enriched.ops || []) {
    if (op?.op === "add_node" && typeof op?.node?.statement === "string") {
      const key = normalizeForMatch(op.node.statement);
      if (!key) continue;
      if (existingByStmt.has(key)) continue;
      if (newStmt.has(key)) continue;
      newStmt.add(key);
      newNodes.push({ id: op.node.id, type: op.node.type });
      kept.push(op);
      continue;
    }
    kept.push(op);
  }

  if (root) {
    const hasEdge = (from: string, to: string) =>
      kept.some((x) => x?.op === "add_edge" && x?.edge?.from === from && x?.edge?.to === to);

    let k = 1;
    for (const n of newNodes) {
      if (!["constraint", "preference", "fact", "belief"].includes(n.type)) continue;
      if (hasEdge(n.id, root)) continue;
      kept.push({
        op: "add_edge",
        edge: {
          id: makeTempId(`e_auto${k++}`),
          from: n.id,
          to: root,
          type: n.type === "constraint" ? "constraint" : "enable",
          confidence: 0.65,
        },
      });
    }
  }

  return { ops: kept.slice(0, 12), notes: (enriched.notes || []).slice(0, 10) };
}

const GRAPH_SYSTEM_PROMPT = `
你是“用户意图图（CDG）更新器”。你不与用户对话，只输出用于更新图的增量 patch。

输出协议（必须严格遵守）：
<<<PATCH_JSON>>>
{ "ops": [ ... ], "notes": [ ... ] }
<<<END_PATCH_JSON>>>
不要输出任何其他文字，不要 Markdown，不要解释。

规则：
- 默认只使用 add_node / update_node / add_edge 三种操作。
- 禁止 remove_node/remove_edge（除非用户明确要求删除且你非常确定）。
- 节点类型：goal / constraint / preference / belief / fact / question
- constraint 可带 strength: hard|soft
- 若信息包含健康/安全/法律等高风险因素，务必设置 severity（high 或 critical），并可补 tags（如 ["health"]）。
- 若信息表达“不能/必须/禁忌”等限制，优先用 constraint，且 strength 优先 hard。
- statement 保持简洁，不要加“用户补充：/用户任务：”前缀。
- 边类型：enable / constraint / determine / conflicts_with
- 去重：已有等价节点优先 update_node
- 连边克制：有 root_goal_id 时，constraint/preference/fact/belief 可以连到 root_goal_id
- 每轮 op 建议 1~6 个，少而准。
`.trim();

export async function generateGraphPatch(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  assistantText: string;
  systemPrompt?: string;
}): Promise<GraphPatch> {
  const rootGoalId = pickRootGoalId(params.graph);

  const modelInput = {
    root_goal_id: rootGoalId,
    current_graph: params.graph,
    recent_dialogue: params.recentTurns,
    latest_turn: { user: params.userText, assistant: params.assistantText },
  };

  const resp = await openai.chat.completions.create({
    model: GRAPH_MODEL,
    messages: [
      { role: "system", content: GRAPH_SYSTEM_PROMPT },
      ...(params.systemPrompt
        ? [{ role: "system" as const, content: `任务补充（可参考）：\n${String(params.systemPrompt).trim()}` }]
        : []),
      {
        role: "user",
        content:
          `输入如下（JSON）。只输出分隔符包裹的 patch JSON：\n` + JSON.stringify(modelInput),
      },
    ],
    max_tokens: 900,
    temperature: 0.1,
  });

  const raw = String(resp.choices?.[0]?.message?.content ?? "");
  dlog("raw_len=", raw.length, "finish=", resp.choices?.[0]?.finish_reason);

  const jsonText = extractBetween(raw, PATCH_START, PATCH_END);
  if (!jsonText) {
    dlog("missing markers -> fallback");
    return fallbackPatch(params.graph, params.userText, "missing_markers");
  }

  const parsed = safeJsonParse(jsonText);
  if (!parsed) {
    dlog("invalid json -> fallback");
    return fallbackPatch(params.graph, params.userText, "invalid_json");
  }

  // ✅ 核心：严格白名单清洗（默认禁止 remove）
  const strict = sanitizeGraphPatchStrict(parsed);

  // 空 patch 也不允许把图“断更”：给 fallback
  if (!strict.ops.length) {
    dlog("empty strict ops -> fallback");
    return fallbackPatch(params.graph, params.userText, "empty_ops");
  }

  const post = postProcessPatch(params.graph, strict);

  // 打印 op 概览，定位“为什么图被清空”
  if (DEBUG) {
    const counts: Record<string, number> = {};
    for (const op of post.ops) counts[op.op] = (counts[op.op] || 0) + 1;
    dlog("ops_counts=", counts, "notes=", post.notes);
  }

  return post;
}
