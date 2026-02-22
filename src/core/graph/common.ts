import type {
  ConceptEdge,
  ConceptNode,
  ConceptType,
  EdgeType,
  MotifEvidence,
  MotifStructure,
  MotifType,
  RevisionRecord,
  Severity,
  Status,
  Strength,
} from "./types.js";

export const ALLOW_DELETE = process.env.CI_ALLOW_DELETE === "1";

export const ALLOWED_STATUS = new Set<Status>(["proposed", "confirmed", "rejected", "disputed"]);
export const ALLOWED_STRENGTH = new Set<Strength>(["hard", "soft"]);
export const ALLOWED_SEVERITY = new Set<Severity>(["low", "medium", "high", "critical"]);
export const ALLOWED_MOTIF_TYPES = new Set<MotifType>(["belief", "hypothesis", "expectation", "cognitive_step"]);
export const ALLOWED_NODE_TYPES = new Set<ConceptType>([
  "goal",
  "constraint",
  "preference",
  "belief",
  "fact",
  "question",
]);
export const ALLOWED_EDGE_TYPES = new Set<EdgeType>(["enable", "constraint", "determine", "conflicts_with"]);
export const HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|老人|老年|儿童|行动不便|不能爬山|不能久走|危险|安全|急救|摔倒|health|medical|heart|cardiac|safety|risk/i;
export const BUDGET_HINT_RE = /预算|花费|费用|开销|贵|便宜|酒店|住宿|房费|星级/i;
export const DURATION_HINT_RE = /时长|几天|多少天|周|日程|行程|节奏/i;
export const DESTINATION_HINT_RE =
  /目的地|城市|国家|地区|路线|交通|高铁|飞机|机场|景点|出发|到达|行程段|flight|train|airport|city|destination/i;
export const PEOPLE_HINT_RE = /同行|一家|家人|父亲|母亲|老人|儿童|三口|两人|人数/i;
export const PREFERENCE_HINT_RE = /偏好|喜欢|不喜欢|感兴趣|人文|自然|文化|历史/i;
export const GENERIC_RESOURCE_HINT_RE = /预算|经费|成本|资源|工时|算力|内存|gpu|人天|cost|budget|resource|cpu|memory/i;
export const GENERIC_TIMELINE_HINT_RE = /截止|deadline|里程碑|周期|排期|冲刺|迭代|时长|天|周|月|季度|timeline|schedule/i;
export const GENERIC_STAKEHOLDER_HINT_RE = /用户|客户|老板|团队|同事|角色|stakeholder|owner|reviewer|审批/i;
export const GENERIC_RISK_HINT_RE = /风险|故障|安全|合规|隐私|法律|阻塞|依赖|上线事故|risk|security|privacy|compliance/i;
export const DESTINATION_BAD_TOKEN_RE =
  /我|你|他|她|我们|时间|之外|之前|之后|必须|到场|安排|计划|准备|打算|预算|经费|花费|费用|人民币|pre|chi|会议|汇报|报告|论文|一天|两天|三天|四天|五天|顺带|顺便|顺路|顺道|其中|其中有|其余|其他时候|海地区|该地区|看球|观赛|比赛|演讲|发表|打卡|参观|游览|所以这|因此|另外|此外|unknown|语地区|西班牙语地区|英语地区|安全一点|安静一点|方便一点|便宜一点|舒适一点|热闹一点|清净一点|治安好一点|附近一点|地方吧|地方呢|地方啊|地方呀|安全的地方|安静的地方|方便的地方|便宜的地方/i;

function normalizePlaceToken(raw: string): string {
  return cleanText(raw)
    .replace(/[省市县区州郡]/g, "")
    .replace(/[\s·•\-_/]+/g, "")
    .toLowerCase();
}

