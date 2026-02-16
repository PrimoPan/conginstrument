import {
  type IntentSignals,
  isLikelyDestinationCandidate,
  normalizeDestination,
} from "./intentSignals.js";
import { cleanStatement } from "./text.js";

const GEO_ENABLED = process.env.CI_GEO_VALIDATE !== "0";
const GEO_ENDPOINT = String(process.env.CI_GEO_ENDPOINT || "https://nominatim.openstreetmap.org").replace(
  /\/+$/,
  ""
);
const GEO_TIMEOUT_MS = Math.max(500, Number(process.env.CI_GEO_TIMEOUT_MS || 2600));
const GEO_MAX_LOOKUPS = Math.max(0, Math.min(24, Number(process.env.CI_GEO_MAX_LOOKUPS || 12)));
const GEO_CACHE_TTL_MS = Math.max(60_000, Number(process.env.CI_GEO_CACHE_TTL_MS || 12 * 60 * 60 * 1000));
const DEBUG = process.env.CI_DEBUG_LLM === "1";

function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][geo]", ...args);
}

type NominatimAddress = {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  suburb?: string;
  neighbourhood?: string;
  county?: string;
  state?: string;
  country?: string;
  [key: string]: string | undefined;
};

type NominatimItem = {
  display_name?: string;
  name?: string;
  class?: string;
  type?: string;
  importance?: number;
  address?: NominatimAddress;
};

type ResolvedPlace = {
  query: string;
  label: string;
  cityAnchor?: string;
  parentCity?: string;
  isCityLevel: boolean;
  isSubLocation: boolean;
  score: number;
};

const cache = new Map<string, { expiresAt: number; value: ResolvedPlace | null }>();

