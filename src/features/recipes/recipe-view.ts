// What the recipe screens show (boards 05–07). Pure: no React, SQLite or network.

import { kitchenRound } from '@/domain/kitchen-round';
import { formatAmount, type Amount } from '@/domain/quantity-display';
import { i18n, onLanguageChanged } from '@/i18n';
import { tagLabel } from '@/i18n/vocabulary';
import {
  choiceGroups,
  isStepHeading,
  MAX_RECIPE_SECTION_LENGTH,
  MAX_RECIPE_SECTIONS,
  recipeSections,
  stepPath,
  stepTexts,
  type RecipeStepEntry,
} from '@/shared/recipe-steps';
import { knownTags, type RecipeTags } from '@/shared/recipe-tags';

import type { RecipeFavorite } from './favorites';
import type { RecipeGroup } from './recipe-sort';

export type RecipeHouseholdGroup<R> = { householdId: string; name: string; recipes: R[] };

/** Recipes under their household's name, households in order of their first recipe, recipes in order. */
export function groupRecipesByHousehold<R extends { householdId: string; householdName: string }>(
  recipes: readonly R[],
): RecipeHouseholdGroup<R>[] {
  const groups = new Map<string, RecipeHouseholdGroup<R>>();
  for (const recipe of recipes) {
    const group = groups.get(recipe.householdId) ?? { householdId: recipe.householdId, name: recipe.householdName, recipes: [] };
    group.recipes.push(recipe);
    groups.set(recipe.householdId, group);
  }
  return [...groups.values()];
}

/**
 * The list each recipe is on, for its "On Groceries" badge: the list it was most recently added
 * to, of those where it still has an open item (`recipesOnListsQuery` rows).
 */
export function onListByRecipe(rows: readonly { recipeId: string; listName: string; addedAt: Date }[]): Map<string, string> {
  const latest = new Map<string, { listName: string; at: number }>();
  for (const row of rows) {
    const at = row.addedAt.getTime();
    const current = latest.get(row.recipeId);
    if (!current || at > current.at) latest.set(row.recipeId, { listName: row.listName, at });
  }
  return new Map([...latest].map(([recipeId, { listName }]) => [recipeId, listName]));
}

/** "1 ingredient", "9 ingredients". */
export function ingredientCountLabel(count: number): string {
  return i18n.t('recipes.tab.ingredients', { count });
}

/**
 * What VoiceOver reads for a recipe card: "Chicken tacos, 9 ingredients, on Groceries". A card a
 * search matched only through an ingredient reads that instead of the count: "Tacos, has chicken thighs".
 */
