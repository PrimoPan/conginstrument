# CogInstrument Backend

Node.js + TypeScript + Express + MongoDB 后端服务，提供：

1. 用户名登录（会话 token）
2. 多会话管理
3. 对话轮次处理（非流式与 SSE 流式）
4. CDG（Concept Dependency Graph）自动更新与持久化

> 安全提示：当前是“用户名即身份”的实验登录，不是生产级鉴权方案。

## 1. 启动与依赖

### 技术栈

- Node.js + TypeScript
- Express + CORS + Helmet
- MongoDB
- OpenAI SDK（可接 GreatRouter/兼容网关）

### 启动命令

```bash
npm install
npm run dev:api
```

默认监听端口由 `PORT` 决定（未设置时为 `3001`）。

## 2. 环境变量

在服务器或本地提供 `.env`（不要提交仓库）：

| 变量 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3001` | 服务监听端口 |
| `MONGO_URI` | 否 | `mongodb://127.0.0.1:27017` | Mongo 连接串 |
| `MONGO_DB` | 否 | `conginstrument` | 数据库名 |
| `OPENAI_API_KEY` | 是 | 空 | LLM 网关/API Key |
| `OPENAI_BASE_URL` | 是 | 空 | OpenAI 兼容接口地址 |
| `MODEL` | 否 | `gpt-4o-mini` | 对话默认模型 |
| `SESSION_TTL_DAYS` | 否 | `7` | 会话有效天数 |
| `CI_STREAM_MODE` | 否 | `pseudo` | `pseudo` 或 `upstream`，控制流式模式 |
| `CI_GRAPH_MODEL` | 否 | 与 `MODEL` 相同 | 图更新模型 |
| `CI_ALLOW_DELETE` | 否 | `0` | 设为 `1` 才允许 remove_node/remove_edge |
| `CI_DEBUG_LLM` | 否 | `0` | 设为 `1` 输出调试日志 |

## 3. 鉴权规则

- 登录接口返回 `sessionToken`
- 需要鉴权的接口使用 Header：

```http
Authorization: Bearer <sessionToken>
```

- 缺失 token：`401 Missing Authorization Bearer token`
- token 无效：`401 Invalid session`
- 对应用户不存在：`401 User not found`

## 4. 数据与类型模型

### 4.1 CDG 图结构

```ts
type ConceptType = "goal" | "constraint" | "preference" | "belief" | "fact" | "question";
type Strength = "hard" | "soft";
type Status = "proposed" | "confirmed" | "rejected" | "disputed";
type Severity = "low" | "medium" | "high" | "critical";

type ConceptNode = {
  id: string;
  type: ConceptType;
  statement: string;
  status: Status;
  confidence: number; // 0~1
  strength?: Strength;
  locked?: boolean;
  severity?: Severity;
  importance?: number; // 0~1
  tags?: string[];
  key?: string;
  value?: unknown;
  evidenceIds?: string[];
  sourceMsgIds?: string[];
};

type EdgeType = "enable" | "constraint" | "determine" | "conflicts_with";
type ConceptEdge = {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  confidence: number; // 0~1
  phi?: string;
};

type CDG = {
  id: string; // conversationId
  version: number;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
};
```

### 4.2 GraphPatch 结构

```ts
type PatchOp =
  | { op: "add_node"; node: ConceptNode }
  | { op: "update_node"; id: string; patch: Partial<ConceptNode> }
  | { op: "remove_node"; id: string }
  | { op: "add_edge"; edge: ConceptEdge }
  | { op: "remove_edge"; id: string };

type GraphPatch = {
  ops: PatchOp[];
  notes?: string[];
};
```

说明：

1. 后端会对白名单字段做清洗和归一化（状态、置信度、枚举值等）。
2. 默认不允许删除节点/边，除非 `CI_ALLOW_DELETE=1`。
3. 只有 patch 真正生效（应用了至少一个 op）时，`graph.version` 才会递增。

## 5. API 总览

