import assert from "node:assert/strict";

import { renderTravelPlanPdf } from "../travelPlan/pdf.js";

async function main() {
  const plan = {
    version: 1,
    updatedAt: new Date().toISOString(),
    summary: "测试摘要：米兰 3 天行程，关注预算与安全。",
    destinations: ["米兰"],
    constraints: ["住安全区域", "预算控制在 10000 元内"],
    totalDays: 3,
    budget: {
      totalCny: 10000,
      spentCny: 2600,
      remainingCny: 7400,
      pendingCny: 400,
    },
    narrativeText: "第1天：抵达与城市漫步。第2天：核心景点。第3天：返程前轻松活动。",
    dayPlans: [
      {
        day: 1,
        city: "米兰",
        title: "抵达与适应",
        items: ["入住安全区域酒店", "附近步行熟悉环境"],
      },
      {
        day: 2,
        city: "米兰",
        title: "核心行程",
        items: ["白天核心景点", "晚间控制出行时段"],
      },
      {
        day: 3,
        city: "米兰",
        title: "返程前安排",
        items: ["行李整理", "返程交通确认"],
      },
    ],
    source: {
      turnCount: 6,
    },
  } as any;

  const zhPdf = await renderTravelPlanPdf({
    plan,
    conversationId: "pdf_regression_zh",
    locale: "zh-CN" as any,
  });
  assert.ok(Buffer.isBuffer(zhPdf));
  assert.ok(zhPdf.length > 800);

  const enPdf = await renderTravelPlanPdf({
    plan,
    conversationId: "pdf_regression_en",
    locale: "en-US" as any,
  });
  assert.ok(Buffer.isBuffer(enPdf));
  assert.ok(enPdf.length > 800);

  console.log("All travel-plan PDF regression checks passed.");
}

main().catch((err) => {
  console.error("travel-plan PDF regression failed");
  console.error(err);
  process.exit(1);
});
