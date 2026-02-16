# CogInstrument Backend (`conginstrument`)

Language / 语言：
[中文](#中文) | [English](#english)

---

## 中文

### 1. 工程目的

`conginstrument` 是 CogInstrument 的后端服务，负责：

1. 用户登录与会话鉴权（实验性：用户名 + session token）。
2. 会话与对话轮次持久化（MongoDB）。
3. 调用 LLM 生成助手回复。
4. 基于用户最新输入持续更新 CDG（Concept Dependency Graph，意图依赖图）。
5. 通过普通 JSON 接口和 SSE 流式接口向前端提供数据。

这个服务的核心目标是“对话推进 + 意图建图同步”，不是纯聊天后端。

---

### 2. 技术栈

- Node.js + TypeScript（ESM）
- Express + CORS + Helmet
- MongoDB（官方驱动）
- OpenAI SDK（可接兼容网关）

---

### 3. 快速启动

```bash
npm install
npm run dev:api
```

默认端口：`3001`（可通过 `PORT` 覆盖）。

健康检查：

```bash
curl http://localhost:3001/healthz
```

---

### 4. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3001` | 后端监听端口 |
| `MONGO_URI` | 否 | `mongodb://127.0.0.1:27017` | Mongo 连接串 |
| `MONGO_DB` | 否 | `conginstrument` | 数据库名 |
| `OPENAI_API_KEY` | 是 | 空 | LLM API Key |
| `OPENAI_BASE_URL` | 是 | 空 | OpenAI/兼容网关地址 |
| `MODEL` | 否 | `gpt-4o` | 对话模型 |
| `SESSION_TTL_DAYS` | 否 | `7` | session 过期天数 |
| `CI_STREAM_MODE` | 否 | `pseudo` | `pseudo`（伪流）/`upstream`（上游真流） |
| `CI_GRAPH_MODEL` | 否 | 与 `MODEL` 相同 | 建图模型 |
| `CI_GRAPH_USE_FUNCTION_SLOTS` | 否 | `1` | 是否启用 function call 结构化槽位抽取 |
| `CI_GRAPH_PATCH_LLM_WITH_SLOTS` | 否 | `0` | 槽位抽取成功后是否仍并行启用自由 patch LLM |
| `CI_ALLOW_DELETE` | 否 | `0` | 是否允许 remove_node/remove_edge |
| `CI_DEBUG_LLM` | 否 | `0` | LLM 与 patch 调试日志 |

---

### 5. 鉴权约定

登录后得到 `sessionToken`，后续接口带：

```http
Authorization: Bearer <sessionToken>
```

常见鉴权错误：

- `401 Missing Authorization Bearer token`
- `401 Invalid session`
- `401 User not found`

---

### 6. API 总览

Base URL 示例：`http://localhost:3001`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 否 | 健康检查 |
| `POST` | `/api/auth/login` | 否 | 登录并创建 session |
| `GET` | `/api/conversations` | 是 | 会话列表 |
| `POST` | `/api/conversations` | 是 | 新建会话 |
| `GET` | `/api/conversations/:id` | 是 | 会话详情（含图） |
| `PUT` | `/api/conversations/:id/graph` | 是 | 保存前端编辑后的整图快照 |
| `GET` | `/api/conversations/:id/turns?limit=30` | 是 | 历史轮次 |
| `POST` | `/api/conversations/:id/turn` | 是 | 非流式单轮 |
| `POST` | `/api/conversations/:id/turn/stream` | 是 | SSE 流式单轮 |

---

### 7. 接口详情（后端协作重点）

#### 7.1 `GET /healthz`

响应：

```json
{ "ok": true }
```

#### 7.2 `POST /api/auth/login`

请求：

```json
{ "username": "test" }
```

规则：

- `username` 必填，空字符串返回 400。
- 服务端会截断到 32 字符。

成功响应：

```json
{
  "userId": "65f0...",
  "username": "test",
  "sessionToken": "uuid-token"
}
```

错误：

- `400 {"error":"username required"}`

#### 7.3 `GET /api/conversations`

响应：

```json
[
  {
    "conversationId": "65f1...",
    "title": "新对话",
    "updatedAt": "2026-02-15T12:00:00.000Z"
  }
]
```

#### 7.4 `POST /api/conversations`

请求：

```json
{ "title": "新对话" }
```

规则：

- 默认标题：`New Conversation`
- 标题最大 80 字符
- 自动初始化空图：
  `{ id: conversationId, version: 0, nodes: [], edges: [] }`

响应：

```json
{
  "conversationId": "65f1...",
  "title": "新对话",
  "systemPrompt": "你是CogInstrument的助手...",
  "graph": {
    "id": "65f1...",
    "version": 0,
    "nodes": [],
    "edges": []
  }
}
```

#### 7.5 `GET /api/conversations/:id`

响应：

```json
{
  "conversationId": "65f1...",
  "title": "新对话",
  "systemPrompt": "你是CogInstrument的助手...",
  "graph": {
    "id": "65f1...",
    "version": 3,
    "nodes": [],
    "edges": []
  }
}
```

错误：

- `400 {"error":"invalid conversation id"}`
- `404 {"error":"conversation not found"}`

#### 7.6 `GET /api/conversations/:id/turns?limit=30`

参数：

- `limit` 默认 `30`，范围 `1~200`

响应：

```json
[
  {
    "id": "65f2...",
    "createdAt": "2026-02-15T12:10:00.000Z",
    "userText": "我想去云南玩7天，预算10000",
    "assistantText": "可以，我们先把目标拆分...",
    "graphVersion": 4
  }
]
```

#### 7.7 `PUT /api/conversations/:id/graph`（保存前端修改图）

请求：

```json
{
  "graph": {
    "id": "65f1...",
    "version": 6,
    "nodes": [],
    "edges": []
  }
}
```

行为：

1. 服务端把前端图快照转换为 `add_node + add_edge` 的 snapshot patch。
2. 统一走 `applyPatchWithGuards`（字段清洗、去重、拓扑修复）。
3. 持久化到 `conversations.graph`，下一轮对话建图会直接基于这份图继续。

响应：

```json
{
  "conversationId": "65f1...",
  "graph": {
    "id": "65f1...",
    "version": 7,
    "nodes": [],
    "edges": []
  },
  "updatedAt": "2026-02-16T00:00:00.000Z"
}
```

错误：

- `400 {"error":"invalid conversation id"}`
- `400 {"error":"graph required"}`
- `400 {"error":"graph.nodes and graph.edges must be arrays"}`
- `404 {"error":"conversation not found"}`

#### 7.8 `POST /api/conversations/:id/turn`（非流式）

请求：

```json
{ "userText": "预算上限改成15000" }
```

响应：

```json
{
  "assistantText": "好的，我把预算上限更新到15000元。",
  "graphPatch": {
    "ops": [],
    "notes": []
  },
  "graph": {
    "id": "65f1...",
    "version": 5,
    "nodes": [],
    "edges": []
  }
}
```

错误：

- `400 {"error":"invalid conversation id"}`
- `400 {"error":"userText required"}`
- `404 {"error":"conversation not found"}`

#### 7.9 `POST /api/conversations/:id/turn/stream`（SSE）

请求：

```json
{ "userText": "继续细化并考虑我母亲心脏病" }
```

响应头：

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-transform`

SSE 事件序列：

1. `start`
2. `token`（多次）
3. `ping`（心跳）
4. `done`（最终结果）
5. `error`（失败）

示例：

```text
event: start
data: {"conversationId":"65f1...","graphVersion":5}

event: token
data: {"token":"先从约束开始..."}

event: done
data: {"assistantText":"...","graphPatch":{"ops":[]},"graph":{"id":"65f1...","version":6,"nodes":[],"edges":[]}}
```

后端行为补充：

- 如果流式阶段异常且还没吐 token，会自动降级非流式，尽量仍返回 `done`。
- 客户端断开会触发后端 `AbortController` 终止生成。

---

### 8. CDG 数据模型

核心类型在：`src/core/graph.ts`

- `ConceptNode.type`：`goal | constraint | preference | belief | fact | question`
- `ConceptNode.layer`：`intent | requirement | preference | risk`
- `ConceptNode.severity`：`low | medium | high | critical`
- `ConceptEdge.type`：`enable | constraint | determine | conflicts_with`
- `GraphPatch.ops`：`add_node | update_node | remove_node | add_edge | remove_edge`

关键点：

1. `applyPatchWithGuards` 会做字段归一化、白名单校验、ID 重写。
2. 默认禁删（除非 `CI_ALLOW_DELETE=1`）。
3. 单值槽位会做自动压缩（例如预算/人数/目的地/时长，保留更优节点）。
4. `layer` 可由 LLM 显式提供；若缺失，后端会根据节点语义自动推断：
   `goal -> intent`，硬约束/结构化事实 -> `requirement`，偏好语义 -> `preference`，高风险/健康/安全语义 -> `risk`。
5. 时长槽位采用“城市分段优先合并”：
   - 对话中若出现 `城市A n天 + 城市B m天`，后端会优先合成为 `总行程时长 = n+m`。
   - `前两天/后一天` 这类相对时间不会直接覆盖总时长槽位。
   - 历史中的脏目的地（如“顺带”）会在 merge 阶段被清洗，避免污染后续图结构。
6. 子地点归属采用 function-call 槽位：
   - 把“场馆/景点/街区”提取为 `sub_locations`，并尽量给出 `parent_city`。
   - 子地点不作为一级目的地，建图时会挂到对应城市（如城市节点/城市时长节点）下。

---

### 9. 建图更新流水线（graph path）

1. `generateTurn` / `generateTurnStreaming` 先生成助手文本。
2. `generateGraphPatch` 生成图增量 patch。
3. `sanitizeGraphPatchStrict` 做严格清洗（防漂移字段、非法 op）。
4. `postProcessPatch` + 启发式规则补齐原子节点与连边。
5. `applyPatchWithGuards` 应用 patch 并输出新图。
6. 持久化 `turns` 与 `conversations.graph`。
7. 若调用 `PUT /api/conversations/:id/graph` 保存前端改图，后续 turn 的 LLM 输入直接使用这份更新图。

---

### 10. Mongo 集合与索引

集合：

- `users`
- `sessions`
- `conversations`
- `turns`

关键索引：

- `users.username` 唯一
- `sessions.token` 唯一
- `sessions.expiresAt` TTL 过期自动删
- `conversations(userId, updatedAt)`
- `turns(conversationId, createdAt)`

---

### 11. 文件结构与逐文件说明

#### 11.1 目录树

```text
conginstrument/
├─ package.json
├─ package-lock.json
├─ README.md
└─ src/
   ├─ index.ts
   ├─ server/
   │  └─ config.ts
   ├─ core/
   │  ├─ graph.ts
   │  └─ nodeLayer.ts
   ├─ db/
   │  └─ mongo.ts
   ├─ middleware/
   │  └─ auth.ts
   ├─ routes/
   │  ├─ auth.ts
   │  └─ conversations.ts
   └─ services/
      ├─ server.ts
      ├─ llmClient.ts
      ├─ llm.ts
      ├─ chatResponder.ts
      ├─ graphUpdater.ts
      ├─ graphUpdater/
      │  ├─ constants.ts
      │  ├─ text.ts
      │  ├─ intentSignals.ts
      │  ├─ nodeNormalization.ts
      │  ├─ heuristicOps.ts
      │  ├─ slotFunctionCall.ts
      │  ├─ graphOpsHelpers.ts
      │  ├─ prompt.ts
      │  └─ common.ts
      ├─ patchGuard.ts
      └─ textSanitizer.ts
```

#### 11.2 根目录文件

| 文件 | 作用 |
| --- | --- |
| `README.md` | 后端说明文档（本文件） |
| `package.json` | 依赖与脚本（`dev:api`） |
| `package-lock.json` | npm 锁定依赖版本 |

#### 11.3 `src` 文件

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 简单的 OpenAI CLI 测试入口（与 API 服务解耦） |
| `src/server/config.ts` | 环境变量读取与默认值配置 |
| `src/services/server.ts` | Express 启动入口，挂载中间件与路由 |
| `src/db/mongo.ts` | Mongo 连接、集合实例、索引初始化 |
| `src/middleware/auth.ts` | Bearer token 鉴权中间件 |
| `src/routes/auth.ts` | 登录接口：用户 upsert + session 发放 |
| `src/routes/conversations.ts` | 会话 CRUD、turn、SSE 流式接口 |
| `src/core/graph.ts` | CDG 类型定义 + patch 应用守卫 + 槽位压缩 |
| `src/core/nodeLayer.ts` | 节点四层分类（Intent/Requirement/Preference/Risk）的推断与归一化 |
| `src/services/llmClient.ts` | OpenAI SDK 客户端实例 |
| `src/services/chatResponder.ts` | 助手文本生成（非流式/伪流/真流） |
| `src/services/graphUpdater.ts` | 图 patch 主流程（LLM 调用、启发式融合、后处理） |
| `src/services/graphUpdater/constants.ts` | 建图正则与槽位识别常量 |
| `src/services/graphUpdater/text.ts` | 文本清洗、证据合并、去重工具 |
| `src/services/graphUpdater/intentSignals.ts` | 用户意图信号抽取（目的地/时长/预算/人数/关键日），含跨轮时长合并与相对时间过滤 |
| `src/services/graphUpdater/nodeNormalization.ts` | 节点归一化与原子校验（防噪声、保结构） |
| `src/services/graphUpdater/heuristicOps.ts` | 启发式建图（槽位胜出、根节点连通、关键约束落图） |
| `src/services/graphUpdater/slotFunctionCall.ts` | function call 槽位抽取（结构化输出，含子地点归属）与信号映射 |
| `src/services/graphUpdater/graphOpsHelpers.ts` | 证据推断、语句去重 key、root goal 选择工具 |
| `src/services/graphUpdater/prompt.ts` | graph patch LLM 系统提示词（与主流程解耦） |
| `src/services/graphUpdater/common.ts` | patch 提取与临时 id 工具函数 |
| `src/services/patchGuard.ts` | LLM patch 清洗与规范化（强约束） |
| `src/services/textSanitizer.ts` | 把 Markdown/LaTeX 风格文本降级为纯文本 |
| `src/services/llm.ts` | turn 编排：助手回复 + patch 生成 + 统一返回 |

---

### 12. 协作建议

1. 前后端 type 变更时，先改 `src/core/graph.ts`，再同步前端 `src/core/type.ts`。
2. 新增/修改接口时，优先更新本 README 的“接口详情”。
3. 任何影响流式协议的修改，必须同步前端 `client.tsx` 的 SSE 解析逻辑。
4. 图更新策略改动，建议附至少一个“多轮对话输入 -> 期望图”的回归样例。

---

## English

### 1. Purpose

`conginstrument` is the backend service for CogInstrument. It handles:

1. Experimental auth (`username` + `sessionToken`).
2. Conversation/turn persistence in MongoDB.
3. Assistant text generation via LLM.
4. Incremental CDG (Concept Dependency Graph) updates.
5. JSON and SSE APIs for the frontend.

Core objective: **task-oriented dialogue + synchronized intent graphing**.

---

### 2. Stack

- Node.js + TypeScript (ESM)
- Express + CORS + Helmet
- MongoDB (native driver)
- OpenAI SDK (or compatible gateway)

---

### 3. Run

```bash
npm install
npm run dev:api
```

Default port: `3001`.

Health check:

```bash
curl http://localhost:3001/healthz
```

---

### 4. Env vars

See the Chinese section above for the full table. Key vars include:

- `PORT`, `MONGO_URI`, `MONGO_DB`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MODEL`
- `SESSION_TTL_DAYS`
- `CI_STREAM_MODE`, `CI_GRAPH_MODEL`, `CI_ALLOW_DELETE`, `CI_DEBUG_LLM`
- `CI_GRAPH_USE_FUNCTION_SLOTS`, `CI_GRAPH_PATCH_LLM_WITH_SLOTS`

---

### 5. API summary

- `GET /healthz`
- `POST /api/auth/login`
- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:id`
- `PUT /api/conversations/:id/graph`
- `GET /api/conversations/:id/turns?limit=30`
- `POST /api/conversations/:id/turn`
- `POST /api/conversations/:id/turn/stream` (SSE)

Auth header:

```http
Authorization: Bearer <sessionToken>
```

SSE events:

- `start`
- `token`
- `ping`
- `done`
- `error`

---

### 6. Data model

Main types are in `src/core/graph.ts`:

- `CDG`, `ConceptNode`, `ConceptEdge`, `GraphPatch`
- Node types: `goal | constraint | preference | belief | fact | question`
- Node layers: `intent | requirement | preference | risk`
- Severity: `low | medium | high | critical`

Patch application pipeline:

1. sanitize patch
2. apply guards
3. compact singleton slots (budget/duration/people/destination/health/preference)
4. bump graph version when structural changes happen

---

### 7. File map

```text
src/index.ts                 # standalone OpenAI CLI check
src/server/config.ts         # env config
src/services/server.ts       # Express app entry
src/db/mongo.ts              # Mongo collections + indexes
src/middleware/auth.ts       # auth middleware
src/routes/auth.ts           # login route
src/routes/conversations.ts  # conversation + turn + SSE routes
src/core/graph.ts            # graph types and guarded patch apply
src/core/nodeLayer.ts        # 4-layer node taxonomy inference and normalization
src/services/llmClient.ts    # OpenAI client
src/services/chatResponder.ts# assistant text generation
src/services/graphUpdater.ts # graph patch orchestrator
src/services/graphUpdater/constants.ts         # graph regex/constants
src/services/graphUpdater/text.ts              # text/evidence helpers
src/services/graphUpdater/intentSignals.ts     # intent signal extraction
src/services/graphUpdater/nodeNormalization.ts # node normalization + validation
src/services/graphUpdater/heuristicOps.ts      # heuristic graph construction from slots/signals
src/services/graphUpdater/slotFunctionCall.ts  # function-call slot extraction
src/services/graphUpdater/graphOpsHelpers.ts   # evidence/dedup/root-goal helpers
src/services/graphUpdater/prompt.ts            # graph patch system prompt
src/services/graphUpdater/common.ts            # patch parsing/temp id helpers
src/services/patchGuard.ts   # strict patch sanitizer
src/services/textSanitizer.ts# markdown-to-plain sanitizer
src/services/llm.ts          # turn orchestration
```

---

### 8. Collaboration notes

- Treat `src/core/graph.ts` as the backend contract source of truth.
- Keep frontend `src/core/type.ts` aligned after every graph schema change.
- Update README API docs whenever route payloads/events change.