function canonicalizeStructuredPlace(raw: string): string {
  let s = cleanText(raw);
  if (!s) return "";
  s = s
    .replace(/^(在|于|去|到|前往|飞到|抵达)\s*/i, "")
    .replace(/(前|后)\s*[0-9一二三四五六七八九十两]{0,2}\s*天?$/i, "")
    .replace(/^的+/, "")
    .replace(/的+$/g, "")
    .trim();

  const sameRepeat = s.match(/^(.{2,20})的\1$/);
  if (sameRepeat?.[1]) s = cleanText(sameRepeat[1]);

  const dePair = s.match(/^(.{1,20})的(.{2,24})$/);
  if (dePair?.[1] && dePair?.[2]) {
    const left = cleanText(dePair[1]);
    const right = cleanText(dePair[2]);
    if (
      right &&
      (left === right ||
        /(中国|美国|英国|法国|德国|意大利|西班牙|葡萄牙|荷兰|比利时|瑞士|奥地利|日本|韩国|新加坡|泰国|马来西亚|印度尼西亚|澳大利亚|加拿大|新西兰|阿联酋|欧洲|亚洲|非洲|北美|南美|中东)/i.test(
          left
        ))
    ) {
      s = right;
    }
  }

  return s.replace(/^的+/, "").replace(/的+$/g, "").trim();
}

function slotFamily(slot: string | null | undefined): string {
  if (!slot) return "none";
  if (slot.startsWith("slot:destination:")) return "destination";
  if (slot.startsWith("slot:duration_city:")) return "duration_city";
  if (slot.startsWith("slot:meeting_critical:")) return "meeting_critical";
  if (slot.startsWith("slot:sub_location:")) return "sub_location";
  if (slot.startsWith("slot:conflict:")) return "conflict";
  if (slot.startsWith("slot:constraint:")) return "generic_constraint";
  if (slot === "slot:duration_total") return "duration_total";
  if (slot === "slot:duration_meeting") return "duration_meeting";
  if (slot === "slot:people") return "people";
  if (slot === "slot:budget") return "budget";
  if (slot === "slot:lodging") return "lodging";
  if (slot === "slot:scenic_preference") return "scenic_preference";
  if (slot === "slot:activity_preference") return "activity_preference";
  if (slot === "slot:health") return "health";
  if (slot === "slot:language") return "language";
  if (slot === "slot:goal") return "goal";
  return slot;
}

function isPrimarySlot(slot: string | null | undefined): boolean {
  const f = slotFamily(slot);
  return f === "people" || f === "destination" || f === "duration_total" || f === "budget";
}

function clamp01(x: any, d = 0.6) {
  const n = Number(x);
  if (!Number.isFinite(n)) return d;
  return Math.max(0, Math.min(1, n));
}

function cleanText(s: any) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTags(tags: any): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out = tags.map((t) => cleanText(t)).filter(Boolean).slice(0, 8);
  return out.length ? out : undefined;
}

function normalizeSeverity(x: any): Severity | undefined {
  const s = cleanText(x);
  if (!s) return undefined;
  if (ALLOWED_SEVERITY.has(s as Severity)) return s as Severity;
  return undefined;
}

function normalizeStringArray(input: any, max = 12): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.map((x) => cleanText(x)).filter(Boolean).slice(0, max);
  return out.length ? out : undefined;
}

function normalizeMotifType(x: any): MotifType | undefined {
  const s = cleanText(x).toLowerCase();
  if (!s) return undefined;
  if (ALLOWED_MOTIF_TYPES.has(s as MotifType)) return s as MotifType;
  return undefined;
}

function normalizeMotifStructure(input: any): MotifStructure | undefined {
  if (!input || typeof input !== "object") return undefined;
  const premises = normalizeStringArray((input as any).premises, 8);
  const inference = cleanText((input as any).inference);
  const conclusion = cleanText((input as any).conclusion);
  const out: MotifStructure = {};
  if (premises) out.premises = premises;
  if (inference) out.inference = inference;
  if (conclusion) out.conclusion = conclusion;
  return Object.keys(out).length ? out : undefined;
}

