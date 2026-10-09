// Spec 4.2. The ingredient key: the app and the Edge Functions both call this, so client and
// server always agree on which ingredient a name means. Keep it pure (runs under Deno too).

/** Words that end in "s" but are already singular (or have no singular). */
const UNCOUNTABLE = new Set([
  'asparagus',
  'bitters',
  'couscous',
  'grits',
  'hummus',
  'molasses',
  'schnapps',
  'swiss',
]);

/** Plurals the suffix rules below get wrong. */
const IRREGULAR: Record<string, string> = {
  brownies: 'brownie',
  calves: 'calf',
  chilies: 'chili',
  chillies: 'chilli',
  cookies: 'cookie',
  geese: 'goose',
  halves: 'half',
  knives: 'knife',
  leaves: 'leaf',
  loaves: 'loaf',
  pierogies: 'pierogi',
  pies: 'pie',
  smoothies: 'smoothie',
  veggies: 'veggie',
};

/** Simple English singularization of one lowercase word. */
export function singularize(word: string): string {
  if (word.length < 3 || UNCOUNTABLE.has(word)) return word;
  if (word in IRREGULAR) return IRREGULAR[word];
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`; // berries, anchovies
  if (word.endsWith('oes')) return word.slice(0, -2); // tomatoes, potatoes
  if (/(ch|sh|x|ss|zz)es$/.test(word)) return word.slice(0, -2); // peaches, radishes, boxes, glasses
  if (/(ss|us|is)$/.test(word)) return word; // watercress, citrus
  if (word.endsWith('s')) return word.slice(0, -1); // eggs, limes, olives
  return word;
}

/**
 * The ingredient key for a name: lowercase, trimmed, whitespace collapsed, punctuation stripped,
 * last word singularized. `Cherry Tomatoes!` → `cherry tomato`.
 */
export function normalizeIngredientName(name: string): string {
  const words = name
    .toLowerCase()
    .normalize('NFC')
    .replace(/['’]/g, '') // za'atar → zaatar, not "za atar"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return '';
  words[words.length - 1] = singularize(words[words.length - 1]);
  return words.join(' ');
}
