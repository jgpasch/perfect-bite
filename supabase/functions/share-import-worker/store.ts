import type { SupabaseClient } from '@supabase/supabase-js';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { LeaseLostError, type ShareImportJob, type ShareImportWorkerStore } from './handler.ts';

/** The worker's functions raise `lease_lost` (55000) under a lease that isn't the job's. */
function leaseLost(error: { code?: string; message?: string }): boolean {
  return error.code === '55000' && error.message === 'lease_lost';
}

function check(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  if (leaseLost(error)) throw new LeaseLostError();
  throw error;
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
