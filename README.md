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
5. 构建并维护 `Concept → Motif → Context` 三层认知模型（PRD 对齐）。
6. 通过普通 JSON 接口和 SSE 流式接口向前端提供数据。

这个服务的核心目标是“对话推进 + 意图建图同步”，不是纯聊天后端。

### 1.1 Concept–Motif–Context（PRD 对齐实现）

- `Concept`：基础语义槽位（intent / requirement / preference / risk 等）。
- `Motif`：concept 间关系模式（pair / triad），并带生命周期状态：
  `active | uncertain | deprecated | disabled | cancelled`。
- `Context`：场景化聚合层（由多个 motifs + concepts 组成），并带状态：
  `active | uncertain | conflicted | disabled`。

后端在每次 `create/get/turn/saveGraph/saveConcepts` 后都会重建这三层，并一并返回给前端。

此外，对话生成阶段（`chatResponder`）会把 `Motif/Context` 状态注入 LLM 提示：
- 若存在 `deprecated` motif（冲突），优先触发强制澄清问题；
- 若存在 `uncertain` motif，触发确认型问题；
- 若均稳定，再回退到节点级不确定性提问。

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
npm run test:graph-regression   # 可选：数字槽位回归测试
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
| `CI_GRAPH_PATCH_LLM_WITH_SLOTS` | 否 | `0` | 兼容旧版参数；当前 V2 槽位流水线默认不走自由 patch LLM |
| `CI_GEO_VALIDATE` | 否 | `1` | 是否启用地理校验层（Nominatim） |
| `CI_GEO_ENDPOINT` | 否 | `https://nominatim.openstreetmap.org` | 地理解析服务地址 |
| `CI_GEO_TIMEOUT_MS` | 否 | `2600` | 每次地理查询超时（毫秒） |
| `CI_GEO_MAX_LOOKUPS` | 否 | `12` | 每轮最多地理查询次数 |
| `CI_GEO_CACHE_TTL_MS` | 否 | `43200000` | 地理缓存 TTL（毫秒） |
| `CI_MCP_GEO_URL` | 否 | 空 | 可选 MCP 地理工具桥接地址（优先于 Nominatim） |
| `CI_MCP_GEO_TIMEOUT_MS` | 否 | `1800` | MCP 地理调用超时（毫秒） |
| `CI_MCP_GEO_TOKEN` | 否 | 空 | MCP 地理桥接鉴权 Token（可选） |
| `CI_WEATHER_EXTREME_ALERT` | 否 | `1` | 是否启用“极端天气主动提醒” |
| `CI_WEATHER_TIMEOUT_MS` | 否 | `3200` | 天气 API 请求超时（毫秒） |
| `CI_WEATHER_MAX_DAYS` | 否 | `10` | 预报窗口上限（Open-Meteo 最多 16 天） |
| `CI_WEATHER_GEO_ENDPOINT` | 否 | `https://geocoding-api.open-meteo.com/v1/search` | 天气地理编码 API |
| `CI_WEATHER_FORECAST_ENDPOINT` | 否 | `https://api.open-meteo.com/v1/forecast` | 天气预报 API |
| `CORS_ALLOW_ALL` | 否 | `1` | 是否允许全部 Origin（`1`=允许，`0`=仅白名单） |
| `CORS_ORIGINS` | 否 | 空 | CORS 白名单，逗号分隔，如 `http://localhost:3000,http://your.server:6688` |
| `CI_ALLOW_DELETE` | 否 | `0` | 是否允许 remove_node/remove_edge |
| `CI_DEBUG_LLM` | 否 | `0` | LLM 与 patch 调试日志 |
| `CI_DATE_RANGE_BOUNDARY_MODE` | 否 | `auto` | 日期跨度边界策略：`auto`（会议偏 exclusive，旅游偏 inclusive）/`inclusive`/`exclusive` |
| `CI_PDF_FONT_PATH` | 否 | 空 | PDF 导出中文字体路径（优先）；为空时会尝试系统常见 CJK 字体 |

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
| `PUT` | `/api/conversations/:id/graph` | 是 | 保存前端编辑后的整图快照（可选触发“基于新图”的建议） |
| `PUT` | `/api/conversations/:id/concepts` | 是 | 保存中间 Concept 模块状态（锁定/暂停/编辑） |
| `GET` | `/api/conversations/:id/turns?limit=30` | 是 | 历史轮次 |
| `GET` | `/api/conversations/:id/travel-plan/export.pdf` | 是 | 导出旅行计划 PDF（中文、按天行程） |
| `POST` | `/api/conversations/:id/turn` | 是 | 非流式单轮 |
| `POST` | `/api/conversations/:id/turn/stream` | 是 | SSE 流式单轮 |

