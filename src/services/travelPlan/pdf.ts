import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

import { config } from "../../server/config.js";
import { buildTravelPlanText, type TravelPlanState } from "./state.js";

const FONT_CANDIDATES = [
  process.env.CI_PDF_FONT_PATH || "",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/truetype/arphic/ukai.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
].filter(Boolean);

function pickChineseFontPath(): string | null {
  for (const p of FONT_CANDIDATES) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string) {
  doc.moveDown(0.7);
  doc.fontSize(13).fillColor("#0f172a").text(text, { underline: false });
  doc.moveDown(0.2);
}

export async function renderTravelPlanPdf(params: {
  plan: TravelPlanState;
  conversationId: string;
}): Promise<Buffer> {
  const plan = params.plan;
  const text = buildTravelPlanText(plan);
  const fontPath = pickChineseFontPath();

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

  if (fontPath) {
    doc.font(fontPath);
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
  }

  if (plan.constraints?.length) {
    sectionTitle(doc, "关键约束");
    for (const c of plan.constraints.slice(0, 12)) {
      doc.fontSize(11).fillColor("#111827").text(`• ${c}`, { lineGap: 2 });
    }
  }

  sectionTitle(doc, "按天行程");
  if (!plan.dayPlans?.length) {
    doc.fontSize(11).fillColor("#111827").text("暂无按天计划，请继续对话补全。", { lineGap: 3 });
  } else {
    for (const d of plan.dayPlans) {
      doc.moveDown(0.3);
      doc.fontSize(12).fillColor("#0f172a").text(`第${d.day}天${d.city ? `（${d.city}）` : ""}：${d.title || "行程"}`, {
        lineGap: 2,
      });
      for (const item of d.items || []) {
        doc.fontSize(10.5).fillColor("#111827").text(`- ${item}`, { lineGap: 2, indent: 10 });
      }
    }
  }

  sectionTitle(doc, "自然语言版本");
  doc.fontSize(10.5).fillColor("#111827").text(text, { lineGap: 3 });

  doc.end();
  return done;
}

export function defaultTravelPlanFileName(conversationId: string): string {
  const stamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 19);
  return `travel-plan-${conversationId.slice(-8)}-${stamp}.pdf`;
}
