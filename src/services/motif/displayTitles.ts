import { openai } from "../llmClient.js";
import { config } from "../../server/config.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";
import type { ConceptItem } from "../concepts.js";
import type { ConceptMotif } from "./conceptMotifs.js";

const DISPLAY_TITLE_TIMEOUT_MS = Math.max(4_000, Number(process.env.CI_MOTIF_TITLE_TIMEOUT_MS || 12_000));
const MOTIF_NAMING_TOOL = "rewrite_motif_titles";

type GeneratedMotifNaming = {
  display_title?: string;
  pattern_type?: string;
};

function cleanText(input: any, max = 160): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function uniq(arr: string[], max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr || []) {
    const value = cleanText(item, 160);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function resolveConceptByRef(id: string, conceptById: Map<string, ConceptItem>): ConceptItem | undefined {
  const raw = cleanText(id, 120);
  if (!raw) return undefined;
  const exact = conceptById.get(raw);
  if (exact) return exact;
  if (!raw.startsWith("c_semantic:")) {
    const semantic = conceptById.get(`c_semantic:${raw}`);
    if (semantic) return semantic;
  }
  const normalized = normalizeForMatch(raw);
  if (!normalized) return undefined;
  for (const concept of conceptById.values()) {
    const conceptId = normalizeForMatch(String(concept.id || ""));
    const semanticKey = normalizeForMatch(String(concept.semanticKey || ""));
    if (
      conceptId === normalized ||
      semanticKey === normalized ||
      conceptId.endsWith(normalized) ||
      normalized.endsWith(conceptId) ||
      semanticKey.endsWith(normalized) ||
      normalized.endsWith(semanticKey)
    ) {
      return concept;
    }
  }
  return undefined;
}

function localizedRelation(locale: AppLocale | undefined, relation?: string): string {
  if (relation === "constraint") return isEnglishLocale(locale) ? "constrains" : "限制";
  if (relation === "determine") return isEnglishLocale(locale) ? "directly determines" : "直接决定";
  if (relation === "conflicts_with") return isEnglishLocale(locale) ? "conflicts with" : "冲突";
  return isEnglishLocale(locale) ? "supports" : "推动";
}

function localizedConceptFamily(locale: AppLocale | undefined, family?: string): string {
  if (family === "goal") return isEnglishLocale(locale) ? "goal" : "目标";
  if (family === "destination") return isEnglishLocale(locale) ? "destination" : "目的地";
  if (family === "duration_total") return isEnglishLocale(locale) ? "trip duration" : "总时长";
  if (family === "duration_city") return isEnglishLocale(locale) ? "city stay" : "城市停留";
  if (family === "budget") return isEnglishLocale(locale) ? "budget" : "预算";
  if (family === "people") return isEnglishLocale(locale) ? "traveler profile" : "出行人群";
  if (family === "lodging") return isEnglishLocale(locale) ? "lodging" : "住宿";
  if (family === "activity_preference") return isEnglishLocale(locale) ? "activity choice" : "活动选择";
  if (family === "meeting_critical") return isEnglishLocale(locale) ? "fixed agenda" : "关键日程";
  if (family === "limiting_factor") return isEnglishLocale(locale) ? "limiting factor" : "限制因素";
  if (family === "scenic_preference") return isEnglishLocale(locale) ? "scenic preference" : "景点偏好";
  if (family === "generic_constraint") return isEnglishLocale(locale) ? "constraint" : "约束";
  if (family === "sub_location") return isEnglishLocale(locale) ? "sub-location" : "子地点";
  if (family === "conflict") return isEnglishLocale(locale) ? "conflict" : "冲突";
  return isEnglishLocale(locale) ? "concept" : "概念";
}

function preserveConceptQualifier(concept: ConceptItem | undefined): boolean {
  const key = cleanText(concept?.semanticKey, 120).toLowerCase();
  return (
    key === "slot:budget" ||
    key === "slot:budget_remaining" ||
    key === "slot:budget_spent" ||
    key === "slot:budget_pending"
  );
}

function conceptSurfaceTitle(raw: string, preserveQualifier: boolean): string {
  const title = cleanText(raw, 80);
  if (!title) return "";
  if (!preserveQualifier) return title.replace(/^[^:：]{1,12}[:：]\s*/, "").trim() || title;
  return title.replace(/\s*[:：]\s*/g, "").trim() || title;
}

function conceptTitleFromId(id: string, conceptById: Map<string, ConceptItem>): string {
  const concept = resolveConceptByRef(id, conceptById);
  const raw = cleanText(concept?.title, 80) || cleanText(id, 80);
  return conceptSurfaceTitle(raw, preserveConceptQualifier(concept));
}

function motifRefs(motif: ConceptMotif, conceptById: Map<string, ConceptItem>) {
  const conceptIds = uniq((motif.conceptIds || []).map((id) => cleanText(id, 100)).filter(Boolean), 8);
  const anchorCandidates = uniq(
    [
      cleanText(motif.anchorConceptId, 100),
      cleanText(motif.roles?.target, 100),
      cleanText(motif.conceptIds?.[motif.conceptIds.length - 1], 100),
    ].filter(Boolean),
    4
  );
  const anchorId =
    anchorCandidates.find((id) => !!resolveConceptByRef(id, conceptById)) ||
    anchorCandidates[0] ||
    "";
  const roleSourceIds = uniq(
    (motif.roles?.sources || [])
      .map((id) => cleanText(id, 100))
      .filter((id) => id && id !== anchorId),
    7
  );
  const conceptSourceIds = uniq(
    conceptIds
      .filter((id) => id && id !== anchorId),
    7
  );
  const sourceIds = (roleSourceIds.length ? roleSourceIds : conceptSourceIds).every((id) => !!resolveConceptByRef(id, conceptById))
    ? (roleSourceIds.length ? roleSourceIds : conceptSourceIds)
    : conceptSourceIds.length
    ? conceptSourceIds
    : roleSourceIds;
  return {
    sources: sourceIds.map((id) => conceptTitleFromId(id, conceptById)),
    target: anchorId ? conceptTitleFromId(anchorId, conceptById) : "",
  };
}

function motifPatternSchemaFamilies(params: {
  motif: ConceptMotif;
  conceptById: Map<string, ConceptItem>;
}): { drivers: string[]; target: string[] } {
  const schemaDrivers = uniq(
    (Array.isArray((params.motif as any)?.motif_type_role_schema?.drivers)
      ? (params.motif as any).motif_type_role_schema.drivers
      : []
    )
      .map((family: any) => cleanText(family, 60).toLowerCase())
      .filter(Boolean),
    6
  );
  const schemaTarget = uniq(
    (Array.isArray((params.motif as any)?.motif_type_role_schema?.target)
      ? (params.motif as any).motif_type_role_schema.target
      : []
    )
      .map((family: any) => cleanText(family, 60).toLowerCase())
      .filter(Boolean),
    3
  );
  if (schemaDrivers.length && schemaTarget.length) {
    return {
      drivers: schemaDrivers,
      target: schemaTarget,
    };
  }

  const sourceIds = uniq(
    (
      Array.isArray(params.motif.source_concept_ids) && params.motif.source_concept_ids.length
        ? params.motif.source_concept_ids
        : Array.isArray(params.motif.roles?.sources)
        ? params.motif.roles.sources
        : (params.motif.conceptIds || []).filter((id) => id !== params.motif.anchorConceptId)
    )
      .map((id) => cleanText(id, 100))
      .filter(Boolean),
    8
  );
  const targetId =
    cleanText(params.motif.target_concept_id, 100) ||
    cleanText(params.motif.anchorConceptId, 100) ||
    cleanText(params.motif.roles?.target, 100);

  const drivers = uniq(
    sourceIds
      .map((id) => cleanText(resolveConceptByRef(id, params.conceptById)?.family, 60).toLowerCase())
      .filter(Boolean),
    6
  );
  const target = uniq(
    [cleanText(resolveConceptByRef(targetId, params.conceptById)?.family, 60).toLowerCase()].filter(Boolean),
    3
  );
  return { drivers, target };
}

function normalizeForMatch(text: string): string {
  return cleanText(text, 120)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function generatedTitleMentionsEndpoints(params: {
  generatedTitle: string;
  motif: ConceptMotif;
  concepts: ConceptItem[];
}): boolean {
  const conceptById = new Map((params.concepts || []).map((concept) => [concept.id, concept]));
  const refs = motifRefs(params.motif, conceptById);
  const normalizedTitle = normalizeForMatch(params.generatedTitle);
  if (!normalizedTitle || !refs.sources.length || !refs.target) return false;
  const normalizedTarget = normalizeForMatch(refs.target);
  const normalizedSources = refs.sources.map((source) => normalizeForMatch(source)).filter((source) => source.length >= 2);
  if (!normalizedTarget || !normalizedSources.length) return false;
  return normalizedTitle.includes(normalizedTarget) && normalizedSources.some((source) => normalizedTitle.includes(source));
}

function generatedPatternTitleMentionsConcreteInstanceText(params: {
  generatedTitle: string;
  motif: ConceptMotif;
  concepts: ConceptItem[];
  locale?: AppLocale;
}): boolean {
  const normalizedTitle = normalizeForMatch(params.generatedTitle);
  if (!normalizedTitle) return false;
  const conceptById = new Map((params.concepts || []).map((concept) => [concept.id, concept]));

  const inspectConcept = (conceptId: string): boolean => {
    const concept = resolveConceptByRef(conceptId, conceptById);
    if (!concept) return false;
    const concreteSurface = normalizeForMatch(
      conceptSurfaceTitle(cleanText(concept.title, 80), preserveConceptQualifier(concept))
    );
    const genericSurface = normalizeForMatch(localizedConceptFamily(params.locale, cleanText(concept.family, 60).toLowerCase()));
    if (!concreteSurface || concreteSurface === genericSurface) return false;
    return normalizedTitle.includes(concreteSurface);
  };

  const sourceIds = uniq(
    (
      Array.isArray(params.motif.source_concept_ids) && params.motif.source_concept_ids.length
        ? params.motif.source_concept_ids
        : Array.isArray(params.motif.roles?.sources)
        ? params.motif.roles.sources
        : (params.motif.conceptIds || []).filter((id) => id !== params.motif.anchorConceptId)
    )
      .map((id) => cleanText(id, 100))
      .filter(Boolean),
    8
  );
  const targetId =
    cleanText(params.motif.target_concept_id, 100) ||
    cleanText(params.motif.anchorConceptId, 100) ||
    cleanText(params.motif.roles?.target, 100);
  return sourceIds.some(inspectConcept) || (!!targetId && inspectConcept(targetId));
}

export function fallbackMotifDisplayTitle(params: {
  motif: ConceptMotif;
  concepts: ConceptItem[];
  locale?: AppLocale;
}): string {
  const conceptById = new Map((params.concepts || []).map((concept) => [concept.id, concept]));
  const refs = motifRefs(params.motif, conceptById);
  const sourceText = refs.sources.join(isEnglishLocale(params.locale) ? " + " : "、");
  const targetText = refs.target;
  if (!sourceText || !targetText) {
    return cleanText(params.motif.display_title, 80) ||
      cleanText(params.motif.title, 80) ||
      cleanText((params.motif as any).motif_type_title, 80) ||
      cleanText(params.motif.id, 80) ||
      (isEnglishLocale(params.locale) ? "Untitled motif" : "未命名思路");
  }
  const relation = params.motif.dependencyClass || params.motif.relation;
  if (relation === "constraint") {
    return isEnglishLocale(params.locale) ? `${sourceText} constrains ${targetText}` : `${sourceText}会限制${targetText}`;
  }
  if (relation === "determine") {
    return isEnglishLocale(params.locale) ? `${sourceText} directly determines ${targetText}` : `${sourceText}会直接决定${targetText}`;
  }
  if (relation === "conflicts_with") {
    if (refs.sources.length === 1) {
      return isEnglishLocale(params.locale) ? `${sourceText} conflicts with ${targetText}` : `${sourceText}和${targetText}互相冲突`;
    }
    return isEnglishLocale(params.locale) ? `${sourceText} conflicts with ${targetText}` : `${sourceText}会和${targetText}产生冲突`;
  }
  return isEnglishLocale(params.locale) ? `${sourceText} leads to ${targetText}` : `${sourceText}会推动${targetText}`;
}

export function pickMotifDisplayTitle(params: {
  motif: ConceptMotif;
  concepts: ConceptItem[];
  locale?: AppLocale;
  generatedTitle?: string;
}): string {
  const fallbackTitle = fallbackMotifDisplayTitle({
    motif: params.motif,
    concepts: params.concepts,
    locale: params.locale,
  });
  const generatedTitle = cleanText(params.generatedTitle, 80);
  if (!generatedTitle) return fallbackTitle;
  if (generatedTitleMentionsEndpoints({
    generatedTitle,
    motif: params.motif,
    concepts: params.concepts,
  })) {
    return generatedTitle;
  }
  return fallbackTitle;
}

function motifDisplaySignature(motif: ConceptMotif | undefined, conceptById: Map<string, ConceptItem>): string {
  if (!motif) return "none";
  const refs = motifRefs(motif, conceptById);
  return [
    cleanText(motif.id, 120),
    cleanText(motif.relation, 40),
    cleanText(motif.dependencyClass, 40),
    cleanText(motif.causalOperator, 40),
    cleanText(motif.anchorConceptId, 120),
    cleanText((motif as any).motif_type_title, 160),
    cleanText((motif as any).context, 120),
    refs.sources.join("|"),
    refs.target,
  ].join("::");
}

function readTextContent(raw: any): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.type === "string" && item.type === "text" && typeof item?.text?.value === "string") {
          return item.text.value;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function normalizeTitleKey(text: string): string {
  return cleanText(text, 120)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hasCodeLikePatternTitle(text: string): boolean {
  return /->|<-|::|\b(do\(|enable|constraint|determine|motif|pattern|causal|dependency|direct causation|mediated causation|confounding|intervention|contradiction)\b/i.test(
    text
  );
}

function fallbackMotifPatternTitle(params: {
  motif: ConceptMotif;
  concepts: ConceptItem[];
  locale?: AppLocale;
}): string {
  const conceptById = new Map((params.concepts || []).map((concept) => [concept.id, concept]));
  const schema = motifPatternSchemaFamilies({
    motif: params.motif,
    conceptById,
  });
  const driverText = schema.drivers
    .map((family) => localizedConceptFamily(params.locale, family))
    .join(isEnglishLocale(params.locale) ? " + " : "与");
  const targetText = schema.target
    .map((family) => localizedConceptFamily(params.locale, family))
    .join(isEnglishLocale(params.locale) ? " + " : "与");
  const relation = cleanText(params.motif.dependencyClass || params.motif.relation, 40);
  if (driverText && targetText) {
    if (relation === "constraint") {
      return isEnglishLocale(params.locale)
        ? `${driverText} filters ${targetText} first`
        : `${driverText}先过滤${targetText}`;
    }
    if (relation === "determine") {
      return isEnglishLocale(params.locale)
        ? `${driverText} locks ${targetText}`
        : `${driverText}锁定${targetText}`;
    }
    if (relation === "conflicts_with") {
      return isEnglishLocale(params.locale)
        ? `${driverText} conflicts with ${targetText}`
        : `${driverText}与${targetText}冲突`;
    }
    return isEnglishLocale(params.locale)
      ? `${driverText} supports ${targetText}`
      : `${driverText}支撑${targetText}`;
  }
  const stored =
    cleanText((params.motif as any).motif_type_title, 80) ||
    cleanText((params.motif as any).pattern_type, 80) ||
    cleanText(params.motif.title, 80);
  if (
    stored &&
    !hasCodeLikePatternTitle(stored) &&
    !generatedPatternTitleMentionsConcreteInstanceText({
      generatedTitle: stored,
      motif: params.motif,
      concepts: params.concepts,
      locale: params.locale,
    })
  ) {
    return stored;
  }
  return isEnglishLocale(params.locale) ? "Reusable decision rule" : "可复用决策规则";
}

export function pickMotifPatternTitle(params: {
  motif: ConceptMotif;
  concepts: ConceptItem[];
  locale?: AppLocale;
  generatedTitle?: string;
}): string {
  const fallbackTitle = fallbackMotifPatternTitle({
    motif: params.motif,
    concepts: params.concepts,
    locale: params.locale,
  });
  const generatedTitle = cleanText(params.generatedTitle, 80);
  if (!generatedTitle) return fallbackTitle;
  if (hasCodeLikePatternTitle(generatedTitle)) return fallbackTitle;
  if (
    generatedPatternTitleMentionsConcreteInstanceText({
      generatedTitle,
      motif: params.motif,
      concepts: params.concepts,
      locale: params.locale,
    })
  ) {
    return fallbackTitle;
  }
  return generatedTitle;
}

function disambiguateDuplicateDisplayTitles(params: {
  motifs: ConceptMotif[];
  concepts: ConceptItem[];
  locale?: AppLocale;
}): ConceptMotif[] {
  const indexesByTitle = new Map<string, number[]>();
  for (let i = 0; i < (params.motifs || []).length; i += 1) {
    const titleKey = normalizeTitleKey(String(params.motifs[i]?.display_title || params.motifs[i]?.title || ""));
    if (!titleKey) continue;
    if (!indexesByTitle.has(titleKey)) indexesByTitle.set(titleKey, []);
    indexesByTitle.get(titleKey)!.push(i);
  }

  return (params.motifs || []).map((motif, index) => {
    const titleKey = normalizeTitleKey(String(motif?.display_title || motif?.title || ""));
    const collisions = titleKey ? indexesByTitle.get(titleKey) || [] : [];
    if (collisions.length < 2) return motif;
    const fallback = fallbackMotifDisplayTitle({
      motif: {
        ...motif,
        display_title: undefined,
      },
      concepts: params.concepts,
      locale: params.locale,
    });
    if (normalizeTitleKey(fallback) && normalizeTitleKey(fallback) !== titleKey) {
      return {
        ...motif,
        display_title: fallback,
      };
    }
    const rawTitle = cleanText(motif.title, 80);
    if (normalizeTitleKey(rawTitle) && normalizeTitleKey(rawTitle) !== titleKey) {
      return {
        ...motif,
        display_title: rawTitle,
      };
    }
    return {
      ...motif,
      display_title: collisions.length > 1 ? `${cleanText(motif.display_title || motif.title, 72)} #${collisions.indexOf(index) + 1}` : motif.display_title,
    };
  });
}

function extractJson(raw: string): any {
  const text = cleanText(raw, 10_000);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch?.[0]) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function createChatCompletionWithTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`motif_title_timeout:${timeoutMs}`)), timeoutMs);
  try {
    return await factory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function generateDisplayTitleBatch(params: {
  motifs: ConceptMotif[];
  concepts: ConceptItem[];
  locale?: AppLocale;
  model?: string;
}): Promise<Map<string, GeneratedMotifNaming>> {
  const conceptById = new Map((params.concepts || []).map((concept) => [concept.id, concept]));
  const payload = params.motifs.map((motif) => {
    const refs = motifRefs(motif, conceptById);
    return {
      id: motif.id,
      source_titles: refs.sources,
      target_title: refs.target,
      relation: cleanText(motif.dependencyClass || motif.relation, 40),
      relation_label: localizedRelation(params.locale, motif.dependencyClass || motif.relation),
      motif_type_title: cleanText((motif as any).motif_type_title, 160),
      context: cleanText((motif as any).context, 120),
      current_title: cleanText(motif.title, 160),
    };
  });
  if (!payload.length || !config.openaiKey) return new Map<string, GeneratedMotifNaming>();

  const system = isEnglishLocale(params.locale)
    ? 'You rewrite motif names for a consumer UI. Call the provided function only. "display_title" must be a concrete current-task title that keeps the source and target meaning. "pattern_type" must be a reusable readable pattern name, not theory jargon, not arrows, not code-like syntax, and not labels like enable/constraint/determine.'
    : '你负责把 motif 名称改写成面向普通用户的界面用语。只能调用提供的 function。"display_title" 必须是当前任务里的具体实例标题，保持 source 和 target 的原意。"pattern_type" 必须是可复用、可读的模式名，不能写理论术语、箭头、代码式结构，也不要写 enable/constraint/determine 这类标签。';
  const user = isEnglishLocale(params.locale)
    ? `Rewrite these motif names. Prefer short natural UI wording.\n${JSON.stringify(payload, null, 2)}`
    : `请改写下面这些 motif 名称，优先用简短自然的界面表达。\n${JSON.stringify(payload, null, 2)}`;

  try {
    const resp = await createChatCompletionWithTimeout(
      (signal) =>
        openai.chat.completions.create(
          {
            model: params.model || config.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            max_tokens: 360,
            temperature: 0.2,
            tools: [
              {
                type: "function",
                function: {
                  name: MOTIF_NAMING_TOOL,
                  description: isEnglishLocale(params.locale)
                    ? "Rewrite motif display titles and reusable pattern names for UI."
                    : "为 motif 生成实例标题与可复用模式名。",
                  parameters: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            id: { type: "string" },
                            display_title: { type: "string" },
                            pattern_type: { type: "string" },
                          },
                          required: ["id", "display_title", "pattern_type"],
                        },
                      },
                    },
                    required: ["items"],
                  },
                },
              },
            ],
            tool_choice: {
              type: "function",
              function: { name: MOTIF_NAMING_TOOL },
            },
          },
          { signal }
        ),
      DISPLAY_TITLE_TIMEOUT_MS
    );
    const msg = resp.choices?.[0]?.message as any;
    const toolCall = (msg?.tool_calls || []).find(
      (item: any) => item?.type === "function" && item?.function?.name === MOTIF_NAMING_TOOL
    );
    const parsed = extractJson(String(toolCall?.function?.arguments || "")) || extractJson(readTextContent(msg?.content));
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.titles)
      ? parsed.titles
      : [];
    const out = new Map<string, GeneratedMotifNaming>();
    for (const item of items) {
      const id = cleanText(item?.id, 120);
      const displayTitle = cleanText(item?.display_title || item?.title, 80);
      const patternType = cleanText(item?.pattern_type || item?.motif_type_title || item?.pattern_title, 80);
      if (!id || (!displayTitle && !patternType)) continue;
      out.set(id, {
        display_title: displayTitle || undefined,
        pattern_type: patternType || undefined,
      });
    }
    return out;
  } catch {
    return new Map<string, GeneratedMotifNaming>();
  }
}

