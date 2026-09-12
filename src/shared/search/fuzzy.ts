/**
 * Minimal dependency-free fuzzy matcher for command/search palettes.
 *
 * Subsequence matching: every character of the query must appear in the target
 * in order. Scores reward the common "good fuzzy" properties without a heavy
 * algorithm:
 *  - matching at a word boundary (start / after space, -, or /) — strongly,
 *  - continuing a previous match (contiguous run) — well,
 *  - matching the target's first character — a little extra.
 * A score of -1 means "no match"; an empty query matches everything with score
 * 0 (callers show all results). Language-agnostic: it matches code points by
 * simple lower-casing, so Arabic/English/Latin text behaves identically.
 */

export function fuzzyMatchScore(query: string, target: string): number {
  const q = (query || "").trim().toLowerCase();
  const t = (target || "").toLowerCase();
  if (q.length === 0) return 0;
  if (t.length === 0) return -1;

  let ti = 0;
  let score = 0;
  let prevMatchAt = -2;

  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;

    const prevChar = found > 0 ? t[found - 1] : "";
    const atBoundary = found === 0 || prevChar === " " || prevChar === "-" || prevChar === "/" || prevChar === ".";
    if (atBoundary) score += 8;
    else if (found === prevMatchAt + 1) score += 6;
    else score += 2;
    if (i === 0 && found === 0) score += 4;

    prevMatchAt = found;
    ti = found + 1;
  }
  return score;
}

export interface FuzzyCandidate<T> {
  item: T;
  score: number;
}

/** Rank `items` by fuzzy match against their precomputed searchable text. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  searchable: (item: T) => string
): FuzzyCandidate<T>[] {
  const terms = (query || "").trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return items.map((item) => ({ item, score: 0 }));
  const out: FuzzyCandidate<T>[] = [];
  for (const item of items) {
    let total = 0;
    let ok = true;
    for (const term of terms) {
      const score = fuzzyMatchScore(term, searchable(item));
      if (score < 0) {
        ok = false;
        break;
      }
      total += score;
    }
    if (ok) out.push({ item, score: total });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}