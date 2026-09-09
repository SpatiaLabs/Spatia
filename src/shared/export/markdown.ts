/**
 * Markdown export. Text-bearing objects (notes, text, links) become headings /
 * paragraphs / links; purely visual objects are summarized in a trailing count
 * so the exported document stays truthful about what was skipped.
 */
import type { CanvasObject } from "../types/object.js";

const VISUAL_KINDS = ["shape", "connection", "image", "file", "frame", "group", "pen"] as const;

export function buildMarkdown(projectName: string, objects: readonly CanvasObject[]): string {
  const sorted = [...objects].sort((a, b) => a.zIndex - b.zIndex);
  const parts: string[] = [];
  const skipped = new Map<string, number>();

  for (const o of sorted) {
    if (o.type === "note") {
      const title = (o.title || "Note").trim();
      const body = (o.text || "").trim().replace(/\n{3,}/g, "\n\n");
      parts.push(`## ${title}\n\n${body || "_Empty note_"}`);
    } else if (o.type === "text") {
      const text = (o.text || "").trim();
      if (text) parts.push(text);
    } else if (o.type === "url") {
      const label = o.title || o.url;
      parts.push(`- [${label}](${o.url})`);
    } else {
      skipped.set(o.type, (skipped.get(o.type) ?? 0) + 1);
    }
  }

  const body = parts.join("\n\n").trim();
  let out = `# ${projectName}\n\n`;
  if (body) out += body + "\n";

  const visual = VISUAL_KINDS
    .map((k) => skipped.get(k))
    .map((n, i) => (n ? `${n} ${VISUAL_KINDS[i]}${n === 1 ? "" : "s"}` : ""))
    .filter(Boolean);
  if (visual.length > 0) {
    out += `\n_This export omits visual/props elements (${visual.join(", ")}); open the .spatia file for the full canvas._\n`;
  }
  return out;
}