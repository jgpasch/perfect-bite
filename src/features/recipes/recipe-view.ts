// What the recipe screens show (boards 05–07). Pure: no React, SQLite or network.

import { kitchenRound } from '@/domain/kitchen-round';
import { formatAmount, type Amount } from '@/domain/quantity-display';

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
  return `${count} ${count === 1 ? 'ingredient' : 'ingredients'}`;
}

/**
 * What VoiceOver reads for a recipe card: "Chicken tacos, 9 ingredients, on Groceries". A card a
 * search matched only through an ingredient reads that instead of the count: "Tacos, has chicken thighs".
 */
export function recipeCardLabel(name: string, count: number, onList?: string | null, ingredientMatch?: string | null): string {
  return [name, ingredientMatch ? `has ${ingredientMatch}` : ingredientCountLabel(count), onList ? `on ${onList}` : null]
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

export const SERVINGS_ERROR = 'Servings must be a whole number from 1 to 100';

/** The recipe band's servings: "Serves 4". */
export function servesLabel(servings: number): string {
  return `Serves ${servings}`;
}

/** The Ingredients stepper's value: "For 6". */
export function forServingsLabel(servings: number): string {
  return `For ${servings}`;
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
  return count === 0 ? 'Nothing selected' : `Add ${count} to ${listName}`;
}

/** A recipe row's second line in the add bar's panel (spec 4.2): "Recipe · 8 items". */
export function recipeSuggestionDetail(count: number): string {
  return `Recipe · ${count} ${count === 1 ? 'item' : 'items'}`;
}

/** What VoiceOver reads for that row: "Add recipe Tacos, 8 items". */
export function recipeSuggestionLabel(name: string, count: number): string {
  return `Add recipe ${name}, ${count} ${count === 1 ? 'item' : 'items'}`;
}

/** The toast after adding a recipe to a list: "Added Tacos · 8 items", the recipe's name in bold. */
export function addedRecipeToListToast(recipeName: string, count: number): { message: string; emphasis: string } {
  return { message: `Added ${recipeName} · ${count} ${count === 1 ? 'item' : 'items'}`, emphasis: recipeName };
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
  if (count === 0 && skipped.length > 0) return { message: `You always have everything in ${recipeName}`, emphasis: recipeName };
  const added = listName
    ? { message: `Added ${recipeName} to ${listName} · ${count} ${count === 1 ? 'item' : 'items'}`, emphasis: recipeName }
    : addedRecipeToListToast(recipeName, count);
  if (skipped.length === 0) return added;
  const names =
    skipped.length > SKIPPED_NAMES_SHOWN
      ? `${skipped.slice(0, 2).join(', ')} and ${skipped.length - 2} more`
      : skipped.join(', ');
  return { ...added, message: `${added.message}\nSkipped ${names}` };
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
  return `Add ${count} ${count === 1 ? 'item' : 'items'} to…`;
}

/** The toast after adding items to a recipe: "Added 3 items to Tacos", the recipe's name in bold. */
export function addedToRecipeToast(count: number, recipeName: string): { message: string; emphasis: string } {
  return { message: `Added ${count} ${count === 1 ? 'item' : 'items'} to ${recipeName}`, emphasis: recipeName };
}

/**
 * The Steps sheet's text as the recipe's steps: one per line, each trimmed, empty lines dropped.
 * Nothing left is null (no steps), so clearing the field removes them.
 */
export function stepsFromText(text: string): string[] | null {
  const steps = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return steps.length > 0 ? steps : null;
}

/** The recipe's steps as the Steps sheet's text, one per line. */
export function stepsToText(steps: readonly string[] | null | undefined): string {
  return (steps ?? []).join('\n');
}

/** What VoiceOver reads for a step in the Method card: "Step 2 of 7, Toss the chicken…". `index` is 0-based. */
export function stepLabel(index: number, count: number, text: string): string {
  return `Step ${index + 1} of ${count}, ${text}`;
}

/** The recipe screen's Method tab: "Method · 6", read by VoiceOver as "Method, 6 steps". */
export function methodTab(count: number): { label: string; accessibilityLabel: string } {
  return { label: `Method · ${count}`, accessibilityLabel: `Method, ${count} ${count === 1 ? 'step' : 'steps'}` };
}

/** The cook screen's line under the name (board 19): "For 6 · 2 of 6 steps done", or without servings "2 of 6 steps done". */
export function cookProgressLabel(servings: number | null, done: number, total: number): string {
  const progress = `${done} of ${total} ${total === 1 ? 'step' : 'steps'} done`;
  return servings === null ? progress : `${forServingsLabel(servings)} · ${progress}`;
}

/** The cook screen's "Up next" step: the first one not ticked, or -1 when every step is. */
export function upNextIndex(ticked: readonly boolean[]): number {
  return ticked.indexOf(false);
}