import type { CDG, ConceptNode, GraphPatch, PatchOp } from "../../core/graph.js";
import { makeTempId } from "./common.js";
import type { SlotGraphState, SlotNodeSpec } from "./slotTypes.js";
import { normalizeDestination } from "./intentSignals.js";
import { cleanStatement } from "./text.js";

function slug(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[省市县区州郡]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 28);
}

function parseSlotKeyFromStatement(node: ConceptNode): string | null {
  const s = cleanStatement(node.statement || "", 140);
  if (!s) return null;
  if (node.type === "goal") return "slot:goal";

  let m = s.match(/^目的地[:：]\s*(.+)$/);
  if (m?.[1]) return `slot:destination:${slug(normalizeDestination(m[1]))}`;

  m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+[0-9]{1,3}\s*天$/);
  if (m?.[1]) return `slot:duration_city:${slug(normalizeDestination(m[1]))}`;

  if (/^总行程时长[:：]\s*[0-9]{1,3}\s*天$/.test(s)) return "slot:duration_total";
  if (/^预算(?:上限)?[:：]/.test(s)) return "slot:budget";
  if (/^同行人数[:：]/.test(s)) return "slot:people";
  if (/^健康约束[:：]/.test(s)) return "slot:health";
  if (/^语言约束[:：]/.test(s)) return "slot:language";
  if (/^限制因素[:：]/.test(s)) {
    const x = s.split(/[:：]/)[1] || "limiting";
    return `slot:constraint:limiting:${slug(x)}`;
  }
  if (/^冲突提示[:：]/.test(s)) {
    const x = s.split(/[:：]/)[1] || "conflict";
    return `slot:conflict:${slug(x)}`;
  }
  if (/^(关键约束|法律约束|安全约束|出行约束|行程约束)[:：]/.test(s)) {
    const x = s.split(/[:：]/)[1] || "constraint";
    return `slot:constraint:${slug(x)}`;
  }
  if (/^(?:会议关键日|关键会议日|论文汇报日|关键日)[:：]/.test(s)) {
    const x = s.split(/[:：]/)[1] || "critical";
    return `slot:meeting_critical:${slug(x)}`;
  }
  if (/^景点偏好[:：]/.test(s)) return "slot:scenic_preference";
  if (/^活动偏好[:：]/.test(s)) return "slot:activity_preference";
  if (/^(住宿偏好|酒店偏好|住宿标准|酒店标准)[:：]/.test(s)) return "slot:lodging";
  if (/^子地点[:：]/.test(s)) return `slot:sub_location:${slug(s)}`;
  return null;
}

function getNodeSlotKey(node: ConceptNode): string | null {
  const key = cleanStatement(node.key || "", 80);
  if (key.startsWith("slot:")) return key;
  return parseSlotKeyFromStatement(node);
}

function nodePatchFromSpec(existing: ConceptNode | null, spec: SlotNodeSpec): Partial<ConceptNode> | null {
  if (!existing) return null;
  const patch: Partial<ConceptNode> = {};
  const setIfChanged = <K extends keyof ConceptNode>(key: K, val: ConceptNode[K]) => {
    const cur = existing[key];
    const left = JSON.stringify(cur ?? null);
    const right = JSON.stringify(val ?? null);
    if (left !== right) (patch as any)[key] = val;
  };

  setIfChanged("type", spec.type);
  setIfChanged("layer", spec.layer);
  setIfChanged("statement", spec.statement);
  setIfChanged("confidence", spec.confidence);
  setIfChanged("importance", spec.importance);
  setIfChanged("strength", spec.strength);
  setIfChanged("severity", spec.severity);
  setIfChanged("tags", spec.tags);
  setIfChanged("evidenceIds", spec.evidenceIds);
  setIfChanged("sourceMsgIds", spec.sourceMsgIds);
  setIfChanged("key", spec.key || spec.slotKey);
  setIfChanged("motifType", spec.motifType);
  setIfChanged("claim", spec.claim);
  setIfChanged("evidence", spec.evidence as any);
  setIfChanged("linkedIntentIds", spec.linkedIntentIds);
  setIfChanged("rebuttalPoints", spec.rebuttalPoints);
  setIfChanged("revisionHistory", spec.revisionHistory as any);
  setIfChanged("priority", spec.priority);
  setIfChanged("successCriteria", spec.successCriteria);
  return Object.keys(patch).length ? patch : null;
}

