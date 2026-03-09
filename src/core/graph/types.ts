import type { NodeLayer } from "../nodeLayer.js";

export type { NodeLayer } from "../nodeLayer.js";

export type ConceptType = "belief" | "constraint" | "preference" | "factual_assertion";
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

export type GraphSlotFamily =
  | "none"
  | "goal"
  | "destination"
  | "duration_total"
  | "duration_city"
  | "duration_meeting"
  | "meeting_critical"
  | "people"
  | "budget"
  | "lodging"
  | "scenic_preference"
  | "activity_preference"
  | "health"
  | "language"
  | "generic_constraint"
  | "sub_location"
  | "conflict"
  | "other";

export type GraphSemanticLane =
  | "goal"
  | "health"
  | "meeting_critical"
  | "language"
  | "people"
  | "destination"
  | "duration"
  | "budget"
  | "lodging"
  | "preference_slot"
  | "constraint_high"
  | "constraint"
  | "preference"
  | "belief"
  | "factual_assertion"
  | "other";

export type GraphToneKey = "risk" | "goal" | "preference" | "requirement" | "belief" | "default";

export type GraphPresentationMeta = {
  slot_family?: GraphSlotFamily;
  semantic_lane?: GraphSemanticLane;
  semantic_level?: number;
  priority_score?: number;
  is_primary_slot?: boolean;
  tone_key?: GraphToneKey;
};

export type GraphNodeValue = Record<string, any> & {
  ui?: {
    x?: number;
    y?: number;
  };
  conceptState?: Record<string, any> & {
    validation_status?: string;
    paused?: boolean;
  };
  presentation?: GraphPresentationMeta;
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
  value?: GraphNodeValue;
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
