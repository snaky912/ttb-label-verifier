/**
 * Word-level diff, used to show an agent exactly how a submitted
 * government warning departs from the statutory text.
 *
 * Jenny Park's interview made the case for this: the warning has to match
 * word for word, and "it doesn't match" is useless feedback when the
 * paragraph is fifty words long. The agent needs to see the changed word.
 */

/** Longest-common-subsequence table over two token arrays. */
function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/**
 * Diff two strings by word.
 * Returns an array of `{ type: 'same'|'removed'|'added', value }`, where
 * "removed" is text expected by the regulation and absent from the label,
 * and "added" is text the label carries that the regulation does not.
 */
export function wordDiff(expected, actual) {
  const a = String(expected).split(/(\s+)/).filter((t) => t.length);
  const b = String(actual).split(/(\s+)/).filter((t) => t.length);
  const table = lcsTable(a, b);

  const out = [];
  let i = 0;
  let j = 0;
  const push = (type, value) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.value += value;
    else out.push({ type, value });
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('removed', a[i]);
      i++;
    } else {
      push('added', b[j]);
      j++;
    }
  }
  while (i < a.length) push('removed', a[i++]);
  while (j < b.length) push('added', b[j++]);

  return out;
}

/** A short human summary of the first few differences. */
export function summarizeDiff(parts, max = 3) {
  const changes = parts.filter((p) => p.type !== 'same' && p.value.trim());
  if (!changes.length) return '';
  const described = changes.slice(0, max).map((p) =>
    p.type === 'removed'
      ? `missing "${p.value.trim()}"`
      : `unexpected "${p.value.trim()}"`,
  );
  const extra = changes.length - described.length;
  return described.join('; ') + (extra > 0 ? `; and ${extra} more difference${extra === 1 ? '' : 's'}` : '');
}
