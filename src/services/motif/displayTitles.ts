import { openai } from "../llmClient.js";
import { config } from "../../server/config.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";
import type { ConceptItem } from "../concepts.js";
import type { ConceptMotif } from "./conceptMotifs.js";

const DISPLAY_TITLE_TIMEOUT_MS = Math.max(4_000, Number(process.env.CI_MOTIF_TITLE_TIMEOUT_MS || 12_000));

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

function conceptTitleFromId(id: string, conceptById: Map<string, ConceptItem>): string {
  const raw = cleanText(resolveConceptByRef(id, conceptById)?.title, 80) || cleanText(id, 80);
  return raw.replace(/^[^:：]{1,12}[:：]\s*/, "").trim() || raw;
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
}): Promise<Map<string, string>> {
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
  if (!payload.length || !config.openaiKey) return new Map<string, string>();

  const system = isEnglishLocale(params.locale)
    ? "You rewrite motif titles for a consumer UI. Return JSON only in the shape {\"items\":[{\"id\":\"...\",\"display_title\":\"...\"}]}. Titles must be natural, short, concrete, and easy to understand. Avoid arrows, code-like syntax, category labels, and theory jargon. Keep the original meaning."
    : "你负责把 motif 标题改写成面向普通用户的界面标题。只返回 JSON，格式必须是 {\"items\":[{\"id\":\"...\",\"display_title\":\"...\"}]}。标题要自然、简短、具体、好理解，不要出现箭头、代码式结构、类别名或理论术语，且不能改变原意。";
  const user = isEnglishLocale(params.locale)
    ? `Rewrite these motif titles. Prefer a single short sentence. Return JSON only with an "items" array.\n${JSON.stringify(payload, null, 2)}`
    : `请改写下面这些 motif 标题。优先用一句简短自然的话。只返回带 "items" 数组的 JSON。\n${JSON.stringify(payload, null, 2)}`;

  try {
    const resp = await createChatCompletionWithTimeout(
      (signal) =>
        openai.chat.completions.create(
          {
            model: config.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            max_tokens: 360,
            temperature: 0.2,
            response_format: { type: "json_object" },
          },
          { signal }
        ),
      DISPLAY_TITLE_TIMEOUT_MS
    );
    const raw = readTextContent(resp.choices?.[0]?.message?.content);
    const parsed = extractJson(raw);
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.titles)
      ? parsed.titles
      : [];
    const out = new Map<string, string>();
    for (const item of items) {
      const id = cleanText(item?.id, 120);
      const displayTitle = cleanText(item?.display_title || item?.title, 80);
      if (!id || !displayTitle) continue;
      out.set(id, displayTitle);
    }
    return out;
  } catch {
    return new Map<string, string>();
  }
}

export async function enrichMotifDisplayTitles(params: {
  motifs: ConceptMotif[];
  concepts: ConceptItem[];
  previousMotifs?: ConceptMotif[] | any[];
  previousConcepts?: ConceptItem[] | any[];
  locale?: AppLocale;
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
    if (prevTitle && sameSignature) {
      return {
        ...motif,
        display_title: prevTitle,
      };
    }
    if (!cleanText(motif.display_title, 80) || !sameSignature || !prevTitle) {
      candidates.push(motif);
    }
    return {
      ...motif,
      display_title: cleanText(motif.display_title, 80) || prevTitle || undefined,
    };
  });

  if (!candidates.length) return next;

  const generated = await generateDisplayTitleBatch({
    motifs: candidates,
    concepts: params.concepts,
    locale: params.locale,
  });

  return next.map((motif) => {
    const displayTitle = pickMotifDisplayTitle({
      motif,
      concepts: params.concepts,
      locale: params.locale,
      generatedTitle: cleanText(generated.get(motif.id), 80) || cleanText(motif.display_title, 80),
    });
    return {
      ...motif,
      display_title: displayTitle,
    };
  });
}
