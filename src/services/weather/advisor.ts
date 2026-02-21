import type { CDG } from "../../core/graph.js";
import { extractIntentSignalsWithRecency, normalizeDestination } from "../graphUpdater/intentSignals.js";

const WEATHER_ENABLED = process.env.CI_WEATHER_EXTREME_ALERT !== "0";
const WEATHER_TIMEOUT_MS = Math.max(800, Number(process.env.CI_WEATHER_TIMEOUT_MS || 3200));
const WEATHER_MAX_DAYS = Math.max(1, Math.min(16, Number(process.env.CI_WEATHER_MAX_DAYS || 10)));
const WEATHER_GEO_ENDPOINT =
  String(process.env.CI_WEATHER_GEO_ENDPOINT || "https://geocoding-api.open-meteo.com/v1/search").replace(/\/+$/, "");
const WEATHER_FORECAST_ENDPOINT =
  String(process.env.CI_WEATHER_FORECAST_ENDPOINT || "https://api.open-meteo.com/v1/forecast").replace(/\/+$/, "");
const DEBUG = process.env.CI_DEBUG_LLM === "1";

function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][weather]", ...args);
}

type DateSpan = {
  start: Date;
  end: Date;
  evidence: string;
  index: number;
};

type HazardHit = {
  date: string;
  label: string;
  detail?: string;
  severity: number;
};

type GeoResult = {
  latitude: number;
  longitude: number;
  label: string;
};

type DailyForecast = {
  time: string[];
  weathercode: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum: number[];
  wind_gusts_10m_max: number[];
};

const geoCache = new Map<string, { expiresAt: number; value: GeoResult | null }>();

function clean(s: any, max = 120): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromMonthDay(month: number, day: number, now = new Date()): Date | null {
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const year = now.getUTCFullYear();
  let d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;

  const tooOld = d.getTime() < now.getTime() - 45 * 24 * 60 * 60 * 1000;
  if (tooOld) {
    const next = new Date(Date.UTC(year + 1, month - 1, day));
    if (!Number.isNaN(next.getTime())) d = next;
  }
  return d;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseDateSpanCandidates(text: string): DateSpan[] {
  const out: DateSpan[] = [];
  const now = new Date();

  const push = (start: Date | null, end: Date | null, evidence: string, index: number) => {
    if (!start || !end) return;
    if (end.getTime() < start.getTime()) {
      const fixed = new Date(Date.UTC(start.getUTCFullYear() + 1, end.getUTCMonth(), end.getUTCDate()));
      end = fixed;
    }
    const days = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (!Number.isFinite(days) || days <= 0 || days > 62) return;
    out.push({ start, end, evidence: clean(evidence, 40), index: Number(index) || 0 });
  };

  const crossMonth = /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})月([0-9]{1,2})日?/g;
  for (const m of text.matchAll(crossMonth)) {
    const start = fromMonthDay(Number(m[1]), Number(m[2]), now);
    const end = fromMonthDay(Number(m[3]), Number(m[4]), now);
    push(start, end, m[0] || "", Number(m.index));
  }

  const sameMonth = /([0-9]{1,2})月([0-9]{1,2})日?\s*[-~到至]\s*([0-9]{1,2})日?/g;
  for (const m of text.matchAll(sameMonth)) {
    const month = Number(m[1]);
    const start = fromMonthDay(month, Number(m[2]), now);
    const end = fromMonthDay(month, Number(m[3]), now);
    push(start, end, m[0] || "", Number(m.index));
  }

  const shortRange = /([0-9]{1,2})[-/]([0-9]{1,2})\s*[-~到至]\s*([0-9]{1,2})[-/]([0-9]{1,2})/g;
  for (const m of text.matchAll(shortRange)) {
    const start = fromMonthDay(Number(m[1]), Number(m[2]), now);
    const end = fromMonthDay(Number(m[3]), Number(m[4]), now);
    push(start, end, m[0] || "", Number(m.index));
  }

  return out
    .sort((a, b) => a.index - b.index)
    .filter((x, i, arr) => i === arr.findIndex((y) => y.index === x.index && toYmd(y.start) === toYmd(x.start) && toYmd(y.end) === toYmd(x.end)));
}

