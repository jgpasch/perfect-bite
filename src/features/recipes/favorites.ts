// Favorites per person (spec 4.14): each member keeps their own favorites and sees the other
// members'. A favorite is a `recipe_favorites` row for the recipe and the user, household data synced
// like the staples: unfavoriting sets `deleted_at` and favoriting again clears it, so the later change
// wins (7.3). Only rows whose user is a current member of the recipe's household count (the member
// cache, `member-names.ts`), so someone who leaves stops showing at once.
import { and, eq, isNull } from 'drizzle-orm';
import { useMemo } from 'react';

import { db, householdMemberNames, recipeFavorites, recipes } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { nameOf, shortMemberNames, type MemberNames } from '@/features/households/member-names';
import { i18n } from '@/i18n';
import type { RecipeTags } from '@/shared/recipe-tags';
import type { Exec } from '@/sync/clock';
import { upsertRow } from '@/sync/mutate';

import { updateRecipeTags } from './recipes';

/** A recipe's favorites: the user's own, and the other current members' names, A–Z. */
export type RecipeFavorite = { mine: boolean; others: string[] };

/** Favorites by recipe id; a recipe nobody (current) has favorited has no entry. */
export type FavoritesByRecipe = ReadonlyMap<string, RecipeFavorite>;

/** Tables `useRecipeFavorites` reads, for `useLiveQueryOn`. */
export const FAVORITES_QUERY_TABLES = [recipeFavorites, recipes, householdMemberNames];

type FavoriteRow = { recipeId: string; userId: string; householdId: string };
type MemberRow = { householdId: string; userId: string; displayName: string };

/** Live favorites in their recipe's household (every member's). */
function favoriteRowsQuery() {
  return db
    .select({ recipeId: recipeFavorites.recipeId, userId: recipeFavorites.userId, householdId: recipeFavorites.householdId })
    .from(recipeFavorites)
    .innerJoin(recipes, and(eq(recipes.id, recipeFavorites.recipeId), eq(recipes.householdId, recipeFavorites.householdId)))
    .where(isNull(recipeFavorites.deletedAt));
}

function membersQuery() {
  return db
    .select({
      householdId: householdMemberNames.householdId,
      userId: householdMemberNames.userId,
      displayName: householdMemberNames.displayName,
    })
    .from(householdMemberNames);
}

/**
 * Per recipe, `{ mine, others }` from live favorite rows: mine when `me` has one, others' names (as
 * the household shows them) for each other user who is a current member of the recipe's household.
 * Rows of anyone else count for nothing.
 */
export function favoritesByRecipe(
  rows: readonly FavoriteRow[],
  members: readonly MemberRow[],
  me: string | null,
): FavoritesByRecipe {
  const byHousehold = new Map<string, MemberRow[]>();
  for (const m of members) byHousehold.set(m.householdId, [...(byHousehold.get(m.householdId) ?? []), m]);
  const names = new Map<string, MemberNames>();
  const namesIn = (householdId: string) => {
    if (!names.has(householdId)) names.set(householdId, shortMemberNames(byHousehold.get(householdId) ?? []));
    return names.get(householdId)!;
  };
  const isMember = (householdId: string, userId: string) =>
    (byHousehold.get(householdId) ?? []).some((m) => m.userId === userId);

  const out = new Map<string, RecipeFavorite>();
  for (const row of rows) {
    const mine = me !== null && row.userId === me;
    if (!mine && !isMember(row.householdId, row.userId)) continue;
    const entry = out.get(row.recipeId) ?? { mine: false, others: [] };
    if (mine) entry.mine = true;
    else entry.others.push(nameOf(namesIn(row.householdId), row.userId, me));
    out.set(row.recipeId, entry);
  }
  for (const entry of out.values()) entry.others.sort((a, b) => a.localeCompare(b, i18n.language));
  return out;
}

/** Every recipe's favorites (read once). */
export function readRecipeFavorites(): FavoritesByRecipe {
  return favoritesByRecipe(favoriteRowsQuery().all(), membersQuery().all(), getAccount()?.userId ?? null);
}

/** Every recipe's favorites (live). */
export function useRecipeFavorites(): FavoritesByRecipe {
  const { data: rows } = useLiveQueryOn(favoriteRowsQuery(), FAVORITES_QUERY_TABLES);
  const { data: members } = useLiveQueryOn(membersQuery(), [householdMemberNames]);
  const me = getAccount()?.userId ?? null;
  return useMemo(() => favoritesByRecipe(rows, members, me), [rows, members, me]);
}

/** Whether the user has the recipe as a favorite. */
export function isMyFavorite(recipeId: string, exec: Exec = db): boolean {
  const me = getAccount()?.userId;
  if (!me) return false;
  const row = exec
    .select({ deletedAt: recipeFavorites.deletedAt })
    .from(recipeFavorites)
    .where(and(eq(recipeFavorites.recipeId, recipeId), eq(recipeFavorites.userId, me)))
    .get();
  return row !== undefined && row.deletedAt === null;
}

/**
 * Favorites (`on`) or unfavorites a recipe for the user only, whatever other members have. Unfavoriting
 * sets `deleted_at` and favoriting again clears it. No change, no user or no recipe: no write. `exec`: the
 * caller's transaction (the Tags sheet's Save).
 */
export function setMyFavorite(recipeId: string, on: boolean, exec: Exec = db): void {
  const userId = getAccount()?.userId;
  if (!userId || isMyFavorite(recipeId, exec) === on) return;
  const recipe = exec.select({ householdId: recipes.householdId }).from(recipes).where(eq(recipes.id, recipeId)).get();
  if (!recipe) return;
  const deletedAt = on ? null : new Date();
  upsertRow(exec, recipeFavorites, { recipeId, userId, householdId: recipe.householdId, deletedAt }, { deletedAt });
}

/**
 * The Tags sheet's Save (spec 4.14): the tags, the time and `tagsEdited` (`updateRecipeTags`) and, when
 * its Favorite pill changed (`favorite` given), the user's own favorite, in one transaction.
 */
export function saveRecipeTags(id: string, tags: RecipeTags, totalMinutes: number | null, favorite?: boolean): void {
  db.transaction((tx) => {
    updateRecipeTags(id, tags, totalMinutes, tx);
    if (favorite !== undefined) setMyFavorite(id, favorite, tx);
  });
}

/**
 * What VoiceOver reads for a recipe's favorites: "Your favorite" (also when others have it too),
 * "Sam's favorite", "Favorite of Sam and Ana", "Favorite of Sam and 2 others". Null with none.
 */
export function favoriteLabel(mine: boolean, others: readonly string[]): string | null {
  if (mine) return i18n.t('recipes.favorites.yours');
  if (others.length === 0) return null;
  if (others.length === 1) return i18n.t('recipes.favorites.one', { name: others[0] });
  if (others.length === 2) return i18n.t('recipes.favorites.two', { first: others[0], second: others[1] });
  return i18n.t('recipes.favorites.many', { name: others[0], count: others.length - 1 });
}
