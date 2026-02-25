import { Router } from "express";
import { ObjectId } from "mongodb";
import { authMiddleware, AuthedRequest } from "../middleware/auth.js";
import { collections } from "../db/mongo.js";
import { generateTurn, generateTurnStreaming } from "../services/llm.js";
import { applyPatchWithGuards, normalizeGraphSnapshot } from "../core/graph.js";
import type { CDG } from "../core/graph.js";
import { config } from "../server/config.js";
import { generateAssistantTextNonStreaming } from "../services/chatResponder.js";
import { buildCognitiveModel } from "../services/cognitiveModel.js";
import { buildConflictGateMessage, listUnresolvedDeprecatedMotifs } from "../services/motif/conflictGate.js";
import { buildTravelPlanState, type TravelPlanState } from "../services/travelPlan/state.js";
import { defaultTravelPlanFileName, renderTravelPlanPdf } from "../services/travelPlan/pdf.js";

export const convRouter = Router();
convRouter.use(authMiddleware);

function defaultSystemPrompt() {
  // 不限定云南/旅游，保持通用任务助手
  return `你是CogInstrument的助手，目标是帮助用户完成当前任务，并通过提问澄清用户的目标/约束/偏好。每个conversation都是独立的新会话，不要引用其他会话信息。`;
}

function emptyGraph(conversationId: string): CDG {
  return { id: conversationId, version: 0, nodes: [], edges: [] };
}

function parseObjectId(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

function graphComparablePayload(g: CDG) {
  const nodes = (g.nodes || [])
    .map((n) => ({
      id: n.id,
      type: n.type,
      layer: n.layer,
      strength: n.strength,
      statement: n.statement,
      status: n.status,
      confidence: n.confidence,
      locked: !!n.locked,
      severity: n.severity,
      importance: n.importance,
      tags: n.tags || [],
      key: n.key,
      value: n.value,
      evidenceIds: n.evidenceIds || [],
      sourceMsgIds: n.sourceMsgIds || [],
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const edges = (g.edges || [])
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      type: e.type,
      confidence: e.confidence,
      phi: e.phi,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { nodes, edges };
}

function graphChanged(a: CDG, b: CDG): boolean {
  return JSON.stringify(graphComparablePayload(a)) !== JSON.stringify(graphComparablePayload(b));
}

function parseBoolFlag(v: any): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on";
  }
  return false;
}

async function loadRecentTurnsForPlan(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  limit?: number;
}) {
  return collections.turns
    .find({ conversationId: params.conversationId, userId: params.userId })
    .sort({ createdAt: 1 })
    .limit(Math.max(1, Math.min(params.limit || 120, 320)))
    .toArray();
}

async function loadRecentUserTextsForState(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  limit?: number;
}) {
  const docs = await collections.turns
    .find({ conversationId: params.conversationId, userId: params.userId })
    .sort({ createdAt: -1 })
    .limit(Math.max(8, Math.min(params.limit || 120, 320)))
    .toArray();
  return docs
    .reverse()
    .map((t) => String(t.userText || "").trim())
    .filter(Boolean);
}

async function computeTravelPlanState(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  graph: CDG;
  previous?: TravelPlanState | null;
}): Promise<TravelPlanState> {
  const turns = await loadRecentTurnsForPlan({
    conversationId: params.conversationId,
    userId: params.userId,
    limit: 160,
  });
  return buildTravelPlanState({
    graph: params.graph,
    turns: turns.map((t) => ({
      createdAt: t.createdAt,
      userText: t.userText,
      assistantText: t.assistantText,
    })),
    previous: params.previous || null,
  });
}

