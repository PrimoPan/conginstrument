// src/services/chatResponder.ts
import { openai } from "./llmClient.js";
import { config } from "../server/config.js";
import type { CDG } from "../core/graph.js";
import { stripMarkdownToText } from "./textSanitizer.js";
import {
  enforceTargetedQuestion,
  planUncertaintyQuestion,
} from "./uncertainty/questionPlanner.js";
import { reconcileConceptsWithGraph } from "./concepts.js";
import { reconcileMotifsWithGraph } from "./motif/conceptMotifs.js";
import { reconcileContextsWithGraph } from "./contexts.js";

const STREAM_MODE = (process.env.CI_STREAM_MODE || "pseudo") as "upstream" | "pseudo";
const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][chat]", ...args);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => resolve(), ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    }
  });
}

function normalizeRecentTurns(
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>,
  maxEach = 1400
) {
  return (recentTurns || [])
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, maxEach) }));
}

/** 兼容不同兼容层的 message.content 结构 */
function readTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (!content) return "";

  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return String(p.text ?? p.content ?? p.value ?? "");
        return "";
      })
      .join("");
  }

  if (typeof content === "object") {
    return String((content as any).text ?? (content as any).content ?? "");
  }
  return "";
}

function buildChatSystemPrompt(extraSystemPrompt?: string) {
  const base = `
你是 CogInstrument 的对话助手。任务可能是旅行规划、写作、研究、编程、设计、学习、排错等任意类型。
目标：每一轮都把任务推进到“下一步可执行”。

硬规则：
1) 用简体中文回答。
2) 输出必须是纯文本，不要使用 Markdown/LaTeX/代码块。不要出现诸如“###”、“- **”、“”、“\\begin”。
3) 不要自我介绍。
4) 每轮必须先给“具体内容”（可执行建议/清单/步骤/示例），再最多问 1~2 个关键问题。
5) 反模板：当用户给了具体主题/地点/对象时，不要先讲“方法论/三步走”，流程只能当补充，不得当主体。
6) 用户不满/质疑时，先承认并立即给更具体的内容，不要继续复读模板。

领域偏好（仅在对应场景启用）：
- 旅行：先给 2~4 句“地点画像/核心玩法”，再给 6~10 条建议（景点/路线/美食/交通/节奏），最后问 1~2 个关键问题。
- 排错：先给 3~5 个最可能原因 + 对应检查方式，再问 1~2 个关键问题（版本/报错全文/最小复现）。
`.trim();

  if (!extraSystemPrompt) return base;
  return `${base}\n\n补充设定（可参考，不能覆盖硬规则）：\n${String(extraSystemPrompt).trim()}`.trim();
}

function graphSummaryForChat(graph: CDG): string {
  const nodes = (graph.nodes || []).slice(-60);
  const edges = (graph.edges || []).slice(-40);
  const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
  const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] })
    .slice(0, 5)
    .map((m) => `${m.templateKey}:${m.title}(c=${m.confidence.toFixed(2)})`);

  const pick = (type: string, k = 6) =>
    nodes
      .filter((n: any) => n?.type === type)
      .slice(-k)
      .map((n: any) => `- ${String(n.statement || "").slice(0, 80)}`);

  const goals = pick("goal", 6);
  const hardC = nodes
    .filter((n: any) => n?.type === "constraint" && n?.strength === "hard")
    .slice(-6)
    .map((n: any) => `- ${String(n.statement || "").slice(0, 80)}`);

  const prefs = pick("preference", 6);
  const facts = pick("fact", 6);
  const qs = nodes
    .filter((n: any) => n?.type === "question" && (n.status === "proposed" || !n.status))
    .slice(-2)
    .map((n: any) => `- ${String(n.statement || "").slice(0, 80)}`);

  const edgeBrief = edges
    .slice(-8)
    .map((e: any) => `- (${e.type}) ${e.from} -> ${e.to}`);

  return [
    `v${graph.version}`,
    "goals:",
    goals.length ? goals.join("\n") : "- none",
    "hard_constraints:",
    hardC.length ? hardC.join("\n") : "- none",
    "prefs:",
    prefs.length ? prefs.join("\n") : "- none",
    "facts:",
    facts.length ? facts.join("\n") : "- none",
    "questions:",
    qs.length ? qs.join("\n") : "- none",
    "edges:",
    edgeBrief.length ? edgeBrief.join("\n") : "- none",
    "motifs:",
    motifs.length ? motifs.map((x) => `- ${x}`).join("\n") : "- none",
  ].join("\n");
}

