export function cleanStatement(s: any, maxLen = 180) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(用户任务|任务|用户补充)[:：]\s*/i, "")
    .trim()
    .slice(0, maxLen);
}

export function sentenceParts(text: string) {
  return String(text || "")
    .split(/[。！？!?；;\n]/)
    .map((x) => cleanStatement(x, 120))
    .filter(Boolean);
}

export function mergeTextSegments(parts: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const s = String(raw || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.join("\n");
}

export function mergeTags(a?: string[], b?: string[]) {
  const set = new Set<string>([...(a || []), ...(b || [])].map((x) => String(x).trim()).filter(Boolean));
  return set.size ? Array.from(set).slice(0, 8) : undefined;
}

export function mergeEvidence(a?: Array<string | null | undefined>, b?: Array<string | null | undefined>) {
  const set = new Set<string>(
    [...(a || []), ...(b || [])]
      .map((x) => cleanStatement(x, 60))
      .filter((x): x is string => Boolean(x))
  );
  return set.size ? Array.from(set).slice(0, 6) : undefined;
}