function parseSingleDates(text: string): Array<{ date: Date; index: number; evidence: string }> {
  const out: Array<{ date: Date; index: number; evidence: string }> = [];
  const now = new Date();

  const full = /([0-9]{1,2})月([0-9]{1,2})日/g;
  for (const m of text.matchAll(full)) {
    const d = fromMonthDay(Number(m[1]), Number(m[2]), now);
    if (!d) continue;
    out.push({ date: d, index: Number(m.index) || 0, evidence: clean(m[0] || "", 20) });
  }

  const short = /(^|[^\d])([0-9]{1,2})[-/]([0-9]{1,2})(?=[^\d]|$)/g;
  for (const m of text.matchAll(short)) {
    const d = fromMonthDay(Number(m[2]), Number(m[3]), now);
    if (!d) continue;
    out.push({ date: d, index: (Number(m.index) || 0) + String(m[1] || "").length, evidence: clean(`${m[2]}-${m[3]}`, 20) });
  }

  return out;
}

function parseDestinationsFromGraph(graph: CDG): string[] {
  const out: string[] = [];
  for (const n of graph.nodes || []) {
    const s = clean((n as any)?.statement || "", 100);
    const dm = s.match(/^目的地[:：]\s*(.+)$/);
    if (!dm?.[1]) continue;
    const city = normalizeDestination(dm[1]);
    if (!city) continue;
    if (!out.includes(city)) out.push(city);
  }
  return out;
}

function pickCityByContext(cities: string[], text: string, index: number): string | null {
  if (!cities.length) return null;
  const left = Math.max(0, index - 120);
  const right = Math.min(text.length, index + 120);
  const ctx = text.slice(left, right).toLowerCase();

  for (let i = cities.length - 1; i >= 0; i -= 1) {
    const c = String(cities[i] || "").toLowerCase();
    if (!c) continue;
    if (ctx.includes(c)) return cities[i];
  }
  return null;
}

function inferTravelWindow(params: {
  text: string;
  durationDays?: number;
}): DateSpan | null {
  const spans = parseDateSpanCandidates(params.text);
  if (spans.length) return spans[spans.length - 1];

  const singles = parseSingleDates(params.text).sort((a, b) => a.index - b.index);
  const latest = singles[singles.length - 1];
  const days = Number(params.durationDays) || 0;
  if (!latest || days <= 0 || days > 31) return null;

  return {
    start: latest.date,
    end: addDays(latest.date, days - 1),
    evidence: `${latest.evidence} + ${days}天`,
    index: latest.index,
  };
}

