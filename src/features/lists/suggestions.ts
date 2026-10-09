import { searchCatalog } from '@/features/categories/categories';
import { parseQuantity } from '@/shared';

import { searchRecentItems } from './items';

export type Suggestion = { key: string; displayName: string };

/**
 * Add-bar autocomplete (spec 4.2): the household's recently used ingredients, then the catalog.
 * Matches the name part of the text, so `2 lbs chi` suggests chicken thighs.
 * TODO(M6): limit catalog suggestions per spec 6.5 once server rows are cached.
 */
export function getSuggestions(householdId: string, text: string, limit = 5): Suggestion[] {
  const { name } = parseQuantity(text);
  if (name.trim().length < 2) return [];
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const s of [...searchRecentItems(householdId, name, limit), ...searchCatalog(name, limit)]) {
    if (seen.has(s.key) || s.displayName.toLowerCase() === name.trim().toLowerCase()) continue;
    seen.add(s.key);
    out.push(s);
    if (out.length === limit) break;
  }
  return out;
}

/** The add text with its name replaced by a suggestion, keeping a typed amount: `2 lbs chi` → `2 lbs chicken thighs`. */
export function applySuggestion(text: string, suggestion: Suggestion): string {
  const { name } = parseQuantity(text);
  const trimmed = text.trim();
  const prefix = name && trimmed.endsWith(name) ? trimmed.slice(0, trimmed.length - name.length) : '';
  return `${prefix}${suggestion.displayName}`;
}
