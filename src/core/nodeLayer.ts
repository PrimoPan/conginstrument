export type NodeLayer = "intent" | "requirement" | "preference" | "risk";

export type NodeLayerHint = {
  type?: string | null;
  statement?: string | null;
  strength?: string | null;
  severity?: string | null;
  importance?: number | null;
  tags?: string[] | null;
  locked?: boolean | null;
  layer?: string | null;
};

const ALLOWED_NODE_LAYERS = new Set<NodeLayer>(["intent", "requirement", "preference", "risk"]);

const RISK_STATEMENT_RE =
  /风险|危险|安全|医疗|健康|法律|合规|隐私|故障|阻塞|事故|urgent|critical|safety|risk|medical|health|security|compliance|privacy|hazard/i;
const RISK_TAG_RE = /health|medical|risk|safety|security|deadline|urgent|critical|legal|compliance|privacy/i;

const PREFERENCE_STATEMENT_RE =
  /偏好|喜欢|更喜欢|倾向|想要|希望|不喜欢|不感兴趣|prefer|preference|like|dislike|wish/i;
const REQUIREMENT_STATEMENT_RE =
  /必须|务必|硬性|强制|截止|deadline|约束|限制|预算|人数|目的地|时长|工期|里程碑|资源|范围|constraint|requirement/i;
const STRUCTURED_REQUIREMENT_RE =
  /^(?:目的地|同行人数|预算(?:上限)?|总?行程时长|会议时长|城市时长|停留时长|住宿偏好|酒店偏好|健康约束|会议关键日|关键会议日|论文汇报日)[:：]/;

function cleanText(input: unknown) {
  return String(input ?? "").trim();
}

export function normalizeNodeLayer(value: unknown): NodeLayer | undefined {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return undefined;

  const alias: Record<string, NodeLayer> = {
    intent: "intent",
    requirement: "requirement",
    preference: "preference",
    risk: "risk",
    goal: "intent",
    constraint: "requirement",
  };

  const mapped = alias[raw];
  if (mapped && ALLOWED_NODE_LAYERS.has(mapped)) return mapped;
  return undefined;
}

function hasRiskTags(tags: string[] | null | undefined): boolean {
  if (!Array.isArray(tags) || !tags.length) return false;
  return tags.some((tag) => RISK_TAG_RE.test(cleanText(tag)));
}

export function inferNodeLayer(node: NodeLayerHint): NodeLayer {
  const type = cleanText(node.type).toLowerCase();
  const statement = cleanText(node.statement);
  const strength = cleanText(node.strength).toLowerCase();
  const severity = cleanText(node.severity).toLowerCase();
  const importance = Number(node.importance);
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const locked = !!node.locked;

  // Goal is always the intent layer.
  if (type === "goal") return "intent";

  // Respect explicit layer except the invalid case: non-goal cannot be intent.
  const explicit = normalizeNodeLayer(node.layer);
  if (explicit && explicit !== "intent") return explicit;

  if (/^意图[:：]/.test(statement) || /^intent[:：]/i.test(statement)) {
    return "intent";
  }

  const riskByScore = severity === "high" || severity === "critical" || (Number.isFinite(importance) && importance >= 0.9);
  const riskByRule = RISK_STATEMENT_RE.test(statement) || hasRiskTags(tags);
  if (riskByScore || riskByRule || (locked && strength === "hard")) {
    return "risk";
  }

  if (type === "preference" || PREFERENCE_STATEMENT_RE.test(statement) || strength === "soft") {
    return "preference";
  }

  if (
    type === "constraint" ||
    strength === "hard" ||
    STRUCTURED_REQUIREMENT_RE.test(statement) ||
    REQUIREMENT_STATEMENT_RE.test(statement) ||
    type === "fact" ||
    type === "question" ||
    type === "belief"
  ) {
    return "requirement";
  }

  return "requirement";
}
