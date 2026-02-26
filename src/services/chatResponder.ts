// src/services/chatResponder.ts
import { openai } from "./llmClient.js";
import { config } from "../server/config.js";
import type { CDG } from "../core/graph.js";
import { stripMarkdownToText } from "./textSanitizer.js";
import {
  enforceTargetedQuestion,
  planUncertaintyQuestion,
} from "./uncertainty/questionPlanner.js";
import { reconcileConceptsWithGraph } from "./concepts.js";
import { reconcileMotifsWithGraph } from "./motif/conceptMotifs.js";
import { reconcileContextsWithGraph } from "./contexts.js";
import { isEnglishLocale, type AppLocale } from "../i18n/locale.js";

const STREAM_MODE = (process.env.CI_STREAM_MODE || "pseudo") as "upstream" | "pseudo";
const DEBUG = process.env.CI_DEBUG_LLM === "1";
function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][chat]", ...args);
}

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => resolve(), ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    }
  });
}

function normalizeRecentTurns(
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>,
  maxEach = 1400
) {
  return (recentTurns || [])
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, maxEach) }));
}

/** Compatible parsing for different gateway wrappers around message.content */
function readTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (!content) return "";

  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return String(p.text ?? p.content ?? p.value ?? "");
        return "";
      })
      .join("");
  }

  if (typeof content === "object") {
    return String((content as any).text ?? (content as any).content ?? "");
  }
  return "";
}

function buildChatSystemPrompt(locale: AppLocale | undefined, extraSystemPrompt?: string) {
  const zh = `
你是 CogInstrument 的对话助手。任务可能是旅行规划、写作、研究、编程、设计、学习、排错等任意类型。
目标：每一轮都把任务推进到“下一步可执行”。

硬规则：
1) 用简体中文回答。
2) 输出必须是纯文本，不要使用 Markdown/LaTeX/代码块。不要出现诸如“###”、“- **”、“\begin”。
3) 不要自我介绍。
4) 每轮必须先给具体可执行内容（建议/清单/步骤/示例），再最多问 1~2 个关键问题。
5) 用户给了具体主题/地点/对象时，不要把“方法论框架”当主体，流程只能做补充。
6) 用户不满或质疑时，先承认并立即给更具体内容，不要复读模板。

领域偏好（按场景启用）：
- 旅行：先给 2~4 句地点画像与核心玩法，再给 6~10 条可执行建议（景点/路线/美食/交通/节奏），最后问 1~2 个关键问题。
- 排错：先给 3~5 个最可能原因和对应检查动作，再问 1~2 个关键问题（版本/完整报错/最小复现）。
`.trim();

  const en = `
You are CogInstrument's task assistant. The task can be travel planning, writing, research, coding, design, learning, debugging, or other domains.
Goal: move the task to the next executable step on every turn.

Hard rules:
1) Respond in English.
2) Output plain text only. No Markdown/LaTeX/code blocks.
3) Do not introduce yourself.
4) In each turn, give concrete actionable content first (steps/checklist/examples), then ask at most 1-2 key clarifying questions.
5) If the user already gave concrete entities (places/objects/topics), do not make generic methodology the main body.
6) If the user is dissatisfied, acknowledge and immediately provide more concrete actions.

Domain preference (when relevant):
- Travel: start with a short location framing (2-4 sentences), then 6-10 actionable suggestions (route/POI/food/transport/pacing), then 1-2 key questions.
- Debugging: give 3-5 likely causes with concrete checks first, then 1-2 key questions (version/full error/minimal repro).
`.trim();

  const base = isEnglishLocale(locale) ? en : zh;
  if (!extraSystemPrompt) return base;
  return `${base}\n\n${t(
    locale,
    "补充设定（可参考，不能覆盖硬规则）：",
    "Additional instruction (reference only, cannot override hard rules):"
  )}\n${String(extraSystemPrompt).trim()}`.trim();
}