export function recipeCardLabel(name: string, count: number, onList?: string | null, ingredientMatch?: string | null): string {
  return [
    name,
    ingredientMatch ? i18n.t('recipes.tab.cardHas', { name: ingredientMatch }) : ingredientCountLabel(count),
    onList ? i18n.t('recipes.tab.cardOn', { name: onList }) : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** A recipe's total time on its row: "35 min", "1 hr", "1 hr 20 min". Null without a time. */
export function recipeTimeLabel(totalMinutes: number | null | undefined): string | null {
  if (totalMinutes == null || !Number.isFinite(totalMinutes) || totalMinutes <= 0) return null;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  if (hours === 0) return i18n.t('recipes.tab.timeMinutes', { minutes });
  if (minutes === 0) return i18n.t('recipes.tab.timeHours', { hours });
  return i18n.t('recipes.tab.timeHoursMinutes', { hours, minutes });
}

/**
 * The parts of a recipe row's meta line (spec 4.5): its first `meal` tag's label (in the facet's order)
 * and its time, ["Dinner", "35 min"]. Grouped by cuisine, its first cuisine in place of the meal: ["Thai",
 * "30 min"]. Either alone if the other is missing; none if both are.
 */
export function recipeMetaParts(
  recipe: { tags: RecipeTags | null; totalMinutes: number | null },
  group: RecipeGroup = 'none',
): string[] {
  const facet = group === 'cuisine' ? 'cuisine' : 'meal';
  const tag = knownTags(recipe.tags)?.[facet][0];
  return [tag ? tagLabel(facet, tag) : null, recipeTimeLabel(recipe.totalMinutes)].filter((p): p is string => !!p);
}

/** A recipe row's meta line: "Dinner · 35 min", "Dinner", "35 min", or null. */
export function recipeMetaLine(
  recipe: { tags: RecipeTags | null; totalMinutes: number | null },
  group: RecipeGroup = 'none',
): string | null {
  const parts = recipeMetaParts(recipe, group);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * A recipe's favorite and Want to try (spec 4.5, 4.14): its row's heart and bookmark, and its menu. The
 * favorite comes from `recipe_favorites` (`useRecipeFavorites`), not the tags: `mine` when the user has
 * it, `others` when only other current members do, else null. A `favorite` slug stored in the tags
 * before favorites were per person counts for nothing.
 */
export function recipeSavedMarks(
  tags: RecipeTags | null,
  favorite?: RecipeFavorite | null,
): { favorite: 'mine' | 'others' | null; wantToTry: boolean } {
  const saved = tags?.saved ?? [];
  const mark = favorite?.mine ? 'mine' : favorite?.others.length ? 'others' : null;
  return { favorite: mark, wantToTry: saved.includes('want-to-try') };
}

/**
 * What VoiceOver reads for a Recipes tab row: "Chicken tacos, Your favorite, Want to try, Dinner, 35 min, on
 * Groceries" (the favorite and Want to try only when there). A row a search matched
 * only through an ingredient reads that in place of the meta: "Tacos, has chicken thighs".
 */
export function recipeRowLabel(
  recipe: { name: string; tags: RecipeTags | null; totalMinutes: number | null },
  onList?: string | null,
  ingredientMatch?: string | null,
  group: RecipeGroup = 'none',
  /** Who has it as a favorite, as `favoriteLabel` reads it ("Your favorite"), or null. */
  favorite?: string | null,
): string {
  const marks = recipeSavedMarks(recipe.tags);
  return [
    recipe.name,
    favorite,
    marks.wantToTry ? tagLabel('saved', 'want-to-try') : null,
    ...(ingredientMatch ? [i18n.t('recipes.tab.cardHas', { name: ingredientMatch })] : recipeMetaParts(recipe, group)),
    onList ? i18n.t('recipes.tab.cardOn', { name: onList }) : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** A servings multiplier's pill: "½×", "1×", "2×". */
export function servingsLabel(servings: number): string {
  return `${servings === 0.5 ? '½' : servings}×`;
}

/** A recipe's servings, and the recipe screen's stepper, run 1–100. */
export const SERVINGS_MIN = 1;
export const SERVINGS_MAX = 100;

// Module-level strings follow the app's language (a live binding, set once i18n is initialized).
export let SERVINGS_ERROR = '';
onLanguageChanged(() => {
  SERVINGS_ERROR = i18n.t('recipes.servings.error');
});

/** The recipe band's servings: "Serves 4". */
export function servesLabel(servings: number): string {
  return i18n.t('recipes.servings.serves', { count: servings });
}

/** The Ingredients stepper's value: "For 6". */
export function forServingsLabel(servings: number): string {
  return i18n.t('recipes.servings.for', { count: servings });
}

/**
 * The servings prompt's text: a whole number 1–100, or null when it's empty (clearing them). An error
 * for anything else ("0", "2.5", "four").
 */
export function parseServings(text: string): { servings: number | null } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { servings: null };
  if (!/^\d+$/.test(trimmed)) return { error: SERVINGS_ERROR };
  const servings = Number(trimmed);
  return servings >= SERVINGS_MIN && servings <= SERVINGS_MAX ? { servings } : { error: SERVINGS_ERROR };
}

/**
 * An ingredient's amount for `chosen` people when the recipe serves `base`: quantity × chosen ÷ base,
 * rounded to a kitchen measure (`kitchenRound`) and formatted as Add to list does. At `base` it's as
 * written, not rounded. Empty when it has no quantity.
 */
export function scaledAmount(amount: Amount, chosen: number, base: number): string {
  if (amount.quantity === null || chosen === base) return formatAmount(amount);
  return formatAmount(kitchenRound({ quantity: (amount.quantity * chosen) / base, unit: amount.unit }));
}

/** The add-to-list CTA: "Add 8 to Groceries", or "Nothing selected". */
export function addCtaLabel(count: number, listName: string): string {
  return count === 0
    ? i18n.t('recipes.addToList.nothingSelected')
    : i18n.t('recipes.addToList.cta', { count, name: listName });
}

/** A recipe row's second line in the add bar's panel (spec 4.2): "Recipe · 8 items". */
export function recipeSuggestionDetail(count: number): string {
  return i18n.t('recipes.toasts.suggestionDetail', { count });
}

/** What VoiceOver reads for that row: "Add recipe Tacos, 8 items". */
export function recipeSuggestionLabel(name: string, count: number): string {
  return i18n.t('addBar.addRecipeChip', { name, count });
}

/** The toast after adding a recipe to a list: "Added Tacos · 8 items", the recipe's name in bold. */
export function addedRecipeToListToast(recipeName: string, count: number): { message: string; emphasis: string } {
  return { message: i18n.t('recipes.toasts.added', { name: recipeName, count }), emphasis: recipeName };
}

// Past three names, the line names two and counts the rest.
const SKIPPED_NAMES_SHOWN = 3;

/**
 * The add bar's recipe toast (spec 4.2) when it left the household's staples (Always have) out: "Added Tacos · 6
 * items" with a second line "Skipped salt, pepper" ("Skipped salt, pepper and 2 more" past three). With every
 * ingredient a staple nothing was added: "You always have everything in Tacos". With `listName` (the Recipes tab's
 * quick add, which adds away from the list) the first line names it: "Added Tacos to Groceries · 6 items".
 */
export function addedRecipeWithStaplesToast(
  recipeName: string,
  count: number,
  skipped: readonly string[],
  listName?: string,
): { message: string; emphasis: string } {
  if (count === 0 && skipped.length > 0) {
    return { message: i18n.t('recipes.toasts.alwaysHaveAll', { name: recipeName }), emphasis: recipeName };
  }
  const added = listName
    ? { message: i18n.t('recipes.toasts.addedTo', { name: recipeName, list: listName, count }), emphasis: recipeName }
    : addedRecipeToListToast(recipeName, count);
  if (skipped.length === 0) return added;
  const names =
    skipped.length > SKIPPED_NAMES_SHOWN
      ? i18n.t('recipes.toasts.skippedMore', { names: skipped.slice(0, 2).join(', '), count: skipped.length - 2 })
      : skipped.join(', ');
  return { ...added, message: `${added.message}\n${i18n.t('recipes.toasts.skipped', { names })}` };
}

/**
 * Recipes most recently used first (the "Add to recipe" sheet, spec 4.5). A recipe's last use is
 * the later of its last change (`updatedAt`) and the last time it was added to a list (`uses`, one
 * per recipe contribution). Ties go by name, then id.
 */
export function orderByLastUse<R extends { id: string; name: string; updatedAt: Date }>(
  recipes: readonly R[],
  uses: readonly { recipeId: string; at: Date }[],
): R[] {
  const lastAdd = new Map<string, number>();
  for (const use of uses) lastAdd.set(use.recipeId, Math.max(lastAdd.get(use.recipeId) ?? -Infinity, use.at.getTime()));
  const lastUse = (r: R) => Math.max(r.updatedAt.getTime(), lastAdd.get(r.id) ?? -Infinity);
  return [...recipes].sort(
    (a, b) => lastUse(b) - lastUse(a) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The "Add to recipe" sheet's title: "Add 1 item to…", "Add 3 items to…". */
export function addToRecipeTitle(count: number): string {
  return i18n.t('recipes.addToRecipe.title', { count });
}

/** The toast after adding items to a recipe: "Added 3 items to Tacos", the recipe's name in bold. */
export function addedToRecipeToast(count: number, recipeName: string): { message: string; emphasis: string } {
  return { message: i18n.t('recipes.toasts.addedToRecipe', { count, name: recipeName }), emphasis: recipeName };
}

/** A Steps sheet line as a section heading's name ("# Grilling" is "Grilling"), "" for an empty one, or null for a step. */
function headingOfLine(line: string): string | null {
  if (!line.startsWith('#')) return null;
  return [...line.replace(/^#+\s*/, '').trim()].slice(0, MAX_RECIPE_SECTION_LENGTH).join('').trim();
}

/**
 * The Steps sheet's text as the recipe's steps (spec 4.5): one per line, each trimmed, empty lines
 * dropped. A line starting with `#` is a section heading (the `#`s and the spaces after them
 * dropped, at most 80 characters, past the 20th or empty dropped), a `choice` when its name is in
 * `choices`. No step left is null (no steps), so clearing the field removes them.
 */
export function stepsFromText(text: string, choices: ReadonlySet<string> = new Set()): RecipeStepEntry[] | null {
  const entries = textEntries(text, choices);
  return stepTexts(entries).length > 0 ? entries : null;
}

/** The section headings' names in the Steps sheet's text, in order, as Save would write them (the Choose one card). */
export function stepHeadingsInText(text: string): string[] {
  return textEntries(text, new Set()).filter(isStepHeading).map((heading) => heading.section);
}

function textEntries(text: string, choices: ReadonlySet<string>): RecipeStepEntry[] {
  const entries: RecipeStepEntry[] = [];
  let headings = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = headingOfLine(line);
    if (heading === null) entries.push(line);
    else if (heading && headings++ < MAX_RECIPE_SECTIONS) entries.push(choices.has(heading) ? { section: heading, choice: true } : { section: heading });
  }
  return entries;
}

/** The recipe's steps as the Steps sheet's text, one per line, a section heading as "# Grilling". */
export function stepsToText(steps: readonly RecipeStepEntry[] | null | undefined): string {
  return (steps ?? []).map((entry) => (isStepHeading(entry) ? `# ${entry.section}` : entry)).join('\n');
}

/** What the Method card shows, top to bottom (spec 4.5 "Step sections"). */
export type MethodBlock =
  | { kind: 'title'; title: string }
  /** A choice group: its label ("Cook it one way" when `first`), a pill per option and the pick; the picked option's steps follow. */
  | { kind: 'group'; group: number; first: boolean; options: string[]; picked: number }
  /** `index` into `stepTexts`, `number` from 1 along the path shown; `lead` when a title or the pills sit right above it. */
  | { kind: 'step'; index: number; number: number; lead: boolean };

/**
 * The Method card's blocks for one pick per choice group (`picks[g]`; the first option without one,
 * as `stepPath`): each section's title over its steps, and for a group its pills then only the
 * picked option's steps, numbered along that path.
 */
export function methodBlocks(entries: readonly RecipeStepEntry[] | null | undefined, picks: readonly number[] = []): MethodBlock[] {
  const sections = recipeSections(entries);
  const groups = choiceGroups(sections);
  const shown = new Set(stepPath(entries, picks));
  const blocks: MethodBlock[] = [];
  let number = 0;
  let lead = false;
  sections.forEach((section, i) => {
    const group = groups.findIndex((options) => options[0] === i);
    if (group >= 0) {
      const options = groups[group];
      const pick = picks[group];
      blocks.push({
        kind: 'group',
        group,
        first: i === 0,
        options: options.map((o) => sections[o].title ?? ''),
        picked: pick != null && Number.isInteger(pick) && pick >= 0 && pick < options.length ? pick : 0,
      });
      lead = true;
    } else if (!section.choice && section.title !== null) {
      blocks.push({ kind: 'title', title: section.title });
      lead = true;
    }
    for (const index of section.steps) {
      if (!shown.has(index)) continue;
      blocks.push({ kind: 'step', index, number: ++number, lead });
      lead = false;
    }
  });
  return blocks;
}

/** `picks` with group `group`'s pick set to `option` (groups before it without one keep their first). */
export function withPick(picks: readonly number[], group: number, option: number): number[] {
  const next = Array.from({ length: Math.max(picks.length, group + 1) }, (_, g) => picks[g] ?? 0);
  next[group] = option;
  return next;
}

/** The names of the recipe's headings marked `choice`: the Steps sheet's ticks. */
export function choiceHeadings(steps: readonly RecipeStepEntry[] | null | undefined): Set<string> {
  return new Set((steps ?? []).filter(isStepHeading).filter((h) => h.choice === true).map((h) => h.section));
}

/** What VoiceOver reads for a step in the Method card: "Step 2 of 7, Toss the chicken…". `index` is 0-based. */
export function stepLabel(index: number, count: number, text: string): string {
  return i18n.t('recipes.method.step', { number: index + 1, count, text });
}

/** The recipe screen's Method tab: "Method · 6", read by VoiceOver as "Method, 6 steps". */
export function methodTab(count: number): { label: string; accessibilityLabel: string } {
  return { label: i18n.t('recipes.method.tab', { count }), accessibilityLabel: i18n.t('recipes.method.tabLabel', { count }) };
}

/** What a step count counts, singular and plural, for a section header's VoiceOver label. */
export function stepUnit(): readonly [one: string, other: string] {
  return [i18n.t('recipes.method.unit', { count: 1 }), i18n.t('recipes.method.unit', { count: 2 })];
}

/** What an ingredient count counts, singular and plural, for the ingredients header's VoiceOver label. */
export function ingredientUnit(): readonly [one: string, other: string] {
  return [i18n.t('recipes.screen.ingredientUnit', { count: 1 }), i18n.t('recipes.screen.ingredientUnit', { count: 2 })];
}

/** The cook screen's line under the name (board 19): "For 6 · 2 of 6 steps done", or without servings "2 of 6 steps done"; while a choice group has no pick (`picking`), "3 steps done · pick a method". */
export function cookProgressLabel(servings: number | null, done: number, total: number, picking = false): string {
  const progress = picking ? i18n.t('recipes.cook.picking', { count: done }) : i18n.t('recipes.cook.progress', { done, count: total });
  return servings === null ? progress : i18n.t('recipes.cook.withServings', { servings: forServingsLabel(servings), progress });
}

/** The cook screen's "Up next" step: the first one not ticked, or -1 when every step is. */
export function upNextIndex(ticked: readonly boolean[]): number {
  return ticked.indexOf(false);
}