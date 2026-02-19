import { cleanStatement } from "./text.js";
import { isLikelyDestinationCandidate, normalizeDestination } from "./intentSignals.js";

export type McpResolvedPlace = {
  query: string;
  label: string;
  cityAnchor?: string;
  parentCity?: string;
  isCityLevel: boolean;
  isSubLocation: boolean;
  score: number;
};

const MCP_GEO_URL = cleanStatement(process.env.CI_MCP_GEO_URL || "", 256);
const MCP_GEO_TIMEOUT_MS = Math.max(300, Number(process.env.CI_MCP_GEO_TIMEOUT_MS || 1800));
const MCP_GEO_TOKEN = cleanStatement(process.env.CI_MCP_GEO_TOKEN || "", 512);
const DEBUG = process.env.CI_DEBUG_LLM === "1";

function dlog(...args: any[]) {
  if (DEBUG) console.log("[LLM][mcp-geo]", ...args);
}

function hasCjk(input: string): boolean {
  return /[\u4e00-\u9fff]/.test(input);
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

function parsePayload(raw: any): any {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

function toBool(v: any, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v > 0;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return fallback;
}

function toNum(v: any, fallback = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function normalizeLabel(raw: any, query: string): string {
  const s = normalizeDestination(cleanStatement(String(raw || ""), 40));
  if (s) return s;
  return normalizeDestination(query);
}

function normalizeCity(raw: any): string | undefined {
  const s = normalizeDestination(cleanStatement(String(raw || ""), 40));
  if (!s || !isLikelyDestinationCandidate(s)) return undefined;
  return s;
}

function normalizeMcpResult(query: string, raw: any): McpResolvedPlace | null {
  const o = parsePayload(raw);
  if (!o || typeof o !== "object") return null;

  const label = normalizeLabel((o as any).label || (o as any).name, query);
  if (!label) return null;
  const parentCity = normalizeCity((o as any).parentCity || (o as any).parent_city);
  const cityAnchor = normalizeCity((o as any).cityAnchor || (o as any).city_anchor || parentCity);
  const isCityLevel = toBool((o as any).isCityLevel ?? (o as any).is_city_level, !parentCity);
  const isSubLocation = toBool((o as any).isSubLocation ?? (o as any).is_sub_location, !!parentCity);
  const scoreRaw = toNum((o as any).score, 0.65);
  const score = Math.max(0, Math.min(1.2, scoreRaw));

  return {
    query,
    label: hasCjk(query) ? normalizeDestination(query) || label : label,
    parentCity,
    cityAnchor,
    isCityLevel,
    isSubLocation,
    score,
  };
}

function extractResultPayload(respJson: any): any {
  if (!respJson || typeof respJson !== "object") return null;
  if ((respJson as any).result) return (respJson as any).result;
  if ((respJson as any).data) return (respJson as any).data;
  const content = Array.isArray((respJson as any).content) ? (respJson as any).content : null;
  if (content?.length) {
    for (const c of content) {
      if (c && typeof c === "object") {
        if (c.json) return c.json;
        if (c.text) {
          const parsed = parsePayload(c.text);
          if (parsed) return parsed;
        }
      }
    }
  }
  return respJson;
}

export function isMcpGeoEnabled(): boolean {
  return !!MCP_GEO_URL;
}

export async function resolvePlaceByMcp(query: string): Promise<McpResolvedPlace | null> {
  if (!MCP_GEO_URL) return null;
  const q = normalizeDestination(query || "");
  if (!q) return null;

  const timeout = withTimeout(MCP_GEO_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (MCP_GEO_TOKEN) headers.Authorization = `Bearer ${MCP_GEO_TOKEN}`;

    const resp = await fetch(MCP_GEO_URL, {
      method: "POST",
      headers,
      signal: timeout.signal,
      body: JSON.stringify({
        tool: "resolve_place",
        input: {
          query: q,
          locale: "zh-CN,en",
        },
      }),
    });
    if (!resp.ok) {
      dlog("non-200", resp.status, q);
      return null;
    }

    const json = await resp.json().catch(() => null);
    const payload = extractResultPayload(json);
    const normalized = normalizeMcpResult(q, payload);
    if (normalized) dlog("resolved", q, "->", normalized.label, "parent=", normalized.parentCity);
    return normalized;
  } catch (e: any) {
    dlog("resolve error", e?.message || e);
    return null;
  } finally {
    timeout.clear();
  }
}