function graphSummaryForChat(graph: CDG): string {
  const nodes = (graph.nodes || []).slice(-60);
  const edges = (graph.edges || []).slice(-40);
  const concepts = reconcileConceptsWithGraph({ graph, baseConcepts: [] });
  const motifs = reconcileMotifsWithGraph({ graph, concepts, baseMotifs: [] })
    .slice(0, 5)
    .map((m) => `${m.templateKey}:${m.title}(c=${m.confidence.toFixed(2)})`);

  const pick = (type: string, k = 6) =>
    nodes
      .filter((n: any) => n?.type === type)
      .slice(-k)
      .map((n: any) => `- ${String(n.statement || "").slice(0, 80)}`);

  const goals = pick("goal", 6);
  const hardC = nodes
    .filter((n: any) => n?.type === "constraint" && n?.strength === "hard")
    .slice(-6)
    .map((n: any) => `- ${String(n.statement || "").slice(0, 80)}`);

  const prefs = pick("preference", 6);
  const facts = pick("fact", 6);
  const qs = nodes
    .filter((n: any) => n?.type === "question" && (n.status === "proposed" || !n.status))
    .slice(-2)
    .map((n: any) => `- ${String(n.statement || "").slice(0, 80)}`);

  const edgeBrief = edges
    .slice(-8)
    .map((e: any) => `- (${e.type}) ${e.from} -> ${e.to}`);

  return [
    `v${graph.version}`,
    "goals:",
    goals.length ? goals.join("\n") : "- none",
    "hard_constraints:",
    hardC.length ? hardC.join("\n") : "- none",
    "prefs:",
    prefs.length ? prefs.join("\n") : "- none",
    "facts:",
    facts.length ? facts.join("\n") : "- none",
    "questions:",
    qs.length ? qs.join("\n") : "- none",
    "edges:",
    edgeBrief.length ? edgeBrief.join("\n") : "- none",
    "motifs:",
    motifs.length ? motifs.map((x) => `- ${x}`).join("\n") : "- none",
  ].join("\n");
}

function normalizeForMatch(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .slice(0, 240);
}

function chooseQuestionWithPriority(params: {
  motifQuestion: string | null;
  uncertaintyQuestion: string | null;
  locale?: AppLocale;
}): string | null {
  const m = String(params.motifQuestion || "").trim();
  const u = String(params.uncertaintyQuestion || "").trim();
  if (!m && !u) return null;
  if (m && !u) return m;
  if (!m && u) return u;
  if (normalizeForMatch(m).includes(normalizeForMatch(u)) || normalizeForMatch(u).includes(normalizeForMatch(m))) {
    return m;
  }
  return isEnglishLocale(params.locale) ? `${m} Also, ${u}` : `${m}；另外，${u}`;
}

function motifPriorityQuestion(params: {
  graph: CDG;
  concepts: ReturnType<typeof reconcileConceptsWithGraph>;
  locale?: AppLocale;
}) {
  const motifs = reconcileMotifsWithGraph({
    graph: params.graph,
    concepts: params.concepts,
    baseMotifs: [],
  });
  const contexts = reconcileContextsWithGraph({
    graph: params.graph,
    concepts: params.concepts,
    motifs,
    baseContexts: [],
  });

  const deprecated = motifs
    .filter((m) => m.status === "deprecated")
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  if (deprecated.length) {
    const top = deprecated[0];
    const conflictWithId = String(top.statusReason || "").match(/relation_conflict_with:([a-z0-9_\-:]+)/i)?.[1] || "";
    const peer = conflictWithId ? motifs.find((m) => m.id === conflictWithId) : undefined;
    const pairHint =
      peer && peer.title
        ? t(
            params.locale,
            `冲突关系：A=「${top.title}」 vs B=「${peer.title}」`,
            `Conflicting relation: A="${top.title}" vs B="${peer.title}"`
          )
        : "";
    return {
      motifs,
      contexts,
      question: t(
        params.locale,
        `检测到冲突 motif。继续规划前需要先确认保留哪一侧关系。${pairHint}`.trim(),
        `A deprecated/conflicting motif is detected. Before we continue, choose which side to keep. ${pairHint}`.trim()
      ),
      rationale: `motif_conflict:${top.id}`,
    };
  }

  const conflictEdges = (params.graph.edges || [])
    .filter((e) => e.type === "conflicts_with")
    .slice()
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0) || a.id.localeCompare(b.id));
  if (conflictEdges.length) {
    const top = conflictEdges[0];
    const nodeById = new Map((params.graph.nodes || []).map((n) => [n.id, n]));
    const left = cleanText(nodeById.get(top.from)?.statement || "", 72);
    const right = cleanText(nodeById.get(top.to)?.statement || "", 72);
    const pairHint =
      left && right
        ? t(params.locale, `冲突信念：A=「${left}」 vs B=「${right}」`, `Conflicting beliefs: A="${left}" vs B="${right}"`)
        : "";
    return {
      motifs,
      contexts,
      question: t(
        params.locale,
        `检测到两条冲突信念。继续规划前请先确认保留哪一侧。${pairHint}`.trim(),
        `Two conflicting beliefs were detected. Before continuing, please confirm which side to keep. ${pairHint}`.trim()
      ),
      rationale: `concept_conflict:${top.id}`,
    };
  }

  const uncertain = motifs
    .filter((m) => m.status === "uncertain")
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  if (uncertain.length) {
    const top = uncertain[0];
    return {
      motifs,
      contexts,
      question: t(
        params.locale,
        `这条 motif 目前不确定：${top.title}。你希望继续启用，还是先停用它？`,
        `This motif is uncertain: ${top.title}. Do you want to keep it active or disable it for now?`
      ),
      rationale: `motif_uncertain:${top.id}`,
    };
  }

  return {
    motifs,
    contexts,
    question: null,
    rationale: "motif_stable",
  };
}