function normalizeForMatch(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .slice(0, 240);
}

function chooseQuestionWithPriority(params: {
  motifQuestion: string | null;
  uncertaintyQuestion: string | null;
}): string | null {
  const m = String(params.motifQuestion || "").trim();
  const u = String(params.uncertaintyQuestion || "").trim();
  if (!m && !u) return null;
  if (m && !u) return m;
  if (!m && u) return u;
  if (normalizeForMatch(m).includes(normalizeForMatch(u)) || normalizeForMatch(u).includes(normalizeForMatch(m))) {
    return m;
  }
  return `${m}；另外，${u}`;
}

function motifPriorityQuestion(params: { graph: CDG; concepts: ReturnType<typeof reconcileConceptsWithGraph> }) {
  const motifs = reconcileMotifsWithGraph({
    graph: params.graph,
    concepts: params.concepts,
    baseMotifs: [],
  });
  const contexts = reconcileContextsWithGraph({
    graph: params.graph,
    concepts: params.concepts,
    motifs,
    baseContexts: [],
  });

  const deprecated = motifs
    .filter((m) => m.status === "deprecated")
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  if (deprecated.length) {
    const top = deprecated[0];
    return {
      motifs,
      contexts,
      question: `检测到冲突结构：${top.title}。请先确认你要优先保留哪一侧约束？`,
      rationale: `motif_conflict:${top.id}`,
    };
  }

  const uncertain = motifs
    .filter((m) => m.status === "uncertain")
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  if (uncertain.length) {
    const top = uncertain[0];
    return {
      motifs,
      contexts,
      question: `请确认这条关系是否继续生效：${top.title}。若不成立我会停用该结构。`,
      rationale: `motif_uncertain:${top.id}`,
    };
  }

  return {
    motifs,
    contexts,
    question: null,
    rationale: "motif_stable",
  };
}

function contextSummaryForPrompt(
  contexts: ReturnType<typeof reconcileContextsWithGraph>
): string {
  if (!contexts.length) return "contexts: none";
  return contexts
    .slice(0, 5)
    .map((ctx) => {
      const qs = (ctx.openQuestions || []).slice(0, 2).join(" | ") || "-";
      return `${ctx.key}[${ctx.status} c=${ctx.confidence.toFixed(2)}] q=${qs}`;
    })
    .join("\n");
}

async function pseudoStreamText(params: {
  text: string;
  onToken: (t: string) => void;
  signal?: AbortSignal;
  chunkChars?: number;
  delayMs?: number;
}) {
  const chunkChars = Math.max(params.chunkChars ?? 4, 1);
  const delayMs = Math.max(params.delayMs ?? 12, 0);
  const s = params.text || "";

  for (let i = 0; i < s.length; i += chunkChars) {
    if (params.signal?.aborted) throw new Error("aborted");
    const chunk = s.slice(i, i + chunkChars);
    params.onToken(chunk);
    if (delayMs > 0) await sleep(delayMs, params.signal);
  }
}

