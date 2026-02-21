import axios from "axios";
import type { CDG } from "../../core/graph.js";
import { extractIntentSignalsWithRecency } from "../graphUpdater/intentSignals.js";

type FxCode = "CNY" | "EUR" | "USD" | "GBP" | "JPY" | "HKD" | "SGD" | "KRW";

type FxPair = {
  from: FxCode;
  to: FxCode;
};

const FX_CACHE = new Map<string, { at: number; rate: number; date?: string }>();
const FX_TTL_MS = 10 * 60 * 1000;

function cleanText(input: any): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function normalizeUtterance(input: any): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(raw: string): number | null {
  const s = String(raw || "").replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function pickPairFromText(text: string): FxPair | null {
  const s = cleanText(text).toLowerCase();
  const hasFxCue = /汇率|兑换|换汇|换算|折合|折算|equivalent|exchange|convert/i.test(s);
  const toEur = /欧元|\beur\b|€/.test(s);
  const toUsd = /美元|\busd\b|\$/.test(s);
  const toGbp = /英镑|\bgbp\b|£/.test(s);
  const toJpy = /日元|\bjpy\b|円|yen/.test(s);
  const toHkd = /港币|港元|\bhkd\b/.test(s);
  const toSgd = /新币|新加坡元|\bsgd\b/.test(s);
  const toKrw = /韩元|\bkrw\b/.test(s);

  let to: FxCode | null = null;
  if (toEur) to = "EUR";
  else if (toUsd) to = "USD";
  else if (toGbp) to = "GBP";
  else if (toJpy) to = "JPY";
  else if (toHkd) to = "HKD";
  else if (toSgd) to = "SGD";
  else if (toKrw) to = "KRW";

  if (!to) return null;
  if (!hasFxCue && !/(多少|大概|约|几|换成|折合|折算)/.test(s)) return null;

  const from: FxCode = /人民币|\bcny\b|\brmb\b|元/.test(s) ? "CNY" : "CNY";
  if (from === to) return null;
  return { from, to };
}

function pickAmountFromText(text: string): number | null {
  const t = String(text || "").replace(/,/g, "");
  if (!t) return null;
  const wan = t.match(/([0-9]+(?:\.[0-9]+)?)\s*万(?:元|人民币|cny|rmb)?/i);
  if (wan?.[1]) {
    const x = Number(wan[1]);
    if (Number.isFinite(x) && x > 0) return Math.round(x * 10000);
  }
  const n = t.match(/([0-9]{3,9})(?:\s*(?:元|人民币|cny|rmb))?/i);
  if (n?.[1]) return parseAmount(n[1]);
  return null;
}

function readBudgetFromGraph(graph: CDG): number | null {
  const node = (graph.nodes || []).find((n) => String((n as any).key || "") === "slot:budget");
  if (!node) return null;
  const m = String(node.statement || "").match(/^预算(?:上限)?[:：]\s*([0-9]{2,9})\s*元?$/);
  if (m?.[1]) return parseAmount(m[1]);
  return null;
}

function formatAmount(amount: number, ccy: FxCode): string {
  const digits = ccy === "JPY" || ccy === "KRW" ? 0 : amount >= 1000 ? 0 : 2;
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

function currencyLabel(ccy: FxCode): string {
  if (ccy === "CNY") return "人民币";
  if (ccy === "EUR") return "欧元";
  if (ccy === "USD") return "美元";
  if (ccy === "GBP") return "英镑";
  if (ccy === "JPY") return "日元";
  if (ccy === "HKD") return "港币";
  if (ccy === "SGD") return "新加坡元";
  if (ccy === "KRW") return "韩元";
  return ccy;
}

async function fetchFxRate(from: FxCode, to: FxCode): Promise<{ rate: number; date?: string } | null> {
  const key = `${from}->${to}`;
  const now = Date.now();
  const cached = FX_CACHE.get(key);
  if (cached && now - cached.at < FX_TTL_MS) {
    return { rate: cached.rate, date: cached.date };
  }

  try {
    const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
    const res = await axios.get(url, { timeout: 4500 });
    const json: any = res?.data || null;
    const rate = Number(json?.rates?.[to]);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    const date = cleanText(json?.date) || undefined;
    FX_CACHE.set(key, { at: now, rate, date });
    return { rate, date };
  } catch {
    return null;
  }
}

function safeTail(input: string, max = 8): string {
  const arr = cleanText(input).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  return arr.slice(-max).join("\n");
}

export async function buildFxRateAdvisory(params: {
  graph: CDG;
  userText: string;
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<string | null> {
  const pair = pickPairFromText(params.userText);
  if (!pair) return null;

  const recentTurns = params.recentTurns || [];
  const historyUserTurns = recentTurns
    .filter((x) => x.role === "user")
    .map((x) => String(x.content || ""));
  const tailTurn = recentTurns[recentTurns.length - 1];
  if (
    tailTurn?.role === "user" &&
    normalizeUtterance(tailTurn.content) &&
    normalizeUtterance(tailTurn.content) === normalizeUtterance(params.userText) &&
    historyUserTurns.length
  ) {
    historyUserTurns.pop();
  }

  const historyUserText = safeTail(historyUserTurns.join("\n"));
  const mergedSignals = extractIntentSignalsWithRecency(historyUserText, params.userText);

  const amount =
    mergedSignals.budgetCny ||
    pickAmountFromText(params.userText) ||
    readBudgetFromGraph(params.graph);
  if (!amount || !Number.isFinite(amount) || amount <= 0) return null;

  const rateResp = await fetchFxRate(pair.from, pair.to);
  if (!rateResp) return null;

  const converted = amount * rateResp.rate;
  const dateSuffix = rateResp.date ? `（${rateResp.date}）` : "";

  return `实时汇率参考${dateSuffix}：${formatAmount(amount, pair.from)}${currencyLabel(
    pair.from
  )} ≈ ${formatAmount(converted, pair.to)}${currencyLabel(pair.to)}（1${pair.from} ≈ ${rateResp.rate.toFixed(4)}${pair.to}）`;
}
