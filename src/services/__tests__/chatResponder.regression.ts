import assert from "node:assert/strict";

process.env.CI_STREAM_MODE = "upstream";
process.env.CI_CHAT_TIMEOUT_MS = "20";
process.env.CI_STREAM_FIRST_TOKEN_TIMEOUT_MS = "20";
process.env.CI_STREAM_TOTAL_TIMEOUT_MS = "40";
process.env.CI_PLAIN_CHAT_HISTORY_TURN_LIMIT = "2";
process.env.CI_PLAIN_CHAT_HISTORY_MESSAGE_LIMIT = "2";
process.env.CI_PLAIN_CHAT_MAX_CHARS_PER_MESSAGE = "220";
process.env.CI_PLAIN_CHAT_MAX_TOKENS = "180";
process.env.CI_PLAIN_CHAT_FALLBACK_MAX_TOKENS = "120";

const {
  generateAssistantTextNonStreaming,
  generatePlainAssistantTextNonStreaming,
  streamAssistantText,
  streamPlainAssistantText,
} = await import("../chatResponder.js");
const { openai } = await import("../llmClient.js");

type CreateFn = typeof openai.chat.completions.create;

function makeNeverResolvingCreate(): CreateFn {
  return (async (_params: any, opts?: any) => {
    await new Promise((_, reject) => {
      const signal = opts?.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        reject((signal as any).reason || new Error("aborted"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject((signal as any).reason || new Error("aborted")),
        { once: true }
      );
    });
    return null as any;
  }) as CreateFn;
}

function makeRecordedCreate(records: any[]): CreateFn {
  return (async (params: any) => {
    records.push(params);
    if (params?.stream) {
      return (async function* () {
        yield { choices: [{ delta: { content: "短" } }] };
        yield { choices: [{ delta: { content: "答" } }] };
      })() as any;
    }
    return {
      choices: [{ message: { content: "测试回复" }, finish_reason: "stop" }],
    } as any;
  }) as CreateFn;
}

function makePlainFallbackCreate(records: any[]): CreateFn {
  return (async (params: any) => {
    records.push(params);
    if (records.length === 1) {
      return {
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
      } as any;
    }
    return {
      choices: [{ message: { content: "备用回复" }, finish_reason: "stop" }],
    } as any;
  }) as CreateFn;
}

function longMessage(label: string, length = 320): string {
  return `${label}:${"x".repeat(length)}`;
}

const originalCreate = openai.chat.completions.create.bind(openai.chat.completions);

try {
  const fallbackRecords: any[] = [];
  (openai.chat.completions as any).create = makePlainFallbackCreate(fallbackRecords);

  const fallbackText = await generatePlainAssistantTextNonStreaming({
    userText: "请直接回答",
    recentTurns: [],
    locale: "zh-CN",
  });
  assert.equal(fallbackText, "备用回复");
  assert.equal(fallbackRecords[0].max_tokens, 180);
  assert.equal(fallbackRecords[1].max_tokens, 120);

  const records: any[] = [];
  (openai.chat.completions as any).create = makeRecordedCreate(records);

  const recentTurns = [
    { role: "user" as const, content: longMessage("m1") },
    { role: "assistant" as const, content: longMessage("m2") },
    { role: "user" as const, content: longMessage("m3") },
    { role: "assistant" as const, content: longMessage("m4") },
  ];

  const plainText = await generatePlainAssistantTextNonStreaming({
    userText: "继续聊",
    recentTurns,
    locale: "zh-CN",
  });
  assert.equal(plainText, "测试回复");
  assert.equal(records[0].max_tokens, 180);
  assert.equal(records[0].messages.length, 4);
  const plainRecent = records[0].messages.slice(1, -1);
  assert.equal(plainRecent.length, 2);
  assert.match(String(plainRecent[0].content), /^m3:/);
  assert.match(String(plainRecent[1].content), /^m4:/);
  assert.ok(String(plainRecent[0].content).length <= 220);
  assert.ok(String(plainRecent[1].content).length <= 220);

  const normalText = await generateAssistantTextNonStreaming({
    graph: { id: "g_plain_limit_guard", version: 1, nodes: [], edges: [] },
    userText: "继续细化计划",
    recentTurns,
    locale: "zh-CN",
  });
  assert.ok(normalText.length > 0);
  assert.equal(records[1].max_tokens, 900);
  const normalRecent = records[1].messages.slice(1, -1);
  assert.equal(normalRecent.length, 4);
  assert.match(String(normalRecent[0].content), /^m1:/);
  assert.ok(String(normalRecent[0].content).length > 220);

  const streamedTokens: string[] = [];
  const streamText = await streamPlainAssistantText({
    userText: "再说短一点",
    recentTurns,
    locale: "zh-CN",
    onToken: (token) => streamedTokens.push(token),
  });
  assert.equal(streamText, "短答");
  assert.deepEqual(streamedTokens, ["短", "答"]);
  assert.equal(records[2].stream, true);
  assert.equal(records[2].max_tokens, 180);
  assert.equal(records[2].messages.length, 4);

  console.log("PASS plain chat honors env-specific context and token limits");
  console.log("PASS plain chat fallback honors env-specific fallback token limits");
  console.log("PASS normal chat ignores plain chat env limits");

  (openai.chat.completions as any).create = makeNeverResolvingCreate();

  const text = await generateAssistantTextNonStreaming({
    graph: { id: "g_nonstream_timeout", version: 1, nodes: [], edges: [] },
    userText: "帮我规划一次轻松的日本行程",
    recentTurns: [],
    locale: "zh-CN",
  });
  assert.equal(
    text,
    "我明白你的意思了。你把你现在的目标和限制说一句，我直接给你一个可执行版本。"
  );

  const tokens: string[] = [];
  await assert.rejects(
    () =>
      streamAssistantText({
        graph: { id: "g_stream_timeout", version: 1, nodes: [], edges: [] },
        userText: "第二轮继续细化京都和大阪的停留",
        recentTurns: [],
        locale: "zh-CN",
        onToken: (token) => tokens.push(token),
      }),
    /stream_first_token_timeout|chat_timeout|aborted/
  );
  assert.deepEqual(tokens, []);

  console.log("PASS non-stream chat timeout degrades to generic fallback");
  console.log("PASS stream chat first-token timeout throws for route fallback");
} finally {
  (openai.chat.completions as any).create = originalCreate;
}
