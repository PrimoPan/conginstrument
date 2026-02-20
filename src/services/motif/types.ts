import type { ConceptNode, MotifType } from "../../core/graph.js";

export type MotifLikeNode = Pick<
  ConceptNode,
  "id" | "type" | "layer" | "strength" | "severity" | "statement" | "claim" | "motifType" | "confidence" | "importance"
>;

export type MotifCatalogEntry = {
  key: string;
  motifType: MotifType;
  claim: string;
  count: number;
  avgConfidence: number;
  avgImportance: number;
  nodeIds: string[];
  layers: string[];
  conceptTypes: string[];
  representativeNodeId: string;
};

