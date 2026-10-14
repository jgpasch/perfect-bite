// Spec 4.2. The ingredient key: the app and the Edge Functions both call this, so client and
// server always agree on which ingredient a name means. Keep it pure (runs under Deno too).
import { SPANISH_ES_PLURALS } from './spanish-plurals.ts';

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

/**
 * Singularizes one lowercase, accent-folded word: a Spanish `-es` plural from the list generated
 * from the Spanish seed (`limones` → `limon`, spec 4.15), else the English rules.
 */
export function singularize(word: string): string {
  return Object.hasOwn(SPANISH_ES_PLURALS, word) ? SPANISH_ES_PLURALS[word] : englishSingular(word);
}

/** Simple English singularization of one lowercase word. */
export function englishSingular(word: string): string {
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
 * Folds accents (spec 4.15): `limón` → `limon`, `jalapeño` → `jalapeno`, `crème` → `creme`. Only
 * the combining marks U+0300–U+036F go, so other scripts keep theirs, and letters with no
 * decomposition (`ß`, `ø`) stay. The fold-accents migration does the same in SQL
 * (`private.fold_accents`), and the device's one-time merge uses this (`fold-accents.ts`).
 */
export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

/**
 * The ingredient key for a name: lowercase, trimmed, whitespace collapsed, accents folded,
 * punctuation stripped, last word singularized. `Cherry Tomatoes!` → `cherry tomato`,
 * `Limón` → `limon`. The display name keeps what was typed.
 */
export function normalizeIngredientName(name: string): string {
  const words = foldAccents(name.toLowerCase().normalize('NFC'))
    .replace(/['’]/g, '') // za'atar → zaatar, not "za atar"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return '';
  words[words.length - 1] = singularize(words[words.length - 1]);
  return words.join(' ');
}
