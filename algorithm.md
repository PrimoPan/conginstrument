# CogInstrument 建图算法说明（当前实现）

> 更新时间：2026-02-25
> 
> 本文档以当前代码为准，覆盖“对话 -> 信号 -> 槽位状态机 -> 图编译 -> 拓扑重平衡 -> 旅行计划导出”的完整链路。

## 0. 代码锚点（Source of Truth）

核心文件：

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/routes/conversations.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/llm.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/intentSignals.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotFunctionCall.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/signalSanitizer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/budgetLedger.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotStateMachine.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/conflictAnalyzer.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotGraphCompiler.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/motifGrounding.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/patchGuard.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/patchApply.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/common.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/topology.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/state.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/pdf.ts`

---

## 1. 端到端流水线

当前系统分成两段：

1. `槽位状态机`：把用户语言转成结构化 slots（goal/destination/duration/budget/...）
2. `图编译器 + 拓扑器`：把 slots 编译成 patch，再做全图去重、纠错、稀疏化和连通修复

```text
user turn
  -> assistant text (短窗口)
  -> graphUpdater.generateGraphPatch
       -> signal extraction (deterministic + optional function-call)
       -> geo resolve
       -> signal sanitizer
       -> budget ledger replay (长窗口)
       -> slot state machine
       -> slot graph compiler (patch)
       -> motif grounding + strict patch sanitize
  -> applyPatchWithGuards
       -> apply ops
       -> structured node pruning
       -> slot singleton compaction
       -> topology rebalance (A* + Tarjan + reduction + repair)
  -> persist graph + concepts/motifs/contexts + travelPlanState
```

---

## 2. 输入窗口策略（短上下文 + 长状态）

当前不是单一窗口。

- 回答生成窗口：最近 10 轮 user/assistant（低成本、保证对话流畅）
- 建图/预算状态窗口：长窗口用户轮（默认最多 140~160 条）

实现位置：`/Users/primopan/UISTcoginstrument/app/conginstrument/src/routes/conversations.ts`

意义：

- 避免“预算增量在后轮丢失”
- 避免总时长/目的地只看最近几句导致回退

---

## 3. 信号提取（IntentSignals）

实现位置：

- `extractIntentSignals`: `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/intentSignals.ts`
- `extractIntentSignalsByFunctionCall`: `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotFunctionCall.ts`
- merge逻辑：`/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater.ts`

### 3.1 规则解析（deterministic）

提取字段包括：

- 目的地、城市时长、总时长、关键日、子地点
- 预算上限、预算增量、已花预算、已花增量、剩余预算
- 同行人数、健康/语言/泛化约束
- 景点偏好、活动偏好、住宿偏好

### 3.2 Function-call 槽位提取（可开关）

`CI_GRAPH_USE_FUNCTION_SLOTS != 0` 时启用。

- function-call 结果用于补齐语义
- 规则解析在关键标量上仍有优先权（例如用户明确说“玩3天”）

当前保护逻辑：若检测到直接时长表达，且 function-call 时长与规则时长冲突，会回退到规则时长。

### 3.3 地理归一化 + 清洗

`signalSanitizer` 做三类关键处理：

1. 目的地去噪与规范化（过滤“安全一点的地方”“一个人去米兰”这类伪地名）
2. 子地点父子归并（子地点不升级为平级目的地）
3. 时长重整（城市分段、会议时段、显式总时长之间求一致）

---

## 4. 预算状态机（Budget Ledger）

实现位置：`/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/budgetLedger.ts`

### 4.1 事件类型

- `budget_set`：设置总预算
- `budget_adjust`：预算增减
- `expense_commit`：已确认支出
- `expense_refund`：退款/返还
- `expense_pending`：待确认支出（不计入已花）

### 4.2 记账口径（当前实现）

- 仅用户确认支出进入 `expense_commit`
- “帮我扣掉/预留”但未确认金额时进入 `expense_pending`
- 外币入账使用汇率快照（默认内置，可由环境变量覆盖）

### 4.3 重放方程

```text
total := undefined
spent := 0
pending := 0

for ev in events (chronological):
  if ev.type == budget_set:
     total = ev.amount
  if ev.type == budget_adjust:
     total = (total ?? 0) + ev.amount
  if ev.type == expense_commit:
     spent = ev.mode==absolute ? ev.amount : spent + ev.amount
  if ev.type == expense_refund:
     spent = max(spent - ev.amount, 0)
  if ev.type == expense_pending:
     pending += ev.amount

