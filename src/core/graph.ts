export type { NodeLayer } from "./nodeLayer.js";

export type {
  CDG,
  ConceptEdge,
  ConceptNode,
  ConceptType,
  EdgeType,
  GraphPatch,
  GraphNodeValue,
  GraphPresentationMeta,
  GraphSemanticLane,
  GraphSlotFamily,
  GraphToneKey,
  MotifEvidence,
  MotifStructure,
  MotifType,
  PatchOp,
  RevisionRecord,
  Severity,
  Status,
  Strength,
} from "./graph/types.js";

export { applyPatchWithGuards, normalizeGraphSnapshot } from "./graph/patchApply.js";
