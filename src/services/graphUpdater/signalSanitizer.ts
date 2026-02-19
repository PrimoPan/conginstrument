import type { IntentSignals } from "./intentSignals.js";
import { isLikelyDestinationCandidate, normalizeDestination } from "./intentSignals.js";
import { cleanStatement } from "./text.js";

const COUNTRY_OR_REGION_RE =
  /(中国|美国|英国|法国|德国|意大利|西班牙|葡萄牙|荷兰|比利时|瑞士|奥地利|日本|韩国|新加坡|泰国|马来西亚|印度尼西亚|澳大利亚|加拿大|新西兰|阿联酋|欧洲|亚洲|非洲|北美|南美|中东)/i;

const SUB_LOCATION_HINT_RE =
  /(球场|体育场|会展中心|会议中心|大学|学院|博物馆|公园|海滩|车站|机场|码头|教堂|广场|大道|街区|酒店|剧院|stadium|arena|museum|park|beach|district|quarter|square|centre|center|ccib|fira)/i;

function slug(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[省市县区州郡]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 40);
}

function canonicalCity(raw: string): string {
  let s = normalizeDestination(raw || "");
  if (!s) return "";
  s = s.replace(/(前|后)\s*[0-9一二三四五六七八九十两]{0,2}\s*天?$/i, "").trim();
  s = s.replace(/^(在|于|去|到|前往|飞到|抵达)\s*/i, "").trim();
  s = s.replace(/^的+/, "").replace(/的+$/g, "");

  const sameRepeat = s.match(/^(.{2,16})的\1$/);
  if (sameRepeat?.[1]) s = normalizeDestination(sameRepeat[1]);

  const dePair = s.match(/^(.{1,18})的(.{2,24})$/);
  if (dePair?.[1] && dePair?.[2]) {
    const left = normalizeDestination(dePair[1]);
    const right = normalizeDestination(dePair[2]);
    const leftNorm = slug(left);
    const rightNorm = slug(right);
    if (right && isLikelyDestinationCandidate(right)) {
      if (
        !left ||
        leftNorm === rightNorm ||
        rightNorm.includes(leftNorm) ||
        COUNTRY_OR_REGION_RE.test(left)
      ) {
        s = right;
      }
    }
  }

  s = s.replace(/^的+/, "").replace(/的+$/g, "").trim();
  return normalizeDestination(s);
}

function looksLikeSubLocation(name: string): boolean {
  const s = normalizeDestination(name || "");
  if (!s) return false;
  return SUB_LOCATION_HINT_RE.test(s);
}

