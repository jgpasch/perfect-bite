// Spec 4.15: builds the Spanish plural list (`../spanish-plurals.ts`) from the Spanish seed. The
// English suffix rules can't tell `limones` from `scones`, so every Spanish seed word whose plural
// they'd get wrong is listed with its singular. Regenerate after changing the seed:
//
//   yarn seed:es-plurals

import { englishSingular, foldAccents } from '../ingredient-normalizer.ts';

/**
 * The Spanish plural of a lowercase, accent-folded word: `-z` → `-ces` (`nuez` → `nueces`), `+es`
 * after `l n r d j y` (`limon` → `limones`), else `+s` (`leche` → `leches`, `bistec` → `bistecs`).
 * Null for a word already ending in `s` or `x` (a plural, or one that doesn't change).
 */
export function spanishPlural(word: string): string | null {
  if (!word || /[sx]$/.test(word)) return null;
  if (word.endsWith('z')) return `${word.slice(0, -1)}ces`;
  if (/[lnrdjy]$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/**
 * The last word of a name as `normalizeIngredientName` sees it before singularizing it (the only
 * word it singularizes): lowercase, accents folded, apostrophes dropped.
 */
export function lastWord(name: string): string {
  const folded = foldAccents(name.toLowerCase().normalize('NFC')).replace(/['’]/g, '');
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.at(-1) ?? '';
}

/**
 * The plural people would type for a name's last word, or null: none for a word already plural
 * (`aguacates`) or a verb after `para` (`carne para asar`).
 */
export function lastWordPlural(name: string): string | null {
  if (/\bpara \S+(ar|er|ir)$/u.test(foldAccents(name.toLowerCase()))) return null;
  return spanishPlural(lastWord(name));
}

/**
 * Plural → singular for each name's last word whose Spanish plural the English rules get wrong
 * (`limones` → `limon`, `leches` → `leche`, `nueces` → `nuez`), sorted by plural.
 */
export function buildSpanishEsPlurals(names: readonly string[]): Record<string, string> {
  const pairs = new Map<string, string>();
  for (const name of names) {
    const plural = lastWordPlural(name);
    const singular = lastWord(name);
    if (plural && englishSingular(plural) !== singular) pairs.set(plural, singular);
  }
  return Object.fromEntries([...pairs].sort(([a], [b]) => (a < b ? -1 : 1)));
}
