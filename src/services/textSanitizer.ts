// src/services/textSanitizer.ts
export function stripMarkdownToText(input: string): string {
  let s = String(input ?? "");

  // normalize newlines
  s = s.replace(/\r\n/g, "\n");

  // code fences: keep inner, drop ``` markers
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, inner) => inner);

  // inline code
  s = s.replace(/`([^`]+)`/g, "$1");

  // images + links
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // headings / blockquotes
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");

  // bold/italic markers
  s = s.replace(/\*\*(.*?)\*\*/g, "$1");
  s = s.replace(/__(.*?)__/g, "$1");
  s = s.replace(/\*(.*?)\*/g, "$1");
  s = s.replace(/_(.*?)_/g, "$1");

  // bullet list markers at line start
  s = s.replace(/^\s*[-*+]\s+/gm, "");

  // horizontal rules
  s = s.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "");

  // LaTeX-ish (保守清理：只清理明显环境/数学模式)
  s = s.replace(/\$\$[\s\S]*?\$\$/g, "");
  s = s.replace(/\$[^$]+\$/g, "");
  s = s.replace(/\\begin\{[^\}]+\}[\s\S]*?\\end\{[^\}]+\}/g, "");
  // 常见命令残留（避免误伤中文，这里只清理 \command{...} 这种）
  s = s.replace(/\\[a-zA-Z]+(\[[^\]]*\])?(\{[^}]*\})?/g, "");

  // leftover fences
  s = s.replace(/```/g, "");

  // whitespace normalize
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}
