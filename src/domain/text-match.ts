// Splitting a name around what was typed, to set the matched part in bold. Pure.

export type MatchParts = { before: string; match: string; after: string };

/**
 * Splits `text` around the first case-insensitive occurrence of `query`, preferring one at the
 * start of a word (autocomplete matches the start of a word: "chi" in "Dried chilies"). Null when
 * `query` is blank or isn't in `text`.
 */
export function matchParts(text: string, query: string): MatchParts | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const lower = text.toLowerCase();
  let index = -1;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + 1)) {
    if (index === -1) index = i;
    if (i === 0 || /\s/.test(lower[i - 1])) {
      index = i;
      break;
    }
  }
  if (index === -1) return null;
  return { before: text.slice(0, index), match: text.slice(index, index + q.length), after: text.slice(index + q.length) };
}