async function persistConversationModel(params: {
  conversationId: ObjectId;
  userId: ObjectId;
  model: ReturnType<typeof buildCognitiveModel>;
  updatedAt: Date;
  previousTravelPlan?: TravelPlanState | null;
}): Promise<TravelPlanState> {
  const travelPlanState = await computeTravelPlanState({
    conversationId: params.conversationId,
    userId: params.userId,
    graph: params.model.graph,
    previous: params.previousTravelPlan || null,
  });
  await collections.conversations.updateOne(
    { _id: params.conversationId, userId: params.userId },
    {
      $set: {
        graph: params.model.graph,
        concepts: params.model.concepts,
        motifs: params.model.motifs,
        motifLinks: params.model.motifLinks,
        contexts: params.model.contexts,
        travelPlanState,
        updatedAt: params.updatedAt,
      },
    }
  );
  return travelPlanState;
}

function toConflictGatePayload(motifs: any[]) {
  const unresolved = listUnresolvedDeprecatedMotifs(Array.isArray(motifs) ? motifs : []);
  if (!unresolved.length) return null;
  return {
    blocked: true,
    unresolvedMotifs: unresolved,
    message: buildConflictGateMessage(unresolved),
  };
}

/**
 * SSE 发送（event + data）
 * data 必须是 JSON 可序列化对象（或 string），我们统一 JSON.stringify。
 */
function sseSend(res: any, event: string, data: any) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // 某些环境/中间件会提供 flush，用它能更及时把 chunk 推给客户端
    res.flush?.();
  } catch {
    // 忽略写入异常（通常是客户端断开）
  }
}

// ==========================
// Conversations CRUD
// ==========================

convRouter.get("/", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const list = await collections.conversations
    .find({ userId })
    .project({ title: 1, updatedAt: 1 })
    .sort({ updatedAt: -1 })
    .toArray();

  res.json(
    list.map((x) => ({
      conversationId: String(x._id),
      title: x.title,
      updatedAt: x.updatedAt,
    }))
  );
});

convRouter.post("/", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const title = String(req.body?.title || "New Conversation").slice(0, 80);
  const now = new Date();
  const systemPrompt = defaultSystemPrompt();

  const inserted = await collections.conversations.insertOne({
    userId,
    title,
    systemPrompt,
    model: config.model,
    createdAt: now,
    updatedAt: now,
    graph: emptyGraph("temp"), // 先占位，写入后再用 _id 修正
    concepts: [],
    motifs: [],
    motifLinks: [],
    contexts: [],
    travelPlanState: {
      version: 1,
      updatedAt: now.toISOString(),
      summary: "暂无旅行计划，请先开始对话。",
      destinations: [],
      constraints: [],
      dayPlans: [],
      source: { turnCount: 0 },
    },
  } as any);

  const conversationId = String(inserted.insertedId);

  await collections.conversations.updateOne(
    { _id: inserted.insertedId, userId },
    {
      $set: {
        graph: emptyGraph(conversationId),
        concepts: [],
        motifs: [],
        motifLinks: [],
        contexts: [],
        travelPlanState: {
          version: 1,
          updatedAt: now.toISOString(),
          summary: "暂无旅行计划，请先开始对话。",
          destinations: [],
          constraints: [],
          dayPlans: [],
          source: { turnCount: 0 },
        },
      },
    }
  );

  const conv = await collections.conversations.findOne({ _id: inserted.insertedId, userId });
  if (!conv) return res.status(500).json({ error: "failed to create conversation" });

  const model = buildCognitiveModel({
    graph: conv.graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
  });

  res.json({
    conversationId,
    title: conv.title,
    systemPrompt: conv.systemPrompt,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    motifLinks: model.motifLinks,
    contexts: model.contexts,
    travelPlanState: (conv as any).travelPlanState || null,
  });
});

convRouter.get("/:id", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const model = buildCognitiveModel({
    graph: conv.graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
  });

  res.json({
    conversationId: id,
    title: conv.title,
    systemPrompt: conv.systemPrompt,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    motifLinks: model.motifLinks,
    contexts: model.contexts,
    travelPlanState: (conv as any).travelPlanState || null,
  });
});

