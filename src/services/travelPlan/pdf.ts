import fs from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

import { config } from "../../server/config.js";
import { type TravelPlanState } from "./state.js";
import { isEnglishLocale, type AppLocale } from "../../i18n/locale.js";

const BUNDLED_CJK_FONT = fileURLToPath(
  new URL("../../../assets/fonts/NotoSansSC-chinese-simplified-400.woff", import.meta.url)
);

const FONT_CANDIDATES = [
  BUNDLED_CJK_FONT,
  process.env.CI_PDF_FONT_PATH || "",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/arphic/ukai.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
].filter(Boolean);

const FONT_EXT_ALLOWED_RE = /\.(ttf|otf|ttc)$/i;

function t(locale: AppLocale | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function listExistingFontPaths(): string[] {
  const out: string[] = [];
  for (const p of FONT_CANDIDATES) {
    try {
      if (!p || !FONT_EXT_ALLOWED_RE.test(p)) continue;
      if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p);
    } catch {
      // ignore
    }
  }
  return out;
}

function fontRank(p: string): number {
  const s = p.toLowerCase();
  const cjkHint =
    /(notosanscjk|notosanssc|sourcehansans|pingfang|heiti|wqy|simhei|simsun|ukai|noto)/i.test(s) ? 0 : 1;
  const extRank = /\.otf$/i.test(s) ? 0 : /\.ttf$/i.test(s) ? 1 : /\.ttc$/i.test(s) ? 2 : 3;
  return cjkHint * 10 + extRank;
}