export function compileSlotStateToPatch(params: {
  graph: CDG;
  state: SlotGraphState;
}): GraphPatch {
  const existingByKey = new Map<string, ConceptNode>();
  for (const n of params.graph.nodes || []) {
    const key = getNodeSlotKey(n);
    if (!key) continue;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, n);
      continue;
    }
    const old = existingByKey.get(key)!;
    if ((Number(n.confidence) || 0) >= (Number(old.confidence) || 0)) {
      existingByKey.set(key, n);
    }
  }

  const ops: PatchOp[] = [];
  const nodeIdBySlot = new Map<string, string>();

  for (const spec of params.state.nodes) {
    const existing = existingByKey.get(spec.slotKey) || null;
    if (existing) {
      nodeIdBySlot.set(spec.slotKey, existing.id);
      const patch = nodePatchFromSpec(existing, spec);
      if (patch) ops.push({ op: "update_node", id: existing.id, patch });
      continue;
    }

    const nodeId = makeTempId("n");
    nodeIdBySlot.set(spec.slotKey, nodeId);
    ops.push({
      op: "add_node",
      node: {
        id: nodeId,
        type: spec.type,
        layer: spec.layer,
        statement: spec.statement,
        status: "confirmed",
        confidence: spec.confidence,
        strength: spec.strength,
        severity: spec.severity,
        importance: spec.importance,
        tags: spec.tags,
        evidenceIds: spec.evidenceIds,
        sourceMsgIds: spec.sourceMsgIds,
        key: spec.key || spec.slotKey,
        value: spec.value,
        motifType: spec.motifType,
        claim: spec.claim,
        evidence: spec.evidence as any,
        linkedIntentIds: spec.linkedIntentIds,
        rebuttalPoints: spec.rebuttalPoints,
        revisionHistory: spec.revisionHistory as any,
        priority: spec.priority,
        successCriteria: spec.successCriteria,
      } as any,
    });
  }

  const desiredSlots = new Set(params.state.nodes.map((x) => x.slotKey));
  for (const [slotKey, node] of existingByKey.entries()) {
    if (!slotKey.startsWith("slot:")) continue;
    if (desiredSlots.has(slotKey)) continue;
    if (slotKey === "slot:goal") continue;
    if (node.status === "rejected" && (Number(node.importance) || 0) <= 0.35) continue;
    const nextTags = Array.from(
      new Set([...(Array.isArray(node.tags) ? node.tags : []), "stale_slot", "auto_cleaned"])
    ).slice(0, 8);
    ops.push({
      op: "update_node",
      id: node.id,
      patch: {
        status: "rejected",
        importance: 0.24,
        priority: 0.3,
        confidence: Math.min(0.58, Number(node.confidence) || 0.58),
        tags: nextTags,
      } as any,
    });
  }

  const existingEdgeSig = new Set<string>();
  for (const e of params.graph.edges || []) {
    existingEdgeSig.add(`${e.from}|${e.to}`);
  }

  for (const e of params.state.edges) {
    const fromId = nodeIdBySlot.get(e.fromSlot) || existingByKey.get(e.fromSlot)?.id;
    const toId = nodeIdBySlot.get(e.toSlot) || existingByKey.get(e.toSlot)?.id;
    if (!fromId || !toId || fromId === toId) continue;
    const sig = `${fromId}|${toId}`;
    if (existingEdgeSig.has(sig)) continue;
    existingEdgeSig.add(sig);
    ops.push({
      op: "add_edge",
      edge: {
        id: makeTempId("e"),
        from: fromId,
        to: toId,
        type: e.type,
        confidence: e.confidence,
      },
    });
  }

  return {
    ops,
    notes: [...(params.state.notes || []), "slot_graph_compiler_v1"],
  };
}