function normalizeMotifEvidence(input: any): MotifEvidence[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: MotifEvidence[] = [];
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const quote = cleanText((row as any).quote);
    if (!quote) continue;
    const item: MotifEvidence = { quote };
    const id = cleanText((row as any).id);
    const source = cleanText((row as any).source);
    const link = cleanText((row as any).link);
    if (id) item.id = id;
    if (source) item.source = source;
    if (link) item.link = link;
    out.push(item);
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

function normalizeRevisionHistory(input: any): RevisionRecord[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: RevisionRecord[] = [];
  const allowedAction = new Set<RevisionRecord["action"]>(["created", "updated", "replaced", "merged"]);
  const allowedBy = new Set<RevisionRecord["by"]>(["user", "assistant", "system"]);

  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const at = cleanText((row as any).at);
    const actionRaw = cleanText((row as any).action).toLowerCase();
    if (!at || !allowedAction.has(actionRaw as RevisionRecord["action"])) continue;
    const item: RevisionRecord = {
      at,
      action: actionRaw as RevisionRecord["action"],
    };
    const reason = cleanText((row as any).reason);
    const byRaw = cleanText((row as any).by).toLowerCase();
    if (reason) item.reason = reason;
    if (allowedBy.has(byRaw as RevisionRecord["by"])) item.by = byRaw as RevisionRecord["by"];
    out.push(item);
    if (out.length >= 10) break;
  }
  return out.length ? out : undefined;
}

function slotKeyOfNode(node: ConceptNode): string | null {
  const explicitKey = cleanText((node as any).key);
  if (explicitKey.startsWith("slot:")) return explicitKey;

  const s = cleanText(node.statement);
  if (!s) return null;

  if (node.type === "goal") return "slot:goal";
  if (node.type === "constraint" && /^预算(?:上限)?[:：]\s*[0-9]{2,}\s*元?$/.test(s)) return "slot:budget";
  if (node.type === "constraint" && /^(?:总)?行程时长[:：]\s*[0-9]{1,3}\s*天$/.test(s)) return "slot:duration_total";
  if (node.type === "constraint" && /^会议时长[:：]\s*[0-9]{1,3}\s*天$/.test(s)) return "slot:duration_meeting";
  if (node.type === "constraint" && /^(?:会议关键日|关键会议日|论文汇报日)[:：]\s*.+$/.test(s)) {
    const m = s.match(/^(?:会议关键日|关键会议日|论文汇报日)[:：]\s*(.+)$/);
    const detail = normalizePlaceToken((m?.[1] || "").slice(0, 24));
    return `slot:meeting_critical:${detail || "default"}`;
  }
  if ((node.type === "fact" || node.type === "constraint") && /^(?:城市时长|停留时长)[:：]\s*.+\s+[0-9]{1,3}\s*天$/.test(s)) {
    const m = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
    const rawCity = canonicalizeStructuredPlace(m?.[1] || "");
    if (!rawCity) return null;
    if (DESTINATION_BAD_TOKEN_RE.test(rawCity)) return null;
    if (/^的/.test(rawCity)) return null;
    if (/(前|后)$/.test(rawCity)) return null;
    if (/[A-Za-z]/.test(rawCity) && /[\u4e00-\u9fff]/.test(rawCity)) return null;
    const city = normalizePlaceToken(rawCity);
    if (city) return `slot:duration_city:${city}`;
    return "slot:duration_city:unknown";
  }
  if (node.type === "fact" && /^同行人数[:：]\s*[0-9]{1,3}\s*人$/.test(s)) return "slot:people";
  if (node.type === "fact" && /^目的地[:：]\s*.+$/.test(s)) {
    const m = s.match(/^目的地[:：]\s*(.+)$/);
    const rawCity = canonicalizeStructuredPlace(m?.[1] || "");
    if (!rawCity) return null;
    if (DESTINATION_BAD_TOKEN_RE.test(rawCity)) return null;
    if (/^的/.test(rawCity)) return null;
    if (/(前|后)$/.test(rawCity)) return null;
    if (/[A-Za-z]/.test(rawCity) && /[\u4e00-\u9fff]/.test(rawCity)) return null;
    const city = normalizePlaceToken(rawCity);
    if (city) return `slot:destination:${city}`;
    return "slot:destination:unknown";
  }
  if ((node.type === "preference" || node.type === "constraint") && /^景点偏好[:：]\s*.+$/.test(s)) return "slot:scenic_preference";
  if ((node.type === "preference" || node.type === "constraint") && /^活动偏好[:：]\s*.+$/.test(s)) return "slot:activity_preference";
  if (
    (node.type === "preference" || node.type === "constraint") &&
    (/^(住宿偏好|酒店偏好|住宿标准|酒店标准)[:：]/.test(s) ||
      /(全程|尽量|优先).{0,8}(住|入住).{0,8}(酒店|民宿|星级)/.test(s) ||
      /(五星|四星|三星).{0,6}(酒店)/.test(s))
  ) {
    return "slot:lodging";
  }
  if (node.type === "constraint" && /^限制因素[:：]\s*.+$/.test(s)) {
    const m = s.match(/^限制因素[:：]\s*(.+)$/);
    const detail = normalizePlaceToken((m?.[1] || "limiting").slice(0, 28));
    return `slot:constraint:limiting:${detail || "default"}`;
  }
  if ((node.type === "constraint" || node.type === "fact") && /^子地点[:：]\s*.+$/.test(s)) {
    const m = s.match(/^子地点[:：]\s*(.+?)(?:（(.+?)）)?$/);
    const name = normalizePlaceToken((m?.[1] || "loc").slice(0, 24)) || "loc";
    const parent = normalizePlaceToken((m?.[2] || "root").slice(0, 24)) || "root";
    return `slot:sub_location:${parent}:${name}`;
  }
  if (node.type === "constraint" && /^冲突提示[:：]\s*.+$/.test(s)) {
    const m = s.match(/^冲突提示[:：]\s*(.+)$/);
    const detail = normalizePlaceToken((m?.[1] || "conflict").slice(0, 32));
    return `slot:conflict:${detail || "default"}`;
  }
  if (node.type === "constraint" && /^语言约束[:：]\s*.+$/.test(s)) return "slot:language";
  if (node.type === "constraint" && /^(关键约束|法律约束|安全约束|出行约束|行程约束)[:：]\s*.+$/.test(s)) {
    const m = s.match(/^(?:关键约束|法律约束|安全约束|出行约束|行程约束)[:：]\s*(.+)$/);
    const detail = normalizePlaceToken((m?.[1] || "constraint").slice(0, 28));
    return `slot:constraint:${detail || "default"}`;
  }
  if (node.type === "constraint" && HEALTH_RE.test(s)) return "slot:health";
  return null;
}