export function sanitizeIntentSignals(input: IntentSignals): IntentSignals {
  const out: IntentSignals = { ...input };

  if (out.genericConstraints?.length) {
    const map = new Map<string, NonNullable<IntentSignals["genericConstraints"]>[number]>();
    for (const c of out.genericConstraints) {
      const text = cleanStatement(c?.text || "", 120);
      if (!text) continue;
      const key = text.toLowerCase();
      const prev = map.get(key);
      const cur = {
        text,
        evidence: cleanStatement(c?.evidence || text, 80),
        kind: c?.kind || "other",
        hard: !!c?.hard,
        severity: c?.severity,
        importance: Math.max(Number(c?.importance) || 0, Number(prev?.importance) || 0) || undefined,
      } as NonNullable<IntentSignals["genericConstraints"]>[number];
      if (!prev) {
        map.set(key, cur);
        continue;
      }
      map.set(key, {
        ...prev,
        ...cur,
        hard: prev.hard || cur.hard,
        importance: Math.max(Number(prev.importance) || 0, Number(cur.importance) || 0) || undefined,
      });
    }
    out.genericConstraints = map.size ? Array.from(map.values()).slice(0, 6) : undefined;
  }

  const subParentByName = new Map<string, string>();
  if (out.subLocations?.length) {
    const dedup = new Map<string, NonNullable<IntentSignals["subLocations"]>[number]>();
    for (const sub of out.subLocations) {
      const name = cleanStatement(sub?.name || "", 40);
      if (!name) continue;
      const nameNorm = canonicalCity(name);
      const parent = canonicalCity(sub?.parentCity || "");
      const parentOk = parent && isLikelyDestinationCandidate(parent) ? parent : undefined;
      const key = `${slug(nameNorm || name)}|${slug(parentOk || "")}`;
      const prev = dedup.get(key);
      const merged = {
        name,
        parentCity: parentOk,
        evidence: cleanStatement(sub?.evidence || name, 60),
        kind: sub?.kind,
        hard: !!sub?.hard,
        importance: Math.max(Number(prev?.importance) || 0, Number(sub?.importance) || 0) || undefined,
      } as NonNullable<IntentSignals["subLocations"]>[number];
      dedup.set(key, merged);
      if (nameNorm && parentOk) subParentByName.set(slug(nameNorm), parentOk);
    }
    out.subLocations = dedup.size ? Array.from(dedup.values()).slice(0, 12) : undefined;
  }

  const destinationCandidates = [
    ...(out.destinations || []),
    ...(out.destination ? [out.destination] : []),
  ];
  const destMap = new Map<string, string>();
  for (const raw of destinationCandidates) {
    const city = canonicalCity(raw);
    if (!city || !isLikelyDestinationCandidate(city)) continue;
    const key = slug(city);
    if (!key) continue;

    if (subParentByName.has(key)) {
      const parent = subParentByName.get(key)!;
      destMap.set(slug(parent), parent);
      continue;
    }

    if (looksLikeSubLocation(city) && destinationCandidates.length > 1) {
      continue;
    }

    if (!destMap.has(key)) destMap.set(key, city);
  }

  if (destMap.size) {
    out.destinations = Array.from(destMap.values()).slice(0, 8);
    out.destination = out.destinations[0];
    if (!out.destinationEvidence) out.destinationEvidence = out.destination;
  } else {
    out.destinations = undefined;
    out.destination = undefined;
  }

  if (out.cityDurations?.length) {
    const byCity = new Map<string, NonNullable<IntentSignals["cityDurations"]>[number]>();
    for (const seg of out.cityDurations) {
      const rawCity = canonicalCity(seg?.city || "");
      if (!rawCity) continue;
      const mapped = subParentByName.get(slug(rawCity)) || rawCity;
      if (!mapped || !isLikelyDestinationCandidate(mapped)) continue;
      const days = Number(seg?.days) || 0;
      if (days <= 0 || days > 120) continue;
      const kind: "travel" | "meeting" = seg?.kind === "meeting" ? "meeting" : "travel";
      const key = slug(mapped);
      const prev = byCity.get(key);
      const next = {
        city: mapped,
        days,
        evidence: cleanStatement(seg?.evidence || `${mapped}${days}天`, 56),
        kind,
      } as NonNullable<IntentSignals["cityDurations"]>[number];
      if (!prev || next.days > prev.days || (next.days === prev.days && next.kind === "meeting")) {
        byCity.set(key, next);
      }
      if (!destMap.has(key)) destMap.set(key, mapped);
    }
    out.cityDurations = byCity.size ? Array.from(byCity.values()).slice(0, 8) : undefined;
    if (destMap.size) {
      out.destinations = Array.from(destMap.values()).slice(0, 8);
      out.destination = out.destinations[0];
    }
  }

  if (out.criticalPresentation) {
    const city = canonicalCity(out.criticalPresentation.city || "");
    if (city && isLikelyDestinationCandidate(city)) {
      const mapped = subParentByName.get(slug(city)) || city;
      out.criticalPresentation = { ...out.criticalPresentation, city: mapped };
      if (!destMap.has(slug(mapped))) {
        destMap.set(slug(mapped), mapped);
        out.destinations = Array.from(destMap.values()).slice(0, 8);
        out.destination = out.destinations[0];
      }
    }
  }

  if (out.cityDurations?.length) {
    const travelSegments = out.cityDurations.filter((x) => x.kind === "travel");
    const travelCityCount = new Set(travelSegments.map((x) => slug(x.city))).size;
    const travelSum = travelSegments.reduce((acc, x) => acc + (Number(x.days) || 0), 0);
    const hasMeetingOnly = travelSegments.length === 0 && out.cityDurations.some((x) => x.kind === "meeting");
    const hasDurationUpdateCue = !!out.hasDurationUpdateCue;
    if (!hasMeetingOnly && travelCityCount >= 2 && travelSum > 0) {
      if (!out.durationDays || (!hasDurationUpdateCue && out.durationDays < travelSum)) {
        out.durationDays = travelSum;
        out.durationEvidence = travelSegments.map((x) => `${x.city}${x.days}天`).join(" + ");
        out.durationStrength = Math.max(Number(out.durationStrength) || 0.55, 0.88);
      }
    }
  }

  if (out.destinations?.length) {
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const raw of out.destinations) {
      const city = canonicalCity(raw);
      const key = slug(city);
      if (!city || !key || seen.has(key) || !isLikelyDestinationCandidate(city)) continue;
      seen.add(key);
      uniq.push(city);
    }
    out.destinations = uniq.length ? uniq : undefined;
    out.destination = out.destinations?.[0];
  }

  return out;
}