export async function generateAssistantTextNonStreaming(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
}): Promise<string> {
  const safeRecent = normalizeRecentTurns(params.recentTurns);
  const gsum = graphSummaryForChat(params.graph);
  const concepts = reconcileConceptsWithGraph({ graph: params.graph, baseConcepts: [] });
  const motifCtx = motifPriorityQuestion({ graph: params.graph, concepts });
  const uncertaintyPlan = planUncertaintyQuestion({
    graph: params.graph,
    recentTurns: safeRecent,
  });
  const targetedQuestion = chooseQuestionWithPriority({
    motifQuestion: motifCtx.question,
    uncertaintyQuestion: uncertaintyPlan.question,
  });

  const systemOne =
    `${buildChatSystemPrompt(params.systemPrompt)}\n\n` +
    `当前意图图摘要（只供参考，不要复述）：\n${gsum}` +
    `\n\nContext 摘要（只供你内部使用，不要逐字复述）：\n${contextSummaryForPrompt(motifCtx.contexts)}` +
    `\n\n不确定性分析（只供你内部使用，不要逐字复述）：${uncertaintyPlan.rationale}` +
    `\n\nMotif 状态分析（只供你内部使用，不要逐字复述）：${motifCtx.rationale}` +
    (targetedQuestion
      ? `\n本轮请在回答末尾给出一个定向澄清问题（避免泛问）：${targetedQuestion}`
      : "");

  const resp = await openai.chat.completions.create({
    model: config.model,
    messages: [{ role: "system", content: systemOne }, ...safeRecent, { role: "user", content: params.userText }],
    max_tokens: 900,
    temperature: 0.6,
  });

  const msg = resp.choices?.[0]?.message;
  const raw = readTextContent(msg?.content);
  const text = enforceTargetedQuestion(
    stripMarkdownToText(raw),
    targetedQuestion
  );

  dlog("choices=", resp?.choices?.length, "finish=", resp?.choices?.[0]?.finish_reason, "len=", text.length);

  if (text) return text;

  // fallback（尽量别像机器人）
  const resp2 = await openai.chat.completions.create({
    model: config.model,
    messages: [
      {
        role: "user",
        content:
          `请用简体中文给出具体可执行的回答，纯文本输出，不要Markdown。\n用户输入：${params.userText}`,
      },
    ],
    max_tokens: 700,
    temperature: 0.6,
  });

  const raw2 = readTextContent(resp2.choices?.[0]?.message?.content);
  const text2 = enforceTargetedQuestion(
    stripMarkdownToText(raw2),
    targetedQuestion
  );

  dlog("fallback finish=", resp2?.choices?.[0]?.finish_reason, "len=", text2.length);

  return text2 || "我明白你的意思了。你把你现在的目标和限制说一句，我直接给你一个可执行版本。";
}

export async function streamAssistantText(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  if (STREAM_MODE === "pseudo") {
    const full = await generateAssistantTextNonStreaming(params);
    await pseudoStreamText({ text: full, onToken: params.onToken, signal: params.signal });
    return full;
  }

  // upstream 真流（你的网关如果不稳，别开）
  const safeRecent = normalizeRecentTurns(params.recentTurns);
  const gsum = graphSummaryForChat(params.graph);
  const concepts = reconcileConceptsWithGraph({ graph: params.graph, baseConcepts: [] });
  const motifCtx = motifPriorityQuestion({ graph: params.graph, concepts });
  const uncertaintyPlan = planUncertaintyQuestion({
    graph: params.graph,
    recentTurns: safeRecent,
  });
  const targetedQuestion = chooseQuestionWithPriority({
    motifQuestion: motifCtx.question,
    uncertaintyQuestion: uncertaintyPlan.question,
  });
  const systemOne =
    `${buildChatSystemPrompt(params.systemPrompt)}\n\n` +
    `当前意图图摘要（只供参考，不要复述）：\n${gsum}` +
    `\n\nContext 摘要（只供你内部使用，不要逐字复述）：\n${contextSummaryForPrompt(motifCtx.contexts)}` +
    `\n\n不确定性分析（只供你内部使用，不要逐字复述）：${uncertaintyPlan.rationale}` +
    `\n\nMotif 状态分析（只供你内部使用，不要逐字复述）：${motifCtx.rationale}` +
    (targetedQuestion
      ? `\n本轮请在回答末尾给出一个定向澄清问题（避免泛问）：${targetedQuestion}`
      : "");

  const upstream = await openai.chat.completions.create(
    {
      model: config.model,
      messages: [{ role: "system", content: systemOne }, ...safeRecent, { role: "user", content: params.userText }],
      stream: true,
      max_tokens: 900,
      temperature: 0.6,
    },
    params.signal ? { signal: params.signal } : undefined
  );

  let full = "";
  let gotAny = false;

  for await (const chunk of upstream as any) {
    const t = chunk?.choices?.[0]?.delta?.content;
    if (typeof t === "string" && t.length > 0) {
      gotAny = true;
      full += t;
      params.onToken(t);
    }
  }

  const stripped = stripMarkdownToText(full);
  const clean = enforceTargetedQuestion(stripped, targetedQuestion);
  if (gotAny && clean) {
    const missing = clean.startsWith(stripped) ? clean.slice(stripped.length) : "";
    if (missing) params.onToken(missing);
    return clean;
  }

  // 降级 pseudo
  const full2 = await generateAssistantTextNonStreaming(params);
  await pseudoStreamText({ text: full2, onToken: params.onToken, signal: params.signal });
  return full2;
}