function statementNumericHint(node: ConceptNode): number {
  const s = cleanText(node.statement);
  const budget = s.match(/^预算(?:上限)?[:：]\s*([0-9]{2,})\s*元?$/);
  if (budget?.[1]) return Number(budget[1]);
  const duration = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
  if (duration?.[1]) return Number(duration[1]) + 1000;
  const cityDuration = s.match(/^(?:城市时长|停留时长)[:：]\s*.+\s+([0-9]{1,3})\s*天$/);
  if (cityDuration?.[1]) return Number(cityDuration[1]);
  const meetingDuration = s.match(/^会议时长[:：]\s*([0-9]{1,3})\s*天$/);
  if (meetingDuration?.[1]) return Number(meetingDuration[1]) + 300;
  const people = s.match(/^同行人数[:：]\s*([0-9]{1,3})\s*人$/);
  if (people?.[1]) return Number(people[1]);
  return 0;
}

function durationDaysOfNode(node: ConceptNode): number {
  const s = cleanText(node.statement);
  const m = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
  if (!m?.[1]) return 0;
  return Number(m[1]) || 0;
}

function chooseDurationTotalWinner(
  nodes: ConceptNode[],
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): ConceptNode {
  return nodes
    .slice()
    .sort((a, b) => {
      const orderScore = (touchedOrder?.get(b.id) || 0) - (touchedOrder?.get(a.id) || 0);
      if (orderScore !== 0) return orderScore;

      const touchScore = (touched.has(b.id) ? 1 : 0) - (touched.has(a.id) ? 1 : 0);
      if (touchScore !== 0) return touchScore;

      const statusScore = (b.status === "confirmed" ? 1 : 0) - (a.status === "confirmed" ? 1 : 0);
      if (statusScore !== 0) return statusScore;

      const confScore = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      if (confScore !== 0) return confScore;

      const impScore = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (impScore !== 0) return impScore;

      const explicitTotalScore =
        (/^总行程时长[:：]/.test(cleanText(b.statement)) ? 1 : 0) -
        (/^总行程时长[:：]/.test(cleanText(a.statement)) ? 1 : 0);
      if (explicitTotalScore !== 0) return explicitTotalScore;

      const daysDiff = durationDaysOfNode(b) - durationDaysOfNode(a);
      if (daysDiff !== 0) return daysDiff;

      return cleanText(b.id).localeCompare(cleanText(a.id));
    })[0];
}

