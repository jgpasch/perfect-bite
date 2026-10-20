// Planning a recipe from the recipe screen or the Recipes card (spec 4.16, the "Plan → tap a slot"
// prototype): the plan modal's taps, kept in its state until Done, and the recipe screen's plan badges.
// Pure, apart from reading the app's language.
import { currentLanguage, i18n, type Language } from '@/i18n';

import type { PlanEntry, WeekPlan } from './queries';
import { type Day, type Meal, nextWeek } from './week';
import { dayName, entryText, mealLabel } from './week-view';
import type { PlanChange } from './write';

/** An entry a slot showed when the recipe was placed there: one of its recipes, or its note. */
export type ShownEntry = Pick<PlanEntry, 'kind' | 'recipeId' | 'recipeName' | 'note'>;

/** A slot the recipe was placed in during this visit, and what the slot showed then. */
export type Placement = { day: Day; meal: Meal; previous: readonly ShownEntry[] };

/** The modal's placements, in the order they were tapped. Weeks change around them. */
export type Placements = readonly Placement[];

/** The recipe, for the cells it's placed in. */
export type PlacedRecipe = {
  id: string;
  name: string;
  totalMinutes: number | null;
  imageUrl: string | null;
  photoPath: string | null;
};

const isSlot = (p: Placement, day: Day, meal: Meal) => p.day === day && p.meal === meal;

export function isPlaced(placements: Placements, day: Day, meal: Meal): boolean {
  return placements.some((p) => isSlot(p, day, meal));
}

/** Whether a slot's entries already hold the recipe, so a tap there does nothing. */
export function holdsRecipe(shown: readonly ShownEntry[], recipeId: string): boolean {
  return shown.some((e) => e.kind === 'recipe' && e.recipeId === recipeId);
}

/**
 * A tap on a slot: adds the recipe after the slot's recipes (or over its note), or, on a slot placed in this
 * visit, takes it out again so the slot shows what it did before. Tapping the same slot again is also Undo.
 * A slot whose entries already hold the recipe is left alone.
 */
export function tapSlot(placements: Placements, day: Day, meal: Meal, shown: readonly ShownEntry[], recipeId: string): Placements {
  if (isPlaced(placements, day, meal)) return placements.filter((p) => !isSlot(p, day, meal));
  if (holdsRecipe(shown, recipeId)) return placements;
  return [...placements, { day, meal, previous: shown }];
}

/** "Thu dinner" in this week, "Oct 21 dinner" after it; Spanish "cena del jue", "cena del 21 oct". */
export function shortSlotName(day: Day, meal: Meal, today: Day, language: Language = currentLanguage()): string {
  const date =
    day < nextWeek(today)
      ? dayName(day, 'short', language)
      : new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  return i18n.t('mealPlan.slotShort', { day: date, meal: mealLabel(meal).toLocaleLowerCase(language) });
}

/**
 * The toast after a tap: "Planned for Thu dinner" in an empty slot, "Added to Thu dinner" beside other
 * recipes, "Replaced Eating out on Sat dinner" over a note (`emphasis` is the note), or "Already planned for
 * Thu dinner" when the slot already held the recipe and the tap did nothing.
 */
export function placedToast(placement: Placement, recipeId: string, today: Day): { message: string; emphasis?: string } {
  const slot = shortSlotName(placement.day, placement.meal, today);
  const { previous } = placement;
  if (holdsRecipe(previous, recipeId)) return { message: i18n.t('mealPlan.alreadyPlannedFor', { slot }) };
  const first = previous[0];
  if (!first) return { message: i18n.t('mealPlan.plannedFor', { slot }) };
  if (first.kind === 'recipe') return { message: i18n.t('mealPlan.addedTo', { slot }) };
  const name = entryText(first);
  return { message: i18n.t('mealPlan.replacedOn', { name, slot }), emphasis: name };
}

/**
 * The week as the modal shows it: in every slot it's placed in, the recipe after the slot's recipes (alone
 * over a note or in an empty slot); the plan elsewhere.
 */
export function withPlacements(plan: WeekPlan, placements: Placements, recipe: PlacedRecipe, householdId: string): WeekPlan {
  return {
    slotEntries: (day, meal) => {
      const entries = plan.slotEntries(day, meal);
      // Planned there since the tap (another device): shown once, as Done won't add it again.
      if (!isPlaced(placements, day, meal) || holdsRecipe(entries, recipe.id)) return entries;
      const recipes = entries.filter((e) => e.kind === 'recipe');
      const last = recipes[recipes.length - 1];
      return [
        ...recipes,
        {
          id: `placed-${day}-${meal}`,
          householdId,
          planDate: day,
          meal,
          position: last ? last.position + 1 : 0,
          kind: 'recipe',
          recipeId: recipe.id,
          note: null,
          createdAt: new Date(0),
          recipeName: recipe.name,
          recipeTotalMinutes: recipe.totalMinutes,
          recipeImageUrl: recipe.imageUrl,
          recipePhotoPath: recipe.photoPath,
        },
      ];
    },
  };
}

/** Done: the recipe added to every placed slot, for `applyPlanChanges`. */
export function planChanges(placements: Placements, householdId: string, recipeId: string): PlanChange[] {
  return placements.map(({ day, meal }) => ({ householdId, day, meal, add: { recipeId } }));
}

/** The CTA: "Done", or "Done · 2 planned". */
export function doneLabel(count: number): string {
  return count === 0 ? i18n.t('common.done') : i18n.t('mealPlan.donePlanned', { count });
}

/**
 * VoiceOver's hint on a cell, from what the slot holds without this visit's placement: "Double-tap to plan"
 * (empty), "to add" (beside other recipes), "to replace" (a note), "to remove" (placed in this visit), or
 * "Already planned".
 */
export function slotHint(placed: boolean, shown: readonly ShownEntry[], recipeId: string): string {
  if (placed) return i18n.t('mealPlan.hintRemove');
  if (holdsRecipe(shown, recipeId)) return i18n.t('mealPlan.hintAlreadyPlanned');
  const first = shown[0];
  return i18n.t(!first ? 'mealPlan.hintPlan' : first.kind === 'recipe' ? 'mealPlan.hintAdd' : 'mealPlan.hintReplace');
}

/** How many badges the recipe screen shows before "+N". */
export const MAX_PLAN_BADGES = 3;

export type PlanBadge = { key: string; label: string; meal: Meal };

/**
 * The recipe screen's plan badges: one per upcoming entry (`upcomingRecipeEntriesQuery`'s order, soonest
 * first), the first three, then the rest as `more` ("+2").
 */
export function planBadges(
  entries: readonly Pick<PlanEntry, 'id' | 'planDate' | 'meal'>[],
  today: Day,
): { badges: PlanBadge[]; more: number } {
  return {
    badges: entries.slice(0, MAX_PLAN_BADGES).map((e) => ({
      key: e.id,
      label: shortSlotName(e.planDate, e.meal, today),
      meal: e.meal,
    })),
    more: Math.max(0, entries.length - MAX_PLAN_BADGES),
  };
}