function contextSummaryForPrompt(contexts: ReturnType<typeof reconcileContextsWithGraph>): string {
  if (!contexts.length) return "contexts: none";
  return contexts
    .slice(0, 5)
    .map((ctx) => {
      const qs = (ctx.openQuestions || []).slice(0, 2).join(" | ") || "-";
      return `${ctx.key}[${ctx.status} c=${ctx.confidence.toFixed(2)}] q=${qs}`;
    })
    .join("\n");
}

async function pseudoStreamText(params: {
  text: string;
  onToken: (t: string) => void;
  signal?: AbortSignal;
  chunkChars?: number;
  delayMs?: number;
}) {
  const chunkChars = Math.max(params.chunkChars ?? 4, 1);
  const delayMs = Math.max(params.delayMs ?? 12, 0);
  const s = params.text || "";

  for (let i = 0; i < s.length; i += chunkChars) {
    if (params.signal?.aborted) throw new Error("aborted");
    const chunk = s.slice(i, i + chunkChars);
    params.onToken(chunk);
    if (delayMs > 0) await sleep(delayMs, params.signal);
  }
}

export async function generateAssistantTextNonStreaming(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  locale?: AppLocale;
}): Promise<string> {
  const safeRecent = normalizeRecentTurns(params.recentTurns);
  const gsum = graphSummaryForChat(params.graph);
  const concepts = reconcileConceptsWithGraph({ graph: params.graph, baseConcepts: [] });
  const motifCtx = motifPriorityQuestion({ graph: params.graph, concepts, locale: params.locale });
  const uncertaintyPlan = planUncertaintyQuestion({
    graph: params.graph,
    recentTurns: safeRecent,
    locale: params.locale,
  });
  const targetedQuestion = chooseQuestionWithPriority({
    motifQuestion: motifCtx.question,
    uncertaintyQuestion: uncertaintyPlan.question,
    locale: params.locale,
  });

  const systemOne =
    `${buildChatSystemPrompt(params.locale, params.systemPrompt)}\n\n` +
    `${t(params.locale, "当前意图图摘要（只供参考，不要复述）：", "Current intent graph summary (reference only, do not repeat verbatim):")}\n${gsum}` +
    `\n\n${t(params.locale, "Context 摘要（只供你内部使用，不要逐字复述）：", "Context summary (internal use only, do not quote verbatim):")}\n${contextSummaryForPrompt(motifCtx.contexts)}` +
    `\n\n${t(params.locale, "不确定性分析（内部信号，不要复述）：", "Uncertainty signal (internal, do not repeat verbatim):")} ${uncertaintyPlan.rationale}` +
    `\n\n${t(params.locale, "Motif 状态分析（内部信号，不要复述）：", "Motif state signal (internal, do not repeat verbatim):")} ${motifCtx.rationale}` +
    (targetedQuestion
      ? `\n${t(
          params.locale,
          "请在回答末尾加入一个定向澄清问题（避免泛问）：",
          "Append one targeted clarification question at the end (avoid generic questions):"
        )}${targetedQuestion}`
      : "");

  const resp = await openai.chat.completions.create({
    model: config.model,
    messages: [{ role: "system", content: systemOne }, ...safeRecent, { role: "user", content: params.userText }],
    max_tokens: 900,
    temperature: 0.6,
  });

  const msg = resp.choices?.[0]?.message;
  const raw = readTextContent(msg?.content);
  const text = enforceTargetedQuestion(stripMarkdownToText(raw), targetedQuestion);

  dlog("choices=", resp?.choices?.length, "finish=", resp?.choices?.[0]?.finish_reason, "len=", text.length);

  if (text) return text;

  const fallbackPrompt = isEnglishLocale(params.locale)
    ? `Give a concrete actionable response in plain text (no Markdown).\nUser input: ${params.userText}`
    : `请用简体中文给出具体可执行的回答，纯文本输出，不要Markdown。\n用户输入：${params.userText}`;

  const resp2 = await openai.chat.completions.create({
    model: config.model,
    messages: [{ role: "user", content: fallbackPrompt }],
    max_tokens: 700,
    temperature: 0.6,
  });

  const raw2 = readTextContent(resp2.choices?.[0]?.message?.content);
  const text2 = enforceTargetedQuestion(stripMarkdownToText(raw2), targetedQuestion);

  dlog("fallback finish=", resp2?.choices?.[0]?.finish_reason, "len=", text2.length);

  return (
    text2 ||
    t(
      params.locale,
      "我明白你的意思了。你把你现在的目标和限制说一句，我直接给你一个可执行版本。",
      "Got it. Share your current goal and constraints in one sentence, and I will give you an executable version."
    )
  );
}

