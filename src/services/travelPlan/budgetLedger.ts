import { extractIntentSignals } from "../graphUpdater/intentSignals.js";

export type BudgetEventType =
  | "budget_set"
  | "budget_adjust"
  | "expense_commit"
  | "expense_refund"
  | "expense_pending";

export type BudgetEvent = {
  id: string;
  type: BudgetEventType;
  turnIndex: number;
  turnId?: string;
  createdAt?: string;
  evidence: string;
  amountCny?: number;
  amountOriginal?: number;
  currency?: string;
  fxRateToCny?: number;
  mode?: "absolute" | "delta";
  status?: "active" | "resolved";
  note?: string;
};

export type BudgetLedgerSummary = {
  totalCny?: number;
  spentCny: number;
  remainingCny?: number;
  pendingCny: number;
};

export type BudgetLedgerState = {
  events: BudgetEvent[];
  summary: BudgetLedgerSummary;
  latestTotalEvidence?: string;
  latestSpentEvidence?: string;
  latestPendingEvidence?: string;
};

export type BudgetTurnInput = {
  text: string;
  turnId?: string;
  createdAt?: string;
};

const FX_SNAPSHOT_RATE_TO_CNY: Record<string, number> = {
  CNY: 1,
  RMB: 1,
  EUR: 7.9,
  USD: 7.2,
  GBP: 9.1,
  HKD: 0.92,
  JPY: 0.05,
  KRW: 0.0054,
  SGD: 5.35,
};

function clean(input: any, max = 180): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function clampMoney(v: any): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function normalizeCurrency(raw: string): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "€" || s === "eur" || s === "欧元") return "EUR";
  if (s === "$" || s === "usd" || s === "美元") return "USD";
  if (s === "£" || s === "gbp" || s === "英镑") return "GBP";
  if (s === "hkd" || s === "港币" || s === "港元") return "HKD";
  if (s === "jpy" || s === "yen" || s === "円" || s === "日元") return "JPY";
  if (s === "krw" || s === "韩元") return "KRW";
  if (s === "sgd" || s === "新币" || s === "新加坡元") return "SGD";
  if (s === "人民币" || s === "元" || s === "块" || s === "cny" || s === "rmb") return "CNY";
  return "";
}

function parseAmountToken(raw: string): number | undefined {
  const s = clean(raw, 40).replace(/[，,\s]/g, "");
  if (!s) return undefined;
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(s)) return clampMoney(Number(s));

  const wan = s.match(/^([0-9]+(?:\.[0-9]+)?)万$/);
  if (wan?.[1]) return clampMoney(Number(wan[1]) * 10000);

  const thousand = s.match(/^([0-9]+(?:\.[0-9]+)?)千$/);
  if (thousand?.[1]) return clampMoney(Number(thousand[1]) * 1000);

  // "1万5" / "1.5万"
  const mixedWan = s.match(/^([0-9]+(?:\.[0-9]+)?)万([0-9]{1,4})$/);
  if (mixedWan?.[1]) {
    const head = Number(mixedWan[1]) * 10000;
    const tail = Number(mixedWan[2] || 0);
    return clampMoney(head + tail);
  }

  return undefined;
}

function toCny(amount: number, currencyRaw: string): { cny?: number; fxRate?: number; currency?: string } {
  const currency = normalizeCurrency(currencyRaw);
  if (!currency) return {};
  const rate = FX_SNAPSHOT_RATE_TO_CNY[currency];
  if (!Number.isFinite(rate) || rate <= 0) return {};
  return {
    cny: clampMoney(amount * rate),
    fxRate: rate,
    currency,
  };
}

