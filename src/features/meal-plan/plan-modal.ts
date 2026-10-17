// Planning a recipe from the recipe screen or the Recipes card (spec 4.16, the "Plan → tap a slot"
// prototype): the plan modal's taps, kept in its state until Done, and the recipe screen's plan badges.
// Pure, apart from reading the app's language.
import { currentLanguage, i18n, type Language } from '@/i18n';

import type { PlanEntry, WeekPlan } from './queries';
import { type Day, type Meal, nextWeek } from './week';
import { dayName, entryText, mealLabel } from './week-view';
import type { PlanChange } from './write';

/** What a slot showed when the recipe was placed there, put back when the placement is taken out. */
export type ShownEntry = Pick<PlanEntry, 'kind' | 'recipeId' | 'recipeName' | 'note'>;

/** A slot the recipe was placed in during this visit. */
export type Placement = { day: Day; meal: Meal; previous: ShownEntry | null };

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

/**
 * A tap on a slot: places the recipe there (replacing what it shows), or, on a slot placed in this visit,
 * takes it out again so the slot shows what it did before. Tapping the same slot again is also Undo.
 */
export function tapSlot(placements: Placements, day: Day, meal: Meal, shown: ShownEntry | null): Placements {
  if (isPlaced(placements, day, meal)) return placements.filter((p) => !isSlot(p, day, meal));
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
 * The toast after placing: "Planned for Thu dinner", or "Replaced Lemon ricotta pasta on Sat dinner" when
 * the slot showed something else. `emphasis` is what it replaced.
 */
export function placedToast(placement: Placement, recipeId: string, today: Day): { message: string; emphasis?: string } {
  const slot = shortSlotName(placement.day, placement.meal, today);
  const { previous } = placement;
  if (!previous || (previous.kind === 'recipe' && previous.recipeId === recipeId)) {
    return { message: i18n.t('mealPlan.plannedFor', { slot }) };
  }
  const name = entryText(previous);
  return { message: i18n.t('mealPlan.replacedOn', { name, slot }), emphasis: name };
}

/** The week as the modal shows it: the recipe in every slot it's placed in, the plan elsewhere. */
export function withPlacements(plan: WeekPlan, placements: Placements, recipe: PlacedRecipe, householdId: string): WeekPlan {
  return {
    slotEntries: (day, meal) =>
      isPlaced(placements, day, meal)
        ? [
            {
              id: `placed-${day}-${meal}`,
              householdId,
              planDate: day,
              meal,
              position: 0,
              kind: 'recipe',
              recipeId: recipe.id,
              note: null,
              createdAt: new Date(0),
              recipeName: recipe.name,
              recipeTotalMinutes: recipe.totalMinutes,
              recipeImageUrl: recipe.imageUrl,
              recipePhotoPath: recipe.photoPath,
            },
          ]
        : plan.slotEntries(day, meal),
  };
}

/** Done: the recipe into every placed slot, for `applyPlanChanges`. */
export function planChanges(placements: Placements, householdId: string, recipeId: string): PlanChange[] {
  return placements.map(({ day, meal }) => ({ householdId, day, meal, entry: { kind: 'recipe', recipeId } }));
}

/** The CTA: "Done", or "Done · 2 planned". */
export function doneLabel(count: number): string {
  return count === 0 ? i18n.t('common.done') : i18n.t('mealPlan.donePlanned', { count });
}

/** VoiceOver's hint on a cell: "Double-tap to plan", "to replace" or "to remove". */
export function slotHint(placed: boolean, shown: ShownEntry | null): string {
  return i18n.t(placed ? 'mealPlan.hintRemove' : shown ? 'mealPlan.hintReplace' : 'mealPlan.hintPlan');
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
