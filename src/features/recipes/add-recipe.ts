import { i18n, onLanguageChanged } from '@/i18n';

import { normalizeRecipeLink, recipeLinkUrl } from './recipe-link';

/** Under the name field when a link is typed there and recipe import isn't on the plan. A live binding. */
export let NAME_IS_LINK_FOOTNOTE = '';
onLanguageChanged(() => {
  NAME_IS_LINK_FOOTNOTE = i18n.t('recipes.add.nameIsLink');
});

/**
 * The link typed into the Add recipe sheet's name field, if it is one: a link that opens, with
 * `https://` added when there's no scheme ("nytimes.com/recipes/1"). Null for a recipe name.
 */
export function linkInName(name: string): string | null {
  const link = normalizeRecipeLink(name);
  return recipeLinkUrl(link) ? link : null;
}

/**
 * What the name group's button does with what's typed: nothing while empty, or while it's a link
 * without recipe import; import a link with it; otherwise create a recipe with that name.
 */
export function nameAction(
  name: string,
  canImport: boolean,
): { kind: 'none' } | { kind: 'create'; name: string } | { kind: 'import'; url: string } | { kind: 'refuse' } {
  const trimmed = name.trim();
  if (!trimmed) return { kind: 'none' };
  const link = linkInName(trimmed);
  if (!link) return { kind: 'create', name: trimmed };
  return canImport ? { kind: 'import', url: link } : { kind: 'refuse' };
}