function chooseSlotWinner(
  nodes: ConceptNode[],
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): ConceptNode {
  return nodes
    .slice()
    .sort((a, b) => {
      const orderScore = (touchedOrder?.get(b.id) || 0) - (touchedOrder?.get(a.id) || 0);
      if (orderScore !== 0) return orderScore;

      const touchScore = (touched.has(b.id) ? 1 : 0) - (touched.has(a.id) ? 1 : 0);
      if (touchScore !== 0) return touchScore;

      const statusScore = (b.status === "confirmed" ? 1 : 0) - (a.status === "confirmed" ? 1 : 0);
      if (statusScore !== 0) return statusScore;

      const confScore = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      if (confScore !== 0) return confScore;

      const impScore = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (impScore !== 0) return impScore;

      const numericScore = statementNumericHint(b) - statementNumericHint(a);
      if (numericScore !== 0) return numericScore;

      return cleanText(b.id).localeCompare(cleanText(a.id));
    })[0];
}

function compactSingletonSlots(
  nodesById: Map<string, ConceptNode>,
  edgesById: Map<string, ConceptEdge>,
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): boolean {
  const slotToNodes = new Map<string, ConceptNode[]>();
  for (const n of nodesById.values()) {
    const slot = slotKeyOfNode(n);
    if (!slot) continue;
    if (!slotToNodes.has(slot)) slotToNodes.set(slot, []);
    slotToNodes.get(slot)!.push(n);
  }

  let changed = false;
  for (const [slot, nodes] of slotToNodes.entries()) {
    if (nodes.length <= 1) continue;
    const winner =
      slotFamily(slot) === "duration_total"
        ? chooseDurationTotalWinner(nodes, touched, touchedOrder)
        : chooseSlotWinner(nodes, touched, touchedOrder);
    for (const n of nodes) {
      if (n.id === winner.id) continue;
      nodesById.delete(n.id);
      changed = true;
      for (const [eid, e] of edgesById.entries()) {
        if (e.from === n.id || e.to === n.id) edgesById.delete(eid);
      }
    }
  }

  return changed;
}