function inForecastHorizon(start: Date, end: Date): boolean {
  const now = new Date();
  const horizon = addDays(now, 16);
  if (end.getTime() < now.getTime() - 24 * 60 * 60 * 1000) return false;
  if (start.getTime() > horizon.getTime()) return false;
  return true;
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

async function fetchJson(url: string): Promise<any> {
  const timeout = withTimeout(WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "CogInstrument/1.0 weather-alert" },
      signal: timeout.signal,
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch {
    return null;
  } finally {
    timeout.clear();
  }
}

async function geocodeCity(city: string): Promise<GeoResult | null> {
  const key = normalizeDestination(city).toLowerCase();
  if (!key) return null;

  const now = Date.now();
  const cached = geoCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const qs = new URLSearchParams({
    name: city,
    count: "5",
    language: "zh",
    format: "json",
  });
  const url = `${WEATHER_GEO_ENDPOINT}?${qs.toString()}`;
  const data = await fetchJson(url);
  const results = Array.isArray(data?.results) ? data.results : [];
  const first = results.find((x: any) => Number.isFinite(Number(x?.latitude)) && Number.isFinite(Number(x?.longitude)));

  const resolved = first
    ? {
        latitude: Number(first.latitude),
        longitude: Number(first.longitude),
        label: clean(`${first.name || city}${first.country ? `, ${first.country}` : ""}`, 48),
      }
    : null;

  geoCache.set(key, { expiresAt: now + 12 * 60 * 60 * 1000, value: resolved });
  return resolved;
}

async function fetchDailyForecast(params: {
  latitude: number;
  longitude: number;
  startYmd: string;
  endYmd: string;
}): Promise<DailyForecast | null> {
  const qs = new URLSearchParams({
    latitude: String(params.latitude),
    longitude: String(params.longitude),
    timezone: "auto",
    start_date: params.startYmd,
    end_date: params.endYmd,
    daily: "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_gusts_10m_max",
  });

  const url = `${WEATHER_FORECAST_ENDPOINT}?${qs.toString()}`;
  const data = await fetchJson(url);
  const daily = data?.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) return null;

  return {
    time: daily.time,
    weathercode: Array.isArray(daily.weathercode) ? daily.weathercode.map((x: any) => Number(x) || 0) : [],
    temperature_2m_max: Array.isArray(daily.temperature_2m_max)
      ? daily.temperature_2m_max.map((x: any) => Number(x) || 0)
      : [],
    temperature_2m_min: Array.isArray(daily.temperature_2m_min)
      ? daily.temperature_2m_min.map((x: any) => Number(x) || 0)
      : [],
    precipitation_sum: Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum.map((x: any) => Number(x) || 0) : [],
    wind_gusts_10m_max: Array.isArray(daily.wind_gusts_10m_max)
      ? daily.wind_gusts_10m_max.map((x: any) => Number(x) || 0)
      : [],
  };
}