export async function enrichMotifDisplayTitles(params: {
  motifs: ConceptMotif[];
  concepts: ConceptItem[];
  previousMotifs?: ConceptMotif[] | any[];
  previousConcepts?: ConceptItem[] | any[];
  locale?: AppLocale;
  model?: string;
}): Promise<ConceptMotif[]> {
  const currentConceptById = new Map((params.concepts || []).map((concept) => [concept.id, concept]));
  const previousConceptById = new Map(((params.previousConcepts as any[]) || []).map((concept) => [concept.id, concept]));
  const previousById = new Map(
    (((params.previousMotifs as any[]) || []) as ConceptMotif[]).map((motif) => [motif.id, motif])
  );

  const candidates: ConceptMotif[] = [];
  const next = (params.motifs || []).map((motif) => {
    const prev = previousById.get(motif.id);
    const prevTitle = cleanText(prev?.display_title, 80);
    const sameSignature =
      motifDisplaySignature(motif, currentConceptById) === motifDisplaySignature(prev, previousConceptById as any);
    const prevPatternType = cleanText((prev as any)?.pattern_type || (prev as any)?.motif_type_title, 80);
    if (prevTitle && sameSignature) {
      return {
        ...motif,
        display_title: prevTitle,
        pattern_type: prevPatternType || cleanText((motif as any)?.pattern_type, 80) || cleanText((motif as any)?.motif_type_title, 80) || undefined,
        motif_type_title: prevPatternType || cleanText((motif as any)?.motif_type_title, 80) || undefined,
      };
    }
    if (!cleanText(motif.display_title, 80) || !sameSignature || !prevTitle) {
      candidates.push(motif);
    }
    return {
      ...motif,
      display_title: cleanText(motif.display_title, 80) || prevTitle || undefined,
      pattern_type:
        cleanText((motif as any)?.pattern_type, 80) || prevPatternType || cleanText((motif as any)?.motif_type_title, 80) || undefined,
      motif_type_title: cleanText((motif as any)?.motif_type_title, 80) || prevPatternType || undefined,
    };
  });

  if (!candidates.length) {
    return disambiguateDuplicateDisplayTitles({
      motifs: next,
      concepts: params.concepts,
      locale: params.locale,
    });
  }

  const generatedTitles = await generateDisplayTitleBatch({
    motifs: candidates,
    concepts: params.concepts,
    locale: params.locale,
    model: params.model,
  });

  const titled = next.map((motif) => {
    const generated = generatedTitles.get(motif.id);
    const patternType = pickMotifPatternTitle({
      motif,
      concepts: params.concepts,
      locale: params.locale,
      generatedTitle:
        cleanText(generated?.pattern_type, 80) ||
        cleanText((motif as any).pattern_type, 80) ||
        cleanText((motif as any).motif_type_title, 80),
    });
    const displayTitle = pickMotifDisplayTitle({
      motif,
      concepts: params.concepts,
      locale: params.locale,
      generatedTitle: cleanText(generated?.display_title, 80) || cleanText(motif.display_title, 80),
    });
    return {
      ...motif,
      display_title: displayTitle,
      pattern_type: patternType,
      motif_type_title: patternType,
    };
  });
  return disambiguateDuplicateDisplayTitles({
    motifs: titled,
    concepts: params.concepts,
    locale: params.locale,
  });
}