接口返回补充字段：

- `concepts`: `ConceptItem[]`
- `motifs`: `ConceptMotif[]`（含 `status/novelty/statusReason`）
- `motifLinks`: `MotifLink[]`（motif 间关系，可由用户编辑后保存）
- `contexts`: `ContextItem[]`
- `conflictGate`: 仅在 `turn/turn/stream` 被冲突门控时返回，包含 `unresolvedMotifs[]` 与阻塞提示文案

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

#### 7.7 `PUT /api/conversations/:id/graph`（保存前端修改图，可选生成建议）

请求：

```json
{
  "graph": {
    "id": "65f1...",
    "version": 6,
    "nodes": [],
    "edges": []
  },
  "concepts": [],
  "motifs": [],
  "requestAdvice": true,
  "advicePrompt": "用户已手动调整意图图，请基于最新图给出下一步建议"
}
```

行为：

1. 服务端用 `normalizeGraphSnapshot` 对前端整图做轻量规范化（字段清洗、ID 修复、悬挂边过滤、重复边去重）。
2. 不做自动拓扑重排，尽量保留用户手工编辑结构。
3. 持久化到 `conversations.graph`，下一轮对话建图会直接基于这份图继续。
4. 若 `requestAdvice=true`，服务端会把“最新图 + 最近对话 + advicePrompt（或默认提示）”送入聊天模型，返回建议文本。

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
  "concepts": [],
  "motifs": [],
  "updatedAt": "2026-02-16T00:00:00.000Z",
  "assistantText": "基于你手工修正后的意图图，建议先锁定关键约束再排城市节奏...",
  "adviceError": ""
}
```

错误：

- `400 {"error":"invalid conversation id"}`
- `400 {"error":"graph required"}`
- `400 {"error":"graph.nodes and graph.edges must be arrays"}`
- `404 {"error":"conversation not found"}`

#### 7.8 `PUT /api/conversations/:id/concepts`（保存 Concept 模块）

说明：`Concept` 是独立语义槽位对象，不等于单个节点；`nodeIds` 可包含多个关联节点，`primaryNodeId` 是当前展示锚点。

请求：

```json
{
  "concepts": [
    {
      "id": "c_intent",
      "kind": "intent",
      "title": "核心意图",
      "description": "去云南旅游7天",
      "score": 0.84,
      "nodeIds": ["n1", "n8"],
      "primaryNodeId": "n1",
      "evidenceTerms": ["云南", "7天"],
      "sourceMsgIds": ["latest_user"],
      "locked": false,
      "paused": false,
      "updatedAt": "2026-02-16T00:10:00.000Z"
    }
  ]
}
```

响应：

```json
{
  "conversationId": "65f1...",
  "graph": {
    "id": "65f1...",
    "version": 8,
    "nodes": [],
    "edges": []
  },
  "concepts": [],
  "motifs": [],
  "updatedAt": "2026-02-16T00:10:00.000Z"
}
```

#### 7.9 `POST /api/conversations/:id/turn`（非流式）

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
  },
  "concepts": [],
  "motifs": []
}
```

错误：

- `400 {"error":"invalid conversation id"}`
- `400 {"error":"userText required"}`
- `404 {"error":"conversation not found"}`

#### 7.10 `POST /api/conversations/:id/turn/stream`（SSE）

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