function parseRefundFromText(text: string): { amountCny: number; evidence: string; amountOriginal?: number; currency?: string; fxRateToCny?: number } | null {
  const t = String(text || "").replace(/[，,]/g, "");
  if (!t) return null;

  const withCurrencyRe =
    /(?:退了?|退款|返还|返现|退回|取消(?:了)?并退|退票|退订)[^\n。；;，,]{0,18}?([0-9]+(?:\.[0-9]+)?)\s*(欧元|eur|€|美元|usd|\$|英镑|gbp|£|港币|港元|hkd|日元|jpy|yen|円|人民币|cny|rmb|元|块)/i;
  const m1 = t.match(withCurrencyRe);
  if (m1?.[1] && m1?.[2]) {
    const amount = Number(m1[1]);
    if (Number.isFinite(amount) && amount > 0) {
      const conv = toCny(amount, m1[2]);
      if (conv.cny && conv.cny > 0) {
        return {
          amountCny: conv.cny,
          evidence: clean(m1[0], 80),
          amountOriginal: amount,
          currency: conv.currency,
          fxRateToCny: conv.fxRate,
        };
      }
    }
  }

  const cnyRe =
    /(?:退了?|退款|返还|返现|退回|取消(?:了)?并退|退票|退订)[^\n。；;，,]{0,18}?([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(?:人民币|cny|rmb|元|块)/i;
  const m2 = t.match(cnyRe);
  if (m2?.[1]) {
    const amountCny = parseAmountToken(m2[1]);
    if (amountCny && amountCny > 0) {
      return {
        amountCny,
        evidence: clean(m2[0], 80),
      };
    }
  }

  return null;
}

function parsePendingFromText(text: string): { evidence: string; amountCny?: number; note?: string } | null {
  const t = clean(text, 220);
  if (!t) return null;

  const hasPendingCue = /(扣掉|扣除|计入|算上|帮我扣|帮我减|帮我算|预留|留出|先留|先预留|待定预算|稍后确定预算)/.test(t);
  const hasBudgetCue = /(预算|费用|开销|成本|花费|金额)/.test(t);
  if (!hasPendingCue || !hasBudgetCue) return null;

  const hasCommitCue = /(买了?|订了?|定了?|下单|付款|支付|已花|花了)/.test(t);
  const hasAnyAmount = /([0-9一二两三四五六七八九十百千万\.]{1,14}(?:万|千)?[0-9一二两三四五六七八九十百千]{0,6}|[0-9]{2,9})\s*(人民币|cny|rmb|元|块|欧元|eur|€|美元|usd|\$|英镑|gbp|£|港币|港元|hkd|日元|jpy|yen|円)/i.test(
    t
  );
  // 已明确成交且带金额，交由 expense_commit 处理，不进入 pending。
  if (hasCommitCue && hasAnyAmount) return null;

  const amountRaw = t.match(/([0-9]+(?:\.[0-9]+)?\s*(?:万|千)?|[0-9]{2,9})\s*(人民币|cny|rmb|元|块)/i);
  if (amountRaw?.[1]) {
    const amountCny = parseAmountToken(String(amountRaw[1]).replace(/\s+/g, ""));
    if (amountCny && amountCny > 0) {
      return { evidence: clean(t, 100), amountCny, note: "pending_amount_mentioned" };
    }
  }

  return { evidence: clean(t, 100), note: "pending_without_amount" };
}

function pushEvent(events: BudgetEvent[], next: BudgetEvent) {
  const prev = events[events.length - 1];
  if (
    prev &&
    prev.type === next.type &&
    (prev.amountCny || 0) === (next.amountCny || 0) &&
    clean(prev.evidence, 100) === clean(next.evidence, 100)
  ) {
    return;
  }
  events.push(next);
}

function makeEventId(turnIndex: number, seq: number, type: BudgetEventType) {
  return `b_${turnIndex}_${seq}_${type}`;
}

export function buildBudgetLedgerFromUserTurns(turns: BudgetTurnInput[]): BudgetLedgerState {
  const events: BudgetEvent[] = [];

  let seq = 1;
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const text = clean(turn.text || "", 2400);
    if (!text) continue;

    const s = extractIntentSignals(text, { historyMode: true });

    if (s.budgetCny != null && Number.isFinite(Number(s.budgetCny)) && Number(s.budgetCny) > 0) {
      pushEvent(events, {
        id: makeEventId(i + 1, seq++, "budget_set"),
        type: "budget_set",
        turnIndex: i + 1,
        turnId: turn.turnId,
        createdAt: turn.createdAt,
        amountCny: Math.round(Number(s.budgetCny)),
        evidence: clean(s.budgetEvidence || text, 90),
        mode: "absolute",
        status: "active",
      });
    }

    if (s.budgetDeltaCny != null && Number.isFinite(Number(s.budgetDeltaCny)) && Number(s.budgetDeltaCny) !== 0) {
      pushEvent(events, {
        id: makeEventId(i + 1, seq++, "budget_adjust"),
        type: "budget_adjust",
        turnIndex: i + 1,
        turnId: turn.turnId,
        createdAt: turn.createdAt,
        amountCny: Math.round(Number(s.budgetDeltaCny)),
        evidence: clean(s.budgetEvidence || text, 90),
        mode: "delta",
        status: "active",
      });
    }

    // 仅“用户确认”才会被 extractIntentSignals 识别为 spentDelta/spentAbsolute。
    if (s.budgetSpentCny != null && Number.isFinite(Number(s.budgetSpentCny)) && Number(s.budgetSpentCny) > 0) {
      pushEvent(events, {
        id: makeEventId(i + 1, seq++, "expense_commit"),
        type: "expense_commit",
        turnIndex: i + 1,
        turnId: turn.turnId,
        createdAt: turn.createdAt,
        amountCny: Math.round(Number(s.budgetSpentCny)),
        evidence: clean(s.budgetSpentEvidence || text, 90),
        mode: "absolute",
        status: "active",
      });
    } else if (
      s.budgetSpentDeltaCny != null &&
      Number.isFinite(Number(s.budgetSpentDeltaCny)) &&
      Number(s.budgetSpentDeltaCny) > 0
    ) {
      pushEvent(events, {
        id: makeEventId(i + 1, seq++, "expense_commit"),
        type: "expense_commit",
        turnIndex: i + 1,
        turnId: turn.turnId,
        createdAt: turn.createdAt,
        amountCny: Math.round(Number(s.budgetSpentDeltaCny)),
        evidence: clean(s.budgetSpentEvidence || text, 90),
        mode: "delta",
        status: "active",
      });
    }

    const refund = parseRefundFromText(text);
    if (refund?.amountCny) {
      pushEvent(events, {
        id: makeEventId(i + 1, seq++, "expense_refund"),
        type: "expense_refund",
        turnIndex: i + 1,
        turnId: turn.turnId,
        createdAt: turn.createdAt,
        amountCny: refund.amountCny,
        amountOriginal: refund.amountOriginal,
        currency: refund.currency,
        fxRateToCny: refund.fxRateToCny,
        evidence: refund.evidence,
        mode: "delta",
        status: "active",
      });
    }

    const pending = parsePendingFromText(text);
    if (pending) {
      pushEvent(events, {
        id: makeEventId(i + 1, seq++, "expense_pending"),
        type: "expense_pending",
        turnIndex: i + 1,
        turnId: turn.turnId,
        createdAt: turn.createdAt,
        amountCny: pending.amountCny,
        evidence: pending.evidence,
        note: pending.note,
        status: "active",
      });
    }
  }

  let totalCny: number | undefined;
  let spentCny = 0;
  let pendingCny = 0;
  let latestTotalEvidence: string | undefined;
  let latestSpentEvidence: string | undefined;
  let latestPendingEvidence: string | undefined;

  for (const ev of events) {
    if (ev.status === "resolved") continue;
    if (ev.type === "budget_set") {
      if (ev.amountCny != null) {
        totalCny = Math.max(0, Math.round(ev.amountCny));
        latestTotalEvidence = ev.evidence;
      }
      continue;
    }

    if (ev.type === "budget_adjust") {
      const delta = Math.round(Number(ev.amountCny) || 0);
      if (delta !== 0) {
        if (totalCny == null) totalCny = Math.max(0, delta);
        else totalCny = Math.max(0, totalCny + delta);
        latestTotalEvidence = ev.evidence;
      }
      continue;
    }

    if (ev.type === "expense_commit") {
      const amt = Math.max(0, Math.round(Number(ev.amountCny) || 0));
      if (amt > 0) {
        if (ev.mode === "absolute") spentCny = amt;
        else spentCny += amt;
        latestSpentEvidence = ev.evidence;
      }
      continue;
    }

    if (ev.type === "expense_refund") {
      const amt = Math.max(0, Math.round(Number(ev.amountCny) || 0));
      if (amt > 0) {
        spentCny = Math.max(0, spentCny - amt);
        latestSpentEvidence = ev.evidence;
      }
      continue;
    }

    if (ev.type === "expense_pending") {
      const amt = Math.max(0, Math.round(Number(ev.amountCny) || 0));
      if (amt > 0) pendingCny += amt;
      latestPendingEvidence = ev.evidence;
      continue;
    }
  }

  const remainingCny = totalCny != null ? Math.max(0, totalCny - spentCny) : undefined;

  return {
    events,
    summary: {
      totalCny,
      spentCny,
      remainingCny,
      pendingCny,
    },
    latestTotalEvidence,
    latestSpentEvidence,
    latestPendingEvidence,
  };
}
