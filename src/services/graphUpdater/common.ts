export function extractBetween(text: string, start: string, end: string): string | null {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < 0 || e <= s) return null;
  return text.slice(s + start.length, e).trim();
}

export function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function makeTempId(prefix: string) {
  return `t_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