function pruneInvalidStructuredNodes(
  nodesById: Map<string, ConceptNode>,
  edgesById: Map<string, ConceptEdge>
): boolean {
  let changed = false;
  for (const [nid, node] of nodesById.entries()) {
    const s = cleanText(node.statement);
    if (!s) continue;

    let invalid = false;
    const dest = s.match(/^目的地[:：]\s*(.+)$/);
    if (dest?.[1]) {
      const city = cleanText(dest[1]);
      if (!city || DESTINATION_BAD_TOKEN_RE.test(city) || /^的/.test(city)) invalid = true;
      if (/地区$/.test(city) && city.length <= 4) invalid = true;
      if (/(前|后)$/.test(city)) invalid = true;
      if (/[\u4e00-\u9fffA-Za-z]{1,12}(和|与|及|、|,|，)[\u4e00-\u9fffA-Za-z]{1,12}/.test(city)) invalid = true;
      if (city.length >= 7 && /(去|到|在|一起|旅游|旅行|出行|玩|逛)/.test(city)) invalid = true;
    }

    const cityDur = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+[0-9]{1,3}\s*天$/);
    if (cityDur?.[1]) {
      const city = cleanText(cityDur[1]);
      if (!city || DESTINATION_BAD_TOKEN_RE.test(city) || /^的/.test(city)) invalid = true;
      if (/地区$/.test(city) && city.length <= 4) invalid = true;
      if (/(前|后)$/.test(city)) invalid = true;
      if (/[\u4e00-\u9fffA-Za-z]{1,12}(和|与|及|、|,|，)[\u4e00-\u9fffA-Za-z]{1,12}/.test(city)) invalid = true;
      if (city.length >= 7 && /(去|到|在|一起|旅游|旅行|出行|玩|逛)/.test(city)) invalid = true;
    }

    if (!invalid) continue;
    nodesById.delete(nid);
    changed = true;
    for (const [eid, e] of edgesById.entries()) {
      if (e.from === nid || e.to === nid) edgesById.delete(eid);
    }
  }
  return changed;
}

function pruneNoisyDurationOutliers(
  nodesById: Map<string, ConceptNode>,
  edgesById: Map<string, ConceptEdge>
): boolean {
  const cityDaysByCity = new Map<string, number>();
  const totalDurationNodeIds: Array<{ id: string; days: number }> = [];

  for (const [nid, node] of nodesById.entries()) {
    const s = cleanText(node.statement);
    if (!s) continue;

    const cityDur = s.match(/^(?:城市时长|停留时长)[:：]\s*(.+?)\s+([0-9]{1,3})\s*天$/);
    if (cityDur?.[1] && cityDur?.[2]) {
      const city = cleanText(cityDur[1]).toLowerCase();
      const days = Number(cityDur[2]) || 0;
      if (!city || days <= 0 || days > 180) continue;
      if (DESTINATION_BAD_TOKEN_RE.test(city)) continue;
      cityDaysByCity.set(city, Math.max(cityDaysByCity.get(city) || 0, days));
      continue;
    }

    const totalM = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
    if (totalM?.[1]) {
      const days = Number(totalM[1]) || 0;
      if (days > 0) totalDurationNodeIds.push({ id: nid, days });
    }
  }

  if (!cityDaysByCity.size || !totalDurationNodeIds.length) return false;

  const sumCityDays = Array.from(cityDaysByCity.values()).reduce((a, b) => a + b, 0);
  if (sumCityDays <= 0) return false;

  // 允许适度冗余天数（交通/机动），但明显偏离时清理旧噪声总时长节点
  const tolerance = Math.max(2, Math.min(5, Math.floor(sumCityDays * 0.35)));
  let changed = false;

  for (const total of totalDurationNodeIds) {
    const tooLarge = total.days > sumCityDays + tolerance && total.days >= Math.ceil(sumCityDays * 1.6);
    const tooSmall = total.days < Math.max(1, Math.floor(sumCityDays * 0.45));
    if (!tooLarge && !tooSmall) continue;

    nodesById.delete(total.id);
    changed = true;
    for (const [eid, e] of edgesById.entries()) {
      if (e.from === total.id || e.to === total.id) edgesById.delete(eid);
    }
  }

  return changed;
}

function severityRank(sev?: Severity): number {
  if (sev === "critical") return 4;
  if (sev === "high") return 3;
  if (sev === "medium") return 2;
  if (sev === "low") return 1;
  return 0;
}

function edgeSignature(from: string, to: string, type: EdgeType): string {
  return `${from}|${to}|${type}`;
}

function slotPriorityScore(slot: string | null | undefined): number {
  const f = slotFamily(slot);
  if (f === "people") return 1;
  if (f === "destination") return 2;
  if (f === "duration_total") return 3;
  if (f === "budget") return 4;
  if (f === "conflict") return 5;
  if (f === "duration_city" || f === "duration_meeting" || f === "meeting_critical") return 5;
  if (f === "lodging") return 6;
  if (f === "scenic_preference") return 7;
  if (f === "activity_preference") return 7;
  if (f === "sub_location") return 8;
  return 99;
}