function normKey(input: string): string {
  return normalizeDestination(input).toLowerCase();
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

function hasCjk(input: string): boolean {
  return /[\u4e00-\u9fff]/.test(input);
}

function pickAddressCity(addr?: NominatimAddress): string {
  return cleanStatement(
    addr?.city || addr?.town || addr?.municipality || addr?.village || "",
    40
  );
}

function pickBestLabel(item: NominatimItem, query: string): string {
  const fromAddress = cleanStatement(
    item.address?.city ||
      item.address?.town ||
      item.address?.municipality ||
      item.address?.village ||
      item.address?.county ||
      item.address?.state ||
      item.address?.country ||
      "",
    40
  );
  const fromName = cleanStatement(item.name || "", 40);
  const fromDisplay = cleanStatement(String(item.display_name || "").split(",")[0] || "", 40);
  const fromQuery = cleanStatement(query, 40);
  return normalizeDestination(fromName || fromAddress || fromDisplay || fromQuery);
}

function typeScore(item: NominatimItem): number {
  const cls = String(item.class || "").toLowerCase();
  const typ = String(item.type || "").toLowerCase();
  if (["city", "town", "village", "municipality", "county", "state", "country"].includes(typ)) return 0.22;
  if (
    [
      "stadium",
      "museum",
      "attraction",
      "park",
      "hotel",
      "university",
      "airport",
      "station",
      "square",
      "theatre",
      "mall",
      "beach",
      "district",
      "suburb",
      "neighbourhood",
      "borough",
      "quarter",
    ].includes(typ)
  ) {
    return 0.14;
  }
  if (cls === "place") return 0.12;
  if (["amenity", "tourism", "leisure", "historic", "shop", "aeroway", "railway"].includes(cls)) return 0.1;
  return 0;
}

function overlapScore(query: string, label: string): number {
  const q = normKey(query);
  const l = normKey(label);
  if (!q || !l) return 0;
  if (q === l) return 0.18;
  if (q.includes(l) || l.includes(q)) return 0.1;
  return 0;
}

function classify(item: NominatimItem, query: string): ResolvedPlace | null {
  const typ = String(item.type || "").toLowerCase();
  const cls = String(item.class || "").toLowerCase();
  const label = pickBestLabel(item, query);
  if (!label) return null;

  const cityAnchorRaw = pickAddressCity(item.address);
  const cityAnchor = cityAnchorRaw ? normalizeDestination(cityAnchorRaw) : undefined;
  const isCityLevel =
    ["city", "town", "village", "municipality", "county", "state", "country"].includes(typ) ||
    (cls === "place" &&
      ["city", "town", "village", "municipality", "county", "state", "country"].includes(typ));

  const isSubType = [
    "stadium",
    "museum",
    "attraction",
    "park",
    "hotel",
    "university",
    "airport",
    "station",
    "square",
    "theatre",
    "mall",
    "beach",
    "district",
    "suburb",
    "neighbourhood",
    "borough",
    "quarter",
  ].includes(typ);
  const isSubClass = ["amenity", "tourism", "leisure", "historic", "shop", "aeroway", "railway"].includes(cls);
  const isSubLocation = !isCityLevel && (isSubType || isSubClass || !!cityAnchor);

  const parentCity = isSubLocation ? cityAnchor : undefined;
  const importance = Number(item.importance) || 0;
  const score = typeScore(item) + overlapScore(query, label) + Math.min(0.45, importance * 0.45);

  return {
    query,
    label,
    cityAnchor: cityAnchor && isLikelyDestinationCandidate(cityAnchor) ? cityAnchor : undefined,
    parentCity: parentCity && isLikelyDestinationCandidate(parentCity) ? parentCity : undefined,
    isCityLevel,
    isSubLocation,
    score,
  };
}

async function resolvePlace(query: string): Promise<ResolvedPlace | null> {
  const q = normalizeDestination(query);
  if (!q) return null;
  const key = normKey(q);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const params = new URLSearchParams({
    q,
    format: "jsonv2",
    addressdetails: "1",
    limit: "5",
    "accept-language": "zh-CN,en",
  });
  const url = `${GEO_ENDPOINT}/search?${params.toString()}`;

  const timeout = withTimeout(GEO_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "CogInstrument/1.0 (intent-graph research)",
      },
      signal: timeout.signal,
    });
    if (!resp.ok) {
      cache.set(key, { expiresAt: now + 45_000, value: null });
      return null;
    }
    const data = (await resp.json().catch(() => [])) as NominatimItem[];
    const candidates = (Array.isArray(data) ? data : [])
      .map((x) => classify(x, q))
      .filter((x): x is ResolvedPlace => !!x)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0] || null;
    cache.set(key, { expiresAt: now + GEO_CACHE_TTL_MS, value: best });
    if (best) dlog("resolved", q, "->", best.label, "parent=", best.parentCity, "cityLevel=", best.isCityLevel);
    return best;
  } catch {
    cache.set(key, { expiresAt: now + 45_000, value: null });
    return null;
  } finally {
    timeout.clear();
  }
}

function preferSurface(raw: string, resolved: string): string {
  const r = normalizeDestination(raw);
  const g = normalizeDestination(resolved);
  if (hasCjk(r)) return r;
  return g || r;
}

function mergeNumberMapByNormalized(
  input?: Record<string, number>,
  remap?: Map<string, string>
): Record<string, number> | undefined {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const norm = normalizeDestination(k);
    if (!norm) continue;
    const mapped = remap?.get(norm.toLowerCase()) || norm;
    out[mapped] = Math.max(Number(out[mapped]) || 0, Number(v) || 0);
  }
  return Object.keys(out).length ? out : undefined;
}