核心类型在：`src/core/graph/types.ts`（并由 `src/core/graph.ts` 兼容导出）

- `ConceptNode.type`：`goal | constraint | preference | belief | fact | question`
- `ConceptNode.layer`：`intent | requirement | preference | risk`
- `ConceptNode.severity`：`low | medium | high | critical`
- `ConceptNode.motifType`：`belief | hypothesis | expectation | cognitive_step`
- `ConceptEdge.type`：`enable | constraint | determine | conflicts_with`
- `GraphPatch.ops`：`add_node | update_node | remove_node | add_edge | remove_edge`

关键点：

1. `applyPatchWithGuards` 会做字段归一化、白名单校验、ID 重写。
2. 默认禁删（除非 `CI_ALLOW_DELETE=1`）。
3. 单值槽位会做自动压缩（例如预算/人数/目的地/时长，保留更优节点）。
4. `layer` 可由系统显式提供；若缺失，后端会根据节点语义自动推断：
   `goal -> intent`，硬约束/结构化事实 -> `requirement`，偏好语义 -> `preference`，高风险/健康/安全语义 -> `risk`。
5. 时长槽位采用“城市分段优先合并”：
   - 对话中若出现 `城市A n天 + 城市B m天`，后端会优先合成为 `总行程时长 = n+m`。
   - `前两天/后一天` 这类相对时间不会直接覆盖总时长槽位。
   - 历史中的脏目的地（如“顺带”）会在 merge 阶段被清洗，避免污染后续图结构。
6. 子地点归属采用 function-call 槽位：
   - 把“场馆/景点/街区”提取为 `sub_locations`，并尽量给出 `parent_city`。
   - 子地点不作为一级目的地，建图时会挂到对应城市（如城市节点/城市时长节点）下。
7. 手工改图保存与自动建图分离：
   - 对话 turn（自动建图）走 `applyPatchWithGuards`（包含拓扑修复/去重策略）。
   - 前端整图保存走 `normalizeGraphSnapshot`（仅做合法化，不重排用户图结构）。
8. PRD 元数据字段已入模（先存储，前端暂不复杂展示）：
   - `claim/structure/evidence/linkedIntentIds/rebuttalPoints/revisionHistory`
   - `priority/successCriteria`
9. 地理校验层（Global-ready）：
   - 合并后的槽位会进入 `geoResolver` 做地理规范化。
   - 若配置 `CI_MCP_GEO_URL`，优先走 MCP 地理工具桥接；失败时自动回退 Nominatim。
   - 自动判断“子地点 -> 父城市”关系（如冷门地点/场馆），避免把子地点误当一级目的地。
   - 查询失败时自动降级为本地规则，不阻断对话与建图。

---

### 9. 建图更新流水线（V2：槽位状态机 -> 图编译器）

