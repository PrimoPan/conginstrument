import type { ConceptNode, GraphPatch, MotifType, PatchOp } from "../../core/graph.js";

function cleanText(input: any, max = 120): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clamp01(x: any, fallback = 0.68): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function inferMotifType(node: Partial<ConceptNode>): MotifType {
  if (node.type === "goal" || node.layer === "intent") return "expectation";
  if (node.layer === "risk") return "hypothesis";
  if (node.type === "constraint" && node.strength === "hard") return "hypothesis";
  if (node.type === "preference" || node.layer === "preference" || node.type === "belief") return "belief";
  return "cognitive_step";
}

function claimFromStatement(statement: any): string | undefined {
  const s = cleanText(statement, 180);
  if (!s) return undefined;
  return s.length > 72 ? `${s.slice(0, 72)}...` : s;
}

function shouldInjectRevision(op: PatchOp): boolean {
  if (op.op === "add_node") return true;
  if (op.op !== "update_node") return false;
  const p = op.patch || {};
  return (
    p.statement != null ||
    p.status != null ||
    p.confidence != null ||
    p.importance != null ||
    p.type != null ||
    p.layer != null ||
    p.strength != null ||
    p.severity != null
  );
}

export function enrichPatchWithMotifFoundation(
  patch: GraphPatch,
  opts?: { reason?: string; by?: "system" | "assistant" | "user" }
): GraphPatch {
  const reason = cleanText(opts?.reason || "motif_foundation", 60);
  const by = opts?.by || "system";
  const now = new Date().toISOString();

  const ops: PatchOp[] = (patch.ops || []).map((op) => {
    if (op.op === "add_node") {
      const node = { ...op.node };
      if (!node.motifType) node.motifType = inferMotifType(node);
      if (!node.claim) node.claim = claimFromStatement(node.statement);
      if (node.priority == null && node.importance != null) {
        node.priority = clamp01(node.importance, 0.68);
      }
      const existingHistory = Array.isArray(node.revisionHistory) ? node.revisionHistory.slice(0, 9) : [];
      if (!existingHistory.length) {
        existingHistory.push({ at: now, action: "created", by, reason });
      }
      node.revisionHistory = existingHistory;
      return { ...op, node };
    }

    if (op.op === "update_node") {
      const nextPatch: Partial<ConceptNode> = { ...(op.patch || {}) };
      if (!nextPatch.motifType) {
        const inferred = inferMotifType(nextPatch);
        if (inferred) nextPatch.motifType = inferred;
      }
      if (!nextPatch.claim && nextPatch.statement) {
        nextPatch.claim = claimFromStatement(nextPatch.statement);
      }
      if (nextPatch.priority == null && nextPatch.importance != null) {
        nextPatch.priority = clamp01(nextPatch.importance, 0.68);
      }
      if (shouldInjectRevision(op) && !nextPatch.revisionHistory) {
        nextPatch.revisionHistory = [{ at: now, action: "updated", by, reason }];
      }
      return { ...op, patch: nextPatch };
    }

    return op;
  });

  const notes = [...(patch.notes || [])];
  if (!notes.includes("motif_foundation_grounding_v1")) notes.push("motif_foundation_grounding_v1");
  return { ...patch, ops, notes };
}

