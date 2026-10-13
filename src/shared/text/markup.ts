/**
 * Lightweight inline markup for notes and text objects.
 *
 * Supported syntax (all optional — plain text renders identically):
 *   **bold**  *italic*  _underline_  `code`  [label](url)
 * Lines prefixed with #/##/### become headings.
 * Lines starting with - or * or 1. become bullet/numbered list items.
 */

export interface MarkupRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  link?: string;
}

export type MarkupLineKind = "heading" | "bullet" | "numbered" | "paragraph";

export interface MarkupLine {
  kind: MarkupLineKind;
  level: number;
  runs: MarkupRun[];
}

// ── inline parser ────────────────────────────────────────────────────────────

const INLINE_RE = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/;

function parseInline(text: string): MarkupRun[] {
  if (!text) return [{ text: "" }];
  const runs: MarkupRun[] = [];
  const parts = text.split(INLINE_RE);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      runs.push({ text: part.slice(2, -2), bold: true });
    } else if (part.startsWith("*") && part.endsWith("*") && !part.startsWith("**") && part.length > 2) {
      runs.push({ text: part.slice(1, -1), italic: true });
    } else if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      runs.push({ text: part.slice(1, -1), underline: true });
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      runs.push({ text: part.slice(1, -1), code: true });
    } else if (part.startsWith("[") && part.includes("](")) {
      const match = part.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
      if (match) runs.push({ text: match[1], link: match[2] });
      else runs.push({ text: part });
    } else {
      runs.push({ text: part });
    }
  }
  return runs.length ? runs : [{ text }];
}

// ── line parser ──────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)\d{1,3}[.)]\s+(.*)$/;

export function parseMarkup(text: string): MarkupLine[] {
  const out: MarkupLine[] = [];
  const raw = String(text ?? "").split("\n");
  for (const line of raw) {
    const h = HEADING_RE.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1].length, runs: parseInline(h[2]) });
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b) {
      const indent = Math.min(3, Math.floor(b[1].length / 2));
      out.push({ kind: "bullet", level: indent + 1, runs: parseInline(b[2]) });
      continue;
    }
    const n = NUMBERED_RE.exec(line);
    if (n) {
      out.push({ kind: "numbered", level: 1, runs: parseInline(n[2]) });
      continue;
    }
    out.push({ kind: "paragraph", level: 0, runs: parseInline(line) });
  }
  return out;
}
