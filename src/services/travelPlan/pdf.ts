import fs from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

import { config } from "../../server/config.js";
import { type TravelPlanState } from "./state.js";

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

function applyChineseFont(doc: PDFKit.PDFDocument): string | null {
  const files = listExistingFontPaths();
  if (!files.length) return null;
  // 只使用 ttf/otf/ttc，避免 woff 在部分 PDF 阅读器出现乱码。
  const prefer = files
    .slice()
    .sort((a, b) => {
      const rank = (x: string) =>
        /\.ttf$/i.test(x) ? 0 : /\.otf$/i.test(x) ? 1 : /\.ttc$/i.test(x) ? 2 : 3;
      return rank(a) - rank(b);
    });
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
}): Promise<Buffer> {
  const plan = params.plan;

  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    info: {
      Title: `Travel Plan ${params.conversationId}`,
      Author: "CogInstrument",
      Subject: "Travel Plan Export",
      Keywords: "travel,plan,conginstrument",
      Creator: "CogInstrument",
      Producer: "CogInstrument",
    },
  });

  const fontPath = applyChineseFont(doc);
  if (!fontPath) {
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

  doc.fillColor("#0b1220").fontSize(18).text("旅行计划导出", { align: "left" });
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#475569").text(`会话: ${params.conversationId}`);
  doc.fontSize(10).fillColor("#475569").text(`导出时间: ${new Date().toLocaleString("zh-CN", { hour12: false, timeZone: config.timezone || "Asia/Shanghai" })}`);

  sectionTitle(doc, "摘要");
  doc.fontSize(11).fillColor("#111827").text(plan.summary || "（暂无）", { lineGap: 3 });

  sectionTitle(doc, "概览");
  if (plan.destinations?.length) {
    doc.fontSize(11).fillColor("#111827").text(`目的地：${plan.destinations.join("、")}`, { lineGap: 2 });
  }
  if (plan.totalDays) {
    doc.fontSize(11).fillColor("#111827").text(`总天数：${plan.totalDays}天`, { lineGap: 2 });
  }
  if (plan.budget) {
    if (plan.budget.totalCny != null) doc.fontSize(11).fillColor("#111827").text(`总预算：${plan.budget.totalCny}元`, { lineGap: 2 });
    if (plan.budget.spentCny != null) doc.fontSize(11).fillColor("#111827").text(`已花预算：${plan.budget.spentCny}元`, { lineGap: 2 });
    if (plan.budget.remainingCny != null) doc.fontSize(11).fillColor("#111827").text(`剩余预算：${plan.budget.remainingCny}元`, { lineGap: 2 });
    if (plan.budget.pendingCny != null && plan.budget.pendingCny > 0) {
      doc.fontSize(11).fillColor("#92400e").text(`待确认支出：${plan.budget.pendingCny}元`, { lineGap: 2 });
    }
  }

  sectionTitle(doc, "可执行行程");
  const executableText = String(plan.exportNarrative || plan.narrativeText || "").trim();
  const narrativeContainsDays = hasDayStructuredText(executableText);
  if (narrativeContainsDays && executableText.length > 40) {
    doc.fontSize(10.8).fillColor("#111827").text(executableText, { lineGap: 3 });
  } else if (!plan.dayPlans?.length) {
    doc.fontSize(11).fillColor("#111827").text("暂无按天计划，请继续对话补全。", { lineGap: 3 });
  } else {
    for (const d of plan.dayPlans) {
      doc.moveDown(0.3);
      const datePart = d.dateLabel
        ? `（${d.dateLabel}${d.city ? `，${d.city}` : ""}）`
        : d.city
          ? `（${d.city}）`
          : "";
      doc.fontSize(12).fillColor("#0f172a").text(`第${d.day}天${datePart}：${d.title || "行程"}`, {
        lineGap: 2,
      });
      for (const item of d.items || []) {
        doc.fontSize(10.5).fillColor("#111827").text(`- ${item}`, { lineGap: 2, indent: 10 });
      }
    }
  }

  if (plan.budgetLedger?.length) {
    sectionTitle(doc, "预算台账（事件流）");
    const events = plan.budgetLedger.slice(-20);
    for (const ev of events) {
      const amountPart = ev.amountCny != null ? `${ev.amountCny}元` : "待确认";
      const line = `• [${ev.type}] ${amountPart} 证据：${ev.evidence}`;
      doc.fontSize(10.5).fillColor("#111827").text(line, { lineGap: 2 });
    }
  }

  if (plan.constraints?.length) {
    sectionTitle(doc, "关键约束");
    for (const c of plan.constraints.slice(0, 12)) {
      doc.fontSize(11).fillColor("#111827").text(`• ${c}`, { lineGap: 2 });
    }
  }

  if (plan.evidenceAppendix?.length) {
    sectionTitle(doc, "附录（证据片段）");
    for (const e of plan.evidenceAppendix.slice(0, 20)) {
      doc
        .fontSize(10)
        .fillColor("#334155")
        .text(`• [${e.source}] ${e.title}：${e.content}`, { lineGap: 2 });
    }
  }

  doc.end();
  return done;
}

export function defaultTravelPlanFileName(conversationId: string): string {
  const stamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 19);
  return `travel-plan-${conversationId.slice(-8)}-${stamp}.pdf`;
}
