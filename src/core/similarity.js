/**
 * String similarity, implemented locally.
 *
 * No third-party dependency on purpose: Marcus Williams noted that the
 * agency firewall blocks a lot of outbound traffic and that a previous
 * vendor pilot broke on exactly that. A dependency-light prototype is
 * easier to get through review and to run in an air-gapped environment.
 */

import { normalizeForComparison, tokenize } from './normalize.js';

/**
 * Levenshtein edit distance, O(n*m) time, O(min(n,m)) space.
 * Inputs here are label fields (tens of characters), so this is cheap.
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Keep the shorter string on the inner axis to bound memory.
  if (a.length > b.length) [a, b] = [b, a];

  let prev = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    const curr = new Array(a.length + 1);
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1, // deletion
        curr[i - 1] + 1, // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    prev = curr;
  }
  return prev[a.length];
}

/** Edit-distance similarity in [0,1]. */
export function ratio(a, b) {
  const x = normalizeForComparison(a);
  const y = normalizeForComparison(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Token-set similarity (Jaccard over word sets).
 * Catches reordering and extra words — "Old Tom Distillery" vs
 * "Distillery, Old Tom" — which edit distance punishes heavily.
 */
export function tokenSetRatio(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * The score the verification engine actually uses: the more forgiving of
 * character-level and token-level similarity. A label may abbreviate or
 * reorder; either signal alone is enough evidence of "probably the same".
 */
export function bestSimilarity(a, b) {
  return Math.max(ratio(a, b), tokenSetRatio(a, b));
}