Base URL 例如：`http://<host>:3001`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 否 | 健康检查 |
| `POST` | `/api/auth/login` | 否 | 用户名登录，创建会话 |
| `GET` | `/api/conversations` | 是 | 获取会话列表 |
| `POST` | `/api/conversations` | 是 | 创建会话 |
| `GET` | `/api/conversations/:id` | 是 | 获取会话详情和图 |
| `GET` | `/api/conversations/:id/turns` | 是 | 获取历史轮次 |
| `POST` | `/api/conversations/:id/turn` | 是 | 非流式一轮对话 |
| `POST` | `/api/conversations/:id/turn/stream` | 是 | SSE 流式一轮对话 |

## 6. 接口详情

### 6.1 健康检查

#### `GET /healthz`

响应：

```json
{ "ok": true }
```

### 6.2 登录

#### `POST /api/auth/login`

请求体：

```json
{ "username": "u001" }
```

约束：

1. `username` 不能为空
2. 后端会截断到最多 32 字符

成功响应：

```json
{
  "userId": "65f0...",
  "username": "u001",
  "sessionToken": "1b83b9d2-..."
}
```

失败响应示例：

```json
{ "error": "username required" }
```

### 6.3 会话列表

#### `GET /api/conversations`

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

### 6.4 创建会话

#### `POST /api/conversations`

请求体：

```json
{ "title": "新对话" }
```

说明：

1. `title` 默认 `"New Conversation"`
2. 标题最多 80 字符
3. 会初始化空图：`{ id: conversationId, version: 0, nodes: [], edges: [] }`

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

### 6.5 会话详情

#### `GET /api/conversations/:id`

成功响应：

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

常见失败：

- `400 { "error": "invalid conversation id" }`
- `404 { "error": "conversation not found" }`

### 6.6 历史轮次

#### `GET /api/conversations/:id/turns?limit=30`

参数：

- `limit`：默认 `30`，最小 `1`，最大 `200`

响应：

```json
[
  {
    "id": "65f2...",
    "createdAt": "2026-02-15T12:10:00.000Z",
    "userText": "我想做一个三天行程",
    "assistantText": "先给你一个可执行版本...",
    "graphVersion": 4
  }
]
```

### 6.7 非流式 turn

#### `POST /api/conversations/:id/turn`

请求体：

```json
{ "userText": "我预算 2000，偏好轻松一点" }
```

响应：

```json
{
  "assistantText": "好的，我先给你一个轻松路线...",
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

常见失败：

- `400 { "error": "invalid conversation id" }`
- `400 { "error": "userText required" }`
- `404 { "error": "conversation not found" }`

### 6.8 流式 turn（SSE）

#### `POST /api/conversations/:id/turn/stream`

请求体：

```json
{ "userText": "继续细化每天路线" }
```

响应为 `text/event-stream`，事件序列如下：

1. `start`：开场信息
2. `token`：增量文本（可能多次）
3. `ping`：心跳（约每 15 秒一次）
4. `done`：最终完整结果（含 graph 与 patch）
5. `error`：失败信息

事件示例：

```text
event: start
data: {"conversationId":"65f1...","graphVersion":5}

event: token
data: {"token":"先看第一天..."}

event: done
data: {"assistantText":"...","graphPatch":{"ops":[]},"graph":{"id":"65f1...","version":6,"nodes":[],"edges":[]}}
```

说明：

1. 当流式阶段异常且尚未输出 token 时，后端会尝试自动降级为非流式，仍返回 `done`。
2. 客户端断开连接会触发后端中止生成。

## 7. Mongo 集合与索引

集合：

1. `users`
2. `sessions`
3. `conversations`
4. `turns`

关键索引：

1. `users.username` 唯一
2. `sessions.token` 唯一
3. `sessions.expiresAt` TTL 自动过期
4. `conversations (userId, updatedAt)`
5. `turns (conversationId, createdAt)`

## 8. cURL 示例

### 登录

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"u001"}'
```

### 创建会话

```bash
curl -X POST http://localhost:3001/api/conversations \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"新对话"}'
```

### 非流式 turn

```bash
curl -X POST http://localhost:3001/api/conversations/<CID>/turn \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"userText":"给我一个 3 天计划"}'
```

### 流式 turn

```bash
curl -N -X POST http://localhost:3001/api/conversations/<CID>/turn/stream \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"userText":"继续"}'
```