convRouter.put("/:id/graph", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const incomingGraph = req.body?.graph;
  if (!incomingGraph || typeof incomingGraph !== "object") {
    return res.status(400).json({ error: "graph required" });
  }
  if (!Array.isArray(incomingGraph.nodes) || !Array.isArray(incomingGraph.edges)) {
    return res.status(400).json({ error: "graph.nodes and graph.edges must be arrays" });
  }

  const prevGraph: CDG = {
    id: String(conv.graph?.id || id),
    version: Number(conv.graph?.version || 0),
    nodes: Array.isArray(conv.graph?.nodes) ? conv.graph.nodes : [],
    edges: Array.isArray(conv.graph?.edges) ? conv.graph.edges : [],
  };

  const normalized = normalizeGraphSnapshot(incomingGraph, {
    id: prevGraph.id,
    version: prevGraph.version,
  });
  normalized.id = prevGraph.id;
  const model = buildCognitiveModel({
    graph: normalized,
    prevConcepts: conv.concepts || [],
    baseConcepts: Array.isArray(req.body?.concepts) ? req.body.concepts : conv.concepts || [],
    baseMotifs: Array.isArray(req.body?.motifs) ? req.body.motifs : (conv as any).motifs || [],
    baseMotifLinks: Array.isArray(req.body?.motifLinks) ? req.body.motifLinks : (conv as any).motifLinks || [],
    baseContexts: Array.isArray(req.body?.contexts) ? req.body.contexts : (conv as any).contexts || [],
  });
  model.graph.version = prevGraph.version + (graphChanged(prevGraph, model.graph) ? 1 : 0);

  const requestAdvice = parseBoolFlag(req.body?.requestAdvice);
  const advicePrompt = String(req.body?.advicePrompt || "").trim().slice(0, 1200);
  const travelPlanState = await computeTravelPlanState({
    conversationId: oid,
    userId,
    graph: model.graph,
    previous: (conv as any).travelPlanState || null,
  });

  const now = new Date();
  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        graph: model.graph,
        concepts: model.concepts,
        motifs: model.motifs,
        motifLinks: model.motifLinks,
        contexts: model.contexts,
        travelPlanState,
        updatedAt: now,
      },
    }
  );

  let assistantText = "";
  let adviceError = "";
  if (requestAdvice) {
    try {
      const recent = await collections.turns
        .find({ conversationId: oid, userId })
        .sort({ createdAt: -1 })
        .limit(12)
        .toArray();
      const recentTurns = recent
        .reverse()
        .flatMap((t) => [
          { role: "user" as const, content: t.userText },
          { role: "assistant" as const, content: t.assistantText },
        ]);

      const mergedPrompt =
        advicePrompt ||
        "用户已经手动修改了意图流程图。请把这个图视为最新有效意图，结合最近对话给出下一步可执行建议。先给具体行动方案，再给1-2个澄清问题。";

      assistantText = await generateAssistantTextNonStreaming({
        graph: model.graph,
        userText: mergedPrompt,
        recentTurns,
        systemPrompt: conv.systemPrompt,
      });
    } catch (e: any) {
      adviceError = String(e?.message || "advice_generation_failed");
    }
  }

  res.json({
    conversationId: id,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    motifLinks: model.motifLinks,
    contexts: model.contexts,
    travelPlanState,
    updatedAt: now,
    assistantText,
    adviceError,
  });
});

convRouter.put("/:id/concepts", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  if (!Array.isArray(req.body?.concepts)) {
    return res.status(400).json({ error: "concepts array required" });
  }

  const prevGraph: CDG = {
    id: String(conv.graph?.id || id),
    version: Number(conv.graph?.version || 0),
    nodes: Array.isArray(conv.graph?.nodes) ? conv.graph.nodes : [],
    edges: Array.isArray(conv.graph?.edges) ? conv.graph.edges : [],
  };
  const model = buildCognitiveModel({
    graph: prevGraph,
    prevConcepts: conv.concepts || [],
    baseConcepts: req.body?.concepts,
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
  });
  model.graph.version = prevGraph.version + (graphChanged(prevGraph, model.graph) ? 1 : 0);
  const travelPlanState = await computeTravelPlanState({
    conversationId: oid,
    userId,
    graph: model.graph,
    previous: (conv as any).travelPlanState || null,
  });

  const now = new Date();
  await collections.conversations.updateOne(
    { _id: oid, userId },
    {
      $set: {
        graph: model.graph,
        concepts: model.concepts,
        motifs: model.motifs,
        motifLinks: model.motifLinks,
        contexts: model.contexts,
        travelPlanState,
        updatedAt: now,
      },
    }
  );

  res.json({
    conversationId: id,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    motifLinks: model.motifLinks,
    contexts: model.contexts,
    travelPlanState,
    updatedAt: now,
  });
});