export async function streamAssistantText(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  locale?: AppLocale;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  if (STREAM_MODE === "pseudo") {
    const full = await generateAssistantTextNonStreaming(params);
    await pseudoStreamText({ text: full, onToken: params.onToken, signal: params.signal });
    return full;
  }

  const safeRecent = normalizeRecentTurns(params.recentTurns);
  const gsum = graphSummaryForChat(params.graph);
  const concepts = reconcileConceptsWithGraph({ graph: params.graph, baseConcepts: [] });
  const motifCtx = motifPriorityQuestion({ graph: params.graph, concepts, locale: params.locale });
  const uncertaintyPlan = planUncertaintyQuestion({
    graph: params.graph,
    recentTurns: safeRecent,
    locale: params.locale,
  });
  const targetedQuestion = chooseQuestionWithPriority({
    motifQuestion: motifCtx.question,
    uncertaintyQuestion: uncertaintyPlan.question,
    locale: params.locale,
  });

  const systemOne =
    `${buildChatSystemPrompt(params.locale, params.systemPrompt)}\n\n` +
    `${t(params.locale, "当前意图图摘要（只供参考，不要复述）：", "Current intent graph summary (reference only, do not repeat verbatim):")}\n${gsum}` +
    `\n\n${t(params.locale, "Context 摘要（只供你内部使用，不要逐字复述）：", "Context summary (internal use only, do not quote verbatim):")}\n${contextSummaryForPrompt(motifCtx.contexts)}` +
    `\n\n${t(params.locale, "不确定性分析（内部信号，不要复述）：", "Uncertainty signal (internal, do not repeat verbatim):")} ${uncertaintyPlan.rationale}` +
    `\n\n${t(params.locale, "Motif 状态分析（内部信号，不要复述）：", "Motif state signal (internal, do not repeat verbatim):")} ${motifCtx.rationale}` +
    (targetedQuestion
      ? `\n${t(
          params.locale,
          "请在回答末尾加入一个定向澄清问题（避免泛问）：",
          "Append one targeted clarification question at the end (avoid generic questions):"
        )}${targetedQuestion}`
      : "");

  const upstream = await openai.chat.completions.create(
    {
      model: config.model,
      messages: [{ role: "system", content: systemOne }, ...safeRecent, { role: "user", content: params.userText }],
      stream: true,
      max_tokens: 900,
      temperature: 0.6,
    },
    params.signal ? { signal: params.signal } : undefined
  );

  let full = "";
  let gotAny = false;

  for await (const chunk of upstream as any) {
    const token = chunk?.choices?.[0]?.delta?.content;
    if (typeof token === "string" && token.length > 0) {
      gotAny = true;
      full += token;
      params.onToken(token);
    }
  }

  const stripped = stripMarkdownToText(full);
  const cleaned = enforceTargetedQuestion(stripped, targetedQuestion);
  if (gotAny && cleaned) {
    const missing = cleaned.startsWith(stripped) ? cleaned.slice(stripped.length) : "";
    if (missing) params.onToken(missing);
    return cleaned;
  }

  const fallback = await generateAssistantTextNonStreaming(params);
  await pseudoStreamText({ text: fallback, onToken: params.onToken, signal: params.signal });
  return fallback;
}