1. `generateTurn` / `generateTurnStreaming` 先生成助手文本。
2. `extractIntentSignalsWithRecency` + `slotFunctionCall` 抽取结构化槽位（并做冲突融合；健康/语言/饮食/宗教统一归入“限制因素”）。
3. `geoResolver` 做地理规范化（目的地/城市时长/子地点父城归属，支持 MCP 桥接）。
4. `signalSanitizer` 做二次清洗（地名归一化、子地点回收、重复目的地去重、噪声地名拦截、时长冲突收敛与离群回归）。
5. `constraintClassifier` 做硬约束语义归类（health/language/diet/religion/legal/safety/mobility/logistics），减少 prompt 写死规则依赖。
6. `slotStateMachine` 产出“标准化槽位状态”（slot winners），并统一“限制因素”与冲突提示节点。
7. `slotGraphCompiler` 把槽位状态编译为 `GraphPatch`（add/update/edge + stale 降级，含 `conflicts_with` 关系）。
8. `sanitizeGraphPatchStrict` 严格清洗 patch。
9. `applyPatchWithGuards` 应用 patch 并输出新图（含压缩、拓扑修复）。
10. 持久化 `turns` 与 `conversations.graph`。
11. 若调用 `PUT /api/conversations/:id/graph` 保存前端改图，后续 turn 会使用这份更新图作为最新真值。

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
├─ skills/
│  ├─ intent-graph-regression/
│  │  ├─ SKILL.md
│  │  └─ agents/openai.yaml
│  ├─ uncertainty-question-flow/
│  │  ├─ SKILL.md
│  │  └─ agents/openai.yaml
│  └─ motif-foundation/
│     ├─ SKILL.md
│     └─ agents/openai.yaml
└─ src/
   ├─ index.ts
   ├─ server/
   │  └─ config.ts
   ├─ core/
   │  ├─ graph.ts
   │  ├─ graph/
   │  │  ├─ types.ts
   │  │  ├─ common.ts
   │  │  ├─ topology.ts
   │  │  └─ patchApply.ts
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
      ├─ weather/
      │  └─ advisor.ts
      ├─ uncertainty/
      │  └─ questionPlanner.ts
      ├─ graphUpdater.ts
      ├─ graphUpdater/
      │  ├─ constants.ts
      │  ├─ text.ts
      │  ├─ intentSignals.ts
      │  ├─ geoResolver.ts
      │  ├─ mcpGeoBridge.ts
      │  ├─ signalSanitizer.ts
      │  ├─ conflictAnalyzer.ts
      │  ├─ slotTypes.ts
      │  ├─ slotStateMachine.ts
      │  ├─ slotGraphCompiler.ts
      │  ├─ slotFunctionCall.ts
      │  └─ common.ts
      ├─ motif/
      │  ├─ types.ts
      │  ├─ motifGrounding.ts
      │  └─ motifCatalog.ts
      ├─ patchGuard.ts
      └─ textSanitizer.ts