function formatCnDate(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

function detectHazards(daily: DailyForecast): HazardHit[] {
  const out: HazardHit[] = [];
  const severeWeatherCode = new Set([95, 96, 99, 75, 86]);

  for (let i = 0; i < daily.time.length; i += 1) {
    const date = daily.time[i];
    const code = Number(daily.weathercode[i]) || 0;
    const tmax = Number(daily.temperature_2m_max[i]);
    const tmin = Number(daily.temperature_2m_min[i]);
    const rain = Number(daily.precipitation_sum[i]);
    const gust = Number(daily.wind_gusts_10m_max[i]);

    if (severeWeatherCode.has(code)) {
      const isThunder = code === 95 || code === 96 || code === 99;
      out.push({
        date,
        label: isThunder ? "雷暴" : "强降雪",
        detail: isThunder ? undefined : undefined,
        severity: isThunder ? 4 : 3,
      });
    }

    if (Number.isFinite(rain) && rain >= 50) {
      out.push({ date, label: "强降雨", detail: `${Math.round(rain)}mm`, severity: 4 });
    } else if (Number.isFinite(rain) && rain >= 30) {
      out.push({ date, label: "中到大雨", detail: `${Math.round(rain)}mm`, severity: 3 });
    }

    if (Number.isFinite(gust) && gust >= 20) {
      out.push({ date, label: "大风", detail: `${Math.round(gust)}m/s`, severity: 4 });
    } else if (Number.isFinite(gust) && gust >= 15) {
      out.push({ date, label: "强风", detail: `${Math.round(gust)}m/s`, severity: 3 });
    }

    if (Number.isFinite(tmax) && tmax >= 37) {
      out.push({ date, label: "高温", detail: `${Math.round(tmax)}°C`, severity: 4 });
    } else if (Number.isFinite(tmax) && tmax >= 35) {
      out.push({ date, label: "高温", detail: `${Math.round(tmax)}°C`, severity: 3 });
    }

    if (Number.isFinite(tmin) && tmin <= -10) {
      out.push({ date, label: "严寒", detail: `${Math.round(tmin)}°C`, severity: 4 });
    } else if (Number.isFinite(tmin) && tmin <= -5) {
      out.push({ date, label: "低温", detail: `${Math.round(tmin)}°C`, severity: 3 });
    }
  }

  return out;
}

function mergeHazards(hits: HazardHit[]): { summary: string; details: string[]; maxSeverity: number } | null {
  if (!hits.length) return null;

  const byLabel = new Map<string, HazardHit[]>();
  let maxSeverity = 0;
  for (const h of hits) {
    if (!byLabel.has(h.label)) byLabel.set(h.label, []);
    byLabel.get(h.label)!.push(h);
    maxSeverity = Math.max(maxSeverity, h.severity);
  }

  const summary = Array.from(byLabel.keys()).slice(0, 3).join("、");
  const details: string[] = [];
  for (const [label, arr] of byLabel.entries()) {
    const top = arr.sort((a, b) => b.severity - a.severity)[0];
    const day = formatCnDate(top.date);
    const detail = top.detail ? `${label}（${day}，${top.detail}）` : `${label}（${day}）`;
    details.push(detail);
    if (details.length >= 3) break;
  }

  return { summary, details, maxSeverity };
}

function recentlyMentionedWeather(city: string, recentTurns: Array<{ role: "user" | "assistant"; content: string }>): boolean {
  const c = clean(city, 32);
  if (!c) return false;
  const recentAssistant = recentTurns.filter((x) => x.role === "assistant").slice(-3);
  return recentAssistant.some((x) => {
    const t = String(x.content || "");
    return t.includes(c) && /天气风险|极端天气|暴雨|雷暴|高温|低温|强风|强降雨/i.test(t);
  });
}

function pickWindowByForecastLimit(span: DateSpan): DateSpan {
  const now = new Date();
  const horizon = addDays(now, WEATHER_MAX_DAYS);
  const start = span.start.getTime() < now.getTime() ? now : span.start;
  const end = span.end.getTime() > horizon.getTime() ? horizon : span.end;
  return { ...span, start, end };
}

export async function buildExtremeWeatherAdvisory(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string | null> {
  if (!WEATHER_ENABLED) return null;

  const userHistory = (params.recentTurns || [])
    .filter((x) => x.role === "user")
    .map((x) => String(x.content || ""))
    .join("\n");
  const mergedUserText = [userHistory, params.userText].filter(Boolean).join("\n");

  const signals = extractIntentSignalsWithRecency(userHistory, params.userText);
  const graphCities = parseDestinationsFromGraph(params.graph);
  const signalCities = (signals.destinations || [])
    .map((x) => normalizeDestination(x))
    .filter(Boolean);
  const candidates = Array.from(new Set([...signalCities, ...graphCities])).slice(0, 6);
  if (!candidates.length) return null;

  const spanRaw = inferTravelWindow({ text: mergedUserText, durationDays: signals.durationDays });
  if (!spanRaw) return null;
  if (!inForecastHorizon(spanRaw.start, spanRaw.end)) return null;

  const span = pickWindowByForecastLimit(spanRaw);
  if (span.end.getTime() < span.start.getTime()) return null;

  const city = pickCityByContext(candidates, mergedUserText, span.index) || candidates[0];
  if (!city) return null;
  if (recentlyMentionedWeather(city, params.recentTurns || [])) return null;

  const geo = await geocodeCity(city);
  if (!geo) return null;

  const startYmd = toYmd(span.start);
  const endYmd = toYmd(span.end);
  const daily = await fetchDailyForecast({
    latitude: geo.latitude,
    longitude: geo.longitude,
    startYmd,
    endYmd,
  });
  if (!daily) return null;

  const hazards = detectHazards(daily);
  const merged = mergeHazards(hazards);
  if (!merged || merged.maxSeverity < 3) return null;

  const advisory =
    `天气风险提醒：根据公开天气预报，${city}在${formatCnDate(startYmd)}至${formatCnDate(endYmd)}可能出现${merged.summary}。` +
    `${merged.details.length ? `重点关注：${merged.details.join("；")}。` : ""}` +
    `建议预留室内备选行程，并为交通与关键活动安排缓冲。`;

  dlog("weather alert", { city, startYmd, endYmd, hazards: merged.details, source: geo.label });
  return advisory;
}
