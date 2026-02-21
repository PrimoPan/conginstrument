import type { NodeLayer } from "../nodeLayer.js";

export type { NodeLayer } from "../nodeLayer.js";

export type ConceptType = "goal" | "constraint" | "preference" | "belief" | "fact" | "question";
export type Strength = "hard" | "soft";
export type Status = "proposed" | "confirmed" | "rejected" | "disputed";

export type Severity = "low" | "medium" | "high" | "critical";
export type MotifType = "belief" | "hypothesis" | "expectation" | "cognitive_step";

export type MotifStructure = {
  premises?: string[];
  inference?: string;
  conclusion?: string;
};

export type MotifEvidence = {
  id?: string;
  quote: string;
  source?: string;
  link?: string;
};

export type RevisionRecord = {
  at: string;
  action: "created" | "updated" | "replaced" | "merged";
  reason?: string;
  by?: "user" | "assistant" | "system";
};

export type ConceptNode = {
  id: string;
  type: ConceptType;
  layer?: NodeLayer;
  strength?: Strength;
  statement: string;
  status: Status;
  confidence: number;
  locked?: boolean;
  severity?: Severity;
  importance?: number;
  tags?: string[];
  key?: string;
  value?: any;
  evidenceIds?: string[];
  sourceMsgIds?: string[];
  motifType?: MotifType;
  claim?: string;
  structure?: MotifStructure;
  evidence?: MotifEvidence[];
  linkedIntentIds?: string[];
  rebuttalPoints?: string[];
  revisionHistory?: RevisionRecord[];
  priority?: number;
  successCriteria?: string[];
};

export type EdgeType = "enable" | "constraint" | "determine" | "conflicts_with";

export type ConceptEdge = {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  confidence: number;
  phi?: string;
};

export type CDG = {
  id: string;
  version: number;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
};

export type PatchOp =
  | { op: "add_node"; node: ConceptNode }
  | { op: "update_node"; id: string; patch: Partial<ConceptNode> }
  | { op: "remove_node"; id: string }
  | { op: "add_edge"; edge: ConceptEdge }
  | { op: "remove_edge"; id: string };

export type GraphPatch = { ops: PatchOp[]; notes?: string[] };