function applyPreferredFont(doc: PDFKit.PDFDocument, locale?: AppLocale): string | null {
  const files = listExistingFontPaths();
  if (!files.length) {
    if (isEnglishLocale(locale)) {
      doc.font("Helvetica");
      return "Helvetica";
    }
    return null;
  }
  const prefer = files.slice().sort((a, b) => fontRank(a) - fontRank(b));
  for (const p of prefer) {
    try {
      doc.font(p);
      return p;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string) {
  doc.moveDown(0.7);
  doc.fontSize(13).fillColor("#0f172a").text(text, { underline: false });
  doc.moveDown(0.2);
}

function hasDayStructuredText(text: string): boolean {
  return /第\s*[一二三四五六七八九十两0-9]{1,3}\s*天|day\s*[0-9]{1,2}/i.test(String(text || ""));
}

export async function renderTravelPlanPdf(params: {
  plan: TravelPlanState;
  conversationId: string;
  locale?: AppLocale;
}): Promise<Buffer> {
  const plan = params.plan;
  const locale = params.locale;

  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: `Travel Plan ${params.conversationId}`,
      Author: "CogInstrument",
      Subject: t(locale, "旅行计划导出", "Travel Plan Export"),
      Keywords: "travel,plan,conginstrument",
      Creator: "CogInstrument",
      Producer: "CogInstrument",
    },
  });

  const fontPath = applyPreferredFont(doc, locale);
  if (!fontPath && !isEnglishLocale(locale)) {
    throw new Error(
      "No usable CJK font found for PDF export. Set CI_PDF_FONT_PATH or keep bundled font file."
    );
  }

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc
    .fillColor("#0b1220")
    .fontSize(18)
    .text(t(locale, "旅行计划导出", "Travel Plan Export"), { align: "left" });
  doc.moveDown(0.2);
  doc
    .fontSize(10)
    .fillColor("#475569")
    .text(`${t(locale, "会话", "Conversation")}: ${params.conversationId}`);
  doc
    .fontSize(10)
    .fillColor("#475569")
    .text(
      `${t(locale, "导出时间", "Exported at")}: ${new Date().toLocaleString(
        isEnglishLocale(locale) ? "en-US" : "zh-CN",
        {
          hour12: false,
          timeZone: config.timezone || "Asia/Shanghai",
        }
      )}`
    );

  sectionTitle(doc, t(locale, "摘要", "Summary"));
  doc.fontSize(11).fillColor("#111827").text(plan.summary || t(locale, "（暂无）", "(none)"), { lineGap: 3 });

  sectionTitle(doc, t(locale, "概览", "Overview"));
  if (plan.destinations?.length) {
    doc
      .fontSize(11)
      .fillColor("#111827")
      .text(
        isEnglishLocale(locale)
          ? `Destinations: ${plan.destinations.join(" / ")}`
          : `目的地：${plan.destinations.join("、")}`,
        { lineGap: 2 }
      );
  }
  if (plan.totalDays) {
    doc
      .fontSize(11)
      .fillColor("#111827")
      .text(isEnglishLocale(locale) ? `Total duration: ${plan.totalDays} days` : `总天数：${plan.totalDays}天`, {
        lineGap: 2,
      });
  }
  if (plan.budget) {
    if (plan.budget.totalCny != null)
      doc
        .fontSize(11)
        .fillColor("#111827")
        .text(
          isEnglishLocale(locale) ? `Total budget: ${plan.budget.totalCny} CNY` : `总预算：${plan.budget.totalCny}元`,
          { lineGap: 2 }
        );
    if (plan.budget.spentCny != null)
      doc
        .fontSize(11)
        .fillColor("#111827")
        .text(isEnglishLocale(locale) ? `Spent: ${plan.budget.spentCny} CNY` : `已花预算：${plan.budget.spentCny}元`, {
          lineGap: 2,
        });
    if (plan.budget.remainingCny != null)
      doc
        .fontSize(11)
        .fillColor("#111827")
        .text(
          isEnglishLocale(locale) ? `Remaining: ${plan.budget.remainingCny} CNY` : `剩余预算：${plan.budget.remainingCny}元`,
          { lineGap: 2 }
        );
    if (plan.budget.pendingCny != null && plan.budget.pendingCny > 0) {
      doc
        .fontSize(11)
        .fillColor("#92400e")
        .text(
          isEnglishLocale(locale)
            ? `Pending spending: ${plan.budget.pendingCny} CNY`
            : `待确认支出：${plan.budget.pendingCny}元`,
          { lineGap: 2 }
        );
    }
  }

  sectionTitle(doc, t(locale, "可执行行程", "Executable Itinerary"));
  const executableText = String(plan.exportNarrative || plan.narrativeText || "").trim();
  const narrativeContainsDays = hasDayStructuredText(executableText);
  if (narrativeContainsDays && executableText.length > 40) {
    doc.fontSize(10.8).fillColor("#111827").text(executableText, { lineGap: 3 });
  } else if (!plan.dayPlans?.length) {
    doc
      .fontSize(11)
      .fillColor("#111827")
      .text(t(locale, "暂无按天计划，请继续对话补全。", "No day-by-day plan yet. Continue chatting to complete it."), {
        lineGap: 3,
      });
  } else {
    for (const d of plan.dayPlans) {
      doc.moveDown(0.3);
      const datePart = d.dateLabel
        ? `（${d.dateLabel}${d.city ? `，${d.city}` : ""}）`
        : d.city
          ? `（${d.city}）`
          : "";
      doc
        .fontSize(12)
        .fillColor("#0f172a")
        .text(
          isEnglishLocale(locale)
            ? `Day ${d.day}${d.city ? ` (${d.city})` : ""}: ${d.title || "Plan"}`
            : `第${d.day}天${datePart}：${d.title || "行程"}`,
          {
            lineGap: 2,
          }
        );
      for (const item of d.items || []) {
        doc.fontSize(10.5).fillColor("#111827").text(`- ${item}`, { lineGap: 2, indent: 10 });
      }
    }
  }

  if (plan.budgetLedger?.length) {
    sectionTitle(doc, t(locale, "预算台账（事件流）", "Budget Ledger (Event Stream)"));
    const events = plan.budgetLedger.slice(-20);
    for (const ev of events) {
      const amountPart =
        ev.amountCny != null
          ? isEnglishLocale(locale)
            ? `${ev.amountCny} CNY`
            : `${ev.amountCny}元`
          : t(locale, "待确认", "pending");
      const line = isEnglishLocale(locale)
        ? `• [${ev.type}] ${amountPart} evidence: ${ev.evidence}`
        : `• [${ev.type}] ${amountPart} 证据：${ev.evidence}`;
      doc.fontSize(10.5).fillColor("#111827").text(line, { lineGap: 2 });
    }
  }

  if (plan.constraints?.length) {
    sectionTitle(doc, t(locale, "关键约束", "Key Constraints"));
    for (const c of plan.constraints.slice(0, 12)) {
      doc.fontSize(11).fillColor("#111827").text(`• ${c}`, { lineGap: 2 });
    }
  }

  if (plan.evidenceAppendix?.length) {
    sectionTitle(doc, t(locale, "附录（证据片段）", "Appendix (Evidence Snippets)"));
    for (const e of plan.evidenceAppendix.slice(0, 20)) {
      doc
        .fontSize(10)
        .fillColor("#334155")
        .text(
          isEnglishLocale(locale)
            ? `• [${e.source}] ${e.title}: ${e.content}`
            : `• [${e.source}] ${e.title}：${e.content}`,
          { lineGap: 2 }
        );
    }
  }

  doc.end();
  return done;
}

export function defaultTravelPlanFileName(conversationId: string): string {
  const stamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 19);
  return `travel-plan-${conversationId.slice(-8)}-${stamp}.pdf`;
}
