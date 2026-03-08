import assert from "node:assert/strict";

process.env.CI_STREAM_MODE = "pseudo";

const { generateTurn, generateTurnStreaming } = await import("../llm.js");
const { openai } = await import("../llmClient.js");

type CreateFn = typeof openai.chat.completions.create;

function makeStubCreate(calls: any[]): CreateFn {
  return (async (params: any) => {
    calls.push(params);
    return {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "stub assistant response",
          },
        },
      ],
    } as any;
  }) as CreateFn;
}

const originalCreate = openai.chat.completions.create.bind(openai.chat.completions);

try {
  const graph = { id: "g_llm_prompt_reg", version: 1, nodes: [], edges: [] } as any;
  const recentTurns = [
    { role: "user" as const, content: "之前说过想去京都，整体慢一点。" },
    { role: "assistant" as const, content: "收到，我会按京都慢节奏来想。" },
  ];
  const userText = "我后来不想去大阪了，这趟就只保留京都。";

  const nonStreamCalls: any[] = [];
  (openai.chat.completions as any).create = makeStubCreate(nonStreamCalls);
  await generateTurn({
    graph,
    userText,
    recentTurns,
    locale: "zh-CN",
  });
  const nonStreamFirst = nonStreamCalls[0];
  assert.ok(nonStreamFirst, "expected non-stream chat call");
  const nonStreamMessages = nonStreamFirst.messages || [];
  assert.equal(
    nonStreamMessages.filter((m: any) => m.role === "user" && String(m.content || "").includes(userText)).length,
    1,
    "current user turn should appear exactly once in non-stream prompt"
  );

  const streamCalls: any[] = [];
  (openai.chat.completions as any).create = makeStubCreate(streamCalls);
  let streamed = "";
  await generateTurnStreaming({
    graph,
    userText,
    recentTurns,
    locale: "zh-CN",
    onToken: (token) => {
      streamed += token;
    },
  });
  const streamFirst = streamCalls[0];
  assert.ok(streamFirst, "expected stream chat call");
  const streamMessages = streamFirst.messages || [];
  assert.equal(
    streamMessages.filter((m: any) => m.role === "user" && String(m.content || "").includes(userText)).length,
    1,
    "current user turn should appear exactly once in stream prompt"
  );
  assert.equal(streamed.includes("stub assistant response"), true);

  console.log("PASS generateTurn should not duplicate current user text in non-stream prompt");
  console.log("PASS generateTurnStreaming should not duplicate current user text in stream prompt");
} finally {
  (openai.chat.completions as any).create = originalCreate;
}