```

#### 11.2 根目录文件

| 文件 | 作用 |
| --- | --- |
| `README.md` | 后端说明文档（本文件） |
| `skills/intent-graph-regression/SKILL.md` | 图回归排查技能（重复节点/时长冲突/父子地点归属） |
| `skills/uncertainty-question-flow/SKILL.md` | 不确定性驱动提问技能（每轮 1 个定向澄清问题） |
| `skills/motif-foundation/SKILL.md` | motif 地基技能（motifType/claim/revisionHistory/catalog） |
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
| `src/core/graph.ts` | 图模型门面导出（保持旧路径兼容） |
| `src/core/graph/types.ts` | CDG/Node/Edge/Patch 核心类型定义 |
| `src/core/graph/common.ts` | 图归一化与槽位辅助函数（slot key/去重/清洗） |
| `src/core/graph/topology.ts` | 图论编排（A* 锚定、Tarjan 去环、传递边裁剪、连通修复） |
| `src/core/graph/patchApply.ts` | patch 应用主线（normalize snapshot + guarded patch apply） |
| `src/core/nodeLayer.ts` | 节点四层分类（Intent/Requirement/Preference/Risk）的推断与归一化 |
| `src/services/llmClient.ts` | OpenAI SDK 客户端实例 |
| `src/services/chatResponder.ts` | 助手文本生成（非流式/伪流/真流）+ 不确定性驱动定向澄清提问 |
| `src/services/concepts.ts` | Concept 语义槽位映射/对齐/持久化（Concept 独立于节点，可 1:N 绑定 node） |
| `src/services/weather/advisor.ts` | 外部天气 API 风险检测（目的地+日期命中极端天气时主动提醒） |
| `src/services/uncertainty/questionPlanner.ts` | 不确定性评分与目标问题生成（budget/duration/destination/critical day/limiting factor） |
| `src/services/graphUpdater.ts` | 图 patch 主流程（槽位抽取、状态机融合、图编译、motif 地基补全） |
| `src/services/graphUpdater/constants.ts` | 建图正则与槽位识别常量 |
| `src/services/graphUpdater/text.ts` | 文本清洗、证据合并、去重工具 |
| `src/services/graphUpdater/intentSignals.ts` | 用户意图信号抽取（目的地/时长/预算/人数/关键日/限制因素），含跨轮时长合并与相对时间过滤 |
| `src/services/graphUpdater/geoResolver.ts` | 地理校验层（MCP 可选 + Nominatim 回退），做目的地规范化与子地点父城归属修复 |
| `src/services/graphUpdater/mcpGeoBridge.ts` | MCP 地理桥接（可选），解析地点层级关系并回传统一结构 |
| `src/services/graphUpdater/signalSanitizer.ts` | 信号二次清洗（重复节点防抖、子地点回收、噪声地名过滤、时长/城市归一化与离群修正） |
| `src/services/graphUpdater/conflictAnalyzer.ts` | 槽位冲突检测（预算-住宿、时长-目的地密度、限制因素-高强度偏好） |
| `src/services/graphUpdater/constraintClassifier.ts` | 约束语义分类器（health/language/diet/religion/legal/safety/mobility/logistics） |
| `src/services/graphUpdater/slotTypes.ts` | 槽位状态机与图编译器共享类型 |
| `src/services/graphUpdater/slotStateMachine.ts` | 槽位状态机（slot winners、总时长合并、单城市时长去重、限制因素统一建模） |
| `src/services/graphUpdater/slotGraphCompiler.ts` | 图编译器（slot state -> GraphPatch，含 stale 节点降级） |
| `src/services/graphUpdater/slotFunctionCall.ts` | function call 槽位抽取（结构化输出，含子地点归属）与信号映射 |
| `src/services/graphUpdater/common.ts` | patch 提取与临时 id 工具函数 |
| `src/services/motif/types.ts` | motif 聚合与目录类型定义 |
| `src/services/motif/motifGrounding.ts` | patch 级 motif 元数据补全（motifType/claim/priority/revisionHistory） |
| `src/services/motif/motifCatalog.ts` | motif 目录聚合与摘要（为跨任务迁移/可解释性打地基） |
| `src/services/motif/conceptMotifs.ts` | concept-level motif 构建器（稳定模板 + concept 关系实例 + concept↔motif 回写） |
| `src/services/motif/motifLinks.ts` | motif 间关系构建/合并（supports/depends_on/conflicts/refines，支持用户覆盖） |
| `src/services/motif/conflictGate.ts` | 未解决 deprecated motif 门控（阻塞继续生成，要求用户先确认） |
| `src/services/patchGuard.ts` | LLM patch 清洗与规范化（强约束） |
| `src/services/textSanitizer.ts` | 把 Markdown/LaTeX 风格文本降级为纯文本 |
| `src/services/llm.ts` | turn 编排：助手回复 + patch 生成 + 统一返回 |

---

### 12. 协作建议

1. 前后端 type 变更时，先改 `src/core/graph/types.ts`，再同步前端 `src/core/type.ts`。
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
- `CI_GEO_VALIDATE`, `CI_GEO_ENDPOINT`, `CI_GEO_TIMEOUT_MS`, `CI_GEO_MAX_LOOKUPS`, `CI_GEO_CACHE_TTL_MS`
- `CI_MCP_GEO_URL`, `CI_MCP_GEO_TIMEOUT_MS`, `CI_MCP_GEO_TOKEN`
- `CI_WEATHER_EXTREME_ALERT`, `CI_WEATHER_TIMEOUT_MS`, `CI_WEATHER_MAX_DAYS`, `CI_WEATHER_GEO_ENDPOINT`, `CI_WEATHER_FORECAST_ENDPOINT`
- `CORS_ALLOW_ALL`, `CORS_ORIGINS`

---

### 5. API summary

- `GET /healthz`
- `POST /api/auth/login`
- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:id`
- `PUT /api/conversations/:id/graph` (supports `requestAdvice` + `advicePrompt`)
- `PUT /api/conversations/:id/concepts` (save Concept panel states)
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

Main types are in `src/core/graph/types.ts` (re-exported by `src/core/graph.ts`):

- `CDG`, `ConceptNode`, `ConceptEdge`, `GraphPatch`
- Node types: `goal | constraint | preference | belief | fact | question`
- Node layers: `intent | requirement | preference | risk`
- Severity: `low | medium | high | critical`

