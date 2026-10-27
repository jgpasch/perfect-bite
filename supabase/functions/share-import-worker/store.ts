import type { SupabaseClient } from '@supabase/supabase-js';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import {
  CommitConflictError,
  type ContributionRow,
  type ListRow,
  type ShareImportCommitStore,
  type ShareImportReceipt,
} from './commit.ts';
import { LeaseLostError, type ShareImportJob, type ShareImportWorkerStore } from './handler.ts';

/** The worker's functions raise `lease_lost` (55000) under a lease that isn't the job's. */
function leaseLost(error: { code?: string; message?: string }): boolean {
  return error.code === '55000' && error.message === 'lease_lost';
}

function check(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (leaseLost(error)) throw new LeaseLostError();
  if (error.code === '40001' && (error.message === 'plan_conflict' || error.message === 'destination_changed')) {
    throw new CommitConflictError(error.message);
  }
  throw error;
}

type ListDbRow = { id: string; household_id: string; archived_at: string | null; deleted_at: string | null };

const listRow = (r: ListDbRow): ListRow => ({
  id: r.id,
  householdId: r.household_id,
  archivedAt: r.archived_at,
  deletedAt: r.deleted_at,
});

/**
 * A canonical recipe URL's lookup key for `share_import_reuse_candidates`: its host and its path
 * without trailing slashes, as `private.recipe_url_lookup_key` makes them from a stored URL. Null
 * for one that doesn't parse (never a canonical URL).
 */
export function recipeUrlLookupKey(canonicalUrl: string): string | null {
  try {
    const url = new URL(canonicalUrl);
    return `${url.hostname}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * ShareImportCommitStore over the service-role client (which reads past RLS): the reads are plain
 * selects, each its own statement outside any transaction; the commit is one RPC.
 */
export function createShareImportCommitStore(admin: SupabaseClient): ShareImportCommitStore {
  return {
    async isMember(userId, householdId) {
      const { data, error } = await admin
        .from('household_members')
        .select('user_id')
        .eq('household_id', householdId)
        .eq('user_id', userId)
        .maybeSingle();
      check(error);
      return data !== null;
    },

    async list(listId) {
      const { data, error } = await admin
        .from('lists')
        .select('id, household_id, archived_at, deleted_at')
        .eq('id', listId)
        .maybeSingle();
      check(error);
      return data ? listRow(data as ListDbRow) : null;
    },

    async defaultListId(userId) {
      const { data, error } = await admin.from('user_settings').select('default_list_id').eq('user_id', userId).maybeSingle();
      check(error);
      return (data?.default_list_id as string | null | undefined) ?? null;
    },

    async memberLists(userId) {
      const { data: members, error } = await admin.from('household_members').select('household_id').eq('user_id', userId);
      check(error);
      const households = (members ?? []).map((m) => m.household_id as string);
      if (households.length === 0) return [];
      const { data, error: listsError } = await admin
        .from('lists')
        .select('id, household_id, archived_at, deleted_at')
        .in('household_id', households)
        .is('deleted_at', null)
        .is('archived_at', null)
        .order('position')
        .order('id');
      check(listsError);
      return ((data ?? []) as ListDbRow[]).map(listRow);
    },

    async combineLanguages(householdId) {
      const { data, error } = await admin.from('households').select('combine_languages').eq('id', householdId).maybeSingle();
      check(error);
      return data?.combine_languages === true;
    },

    async catalog(names) {
      if (names.length === 0) return [];
      const { data, error } = await admin
        .from('ingredients')
        .select('normalized_name, same_as, default_unit')
        .in('normalized_name', names);
      check(error);
      return (data ?? []).map((r) => ({
        normalizedName: r.normalized_name as string,
        sameAs: r.same_as as string | null,
        defaultUnit: r.default_unit as string | null,
      }));
    },

    async liveItems(listId) {
      const { data, error } = await admin
        .from('list_items')
        .select('id, ingredient_name, display_name, checked_at, checked_by')
        .eq('list_id', listId)
        .is('deleted_at', null)
        .order('created_at')
        .order('id');
      check(error);
      return (data ?? []).map((r) => ({
        id: r.id as string,
        ingredientName: r.ingredient_name as string,
        displayName: r.display_name as string,
        checkedAt: r.checked_at as string | null,
        checkedBy: r.checked_by as string | null,
      }));
    },

    async liveContributions(itemIds) {
      if (itemIds.length === 0) return [];
      const { data, error } = await admin
        .from('list_item_contributions')
        .select('id, list_item_id, source, quantity, unit')
        .in('list_item_id', itemIds)
        .is('deleted_at', null)
        .order('created_at')
        .order('id');
      check(error);
      return (data ?? []).map((r) => ({
        id: r.id as string,
        listItemId: r.list_item_id as string,
        source: r.source as ContributionRow['source'],
        quantity: r.quantity === null ? null : Number(r.quantity),
        unit: r.unit as string | null,
      }));
    },

    async unitUsage(householdId, names) {
      if (names.length === 0) return [];
      const { data, error } = await admin
        .from('ingredient_unit_usage')
        .select('ingredient_name, unit_key, use_count, last_used_at')
        .eq('household_id', householdId)
        .in('ingredient_name', names);
      check(error);
      return (data ?? []).map((r) => ({
        ingredientName: r.ingredient_name as string,
        unitKey: r.unit_key as string,
        useCount: r.use_count as number,
        lastUsedAt: r.last_used_at as string,
      }));
    },

    async recipeExists(id) {
      const { data, error } = await admin.from('recipes').select('id').eq('id', id).maybeSingle();
      check(error);
      return data !== null;
    },

    async reuseCandidates(householdId, importRecipeId, sourceUrl) {
      const { data, error } = await admin.rpc('share_import_reuse_candidates', {
        p_household_id: householdId,
        p_import_recipe_id: importRecipeId,
        p_url_key: sourceUrl === null ? null : recipeUrlLookupKey(sourceUrl),
      });
      check(error);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        householdId: r.household_id as string,
        sourceUrl: r.source_url as string | null,
        deletedAt: r.deleted_at as string | null,
      }));
    },

    async commit(id, lease, target, writes, preconditions) {
      const { data, error } = await admin.rpc('commit_share_import', {
        p_id: id,
        p_lease: lease,
        p_target: target,
        p_writes: writes,
        p_preconditions: preconditions,
      });
      check(error);
      return data as ShareImportReceipt;
    },
  };
}

/** ShareImportWorkerStore over the service-role client: each call is one short transaction. */
export function createShareImportWorkerStore(admin: SupabaseClient): ShareImportWorkerStore {
  return {
    async claim(kinds) {
      const { data, error } = await admin.rpc('claim_share_import', { p_kinds: kinds });
      check(error);
      const rows = (data ?? []) as ShareImportJob[];
      return rows[0] ?? null;
    },

    async reserve(id, lease) {
      const { data, error } = await admin.rpc('reserve_share_import', { p_id: id, p_lease: lease });
      check(error);
      return data as LimitResult;
    },

    async saveExtraction(id, lease, extraction) {
      const { error } = await admin.rpc('save_share_extraction', { p_id: id, p_lease: lease, p_extraction: extraction });
      check(error);
    },

    async release(id, lease, release) {
      const { data, error } = await admin.rpc('release_share_import', {
        p_id: id,
        p_lease: lease,
        p_kind: release.kind,
        p_code: release.code,
        p_next_attempt_at: null,
        p_resets_at: release.resetsAt ?? null,
      });
      check(error);
      return data as string;
    },
  };
}