remaining = total is defined ? max(total - spent, 0) : undefined
```

账本结果会强覆盖图信号中的预算标量，避免“5000 + 5000 未落图”问题。

---

## 5. 槽位状态机（Slot State Machine）

实现位置：`/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotStateMachine.ts`

状态机输出：

- `nodes: SlotNodeSpec[]`
- `edges: SlotEdgeSpec[]`

### 5.1 目标节点

始终生成 `slot:goal`，并把总时长强行对齐到 `DurationState.totalDays`，避免“意图6天/总时长3天”分叉显示。

### 5.2 时长共识（DurationState）

候选集合：

- `explicit_total`（用户显式总时长）
- `city_sum`（城市分段求和）
- `max_segment`（最大分段）

采用加权中位数并加规则修正：

```text
totalDays = weightedMedian(explicit_total, city_sum, max_segment)

if multi-city + has travel segments:
  prefer city_sum when totalDays underestimates

if explicit_total is huge outlier and not explicit-total cue:
  fallback to city_sum
```

这一步用于压制“14天幽灵值”等异常总时长。

### 5.3 预算相关 slots

当前生成 4 类预算槽位：

- `slot:budget`（预算上限）
- `slot:budget_spent`（已花预算）
- `slot:budget_pending`（待确认支出）
- `slot:budget_remaining`（剩余预算）

计算式：

```text
remaining = max(totalBudget - spentBudget, 0)
remainingNode uses max(remainingByCalc, remainingBySignal)
```

并建立依赖边：

- `budget -> budget_remaining (determine)`
- `budget_spent -> budget_remaining (determine)`
- `budget_pending -> budget_remaining (determine)`
- `budget_remaining -> goal (constraint)`

### 5.4 限制因素统一

健康/语言/饮食/宗教/安全/法律等统一入 `限制因素` 家族，输出 slot 前缀：

- `slot:constraint:limiting:<kind>:<text>`

并按 hard/soft 选择 `constraint` 或 `determine` 连到 `goal`。

### 5.5 关键日与子地点

- 关键日（例如看球、汇报）输出 risk 层 `constraint`
- 若关键日带城市且命中目的地，连到该目的地；否则连到 goal
- 子地点优先连到父目的地，不上提为平级主目的地

---

## 6. 冲突分析（Conflict Analyzer）

实现位置：`/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/conflictAnalyzer.ts`

### 6.1 目的地冲突 guard（误报修复核心）

冲突计算前先做：

- canonical 归一化
- 噪声短语剔除
- 近重复压缩

只有当 `destinations.length >= 2` 时才允许触发 `duration_destination_density`。

### 6.2 当前冲突规则

- `budget_lodging`：预算 vs 豪华住宿
- `duration_destination_density`：目的地数量 vs 总时长
- `mobility_scenic_conflict`：高强度偏好 vs 行动/健康限制
- `too_many_hard_constraints`：硬约束过多且时长过短

冲突节点统一生成 `slot:conflict:*`，并建立：

- `conflict -> goal (constraint)`
- `conflict -> related_slots (conflicts_with)`

---

## 7. Slot 图编译器（Patch Compiler）

实现位置：`/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/graphUpdater/slotGraphCompiler.ts`

### 7.1 主节点选举

对同一 slotKey 的历史节点做分组，选主节点：

- 优先 confirmed
- 然后 confidence
- 再 importance

### 7.2 冗余节点清理

- 冗余节点：优先 `remove_node` + 断边
- 锁定节点：降级为 rejected + `stale_slot/auto_cleaned` 标签

### 7.3 目标槽位对齐

当前状态机没有产出的旧 slot 会被标记 stale/移除，避免旧噪声残留污染后续回合。

---

## 8. Motif Grounding + Patch Guard

实现位置：

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/motif/motifGrounding.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/patchGuard.ts`

流程：

```text
rawPatch
  -> enrichPatchWithMotifFoundation
  -> sanitizeGraphPatchStrict
```

补齐字段：

- `motifType`
- `claim`
- `priority`
- `revisionHistory`

Patch Guard 负责：

- op 白名单
- node/edge 类型白名单
- 分数字段 clamp
- 结构化字段归一化

---

## 9. Patch 应用后的拓扑重平衡（核心图论部分）

