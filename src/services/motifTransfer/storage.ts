import { ObjectId } from "mongodb";
import { collections } from "../../db/mongo.js";
import { DEFAULT_LOCALE, type AppLocale } from "../../i18n/locale.js";
import type { ConceptMotif } from "../motif/conceptMotifs.js";
import { genericMotifPatternTitle } from "../motif/naming.js";
import type {
  MotifLibraryEntryPayload,
  MotifLibraryRevisionFieldDiff,
  MotifLibraryRevisionSummary,
  MotifLibraryVersionPayload,
} from "./types.js";

function clean(input: any, max = 240): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function uniq<T>(arr: T[], max = 40): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of arr || []) {
    const k = JSON.stringify(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMotifLocale(locale?: AppLocale): AppLocale {
  return locale || DEFAULT_LOCALE;
}

function motifPatternTitle(motif: ConceptMotif, locale?: AppLocale): string {
  return (
    clean((motif as any)?.pattern_type, 180) ||
    clean((motif as any)?.motif_type_title, 180) ||
    genericMotifPatternTitle({
      locale,
      relation: clean((motif as any)?.dependencyClass || motif.relation, 40),
    })
  );
}

function motifDisplayTitle(motif: ConceptMotif): string {
  return clean((motif as any)?.display_title, 180);
}

function motifReusableDescription(motif: ConceptMotif): string {
  return clean((motif as any)?.motif_type_reusable_description || motif.rationale || motif.description, 220);
}

function toPayload(doc: any): MotifLibraryEntryPayload {
  return {
    locale: normalizeMotifLocale(doc?.locale),
    motif_type_id: clean(doc?.motif_type_id, 180),
    motif_type_title: clean(doc?.motif_type_title, 180),
    dependency: clean(doc?.dependency, 40) || "enable",
    abstraction_levels: Array.isArray(doc?.abstraction_levels)
      ? doc.abstraction_levels.filter((x: string) => x === "L1" || x === "L2" || x === "L3")
      : ["L1", "L2"],
    status:
      clean(doc?.status, 24) === "uncertain" ||
      clean(doc?.status, 24) === "deprecated" ||
      clean(doc?.status, 24) === "cancelled"
        ? clean(doc?.status, 24)
        : "active",
    current_version_id: clean(doc?.current_version_id, 120),
    versions: Array.isArray(doc?.versions)
      ? doc.versions.map((v: any) => ({
          version_id: clean(v?.version_id, 120),
          version: Number(v?.version || 1),
          title: clean(v?.title, 180),
          dependency: clean(v?.dependency, 40) || "enable",
          reusable_description: clean(v?.reusable_description, 260),
          abstraction_levels: {
            L1: clean(v?.abstraction_levels?.L1, 180) || undefined,
            L2: clean(v?.abstraction_levels?.L2, 180) || undefined,
            L3: clean(v?.abstraction_levels?.L3, 180) || undefined,
          },
          status:
            clean(v?.status, 24) === "uncertain" ||
            clean(v?.status, 24) === "deprecated" ||
            clean(v?.status, 24) === "cancelled"
              ? clean(v?.status, 24)
              : "active",
          source_task_id: clean(v?.source_task_id, 80) || undefined,
          source_conversation_id: clean(v?.source_conversation_id, 80) || undefined,
          created_at: clean(v?.created_at, 40) || nowIso(),
          updated_at: clean(v?.updated_at, 40) || nowIso(),
        }))
      : [],
    source_task_ids: Array.isArray(doc?.source_task_ids)
      ? uniq(doc.source_task_ids.map((x: any) => clean(x, 80)).filter(Boolean), 24)
      : [],
    usage_stats: {
      adopted_count: Number(doc?.usage_stats?.adopted_count || 0),
      ignored_count: Number(doc?.usage_stats?.ignored_count || 0),
      feedback_negative_count: Number(doc?.usage_stats?.feedback_negative_count || 0),
      transfer_confidence: Math.max(0, Math.min(1, Number(doc?.usage_stats?.transfer_confidence || 0.7))),
      last_used_at: clean(doc?.usage_stats?.last_used_at, 40) || undefined,
    },
  };
}

export function abstractionFromMotif(motif: ConceptMotif, locale?: AppLocale): { L1?: string; L2?: string; L3?: string } {
  const l1 = motifDisplayTitle(motif);
  const l2 = motifPatternTitle(motif, locale);
  const l3 = motifReusableDescription(motif);
  return {
    L1: l1 || undefined,
    L2: l2 || undefined,
    L3: l3 || undefined,
  };
}

function buildVersionId(motifTypeId: string, version: number) {
  const safe = clean(motifTypeId, 90)
    .toLowerCase()
    .replace(/[^a-z0-9_\-:]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `mv_${safe || "motif"}_${version}`;
}

function buildRevisionFieldDiffs(params: {
  current?: MotifLibraryVersionPayload | null;
  next: MotifLibraryVersionPayload;
}): MotifLibraryRevisionFieldDiff[] {
  const current = params.current || null;
  const next = params.next;
  const pairs: Array<MotifLibraryRevisionFieldDiff> = [
    {
      field: "title",
      current_value: clean(current?.title, 180) || undefined,
      next_value: clean(next.title, 180) || undefined,
    },
    {
      field: "dependency",
      current_value: clean(current?.dependency, 40) || undefined,
      next_value: clean(next.dependency, 40) || undefined,
    },
    {
      field: "reusable_description",
      current_value: clean(current?.reusable_description, 260) || undefined,
      next_value: clean(next.reusable_description, 260) || undefined,
    },
    {
      field: "L1",
      current_value: clean(current?.abstraction_levels?.L1, 180) || undefined,
      next_value: clean(next.abstraction_levels?.L1, 180) || undefined,
    },
    {
      field: "L2",
      current_value: clean(current?.abstraction_levels?.L2, 180) || undefined,
      next_value: clean(next.abstraction_levels?.L2, 180) || undefined,
    },
    {
      field: "L3",
      current_value: clean(current?.abstraction_levels?.L3, 180) || undefined,
      next_value: clean(next.abstraction_levels?.L3, 180) || undefined,
    },
    {
      field: "status",
      current_value: clean(current?.status, 24) || undefined,
      next_value: clean(next.status, 24) || undefined,
    },
  ];
  return pairs.filter((item) => (item.current_value || "") !== (item.next_value || ""));
}

function currentVersionIndex(entry: any): number {
  const versions = Array.isArray(entry?.versions) ? entry.versions : [];
  const currentId = clean(entry?.current_version_id, 120);
  const byId = currentId ? versions.findIndex((x: any) => clean(x?.version_id, 120) === currentId) : -1;
  if (byId >= 0) return byId;
  return versions.length > 0 ? versions.length - 1 : -1;
}

export function applyRevisionChoiceToVersions(params: {
  existingEntry: {
    current_version_id?: string;
    versions?: MotifLibraryVersionPayload[];
  };
  nextVersion: MotifLibraryVersionPayload;
  choice: "overwrite" | "new_version";
}): {
  versions: MotifLibraryVersionPayload[];
  currentVersionId: string;
  summary: MotifLibraryRevisionSummary;
} {
  const versions = Array.isArray(params.existingEntry.versions) ? [...params.existingEntry.versions] : [];
  const currentIdx = currentVersionIndex(params.existingEntry);
  const currentVersion = currentIdx >= 0 ? versions[currentIdx] : null;
  const changedFields = buildRevisionFieldDiffs({ current: currentVersion, next: params.nextVersion });
  if (params.choice === "overwrite" && currentVersion) {
    const overwritten: MotifLibraryVersionPayload = {
      ...currentVersion,
      title: params.nextVersion.title,
      dependency: params.nextVersion.dependency,
      reusable_description: params.nextVersion.reusable_description,
      abstraction_levels: { ...params.nextVersion.abstraction_levels },
      status: params.nextVersion.status,
      source_task_id: params.nextVersion.source_task_id,
      source_conversation_id: params.nextVersion.source_conversation_id,
      updated_at: params.nextVersion.updated_at,
    };
    versions[currentIdx] = overwritten;
    return {
      versions: versions.slice(-60),
      currentVersionId: clean(overwritten.version_id, 120),
      summary: {
        choice: "overwrite",
        previous_version_id: clean(currentVersion.version_id, 120) || undefined,
        current_version_id: clean(overwritten.version_id, 120) || undefined,
        overwritten_version_id: clean(currentVersion.version_id, 120) || undefined,
        version_created: false,
        changed_fields: changedFields,
      },
    };
  }

  const appended = [...versions, params.nextVersion].slice(-60);
  return {
    versions: appended,
    currentVersionId: clean(params.nextVersion.version_id, 120),
    summary: {
      choice: "new_version",
      previous_version_id: clean(currentVersion?.version_id, 120) || undefined,
      current_version_id: clean(params.nextVersion.version_id, 120) || undefined,
      overwritten_version_id: undefined,
      version_created: true,
      changed_fields: changedFields,
    },
  };
}

export function motifVersionMeaningfullyChanged(params: {
  existing?: {
    title?: string;
    dependency?: string;
    reusable_description?: string;
    abstraction_levels?: {
      L1?: string;
      L2?: string;
      L3?: string;
    };
  } | null;
  next: {
    title?: string;
    dependency?: string;
    reusable_description?: string;
    abstraction_levels?: {
      L1?: string;
      L2?: string;
      L3?: string;
    };
  };
}) {
  const current = params.existing || null;
  const next = params.next;
  return (
    clean(current?.title, 180) !== clean(next?.title, 180) ||
    clean(current?.dependency, 40) !== clean(next?.dependency, 40) ||
    clean(current?.reusable_description, 260) !== clean(next?.reusable_description, 260) ||
    clean(current?.abstraction_levels?.L1, 180) !== clean(next?.abstraction_levels?.L1, 180) ||
    clean(current?.abstraction_levels?.L2, 180) !== clean(next?.abstraction_levels?.L2, 180) ||
    clean(current?.abstraction_levels?.L3, 180) !== clean(next?.abstraction_levels?.L3, 180)
  );
}

export async function listUserMotifLibrary(userId: ObjectId, locale: AppLocale): Promise<MotifLibraryEntryPayload[]> {
  const docs = await collections.motifLibrary
    .find({ userId, locale: normalizeMotifLocale(locale) })
    .sort({ updatedAt: -1 })
    .limit(200)
    .toArray();
  return docs.map((x) => toPayload(x));
}

export async function confirmMotifLibraryEntries(params: {
  userId: ObjectId;
  locale: AppLocale;
  conversationId: string;
  taskId: string;
  motifs: ConceptMotif[];
  selections: Array<{
    motif_id?: string;
    motif_type_id?: string;
    store?: boolean;
    abstraction_levels?: ("L1" | "L2" | "L3")[];
    abstraction_text?: { L1?: string; L2?: string; L3?: string };
  }>;
}) {
  const now = new Date();
  const nowText = now.toISOString();
  const locale = normalizeMotifLocale(params.locale);
  const motifById = new Map((params.motifs || []).map((m) => [clean(m.id, 140), m]));
  const stored: string[] = [];

  for (const sel of params.selections || []) {
    if (sel.store === false) continue;
    const motif =
      motifById.get(clean(sel.motif_id, 140)) ||
      (params.motifs || []).find((m) => clean((m as any)?.motif_type_id, 180) === clean(sel.motif_type_id, 180));
    if (!motif) continue;
    const motifTypeId = clean(sel.motif_type_id || (motif as any)?.motif_type_id, 180);
    if (!motifTypeId) continue;
    const chosenLevels = Array.isArray(sel.abstraction_levels) && sel.abstraction_levels.length
      ? sel.abstraction_levels.filter((x) => x === "L1" || x === "L2" || x === "L3")
      : (["L1", "L2"] as Array<"L1" | "L2" | "L3">);
    const autoLevels = abstractionFromMotif(motif, locale);
    const levels = {
      L1: clean(sel.abstraction_text?.L1, 180) || autoLevels.L1,
      L2: clean(sel.abstraction_text?.L2, 180) || autoLevels.L2,
      L3: clean(sel.abstraction_text?.L3, 180) || autoLevels.L3,
    };
    const existing = await collections.motifLibrary.findOne({
      userId: params.userId,
      locale,
      motif_type_id: motifTypeId,
    });
    const prevVersion = Array.isArray(existing?.versions) ? existing!.versions[existing!.versions.length - 1] : null;
    const nextVersionNo = Number(prevVersion?.version || 0) + 1;
    const canonicalTitle = motifPatternTitle(motif, locale);
    const version: MotifLibraryVersionPayload = {
      version_id: buildVersionId(motifTypeId, nextVersionNo),
      version: nextVersionNo,
      title: canonicalTitle,
      dependency: clean((motif as any)?.dependencyClass || motif.relation, 40) || "enable",
      reusable_description: motifReusableDescription(motif) || canonicalTitle,
      abstraction_levels: levels,
      status:
        clean(motif.status, 24) === "uncertain" ||
        clean(motif.status, 24) === "deprecated" ||
        clean(motif.status, 24) === "cancelled"
          ? (clean(motif.status, 24) as any)
          : "active",
      source_task_id: clean(params.taskId, 80),
      source_conversation_id: clean(params.conversationId, 80),
      created_at: nowText,
      updated_at: nowText,
    };
    const shouldAppendVersion = motifVersionMeaningfullyChanged({
      existing: prevVersion,
      next: version,
    });

    if (!existing) {
      await collections.motifLibrary.insertOne({
        userId: params.userId,
        locale,
        motif_type_id: motifTypeId,
        motif_type_title: canonicalTitle,
        dependency: clean((motif as any)?.dependencyClass || motif.relation, 40) || "enable",
        abstraction_levels: chosenLevels,
        status: version.status,
        current_version_id: version.version_id,
        versions: [version],
        source_task_ids: uniq([clean(params.taskId, 80)], 20),
        usage_stats: {
          adopted_count: 0,
          ignored_count: 0,
          feedback_negative_count: 0,
          transfer_confidence: Math.max(0.45, Math.min(0.95, Number((motif as any)?.confidence || 0.72))),
        },
        createdAt: now,
        updatedAt: now,
      } as any);
    } else {
      const mergedTaskIds = uniq(
        [...(Array.isArray(existing.source_task_ids) ? existing.source_task_ids : []), clean(params.taskId, 80)].filter(Boolean),
        20
      );
      const nextVersions = shouldAppendVersion ? [...(existing.versions || []), version].slice(-60) : existing.versions || [];
      await collections.motifLibrary.updateOne(
        { _id: existing._id, userId: params.userId, locale },
        {
          $set: {
            motif_type_title: canonicalTitle,
            dependency: clean((motif as any)?.dependencyClass || motif.relation, 40) || "enable",
            abstraction_levels: chosenLevels,
            status: version.status,
            current_version_id: shouldAppendVersion ? version.version_id : clean(existing.current_version_id, 120),
            versions: nextVersions,
            source_task_ids: mergedTaskIds,
            updatedAt: now,
          },
        }
      );
    }
    stored.push(motifTypeId);
  }
  return { stored_motif_type_ids: uniq(stored, 40) };
}

export async function reviseMotifLibraryEntry(params: {
  userId: ObjectId;
  locale: AppLocale;
  motifTypeId: string;
  choice: "overwrite" | "new_version";
  title?: string;
  dependency?: string;
  reusableDescription?: string;
  abstractionText?: { L1?: string; L2?: string; L3?: string };
  status?: "active" | "uncertain" | "deprecated" | "cancelled";
  sourceTaskId?: string;
  sourceConversationId?: string;
}): Promise<{ entry: MotifLibraryEntryPayload; summary: MotifLibraryRevisionSummary } | null> {
  const locale = normalizeMotifLocale(params.locale);
  const motifTypeId = clean(params.motifTypeId, 180);
  if (!motifTypeId) return null;
  const existing = await collections.motifLibrary.findOne({
    userId: params.userId,
    locale,
    motif_type_id: motifTypeId,
  });
  if (!existing) return null;

  const now = new Date();
  const nowText = now.toISOString();
  const prevVersion = Array.isArray(existing.versions) ? existing.versions[existing.versions.length - 1] : null;
  const versionNo = Number(prevVersion?.version || 0) + 1;
  const version: MotifLibraryVersionPayload = {
    version_id: buildVersionId(motifTypeId, versionNo),
    version: versionNo,
    title: clean(params.title, 180) || clean(prevVersion?.title, 180) || clean(existing.motif_type_title, 180),
    dependency: clean(params.dependency, 40) || clean(prevVersion?.dependency, 40) || clean(existing.dependency, 40) || "enable",
    reusable_description:
      clean(params.reusableDescription, 260) || clean(prevVersion?.reusable_description, 260),
    abstraction_levels: {
      L1: clean(params.abstractionText?.L1, 180) || clean(prevVersion?.abstraction_levels?.L1, 180) || undefined,
      L2: clean(params.abstractionText?.L2, 180) || clean(prevVersion?.abstraction_levels?.L2, 180) || undefined,
      L3: clean(params.abstractionText?.L3, 180) || clean(prevVersion?.abstraction_levels?.L3, 180) || undefined,
    },
    status: params.status || clean(prevVersion?.status, 24) || "active",
    source_task_id: clean(params.sourceTaskId, 80) || clean(prevVersion?.source_task_id, 80) || undefined,
    source_conversation_id:
      clean(params.sourceConversationId, 80) || clean(prevVersion?.source_conversation_id, 80) || undefined,
    created_at: nowText,
    updated_at: nowText,
  };
  const applied = applyRevisionChoiceToVersions({
    existingEntry: {
      current_version_id: clean(existing.current_version_id, 120),
      versions: Array.isArray(existing.versions) ? existing.versions : [],
    },
    nextVersion: version,
    choice: params.choice,
  });
  await collections.motifLibrary.updateOne(
    { _id: existing._id, userId: params.userId, locale },
    {
      $set: {
        motif_type_title: clean(params.title, 180) || clean(existing.motif_type_title, 180),
        dependency: clean(params.dependency, 40) || clean(existing.dependency, 40) || "enable",
        current_version_id: applied.currentVersionId,
        versions: applied.versions,
        status: params.status || clean(existing.status, 24) || "active",
        updatedAt: now,
      },
    }
  );
  const updated = await collections.motifLibrary.findOne({ _id: existing._id, userId: params.userId, locale });
  return updated ? { entry: toPayload(updated), summary: applied.summary } : null;
}

export async function recordTransferUsage(params: {
  userId: ObjectId;
  locale: AppLocale;
  motifTypeId: string;
  action: "adopt" | "ignore" | "feedback_negative";
  confidenceDelta?: number;
}) {
  const locale = normalizeMotifLocale(params.locale);
  const motifTypeId = clean(params.motifTypeId, 180);
  if (!motifTypeId) return;
  const existing = await collections.motifLibrary.findOne({
    userId: params.userId,
    locale,
    motif_type_id: motifTypeId,
  });
  if (!existing) return;
  const stats = existing.usage_stats || ({} as any);
  let confidence = Math.max(0, Math.min(1, Number(stats.transfer_confidence || 0.7)));
  confidence = Math.max(0, Math.min(1, confidence + Number(params.confidenceDelta || 0)));
  const patch: any = {
    "usage_stats.transfer_confidence": confidence,
    "usage_stats.last_used_at": nowIso(),
    updatedAt: new Date(),
  };
  if (params.action === "adopt") patch["usage_stats.adopted_count"] = Number(stats.adopted_count || 0) + 1;
  if (params.action === "ignore") patch["usage_stats.ignored_count"] = Number(stats.ignored_count || 0) + 1;
  if (params.action === "feedback_negative") {
    patch["usage_stats.feedback_negative_count"] = Number(stats.feedback_negative_count || 0) + 1;
  }
  await collections.motifLibrary.updateOne({ _id: existing._id, userId: params.userId, locale }, { $set: patch });
}