// 前端加载历史 turns（默认 30 条）
convRouter.get("/:id/turns", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const limit = Math.min(Math.max(Number(req.query?.limit || 30), 1), 200);

  const turns = await collections.turns
    .find({ conversationId: oid, userId })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  res.json(
    turns.map((t) => ({
      id: String(t._id),
      createdAt: t.createdAt,
      userText: t.userText,
      assistantText: t.assistantText,
      graphVersion: t.graphVersion,
    }))
  );
});

// 导出当前旅行计划 PDF（含中文自然语言与按天行程）
convRouter.get("/:id/travel-plan/export.pdf", async (req: AuthedRequest, res) => {
  try {
    const userId = req.userId!;
    const id = req.params.id;

    const oid = parseObjectId(id);
    if (!oid) return res.status(400).json({ error: "invalid conversation id" });

    const conv = await collections.conversations.findOne({ _id: oid, userId });
    if (!conv) return res.status(404).json({ error: "conversation not found" });

    const turns = await loadRecentTurnsForPlan({ conversationId: oid, userId, limit: 240 });
    if (!turns.length) {
      return res.status(400).json({ error: "no conversation turns yet, cannot export plan" });
    }

    const graph: CDG = {
      id: String(conv.graph?.id || id),
      version: Number(conv.graph?.version || 0),
      nodes: Array.isArray(conv.graph?.nodes) ? conv.graph.nodes : [],
      edges: Array.isArray(conv.graph?.edges) ? conv.graph.edges : [],
    };
    const travelPlanState = buildTravelPlanState({
      graph,
      turns: turns.map((t) => ({
        createdAt: t.createdAt,
        userText: t.userText,
        assistantText: t.assistantText,
      })),
      previous: (conv as any).travelPlanState || null,
    });

    const now = new Date();
    await collections.conversations.updateOne(
      { _id: oid, userId },
      {
        $set: {
          travelPlanState,
          updatedAt: now,
        },
      }
    );

    const pdf = await renderTravelPlanPdf({
      plan: travelPlanState,
      conversationId: id,
    });
    const filename = defaultTravelPlanFileName(id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdf.length));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=\"travel-plan.pdf\"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    return res.status(200).send(pdf);
  } catch (err: any) {
    return res.status(500).json({
      error:
        err?.message ||
        "travel plan pdf export failed",
    });
  }
});

// ==========================
// Turn - Non-stream (CLI/debug)
// ==========================

