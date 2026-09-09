/**
 * Pure, framework-free search engine used by the renderer "Find" modal.
 *
 * Intentionally generic: callers build a flat list of `SearchableItem`s
 * (canvas objects, the current project…), and `searchItems` returns
 * relevance-ranked hits. No DOM, no Node — safe for desktop, web and tests.
 */

export interface SearchableItem {
  id: string;
  kind: string;
  label: string;
  /** Free text (already displayed text, urls, author names…). */
  text: string;
  tags: readonly string[];
  /** Localized-ish type word, e.g. "note", "shape", "frame". */
  typeLabel: string;
  /** Optional confidence bump (e.g. favor notes over decorative shapes). */
  scoreBoost?: number;
}

export interface RankedHit {
  id: string;
  kind: string;
  label: string;
  typeLabel: string;
  snippet: string;
  score: number;
}

/** Lowercase, split on non-letters/digits, drop empties. */
export function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Trim every tag and drop empties, de-duplicating case-insensitively. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw).trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function escapeText(s: string): string {
  return String(s || "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Build a short context snippet around the first query-term occurrence. */
function snippet(text: string, term: string): string {
  const lower = String(text || "").toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return escapeText(text.slice(0, 90));
  const start = Math.max(0, idx - 24);
  const end = Math.min(text.length, idx + term.length + 40);
  return (start > 0 ? "…" : "") + escapeText(text.slice(start, end)) + (end < text.length ? "…" : "");
}

/** Rank items against a multi-term query. Every term must match something. */
export function searchItems(items: readonly SearchableItem[], query: string, maxResults = 50): RankedHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const hits: RankedHit[] = [];
  for (const it of items) {
    const labelLower = String(it.label || "").toLowerCase();
    const typeLower = String(it.typeLabel || "").toLowerCase();
    const textTokens = new Set(tokenize(`${it.label} ${it.text}`));
    const tagsLower = normalizeTags(it.tags).map((t) => t.toLowerCase());

    let score = 0;
    let matched = 0;
    for (const term of terms) {
      let termScore = 0;
      if (labelLower.startsWith(term)) termScore += 10;
      else if (labelLower.includes(term)) termScore += 7;
      const exactTag = tagsLower.some((t) => t === term || t.startsWith(term));
      if (exactTag) termScore += 8;
      else if (tagsLower.some((t) => t.includes(term))) termScore += 4;
      if (textTokens.has(term)) termScore += 5;
      if (typeLower.startsWith(term)) termScore += 3;
      if (termScore === 0) {
        for (const tok of textTokens) {
          if (tok.startsWith(term)) {
            termScore += 2;
            break;
          }
        }
      }
      if (termScore === 0) {
        score = -1;
        break;
      }
      matched++;
      score += termScore;
    }
    if (score < 0 || matched < terms.length) continue;
    score += it.scoreBoost ?? 0;
    hits.push({
      id: it.id,
      kind: it.kind,
      label: String(it.label || "(untitled)"),
      typeLabel: it.typeLabel,
      snippet: snippet(`${it.label} ${it.text}`, terms[0]),
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return hits.slice(0, maxResults);
}