function rootEdgeTypeForNode(node: ConceptNode, slot: string | null): EdgeType {
  const f = slotFamily(slot);
  if (f === "budget" || f === "duration_total" || f === "health" || f === "meeting_critical") return "constraint";
  if (f === "lodging") {
    if (node.type === "constraint" || node.strength === "hard") return "constraint";
    return "enable";
  }
  if (f === "scenic_preference") {
    if (node.type === "constraint" || node.strength === "hard") return "constraint";
    return "enable";
  }
  if (f === "activity_preference") {
    if (node.type === "constraint" || node.strength === "hard") return "constraint";
    return "enable";
  }
  if (f === "people" || f === "destination") return "enable";
  if (f === "duration_city" || f === "duration_meeting" || f === "sub_location") return "determine";
  if (node.type === "constraint") return "constraint";
  if (node.type === "question") return "determine";
  return "enable";
}

function chooseRootGoal(
  nodesById: Map<string, ConceptNode>,
  touched: Set<string>,
  touchedOrder?: Map<string, number>
): ConceptNode | null {
  const goals = Array.from(nodesById.values()).filter((n) => n.type === "goal");
  if (!goals.length) return null;
  return goals
    .slice()
    .sort((a, b) => {
      const orderScore = (touchedOrder?.get(b.id) || 0) - (touchedOrder?.get(a.id) || 0);
      if (orderScore !== 0) return orderScore;
      const touchScore = (touched.has(b.id) ? 1 : 0) - (touched.has(a.id) ? 1 : 0);
      if (touchScore !== 0) return touchScore;
      const statusScore = (b.status === "confirmed" ? 1 : 0) - (a.status === "confirmed" ? 1 : 0);
      if (statusScore !== 0) return statusScore;
      const impScore = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (impScore !== 0) return impScore;
      const confScore = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      if (confScore !== 0) return confScore;
      return cleanText(a.statement).length - cleanText(b.statement).length;
    })[0];
}

function buildSyntheticGoalStatement(nodesById: Map<string, ConceptNode>): string {
  const destinations: string[] = [];
  let durationDays: number | null = null;

  for (const n of nodesById.values()) {
    const s = cleanText(n.statement);
    const dm = s.match(/^目的地[:：]\s*(.+)$/);
    if (dm?.[1]) {
      const city = cleanText(dm[1]).slice(0, 20);
      if (city && !destinations.includes(city)) destinations.push(city);
    }
    const tm = s.match(/^(?:总)?行程时长[:：]\s*([0-9]{1,3})\s*天$/);
    if (tm?.[1]) {
      const days = Number(tm[1]);
      if (Number.isFinite(days) && days > 0) durationDays = Math.max(durationDays || 0, days);
    }
  }

  const destinationPhrase = destinations.slice(0, 2).join("和");
  if (destinationPhrase && durationDays) return `意图：去${destinationPhrase}旅游${durationDays}天`;
  if (destinationPhrase) return `意图：去${destinationPhrase}旅游`;
  if (durationDays) return `意图：制定${durationDays}天计划`;
  return "意图：制定任务计划";
}

export {
  normalizePlaceToken,
  canonicalizeStructuredPlace,
  slotFamily,
  isPrimarySlot,
  clamp01,
  cleanText,
  normalizeTags,
  normalizeSeverity,
  normalizeStringArray,
  normalizeMotifType,
  normalizeMotifStructure,
  normalizeMotifEvidence,
  normalizeRevisionHistory,
  slotKeyOfNode,
  statementNumericHint,
  durationDaysOfNode,
  chooseDurationTotalWinner,
  chooseSlotWinner,
  compactSingletonSlots,
  pruneInvalidStructuredNodes,
  pruneNoisyDurationOutliers,
  severityRank,
  edgeSignature,
  slotPriorityScore,
  rootEdgeTypeForNode,
  chooseRootGoal,
  buildSyntheticGoalStatement,
};
