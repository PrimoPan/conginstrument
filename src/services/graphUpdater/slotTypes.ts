import type { ConceptType, EdgeType, MotifType, NodeLayer, Severity, Strength } from "../../core/graph.js";

export type SlotNodeSpec = {
  slotKey: string;
  type: ConceptType;
  layer: NodeLayer;
  statement: string;
  confidence: number;
  importance: number;
  strength?: Strength;
  severity?: Severity;
  tags?: string[];
  evidenceIds?: string[];
  sourceMsgIds?: string[];
  key?: string;
  value?: unknown;

  // PRD motif/intent fields
  motifType?: MotifType;
  claim?: string;
  evidence?: Array<{ quote: string; source?: string }>;
  linkedIntentIds?: string[];
  rebuttalPoints?: string[];
  revisionHistory?: Array<{
    at: string;
    action: "created" | "updated" | "replaced" | "merged";
    reason?: string;
    by?: "system" | "assistant" | "user";
  }>;
  priority?: number;
  successCriteria?: string[];
};

export type SlotEdgeSpec = {
  fromSlot: string;
  toSlot: string;
  type: EdgeType;
  confidence: number;
};

export type SlotGraphState = {
  nodes: SlotNodeSpec[];
  edges: SlotEdgeSpec[];
  notes?: string[];
};
