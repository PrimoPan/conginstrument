import type {
  CDG,
  ConceptEdge,
  ConceptNode,
  GraphPresentationMeta,
  GraphSemanticLane,
  GraphSlotFamily,
  GraphToneKey,
  GraphNodeValue,
} from "./types.js";
import {
  chooseRootGoal,
  cleanText,
  isPrimarySlot,
  slotFamily,
  slotKeyOfNode,
  slotPriorityScore,
} from "./common.js";

function normalizeSlotFamilyName(raw: string | null | undefined): GraphSlotFamily {
  const family = cleanText(raw);
  if (!family) return "other";
  const allowed = new Set<GraphSlotFamily>([
    "none",
    "goal",
    "destination",
    "duration_total",
    "duration_city",
    "duration_meeting",
    "meeting_critical",
    "people",
    "budget",
    "lodging",
    "scenic_preference",
    "activity_preference",
    "health",
    "language",
    "generic_constraint",
    "sub_location",
    "conflict",
    "other",
  ]);
  return allowed.has(family as GraphSlotFamily) ? (family as GraphSlotFamily) : "other";
}

function laneForSlotFamily(family: GraphSlotFamily): GraphSemanticLane {
  if (family === "people") return "people";
  if (family === "destination") return "destination";
  if (family === "duration_total" || family === "duration_city" || family === "duration_meeting") return "duration";
  if (family === "budget") return "budget";
  if (family === "lodging") return "lodging";
  if (family === "scenic_preference" || family === "activity_preference") return "preference_slot";
  if (family === "health") return "health";
  if (family === "meeting_critical") return "meeting_critical";
  if (family === "language") return "language";
  if (family === "generic_constraint" || family === "conflict") return "constraint_high";
  return "other";
}

function laneForNode(node: ConceptNode, family: GraphSlotFamily): GraphSemanticLane {
  if (family !== "other" && family !== "none") return laneForSlotFamily(family);
  if (node.layer === "risk") return "constraint_high";
  if (node.layer === "preference") return "preference";
  if (node.layer === "intent" || cleanText((node as any).key).startsWith("slot:goal")) return "goal";
  if (node.type === "constraint") {
    if (node.severity === "critical" || node.severity === "high") return "constraint_high";
    return "constraint";
  }
  if (node.type === "preference") return "preference";
  if (node.type === "factual_assertion") return "factual_assertion";
  if (node.type === "belief") return "belief";
  return "other";
}

function toneKeyForNode(node: ConceptNode): GraphToneKey {
  if (node.layer === "risk" || node.severity === "critical" || node.severity === "high") return "risk";
  if (node.layer === "intent" || (node.type === "belief" && cleanText((node as any).key).startsWith("slot:goal"))) {
    return "goal";
  }
  if (node.layer === "preference" || node.type === "preference") return "preference";
  if (node.layer === "requirement" || node.type === "constraint") return "requirement";
  if (node.type === "belief") return "belief";
  return "default";
}

function relationMaps(edges: ConceptEdge[]) {
  const outgoing = new Map<string, ConceptEdge[]>();
  const incoming = new Map<string, ConceptEdge[]>();
  for (const edge of edges || []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from)!.push(edge);
    incoming.get(edge.to)!.push(edge);
  }
  return { outgoing, incoming };
}

export function buildGraphPresentationMeta(graph: CDG): Map<string, GraphPresentationMeta> {
  const nodes = (graph.nodes || []).slice();
  const edges = (graph.edges || []).slice();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const rootGoal = chooseRootGoal(nodesById, new Set<string>(), new Map<string, number>());
  const rootId = rootGoal?.id || null;
  const { outgoing, incoming } = relationMaps(edges);

  const slotByNodeId = new Map<string, string | null>();
  const familyByNodeId = new Map<string, GraphSlotFamily>();
  for (const node of nodes) {
    const slot = slotKeyOfNode(node);
    slotByNodeId.set(node.id, slot);
    familyByNodeId.set(node.id, normalizeSlotFamilyName(slotFamily(slot)));
  }

  const riskAnchorIds = nodes
    .filter((node) => {
      const family = familyByNodeId.get(node.id) || "other";
      return family === "health" || family === "meeting_critical";
    })
    .map((node) => node.id);

  const metaByNodeId = new Map<string, GraphPresentationMeta>();
  for (const node of nodes) {
    const slot = slotByNodeId.get(node.id) || null;
    const family = familyByNodeId.get(node.id) || "other";
    let semanticLevel = 3;

    if (rootId && node.id === rootId) {
      semanticLevel = 0;
    } else if (slot && isPrimarySlot(slot)) {
      semanticLevel = 1;
    } else if (family === "health" || family === "meeting_critical") {
      semanticLevel = 2;
    } else {
      const out = outgoing.get(node.id) || [];
      const inn = incoming.get(node.id) || [];
      const toHealth = riskAnchorIds.length ? out.some((edge) => riskAnchorIds.includes(edge.to)) : false;
      const toPrimary = out.some((edge) => {
        const toSlot = slotByNodeId.get(edge.to) || null;
        return !!toSlot && isPrimarySlot(toSlot);
      });
      const toRoot = !!rootId && out.some((edge) => edge.to === rootId);
      const fromPrimary = inn.some((edge) => {
        const fromSlot = slotByNodeId.get(edge.from) || null;
        return !!fromSlot && isPrimarySlot(fromSlot);
      });

      if (!rootId) {
        semanticLevel = slot ? 1 : 2;
      } else if (toPrimary || toRoot || fromPrimary) {
        semanticLevel = 2;
      } else if (toHealth) {
        semanticLevel = 3;
      }
    }

    metaByNodeId.set(node.id, {
      slot_family: family,
      semantic_lane: rootId && node.id === rootId ? "goal" : laneForNode(node, family),
      semantic_level: semanticLevel,
      priority_score: slot ? slotPriorityScore(slot) : 99,
      is_primary_slot: !!slot && isPrimarySlot(slot),
      tone_key: toneKeyForNode(node),
    });
  }

  return metaByNodeId;
}

function presentationEquals(a: GraphPresentationMeta | undefined, b: GraphPresentationMeta): boolean {
  return (
    cleanText(a?.slot_family) === cleanText(b.slot_family) &&
    cleanText(a?.semantic_lane) === cleanText(b.semantic_lane) &&
    Number(a?.semantic_level ?? NaN) === Number(b.semantic_level ?? NaN) &&
    Number(a?.priority_score ?? NaN) === Number(b.priority_score ?? NaN) &&
    Boolean(a?.is_primary_slot) === Boolean(b.is_primary_slot) &&
    cleanText(a?.tone_key) === cleanText(b.tone_key)
  );
}

export function attachGraphPresentationMeta(graph: CDG): CDG {
  const metaByNodeId = buildGraphPresentationMeta(graph);
  let changed = false;
  const nodes = (graph.nodes || []).map((node) => {
    const nextPresentation = metaByNodeId.get(node.id);
    if (!nextPresentation) return node;
    const currentValue =
      node.value && typeof node.value === "object" && !Array.isArray(node.value)
        ? ({ ...(node.value as GraphNodeValue) } as GraphNodeValue)
        : ({} as GraphNodeValue);
    if (presentationEquals(currentValue.presentation, nextPresentation)) return node;
    changed = true;
    return {
      ...node,
      value: {
        ...currentValue,
        presentation: nextPresentation,
      },
    };
  });
  return changed ? { ...graph, nodes } : graph;
}
