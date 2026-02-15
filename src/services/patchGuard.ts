// src/services/patchGuard.ts
import type { GraphPatch } from "../core/graph.js";

const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][patchGuard]", ...args);
}

const ALLOWED_NODE_TYPES = new Set(["goal", "constraint", "preference", "belief", "fact", "question"]);
const ALLOWED_EDGE_TYPES = new Set(["enable", "constraint", "determine", "conflicts_with"]);
const ALLOWED_SEVERITY = new Set(["low", "medium", "high", "critical"]);

// 默认只允许增/改/加边；删除要显式开开关
const ALLOW_DELETE = process.env.CI_ALLOW_DELETE === "1";
const ALLOWED_OPS = new Set([
  "add_node",
  "update_node",
  "add_edge",
  ...(ALLOW_DELETE ? ["remove_node", "remove_edge"] : []),
]);

function clamp01(x: any, d = 0.6) {
  const n = Number(x);
  if (!Number.isFinite(n)) return d;
  return Math.max(0, Math.min(1, n));
}

function normalizeSeverity(x: any): "low" | "medium" | "high" | "critical" | undefined {
  const s = String(x ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if (ALLOWED_SEVERITY.has(s)) return s as "low" | "medium" | "high" | "critical";
  return undefined;
}

function normalizeTags(tags: any): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out = tags
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
  return out.length ? out : undefined;
}

function normalizeStringArray(input: any, max = 8): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
  return out.length ? out : undefined;
}

