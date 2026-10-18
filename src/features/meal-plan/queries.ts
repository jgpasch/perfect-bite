// Reading the meal plan (spec 4.16). Entries of a deleted recipe aren't shown, so their slot reads
// as empty. A slot holds one entry for now, but these return lists, so a later "main and side" is a
// UI change only.
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';

import { db, mealPlanEntries, recipes } from '@/db';

import { addDays, type Day, type Meal, weekStart } from './week';

/** Tables the plan queries read, for `useLiveQueryOn`. */
export const MEAL_PLAN_QUERY_TABLES = [mealPlanEntries, recipes];

const liveEntry = and(
  isNull(mealPlanEntries.deletedAt),
  // A note, or a recipe that's still there.
  or(isNull(mealPlanEntries.recipeId), isNull(recipes.deletedAt)),
);

const mealOrder = sql`case ${mealPlanEntries.meal} when 'breakfast' then 0 when 'lunch' then 1 else 2 end`;

const entryColumns = {
  id: mealPlanEntries.id,
  householdId: mealPlanEntries.householdId,
  planDate: mealPlanEntries.planDate,
  meal: mealPlanEntries.meal,
  position: mealPlanEntries.position,
  kind: mealPlanEntries.kind,
  recipeId: mealPlanEntries.recipeId,
  note: mealPlanEntries.note,
  createdAt: mealPlanEntries.createdAt,
  recipeName: recipes.name,
  recipeTotalMinutes: recipes.totalMinutes,
  recipeImageUrl: recipes.imageUrl,
  recipePhotoPath: recipes.photoPath,
};

/**
 * The household's live entries in the week starting `start` (live query), joined to their live
 * recipes. In each slot by position, then the one created last first (spec 4.16: two devices filling
 * a slot offline both keep their rows, and the slot shows the newer).
 */
export function weekEntriesQuery(householdId: string, start: Day) {
  const sunday = weekStart(start);
  return db
    .select(entryColumns)
    .from(mealPlanEntries)
    .leftJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(
      and(
        eq(mealPlanEntries.householdId, householdId),
        gte(mealPlanEntries.planDate, sunday),
        lte(mealPlanEntries.planDate, addDays(sunday, 6)),
        liveEntry,
      ),
    )
    .orderBy(
      asc(mealPlanEntries.planDate),
      asc(mealOrder),
      asc(mealPlanEntries.position),
      desc(mealPlanEntries.createdAt),
      desc(mealPlanEntries.id),
    );
}
export type PlanEntry = Awaited<ReturnType<typeof weekEntriesQuery>>[number];

export type WeekPlan = {
  /** The slot's entries, the shown one first; empty for an empty slot. */
  slotEntries: (day: Day, meal: Meal) => PlanEntry[];
};

/** Groups a week's entries (in `weekEntriesQuery`'s order) by slot. */
export function groupWeek(entries: readonly PlanEntry[]): WeekPlan {
  const slots = new Map<string, PlanEntry[]>();
  for (const entry of entries) {
    const key = `${entry.planDate}|${entry.meal}`;
    const list = slots.get(key);
    if (list) list.push(entry);
    else slots.set(key, [entry]);
  }
  return { slotEntries: (day, meal) => slots.get(`${day}|${meal}`) ?? [] };
}

/**
 * Every household's live entries from `from` (today) to the end of its week (live query), for the Recipes
 * tab's This week shelf (spec 4.5).
 */
export function restOfWeekEntriesQuery(from: Day) {
  return db
    .select(entryColumns)
    .from(mealPlanEntries)
    .leftJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(and(gte(mealPlanEntries.planDate, from), lte(mealPlanEntries.planDate, addDays(weekStart(from), 6)), liveEntry))
    .orderBy(asc(mealPlanEntries.planDate), asc(mealOrder), asc(mealPlanEntries.position));
}

/**
 * The recipe's live entries from `from` (today) on (live query), soonest first, for the recipe
 * screen's plan badges. None once the recipe is deleted.
 */
export function upcomingRecipeEntriesQuery(recipeId: string, from: Day) {
  return db
    .select(entryColumns)
    .from(mealPlanEntries)
    .innerJoin(recipes, eq(recipes.id, mealPlanEntries.recipeId))
    .where(and(eq(mealPlanEntries.recipeId, recipeId), gte(mealPlanEntries.planDate, from), liveEntry))
    .orderBy(asc(mealPlanEntries.planDate), asc(mealOrder), asc(mealPlanEntries.position));
}