convRouter.post("/:id/turn", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const userText = String(req.body?.userText || "").trim();
  if (!userText) return res.status(400).json({ error: "userText required" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const graph: CDG = conv.graph;

  // recent turns：取最近 10 轮（更像“有记忆”）
  const recent = await collections.turns
    .find({ conversationId: oid, userId })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

  const recentTurns = recent
    .reverse()
    .flatMap((t) => [
      { role: "user" as const, content: t.userText },
      { role: "assistant" as const, content: t.assistantText },
    ]);
  const stateContextUserTurns = await loadRecentUserTextsForState({
    conversationId: oid,
    userId,
    limit: 140,
  });

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
  });
  const conflictGate = toConflictGatePayload(preModel.motifs);
  if (conflictGate) {
    const now = new Date();
    const blockedPatch = { ops: [], notes: ["blocked:motif_conflict_gate"] };
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graphVersion: preModel.graph.version,
    } as any);

    const travelPlanState = await persistConversationModel({
      conversationId: oid,
      userId,
      model: preModel,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
    });

    return res.json({
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graph: preModel.graph,
      concepts: preModel.concepts,
      motifs: preModel.motifs,
      motifLinks: preModel.motifLinks,
      contexts: preModel.contexts,
      travelPlanState,
      conflictGate,
    });
  }

  // ✅ 把 conv.systemPrompt 传给 LLM
  const out = await generateTurn({
    graph,
    userText,
    recentTurns,
    stateContextUserTurns,
    systemPrompt: conv.systemPrompt,
  });

  const merged = applyPatchWithGuards(graph, out.graph_patch);
  const model = buildCognitiveModel({
    graph: merged.newGraph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
  });
  model.graph.version = merged.newGraph.version + (graphChanged(merged.newGraph, model.graph) ? 1 : 0);

  const now = new Date();
  await collections.turns.insertOne({
    conversationId: oid,
    userId,
    createdAt: now,
    userText,
    assistantText: out.assistant_text,
    graphPatch: merged.appliedPatch,
    graphVersion: model.graph.version,
  } as any);

  const travelPlanState = await persistConversationModel({
    conversationId: oid,
    userId,
    model,
    updatedAt: now,
    previousTravelPlan: (conv as any).travelPlanState || null,
  });

  res.json({
    assistantText: out.assistant_text,
    graphPatch: merged.appliedPatch,
    graph: model.graph,
    concepts: model.concepts,
    motifs: model.motifs,
    motifLinks: model.motifLinks,
    contexts: model.contexts,
    travelPlanState,
  });
});

// ==========================
// Turn - Stream (SSE for UX)
// ==========================