Patch application pipeline:

1. sanitize patch
2. motif foundation grounding (`motifType/claim/revisionHistory/priority`)
3. apply guards
4. compact singleton slots (budget/duration/people/destination/limiting_factor/preference)
5. bump graph version when structural changes happen

Manual full-graph save path:

1. `PUT /graph` uses `normalizeGraphSnapshot` (light validation only).
2. It preserves user-edited topology instead of auto-rebalancing.
3. Optional advice generation can return `assistantText` in the same response.

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
skills/intent-graph-regression/SKILL.md  # graph regression skill
skills/uncertainty-question-flow/SKILL.md# uncertainty-driven questioning skill
skills/motif-foundation/SKILL.md         # motif foundation skill
src/core/graph.ts            # graph model facade (re-export)
src/core/graph/types.ts      # graph types
src/core/graph/common.ts     # normalization and slot helpers
src/core/graph/topology.ts   # A*/Tarjan/transitive-reduction topology pipeline
src/core/graph/patchApply.ts # guarded patch apply + snapshot normalization
src/core/nodeLayer.ts        # 4-layer node taxonomy inference and normalization
src/services/llmClient.ts    # OpenAI client
src/services/chatResponder.ts# assistant text generation + targeted clarification
src/services/concepts.ts     # semantic-slot concept mapping/reconcile (concept independent from nodes, 1:N grounding)
src/services/weather/advisor.ts # extreme-weather proactive advisory via external APIs
src/services/uncertainty/questionPlanner.ts # uncertainty scoring + targeted question planner
src/services/graphUpdater.ts # graph patch orchestrator (+ motif grounding)
src/services/graphUpdater/constants.ts         # graph regex/constants
src/services/graphUpdater/text.ts              # text/evidence helpers
src/services/graphUpdater/intentSignals.ts     # intent signal extraction
src/services/graphUpdater/geoResolver.ts       # geo normalization + parent-city repair (MCP optional, OSM fallback)
src/services/graphUpdater/mcpGeoBridge.ts      # optional MCP geo bridge
src/services/graphUpdater/signalSanitizer.ts   # dedup/cleanup pass for slots
src/services/graphUpdater/conflictAnalyzer.ts  # slot conflict detection
src/services/graphUpdater/constraintClassifier.ts # constraint semantic classifier
src/services/graphUpdater/slotTypes.ts         # slot state/compiler shared schema
src/services/graphUpdater/slotStateMachine.ts  # slot-state machine (winner selection)
src/services/graphUpdater/slotGraphCompiler.ts # slot-state -> graph patch compiler
src/services/graphUpdater/slotFunctionCall.ts  # function-call slot extraction
src/services/graphUpdater/common.ts            # patch parsing/temp id helpers
src/services/motif/types.ts                    # motif schema types
src/services/motif/motifGrounding.ts           # patch-time motif metadata grounding
src/services/motif/motifCatalog.ts             # motif aggregation/catalog
src/services/motif/conceptMotifs.ts            # concept-level motif builder (relation templates)
src/services/patchGuard.ts   # strict patch sanitizer
src/services/textSanitizer.ts# markdown-to-plain sanitizer
src/services/llm.ts          # turn orchestration
```

---

### 8. Collaboration notes

- Treat `src/core/graph/types.ts` as the backend graph contract source of truth (`src/core/graph.ts` keeps compatibility exports).
- Keep frontend `src/core/type.ts` aligned after every graph schema change.
- Update README API docs whenever route payloads/events change.
### 6.1 隐藏式旅行计划状态（后端）

后端在每轮 turn、保存 graph/concepts 时，都会同步维护 `travelPlanState`（存于 `conversations` 文档）：

- 摘要 `summary`
- 目的地 `destinations[]`
- 预算结构：`totalCny / spentCny / remainingCny`
- 总天数 `totalDays`
- 关键约束 `constraints[]`
- 按天行程 `dayPlans[]`

该结构用于导出 PDF 与后续“基于当前计划继续建议”，默认不在主对话界面完整展示。