实现位置：

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/patchApply.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/core/graph/topology.ts`

应用顺序：

1. patch 执行（含临时 id 重写）
2. `pruneInvalidStructuredNodes`
3. `pruneNoisyDurationOutliers`
4. `compactSingletonSlots`
5. `rebalanceIntentTopology`

### 9.1 Root 选择与骨架约束

- 保留单一 goal root
- Primary slots（people/destination/duration_total/budget）优先成为结构主干
- duration/budget 等硬约束作为“主动脉”约束后续分支

### 9.2 A*-style anchor（非 slot 节点挂载）

代价：

```text
travelCost(edge) = typeBias(edge.type) + 0.35 * (1 - edge.confidence)

typeBias(determine)=1.08
typeBias(enable)=0.95
typeBias(constraint)=0.88

semanticPenalty = lexical(1-Jaccard)
                + slotDistancePenalty
                + typePenalty
                + riskPenalty

score(anchor) = g(root->anchor) + semanticPenalty
```

用于把非结构化节点挂到最合理锚点，而不是全部回根。

### 9.3 自适应稀疏参数

```text
density   = |E| / (|V| * log2(|V|+1))
cycleRate = (#nodes in SCC cycles) / |V|

lambda = clip(0.38 + 0.24*tanh(density - 1) + 0.36*cycleRate, 0, 1)

maxRootIncoming = clip(round(9 - 4*lambda), 4, 10)
maxAStarSteps   = clip(round(30 + |V|*(0.28 + (1-lambda)*0.35)), 20, 96)
transitiveCutoff= clip(0.72 - 0.18*lambda, 0.48, 0.9)
```

### 9.4 Tarjan 去环 + 近似传递约简

Tarjan SCC 后，按 keep score 最低边优先删除：

```text
keepScore(edge) = typeScore
                + 0.9*edge.confidence
                + 0.65*avg(node.importance)
                + touchedBonus
                + toRootBonus
                + riskBonus
```

随后做 transitive reduction（带 root reachability 保护），最后修复断连节点：

```text
if node cannot reach root:
   add node -> root with inferred edge type
```

---

## 10. 旅行计划隐式状态与 PDF 导出

实现位置：

- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/state.ts`
- `/Users/primopan/UISTcoginstrument/app/conginstrument/src/services/travelPlan/pdf.ts`

### 10.1 状态源

`travelPlanState` 预算字段以 ledger 重放结果优先：

- `budgetSummary.totalCny`
- `budgetSummary.spentCny`
- `budgetSummary.remainingCny`
- `budgetSummary.pendingCny`

并保留 `budgetLedger[]` 作为证据链。

### 10.2 去噪与去重

- 确认模板问句过滤（例如“请确认是否硬约束”）
- 段落 hash 去重
- 约束表述规范化（避免“限制因素: 限制因素…”重复）

### 10.3 PDF 结构

当前导出固定结构：

1. 摘要
2. 概览
3. 可执行行程
4. 预算台账（事件流）
5. 关键约束
6. 附录（证据片段）

---

## 11. 配置项（与算法行为相关）

- `CI_GRAPH_USE_FUNCTION_SLOTS`：是否启用 function-call 槽位抽取
- `CI_GRAPH_MODEL`：图抽取模型
- `CI_ALLOW_DELETE`：是否允许 remove_node/remove_edge 在 apply 阶段生效
- `CI_DATE_RANGE_BOUNDARY_MODE`：日期区间边界策略（auto/inclusive/exclusive）
- `CI_FX_<CUR>_TO_CNY`：汇率覆盖（如 EUR/USD/GBP）
- `CI_PDF_FONT_PATH`：PDF CJK 字体路径

> 注意：`patchGuard` 与 `applyPatchWithGuards` 都会影响删除行为；生产建议统一配置 `CI_ALLOW_DELETE`，避免行为歧义。

---

## 12. 当前已覆盖的关键 bug（对照）

1. **预算不更新**：通过 ledger 重放修复（总预算、已花、剩余分槽位）
2. **“两个目的地三天”误报**：通过目的地 canonical + 去噪 + `<2目的地` guard 修复
3. **旧节点污染**：slot compiler stale 清理 + core 层二次去噪
4. **总时长跳变（如 14 天）**：duration consensus + outlier pruning 修复
5. **导出重复/不可读**：exportNarrative 去重 + 结构化 PDF 修复

---

## 13. 后续增强建议（与当前代码兼容）

1. 把 `expense_pending -> expense_commit` 做显式确认状态迁移（当前仍偏规则驱动）
2. 冲突节点增加 `resolvedBy=user/system`，支持前端一键消歧
3. 目的地层引入更稳定的地理层级缓存（city/region/venue）
4. PDF 增加“精简版/附录版”导出选项

