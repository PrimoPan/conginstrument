import type { CDG, MotifType } from "../../core/graph.js";
import type { MotifCatalogEntry } from "./types.js";

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

function normalizeKey(input: string): string {
  return cleanText(input, 160).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function inferMotifTypeByNode(node: { motifType?: MotifType; type?: string; layer?: string; strength?: string }): MotifType {
  if (node.motifType) return node.motifType;
  if (node.type === "goal" || node.layer === "intent") return "expectation";
  if (node.layer === "risk") return "hypothesis";
  if (node.type === "constraint" && node.strength === "hard") return "hypothesis";
  if (node.type === "preference" || node.layer === "preference" || node.type === "belief") return "belief";
  return "cognitive_step";
}

function claimOfNode(node: { claim?: string; statement?: string }): string {
  const claim = cleanText(node.claim || "", 160);
  if (claim) return claim;
  const statement = cleanText(node.statement || "", 160);
  if (!statement) return "";
  return statement.length > 88 ? `${statement.slice(0, 88)}...` : statement;
}

export function buildMotifCatalog(graph: CDG): MotifCatalogEntry[] {
  const bucket = new Map<
    string,
    {
      motifType: MotifType;
      claim: string;
      nodeIds: string[];
      layers: Set<string>;
      types: Set<string>;
      confidenceSum: number;
      importanceSum: number;
      count: number;
    }
  >();

  for (const node of graph.nodes || []) {
    if (!node || node.status === "rejected") continue;
    const claim = claimOfNode(node);
    if (!claim) continue;
    const motifType = inferMotifTypeByNode(node);
    const k = `${motifType}:${normalizeKey(claim)}`;
    if (!k || k.endsWith(":")) continue;

    const cur = bucket.get(k) || {
      motifType,
      claim,
      nodeIds: [],
      layers: new Set<string>(),
      types: new Set<string>(),
      confidenceSum: 0,
      importanceSum: 0,
      count: 0,
    };

    cur.nodeIds.push(node.id);
    if (node.layer) cur.layers.add(node.layer);
    if (node.type) cur.types.add(node.type);
    cur.confidenceSum += clamp01(node.confidence, 0.68);
    cur.importanceSum += clamp01(node.importance, 0.68);
    cur.count += 1;
    bucket.set(k, cur);
  }

  return Array.from(bucket.entries())
    .map(([key, v]) => ({
      key,
      motifType: v.motifType,
      claim: v.claim,
      count: v.count,
      avgConfidence: Number((v.confidenceSum / Math.max(1, v.count)).toFixed(4)),
      avgImportance: Number((v.importanceSum / Math.max(1, v.count)).toFixed(4)),
      nodeIds: v.nodeIds.slice(0, 12),
      layers: Array.from(v.layers),
      conceptTypes: Array.from(v.types),
      representativeNodeId: v.nodeIds[0],
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.avgImportance - a.avgImportance ||
        b.avgConfidence - a.avgConfidence
    );
}

export function summarizeTopMotifs(graph: CDG, topN = 4): string[] {
  return buildMotifCatalog(graph)
    .slice(0, Math.max(1, topN))
    .map((m) => `${m.motifType}:${m.claim}(n=${m.count},i=${m.avgImportance.toFixed(2)})`);
}