export async function resolveIntentSignalsGeo(params: {
  signals: IntentSignals;
  latestUserText?: string;
  recentTurns?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<IntentSignals> {
  const inSig = params.signals || {};
  if (!GEO_ENABLED) return inSig;

  const out: IntentSignals = { ...inSig };
  const queries = new Set<string>();
  const addQuery = (x?: string) => {
    const s = normalizeDestination(x || "");
    if (s && s.length >= 2) queries.add(s);
  };

  addQuery(out.destination);
  for (const d of out.destinations || []) addQuery(d);
  for (const seg of out.cityDurations || []) addQuery(seg.city);
  for (const sub of out.subLocations || []) {
    addQuery(sub.name);
    addQuery(sub.parentCity);
  }
  if (out.criticalPresentation?.city) addQuery(out.criticalPresentation.city);

  const resolvedByNorm = new Map<string, ResolvedPlace | null>();
  let lookupCount = 0;
  for (const q of queries) {
    if (lookupCount >= GEO_MAX_LOOKUPS) break;
    lookupCount += 1;
    const r = await resolvePlace(q);
    resolvedByNorm.set(normKey(q), r);
  }

  const cityRemap = new Map<string, string>();
  const resolvedOf = (raw?: string): ResolvedPlace | null => {
    const k = normKey(raw || "");
    if (!k) return null;
    return resolvedByNorm.get(k) || null;
  };

  const canonicalCity = (raw?: string): string => {
    const n = normalizeDestination(raw || "");
    if (!n) return "";
    const r = resolvedOf(n);
    if (r?.isSubLocation && r.parentCity) {
      cityRemap.set(n.toLowerCase(), r.parentCity);
      return preferSurface(raw || n, r.parentCity);
    }
    if (r?.cityAnchor && r.isCityLevel) {
      return preferSurface(raw || n, r.cityAnchor);
    }
    return n;
  };

  const normalizedDests: string[] = [];
  const pushDest = (raw?: string) => {
    const city = canonicalCity(raw);
    if (!city || !isLikelyDestinationCandidate(city)) return;
    if (!normalizedDests.some((x) => normKey(x) === normKey(city))) normalizedDests.push(city);
  };

  pushDest(out.destination);
  for (const d of out.destinations || []) pushDest(d);

  const nextSubs = (out.subLocations || [])
    .map((sub) => {
      const rawName = normalizeDestination(sub.name || "");
      if (!rawName) return null;
      const rs = resolvedOf(rawName);
      let parent = canonicalCity(sub.parentCity);
      if (!parent && rs?.parentCity) parent = canonicalCity(rs.parentCity);

      if (rs?.isCityLevel && !parent) {
        pushDest(rawName);
        return null;
      }

      if (parent) pushDest(parent);
      return {
        ...sub,
        name: cleanStatement(sub.name || rawName, 36),
        parentCity: parent || undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const subNameSet = new Set(
    nextSubs.map((x) => normalizeDestination(x.name || "").toLowerCase()).filter(Boolean)
  );
  const filteredDests = normalizedDests.filter((d) => !subNameSet.has(normKey(d)));

  const segMap = new Map<
    string,
    { city: string; days: number; evidence: string; kind: "travel" | "meeting" }
  >();
  for (const seg of out.cityDurations || []) {
    const city = canonicalCity(seg.city);
    const days = Number(seg.days) || 0;
    if (!city || !isLikelyDestinationCandidate(city) || days <= 0) continue;
    pushDest(city);
    const kind: "travel" | "meeting" = seg.kind === "meeting" ? "meeting" : "travel";
    const key = `${normKey(city)}|${kind}`;
    const prev = segMap.get(key);
    if (!prev) {
      segMap.set(key, {
        city,
        days,
        evidence: cleanStatement(seg.evidence || `${city}${days}天`, 48),
        kind,
      });
      continue;
    }
    if (days >= prev.days) {
      segMap.set(key, {
        city,
        days,
        evidence: cleanStatement(seg.evidence || prev.evidence, 48),
        kind,
      });
    }
  }

  out.subLocations = nextSubs.length ? nextSubs : undefined;
  out.destinations = filteredDests.length ? filteredDests.slice(0, 8) : undefined;
  out.destination = out.destinations?.[0];
  if (out.cityDurations?.length) {
    out.cityDurations = Array.from(segMap.values());
  }
  if (out.criticalPresentation?.city) {
    const c = canonicalCity(out.criticalPresentation.city);
    out.criticalPresentation = { ...out.criticalPresentation, city: c || undefined };
  }

  out.destinationImportanceByCity = mergeNumberMapByNormalized(
    out.destinationImportanceByCity,
    cityRemap
  );
  out.cityDurationImportanceByCity = mergeNumberMapByNormalized(
    out.cityDurationImportanceByCity,
    cityRemap
  );

  return out;
}

