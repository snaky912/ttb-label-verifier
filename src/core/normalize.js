/**
 * Text normalization helpers.
 *
 * Every comparison in this app runs on normalized text, never raw text.
 * Normalization is deliberately layered so a verdict can say *how* two
 * values differed: identical, identical-but-for-presentation, or actually
 * different.
 */

/** Characters that vary by typesetting but carry no meaning for matching. */
const SMART_QUOTES = /[‘’‚‛′´`]/g; // ' ' ‚ ‛ ′ ´ `
const SMART_DQUOTES = /[“”„‟″]/g; // " " „ ‟ ″
const DASHES = /[‐‑‒–—―−]/g; // ‐ ‑ ‒ – — ― −

/**
 * Level 1 — presentation normalization.
 * Fixes only how characters were typeset. Case and words are untouched.
 * Two strings equal after this differ *only* in typography.
 */
export function normalizeTypography(input) {
  if (input == null) return '';
  return String(input)
    .normalize('NFKC')
    .replace(SMART_QUOTES, "'")
    .replace(SMART_DQUOTES, '"')
    .replace(DASHES, '-')
    .replace(/ /g, ' ')
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    .trim();
}

/**
 * Level 2 — comparison normalization.
 * Adds case folding and punctuation removal. This is the level at which
 * "STONE'S THROW" and "Stone's Throw" become the same string — the case
 * Dave Morrison raised in the discovery interview.
 */
export function normalizeForComparison(input) {
  return normalizeTypography(input)
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"?\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split normalized text into comparison tokens. */
export function tokenize(input) {
  const n = normalizeForComparison(input);
  return n ? n.split(' ') : [];
}

/**
 * True when a string's letters are all uppercase (ignoring digits,
 * punctuation and spaces). Used for the "GOVERNMENT WARNING:" caps rule.
 * A string containing no letters at all returns false — there is nothing
 * to have capitalized.
 */
export function isAllCaps(input) {
  const s = normalizeTypography(input);
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (!letters) return false;
  return letters === letters.toUpperCase();
}

/** Collapse to a single line for display in a report. */
export function oneLine(input, max = 120) {
  const s = normalizeTypography(input);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