function makeTempId(prefix: "n" | "e") {
  return `t_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把各种 op 名称统一成 snake_case，并做别名映射 */
function normalizeKind(v: any): string {
  if (v == null) return "";
  let k = String(v).trim();
  if (!k) return "";

  // camelCase -> snake_case
  k = k.replace(/([a-z])([A-Z])/g, "$1_$2");
  k = k.toLowerCase().replace(/[\s-]+/g, "_");

  const map: Record<string, string> = {
    addnode: "add_node",
    add_nodes: "add_node",
    create_node: "add_node",
    createnode: "add_node",

    updatenode: "update_node",
    update: "update_node",
    patch_node: "update_node",

    addedge: "add_edge",
    add_edges: "add_edge",
    create_edge: "add_edge",
    createedge: "add_edge",

    removenode: "remove_node",
    deletenode: "remove_node",
    delete_node: "remove_node",
    remove_node: "remove_node",

    removeedge: "remove_edge",
    deleteedge: "remove_edge",
    delete_edge: "remove_edge",
    remove_edge: "remove_edge",
  };

  return map[k] || k;
}

/** 兼容 raw 里 ops 不叫 ops 的情况 */
function pickOpsArray(raw: any): any[] {
  if (Array.isArray(raw?.ops)) return raw.ops;
  if (Array.isArray(raw?.operations)) return raw.operations;
  if (Array.isArray(raw?.actions)) return raw.actions;
  if (Array.isArray(raw)) return raw;
  return [];
}

/** 兼容 payload 字段漂移：node/data/payload/value */
function pickPayload(op: any, preferKey: "node" | "edge" | "patch") {
  return op?.[preferKey] ?? op?.data ?? op?.payload ?? op?.value ?? op;
}

/**
 * sanitizeGraphPatchStrict：
 * - 允许 kind 字段漂移：op/type/action/operation/kind/name
 * - 允许 payload 字段漂移：node/edge/patch/data/payload/value
 * - 关键：如果我们给 add_node 生成/替换了 id，会同步替换 edge.from/to 和 update_node.id
 */
export function sanitizeGraphPatchStrict(raw: any): GraphPatch {
  const notes: string[] = [];
  const rawNotes = Array.isArray(raw?.notes) ? raw.notes.map((x: any) => String(x)) : [];

  const opsIn = pickOpsArray(raw);
  const opsOut: any[] = [];

  // ✅ id 映射：oldId -> newTempId
  const idMap = new Map<string, string>();

  // --------
  // Pass 1: 预扫描 add_node，决定哪些 id 需要改成 temp，并记下映射
  // --------
  for (const op of opsIn) {
    if (!op || typeof op !== "object") continue;

    const kindRaw =
      (op as any).op ??
      (op as any).type ??
      (op as any).action ??
      (op as any).operation ??
      (op as any).kind ??
      (op as any).name;

    const kind = normalizeKind(kindRaw);
    if (kind !== "add_node") continue;

    const node = pickPayload(op, "node");
    const type = String(node?.type || "").trim();
    const statement = String(node?.statement ?? node?.text ?? "").trim();

    if (!ALLOWED_NODE_TYPES.has(type) || !statement) continue;

    const srcId = String(node?.id || "").trim();

    // ✅ 规则：新节点最好用 temp id（t_*），但不能只改 node.id 不改 edge.from/to
    // - 若模型已经给了 t_*：尊重
    // - 若给了别的 id：我们会映射到新的 temp id，并记录 old->new
    // - 若没给 id：后面直接生成 temp id（没有 old id 不用映射）
    if (srcId && srcId.startsWith("t_")) continue;
    if (srcId && !idMap.has(srcId)) {
      idMap.set(srcId, makeTempId("n"));
    }
  }

  // 小工具：把某个 id 走映射（若存在）
  const mapId = (id: any) => {
    const s = String(id || "").trim();
    if (!s) return "";
    return idMap.get(s) || s;
  };

  // --------
  // Pass 2: 正式 sanitize，并在必要时应用映射
  // --------
  for (const op of opsIn) {
    if (!op || typeof op !== "object") continue;

    const kindRaw =
      (op as any).op ??
      (op as any).type ??
      (op as any).action ??
      (op as any).operation ??
      (op as any).kind ??
      (op as any).name;

    const kind = normalizeKind(kindRaw);

    if (!kind) {
      notes.push("dropped_op:missing_kind");
      continue;
    }

    // 删除类默认禁用
    if (!ALLOW_DELETE && (kind === "remove_node" || kind === "remove_edge")) {
      notes.push(`dropped_op:${kind}`);
      continue;
    }

    if (!ALLOWED_OPS.has(kind)) {
      notes.push(`dropped_op:${kind}`);
      continue;
    }

    if (kind === "add_node") {
      const node = pickPayload(op, "node");
      const type = String(node?.type || "").trim();
      const statement = String(node?.statement ?? node?.text ?? "").trim();

      if (!ALLOWED_NODE_TYPES.has(type) || !statement) {
        notes.push("drop:add_node_invalid");
        continue;
      }

      const srcId = String(node?.id || "").trim();
      // 如果 srcId 被映射：用映射后的；如果 srcId 本身就是 t_*：用它；否则生成新的 temp
      const id =
        (srcId && mapId(srcId)) ||
        (srcId && srcId.startsWith("t_") ? srcId : "") ||
        makeTempId("n");

      const severity = normalizeSeverity(node?.severity);
      const importance = node?.importance != null ? clamp01(node?.importance, 0.7) : undefined;
      const tags = normalizeTags(node?.tags);
      const evidenceIds = normalizeStringArray(node?.evidenceIds, 6);
      const sourceMsgIds = normalizeStringArray(node?.sourceMsgIds, 6);

      opsOut.push({
        op: "add_node",
        node: {
          id,
          type,
          statement,
          strength: node?.strength === "hard" || node?.strength === "soft" ? node.strength : undefined,
          status: typeof node?.status === "string" ? node.status : "proposed",
          confidence: clamp01(node?.confidence, 0.6),
          severity,
          importance,
          tags,
          evidenceIds,
          sourceMsgIds,
        },
      });
      continue;
    }

    if (kind === "update_node") {
      const rawId =
        (op as any).id ?? (op as any).node_id ?? (op as any).nodeId ?? (op as any).target ?? "";
      const id = mapId(rawId);

      const patchSrc = pickPayload(op, "patch");
      if (!id || !patchSrc || typeof patchSrc !== "object") {
        notes.push("drop:update_node_invalid");
        continue;
      }

      const outPatch: any = {};
      const st = (patchSrc as any).statement ?? (patchSrc as any).text;
      if (typeof st === "string" && st.trim()) outPatch.statement = st.trim();
      if ((patchSrc as any).strength === "hard" || (patchSrc as any).strength === "soft") outPatch.strength = (patchSrc as any).strength;
      if (typeof (patchSrc as any).status === "string") outPatch.status = (patchSrc as any).status;
      if ((patchSrc as any).confidence != null) outPatch.confidence = clamp01((patchSrc as any).confidence);

      const severity = normalizeSeverity((patchSrc as any).severity);
      if (severity) outPatch.severity = severity;

      if ((patchSrc as any).importance != null) {
        outPatch.importance = clamp01((patchSrc as any).importance, 0.7);
      }

      const tags = normalizeTags((patchSrc as any).tags);
      if (tags) outPatch.tags = tags;

      const evidenceIds = normalizeStringArray((patchSrc as any).evidenceIds, 6);
      if (evidenceIds) outPatch.evidenceIds = evidenceIds;

      const sourceMsgIds = normalizeStringArray((patchSrc as any).sourceMsgIds, 6);
      if (sourceMsgIds) outPatch.sourceMsgIds = sourceMsgIds;

      if (Object.keys(outPatch).length === 0) {
        notes.push("drop:update_node_empty_patch");
        continue;
      }

      opsOut.push({ op: "update_node", id, patch: outPatch });
      continue;
    }

    if (kind === "add_edge") {
      const edge = pickPayload(op, "edge");
      const from = mapId(edge?.from ?? edge?.source);
      const to = mapId(edge?.to ?? edge?.target);
      const type = String(edge?.type || "").trim();

      if (!from || !to || !ALLOWED_EDGE_TYPES.has(type)) {
        notes.push("drop:add_edge_invalid");
        continue;
      }

      const srcEid = String(edge?.id || "").trim();
      // edge id 不需要映射，但建议用 temp（避免和已有 edge 冲突）
      const id = srcEid && srcEid.startsWith("t_") ? srcEid : makeTempId("e");

      opsOut.push({
        op: "add_edge",
        edge: { id, from, to, type, confidence: clamp01(edge?.confidence, 0.6) },
      });
      continue;
    }

    // 删除 op（如开启）
    if (kind === "remove_node") {
      const id = mapId((op as any).id);
      if (!id) {
        notes.push("drop:remove_node_invalid");
        continue;
      }
      opsOut.push({ op: "remove_node", id });
      continue;
    }

    if (kind === "remove_edge") {
      const id = String((op as any).id || "").trim();
      if (!id) {
        notes.push("drop:remove_edge_invalid");
        continue;
      }
      opsOut.push({ op: "remove_edge", id });
      continue;
    }
  }

  const mergedNotes = [...rawNotes, ...notes].slice(0, 12);

  if (DEBUG) {
    dlog("ops_in=", opsIn.length, "ops_out=", opsOut.length, "idMap.size=", idMap.size, "notes=", mergedNotes);
    if (opsIn[0] && typeof opsIn[0] === "object") dlog("op0_keys=", Object.keys(opsIn[0]));
  }

  return { ops: opsOut.slice(0, 12), notes: mergedNotes };
}
