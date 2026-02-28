import type { CDG, ConceptNode, GraphPatch, PatchOp } from "../../core/graph.js";
import { makeTempId } from "./common.js";
import type { SlotGraphState, SlotNodeSpec } from "./slotTypes.js";
import { semanticKeyForNode } from "../concepts.js";

function getNodeSlotKey(node: ConceptNode): string | null {
  const key = semanticKeyForNode(node);
  return key.startsWith("slot:") ? key : null;
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
  const existingGroups = new Map<string, ConceptNode[]>();
  const staleDuplicateNodeIds = new Set<string>();
  for (const n of params.graph.nodes || []) {
    const key = getNodeSlotKey(n);
    if (!key) continue;
    const list = existingGroups.get(key) || [];
    list.push(n);
    existingGroups.set(key, list);
  }
  for (const [key, list] of existingGroups.entries()) {
    const sorted = list
      .slice()
      .sort((a, b) => {
        const statusRank = (x: ConceptNode) =>
          x.status === "confirmed" ? 3 : x.status === "proposed" ? 2 : x.status === "disputed" ? 1 : 0;
        const rankDiff = statusRank(b) - statusRank(a);
        if (rankDiff !== 0) return rankDiff;
        const confDiff = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
        if (confDiff !== 0) return confDiff;
        return (Number(b.importance) || 0) - (Number(a.importance) || 0);
      });
    const primary = sorted[0];
    existingByKey.set(key, primary);
    for (let i = 1; i < sorted.length; i += 1) staleDuplicateNodeIds.add(sorted[i].id);
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
  const touchedNodeIds = new Set<string>();
  const removedEdgeIds = new Set<string>();

  const markNodeAsStale = (node: ConceptNode) => {
    if (touchedNodeIds.has(node.id)) return;
    if (!node.locked) {
      ops.push({ op: "remove_node", id: node.id });
      touchedNodeIds.add(node.id);
      return;
    }
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
    touchedNodeIds.add(node.id);
  };
  for (const nodeId of staleDuplicateNodeIds) {
    const node = (params.graph.nodes || []).find((x) => x.id === nodeId);
    if (!node) continue;
    markNodeAsStale(node);
    for (const e of params.graph.edges || []) {
      if ((e.from === nodeId || e.to === nodeId) && !removedEdgeIds.has(e.id)) {
        ops.push({ op: "remove_edge", id: e.id });
        removedEdgeIds.add(e.id);
      }
    }
  }

  for (const [slotKey, node] of existingByKey.entries()) {
    if (!slotKey.startsWith("slot:")) continue;
    if (desiredSlots.has(slotKey)) continue;
    if (slotKey === "slot:goal") continue;
    if (node.status === "rejected" && (Number(node.importance) || 0) <= 0.35) continue;
    markNodeAsStale(node);
    for (const e of params.graph.edges || []) {
      if ((e.from === node.id || e.to === node.id) && !removedEdgeIds.has(e.id)) {
        ops.push({ op: "remove_edge", id: e.id });
        removedEdgeIds.add(e.id);
      }
    }
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
