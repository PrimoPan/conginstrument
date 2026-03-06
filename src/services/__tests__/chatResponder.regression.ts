import assert from "node:assert/strict";

process.env.CI_STREAM_MODE = "upstream";
process.env.CI_CHAT_TIMEOUT_MS = "20";
process.env.CI_STREAM_FIRST_TOKEN_TIMEOUT_MS = "20";
process.env.CI_STREAM_TOTAL_TIMEOUT_MS = "40";

const { generateAssistantTextNonStreaming, streamAssistantText } = await import("../chatResponder.js");
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

const originalCreate = openai.chat.completions.create.bind(openai.chat.completions);

try {
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
