// The recipe screen's tags (spec 4.14): the band's pill row and the Tags sheet. Pure: no React or SQLite.
import {
  knownTags,
  MAX_TOTAL_MINUTES,
  RECIPE_TAG_FACETS,
  recipeTagLabel,
  TIME_BUCKETS,
  timeBucket,
  type RecipeTagFacetKey,
  type RecipeTags,
} from '@/shared/recipe-tags';

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
        const value = recipeTagLabel(facet.key, slug)!;
        pills.push({ key: `${facet.key}:${slug}`, facet: facet.label, value, accessibilityLabel: `${facet.label}: ${value}` });
      }
    }
  }
  const bucket = timeBucket(totalMinutes);
  if (bucket) {
    const value = TIME_BUCKETS.find((b) => b.key === bucket)!.label;
    pills.push({ key: `time:${bucket}`, facet: 'Time', value, accessibilityLabel: `Time: ${value}` });
  }
  return pills;
}

/**
 * "Tagged when you imported it": shown while no person has edited the tags of a recipe that has
 * some (from its import). Never for an untagged recipe.
 */
export function showImportTagsNote(recipe: { tags: RecipeTags | null; tagsEdited: boolean; totalMinutes: number | null }): boolean {
  return !recipe.tagsEdited && recipe.tags !== null && recipeTagPills(recipe.tags, recipe.totalMinutes).length > 0;
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
  return `Pick up to ${max}`;
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
  if ((h && !/^\d+$/.test(h)) || (m && !/^\d+$/.test(m))) return { ok: false, error: 'Use whole numbers' };
  const total = Number(h || 0) * 60 + Number(m || 0);
  if (total === 0) return { ok: true, totalMinutes: null };
  if (total > MAX_TOTAL_MINUTES) return { ok: false, error: `Up to ${MAX_TOTAL_MINUTES / 60} hours` };
  return { ok: true, totalMinutes: total };
}
