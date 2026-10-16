// The recipe screen's tags (spec 4.14): the band's pill row and the Tags sheet. Pure: no React or SQLite.
import {
  AI_TAG_FACETS,
  knownTags,
  MAX_TOTAL_MINUTES,
  RECIPE_TAG_FACETS,
  recipeTagLabel,
  timeBucket,
  type AiRecipeTags,
  type RecipeTagFacetKey,
  type RecipeTags,
} from '@/shared/recipe-tags';
import { i18n } from '@/i18n';
import { tagFacetLabel, tagLabel } from '@/i18n/vocabulary';

import { timeBucketLabel, timeFacetLabel } from './recipe-filters';

export type RecipeTagPill = {
  key: string;
  /** The facet's label, "Meal" (or "Time"). */
  facet: string;
  /** The value's label, "Dinner" (or the time bucket, "Under 30 min"). */
  value: string;
  /** What VoiceOver reads: "Meal: Dinner". */
  accessibilityLabel: string;
};

/**
 * The band's tag pills: each facet's known values in facet order, then the time bucket. Unknown
 * slugs aren't shown. A recipe with neither has none.
 */
export function recipeTagPills(tags: RecipeTags | null, totalMinutes: number | null): RecipeTagPill[] {
  const pills: RecipeTagPill[] = [];
  const known = knownTags(tags);
  if (known) {
    for (const facet of RECIPE_TAG_FACETS) {
      for (const slug of known[facet.key]) {
        const value = tagLabel(facet.key, slug)!;
        const name = tagFacetLabel(facet.key);
        pills.push({ key: `${facet.key}:${slug}`, facet: name, value, accessibilityLabel: tagPillLabel(name, value) });
      }
    }
  }
  const bucket = timeBucket(totalMinutes);
  if (bucket) {
    const facet = timeFacetLabel();
    const value = timeBucketLabel(bucket);
    pills.push({ key: `time:${bucket}`, facet, value, accessibilityLabel: tagPillLabel(facet, value) });
  }
  return pills;
}

function tagPillLabel(facet: string, value: string): string {
  return i18n.t('recipes.tags.pill', { facet, value });
}

/**
 * "Tagged when you imported it": shown while no person has edited the tags of a recipe that has
 * some (from its import). Never for an untagged recipe; `saved` (a person's, never the import's)
 * doesn't count.
 */
export function showImportTagsNote(recipe: { tags: RecipeTags | null; tagsEdited: boolean; totalMinutes: number | null }): boolean {
  if (recipe.tagsEdited || recipe.tags === null) return false;
  return recipeTagPills({ ...recipe.tags, saved: [] }, recipe.totalMinutes).length > 0;
}

/** How many known values of a facet are selected (unknown slugs don't count against its maximum). */
function knownCount(tags: RecipeTags, facet: RecipeTagFacetKey): number {
  return knownTags(tags)![facet].length;
}

/** The facet has as many values as it may: its unselected values can't be picked. */
export function facetAtMax(tags: RecipeTags, facet: RecipeTagFacetKey): boolean {
  const max = RECIPE_TAG_FACETS.find((f) => f.key === facet)!.max;
  return knownCount(tags, facet) >= max;
}

/**
 * Toggles a value: removes it when selected, else adds it unless the facet is at its maximum
 * (then the tags come back unchanged). Slugs this app doesn't know are kept.
 */
export function toggleTag(tags: RecipeTags, facet: RecipeTagFacetKey, slug: string): RecipeTags {
  const current = tags[facet];
  if (current.includes(slug)) return { ...tags, [facet]: current.filter((s) => s !== slug) };
  if (facetAtMax(tags, facet)) return tags;
  return { ...tags, [facet]: [...current, slug] };
}

/** "Pick up to 2". */
export function facetLimitLabel(max: number): string {
  return i18n.t('recipes.tags.limit', { max });
}

/**
 * The sheet's picks after an AI suggestion (spec 4.14): each facet the AI tags becomes the
 * suggestion's known values (in facet order, capped at its maximum), plus any slug this app doesn't
 * know from the current picks, so Save keeps it. `saved` stays as picked. Null when the suggestion
 * has no known value: the picks stay.
 */
export function applySuggestedTags(current: RecipeTags, suggested: AiRecipeTags): RecipeTags | null {
  const known = knownTags({ ...suggested, saved: [] })!;
  if (AI_TAG_FACETS.every((f) => known[f.key].length === 0)) return null;
  const out = { ...current };
  for (const facet of AI_TAG_FACETS) {
    const unknown = current[facet.key].filter((slug) => !recipeTagLabel(facet.key, slug));
    out[facet.key] = [...known[facet.key].slice(0, facet.max), ...unknown];
  }
  return out;
}

/** The Total time row's fields for a stored time: 80 → hours "1", minutes "20"; none → both empty. */
export function splitTotalMinutes(totalMinutes: number | null): { hours: string; minutes: string } {
  if (totalMinutes == null) return { hours: '', minutes: '' };
  const hours = Math.floor(totalMinutes / 60);
  return { hours: hours ? String(hours) : '', minutes: String(totalMinutes % 60) };
}

export type TotalTimeInput = { ok: true; totalMinutes: number | null } | { ok: false; error: string };

/**
 * The Total time row's fields as minutes. Both empty (or both zero) is no time. Whole numbers only,
 * up to 48 hours (`MAX_TOTAL_MINUTES`).
 */
export function parseTotalTime(hours: string, minutes: string): TotalTimeInput {
  const h = hours.trim();
  const m = minutes.trim();
  if (!h && !m) return { ok: true, totalMinutes: null };
  if ((h && !/^\d+$/.test(h)) || (m && !/^\d+$/.test(m))) return { ok: false, error: i18n.t('recipes.tags.wholeNumbers') };
  const total = Number(h || 0) * 60 + Number(m || 0);
  if (total === 0) return { ok: true, totalMinutes: null };
  if (total > MAX_TOTAL_MINUTES) return { ok: false, error: i18n.t('recipes.tags.upToHours', { hours: MAX_TOTAL_MINUTES / 60 }) };
  return { ok: true, totalMinutes: total };
}
