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
    assistantPlan: {
      sourceTurnIndex: 3,
      sourceTurnCreatedAt: new Date().toISOString(),
      rawText:
        "4月10日 上午：参观米兰大教堂及其屋顶。下午：逛埃马努埃莱二世长廊。晚上：在布雷拉区晚餐。4月11日 上午：游览斯福尔扎城堡。下午：参观布雷拉画廊。晚上：布雷拉区用餐。4月12日 上午：自由活动。下午：前往圣西罗体育场参观。晚上：返回市中心晚餐。",
      narrative:
        "4月10日 上午：参观米兰大教堂及其屋顶。下午：逛埃马努埃莱二世长廊。晚上：在布雷拉区晚餐。4月11日 上午：游览斯福尔扎城堡。下午：参观布雷拉画廊。晚上：布雷拉区用餐。4月12日 上午：自由活动。下午：前往圣西罗体育场参观。晚上：返回市中心晚餐。",
      parser: "date_header",
      dayPlans: [
        {
          day: 1,
          city: "米兰",
          dateLabel: "4月10日",
          title: "米兰中心区",
          items: ["上午：参观米兰大教堂及其屋顶", "下午：逛埃马努埃莱二世长廊", "晚上：布雷拉区晚餐"],
        },
        {
          day: 2,
          city: "米兰",
          dateLabel: "4月11日",
          title: "艺术与城堡",
          items: ["上午：游览斯福尔扎城堡", "下午：参观布雷拉画廊", "晚上：布雷拉区用餐"],
        },
        {
          day: 3,
          city: "米兰",
          dateLabel: "4月12日",
          title: "圣西罗日",
          items: ["上午：自由活动", "下午：前往圣西罗体育场参观", "晚上：返回市中心晚餐"],
        },
      ],
    },
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