convRouter.post("/:id/turn/stream", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;

  const oid = parseObjectId(id);
  if (!oid) return res.status(400).json({ error: "invalid conversation id" });

  const userText = String(req.body?.userText || "").trim();
  if (!userText) return res.status(400).json({ error: "userText required" });

  const conv = await collections.conversations.findOne({ _id: oid, userId });
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const graph: CDG = conv.graph;

  // recent turns：取最近 10 轮
  const recent = await collections.turns
    .find({ conversationId: oid, userId })
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

  const recentTurns = recent
    .reverse()
    .flatMap((t) => [
      { role: "user" as const, content: t.userText },
      { role: "assistant" as const, content: t.assistantText },
    ]);
  const stateContextUserTurns = await loadRecentUserTextsForState({
    conversationId: oid,
    userId,
    limit: 140,
  });

  const preModel = buildCognitiveModel({
    graph,
    prevConcepts: conv.concepts || [],
    baseConcepts: conv.concepts || [],
    baseMotifs: (conv as any).motifs || [],
    baseMotifLinks: (conv as any).motifLinks || [],
    baseContexts: (conv as any).contexts || [],
  });
  const conflictGate = toConflictGatePayload(preModel.motifs);
  if (conflictGate) {
    const now = new Date();
    const blockedPatch = { ops: [], notes: ["blocked:motif_conflict_gate"] };

    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graphVersion: preModel.graph.version,
    } as any);

    const travelPlanState = await persistConversationModel({
      conversationId: oid,
      userId,
      model: preModel,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
    });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as any).flushHeaders?.();
    sseSend(res, "start", { conversationId: id, graphVersion: preModel.graph.version });
    sseSend(res, "token", { token: conflictGate.message });
    sseSend(res, "done", {
      assistantText: conflictGate.message,
      graphPatch: blockedPatch,
      graph: preModel.graph,
      concepts: preModel.concepts,
      motifs: preModel.motifs,
      motifLinks: preModel.motifLinks,
      contexts: preModel.contexts,
      travelPlanState,
      conflictGate,
    });
    return res.end();
  }

  // SSE headers
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as any).flushHeaders?.();

  // start
  sseSend(res, "start", { conversationId: id, graphVersion: graph.version });

  // heartbeat ping
  const pingTimer = setInterval(() => {
    sseSend(res, "ping", { t: Date.now() });
  }, 15000);

  // abort handling
  const ac = new AbortController();
  let closed = false;

  req.on("close", () => {
    closed = true;
    clearInterval(pingTimer);
    ac.abort();
  });

  let sentAnyToken = false;

  try {
    // ✅ 把 conv.systemPrompt 传给流式 LLM
    const out = await generateTurnStreaming({
      graph,
      userText,
      recentTurns,
      stateContextUserTurns,
      systemPrompt: conv.systemPrompt,
      signal: ac.signal,
      onToken: (token) => {
        if (closed) return;
        if (typeof token !== "string" || token.length === 0) return;
        sentAnyToken = true;

        // ✅ token 统一发 JSON：{ token: "..." }
        sseSend(res, "token", { token });
      },
    });

    if (closed) return;

    const merged = applyPatchWithGuards(graph, out.graph_patch);
    const model = buildCognitiveModel({
      graph: merged.newGraph,
      prevConcepts: conv.concepts || [],
      baseConcepts: conv.concepts || [],
      baseMotifs: (conv as any).motifs || [],
      baseMotifLinks: (conv as any).motifLinks || [],
      baseContexts: (conv as any).contexts || [],
    });
    model.graph.version = merged.newGraph.version + (graphChanged(merged.newGraph, model.graph) ? 1 : 0);

    const now = new Date();
    await collections.turns.insertOne({
      conversationId: oid,
      userId,
      createdAt: now,
      userText,
      assistantText: out.assistant_text,
      graphPatch: merged.appliedPatch,
      graphVersion: model.graph.version,
    } as any);

    const travelPlanState = await persistConversationModel({
      conversationId: oid,
      userId,
      model,
      updatedAt: now,
      previousTravelPlan: (conv as any).travelPlanState || null,
    });

    sseSend(res, "done", {
      assistantText: out.assistant_text,
      graphPatch: merged.appliedPatch,
      graph: model.graph,
      concepts: model.concepts,
      motifs: model.motifs,
      motifLinks: model.motifLinks,
      contexts: model.contexts,
      travelPlanState,
    });

    clearInterval(pingTimer);
    res.end();
  } catch (e: any) {
    // 降级：若尚未吐 token，则走非流式（保证可用）
    if (!sentAnyToken && !closed) {
      try {
        const out2 = await generateTurn({
          graph,
          userText,
          recentTurns,
          stateContextUserTurns,
          systemPrompt: conv.systemPrompt,
        });

        const merged2 = applyPatchWithGuards(graph, out2.graph_patch);
        const model2 = buildCognitiveModel({
          graph: merged2.newGraph,
          prevConcepts: conv.concepts || [],
          baseConcepts: conv.concepts || [],
          baseMotifs: (conv as any).motifs || [],
          baseMotifLinks: (conv as any).motifLinks || [],
          baseContexts: (conv as any).contexts || [],
        });
        model2.graph.version = merged2.newGraph.version + (graphChanged(merged2.newGraph, model2.graph) ? 1 : 0);

        const now = new Date();
        await collections.turns.insertOne({
          conversationId: oid,
          userId,
          createdAt: now,
          userText,
          assistantText: out2.assistant_text,
          graphPatch: merged2.appliedPatch,
          graphVersion: model2.graph.version,
        } as any);

        const travelPlanState = await persistConversationModel({
          conversationId: oid,
          userId,
          model: model2,
          updatedAt: now,
          previousTravelPlan: (conv as any).travelPlanState || null,
        });

        sseSend(res, "done", {
          assistantText: out2.assistant_text,
          graphPatch: merged2.appliedPatch,
          graph: model2.graph,
          concepts: model2.concepts,
          motifs: model2.motifs,
          motifLinks: model2.motifLinks,
          contexts: model2.contexts,
          travelPlanState,
        });

        clearInterval(pingTimer);
        res.end();
        return;
      } catch (e2: any) {
        e = e2;
      }
    }

    if (!closed) {
      sseSend(res, "error", { message: e?.message || "stream failed" });
      clearInterval(pingTimer);
      res.end();
    }
  }
});
