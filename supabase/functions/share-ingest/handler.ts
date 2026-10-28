// share-ingest (spec 6.12): records a shared recipe as a `share_imports` operation keyed by the
// envelope id, for share-import-worker to import. The user comes from authentication, never the
// envelope; the same id with the same user and payload is the same operation (a lost answer, or the
// background upload and the app's submit of one share).
import { canonicalRecipeUrl, type ShareEnvelope, shareAddsToList } from '@shared/index.ts';

import type { RpcClient } from '../_shared/device-credentials.ts';

/** Who is submitting: a device credential's user (with its id) or a session's (null). */
export type ShareIngestAuth = { userId: string; credentialId: string | null };

export type ShareImportStatus = 'received' | 'extracting' | 'extracted' | 'committing' | 'done' | 'failed';

/** What ingest_share_import records. */
export type ShareIngestRow = {
  id: string;
  userId: string;
  credentialId: string | null;
  /** Null: the list's household, else the user's default list's, else their first (the RPC decides). */
  householdId: string | null;
  listId: string | null;
  addToList: boolean;
  url: string;
  urlKey: string;
  title: string | null;
  /** sha256 of the canonical payload, lowercase hex. */
  payloadHash: string;
  page: ShareEnvelope['page'] | null;
  clientCreatedAt: string;
  appVersion: string;
  source: string;
};

export type ShareIngestOutcome =
  | { outcome: 'accepted'; status: ShareImportStatus }
  | { outcome: 'conflict' | 'not_a_member' | 'invalid_list' };

export type ShareIngestStore = {
  /** The credential's `share_ingest` limit, counting one upload: 'ok' or 'user_limit'. */
  checkLimit(credentialId: string): Promise<'ok' | 'user_limit'>;
  /** The user's `share_ingest` limit for uploads with a session, counting one: 'ok' or 'user_limit'. */
  checkUserLimit(userId: string): Promise<'ok' | 'user_limit'>;
  /** Records the operation, or answers the one already under its id. */
  ingest(row: ShareIngestRow): Promise<ShareIngestOutcome>;
};

/** JSON with object keys sorted at every level, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The payload hash: sha256 of the canonical (url, household, list, addToList, page), the URL by
 * its canonical form and ids lower-case, so a resubmit of the same share always matches.
 */
export function sharePayloadHash(envelope: ShareEnvelope): Promise<string> {
  return sha256Hex(
    canonicalJson({
      url: envelope.url === undefined ? null : canonicalRecipeUrl(envelope.url),
      householdId: envelope.householdId?.toLowerCase() ?? null,
      listId: envelope.listId?.toLowerCase() ?? null,
      addToList: shareAddsToList(envelope),
      page: envelope.page ?? null,
    }),
  );
}

/** The row to record for a validated envelope from `auth`'s user. */
export async function shareIngestRow(envelope: ShareEnvelope, auth: ShareIngestAuth): Promise<ShareIngestRow> {
  if (envelope.url === undefined) throw new Error('share-ingest: a photo share has no row yet');
  const urlKey = canonicalRecipeUrl(envelope.url);
  if (urlKey === null) throw new Error('share-ingest: the envelope URL was not validated');
  return {
    id: envelope.id.toLowerCase(),
    userId: auth.userId,
    credentialId: auth.credentialId,
    householdId: envelope.householdId?.toLowerCase() ?? null,
    listId: envelope.listId?.toLowerCase() ?? null,
    addToList: shareAddsToList(envelope),
    url: envelope.url.trim(),
    urlKey,
    title: envelope.page?.title?.trim() || null,
    payloadHash: await sharePayloadHash(envelope),
    page: envelope.page ?? null,
    clientCreatedAt: envelope.createdAt,
    appVersion: envelope.appVersion,
    source: envelope.source,
  };
}

const STATUSES: readonly string[] = ['received', 'extracting', 'extracted', 'committing', 'done', 'failed'];
const REFUSALS: readonly string[] = ['conflict', 'not_a_member', 'invalid_list'];

/** The store over the service-role client. */
export function createShareIngestStore(admin: RpcClient): ShareIngestStore {
  return {
    async checkLimit(credentialId) {
      const { data, error } = await admin.rpc('check_share_ingest_limit', { p_credential_id: credentialId });
      if (error) throw new Error(`check_share_ingest_limit failed: ${error.message}`);
      if (data !== 'ok' && data !== 'user_limit') throw new Error(`check_share_ingest_limit answered ${String(data)}`);
      return data;
    },
    async checkUserLimit(userId) {
      const { data, error } = await admin.rpc('check_share_ingest_user_limit', { p_user_id: userId });
      if (error) throw new Error(`check_share_ingest_user_limit failed: ${error.message}`);
      if (data !== 'ok' && data !== 'user_limit') throw new Error(`check_share_ingest_user_limit answered ${String(data)}`);
      return data;
    },
    async ingest(row) {
      const { data, error } = await admin.rpc('ingest_share_import', {
        p_id: row.id,
        p_user_id: row.userId,
        p_credential_id: row.credentialId,
        p_household_id: row.householdId,
        p_list_id: row.listId,
        p_add_to_list: row.addToList,
        p_url: row.url,
        p_url_key: row.urlKey,
        p_title: row.title,
        p_payload_hash: row.payloadHash,
        p_page: row.page,
        p_client_created_at: row.clientCreatedAt,
        p_app_version: row.appVersion,
        p_source: row.source,
      });
      if (error) throw new Error(`ingest_share_import failed: ${error.message}`);
      const answer = (Array.isArray(data) ? data[0] : data) as { outcome?: unknown; status?: unknown } | null;
      if (answer?.outcome === 'accepted' && typeof answer.status === 'string' && STATUSES.includes(answer.status)) {
        return { outcome: 'accepted', status: answer.status as ShareImportStatus };
      }
      if (typeof answer?.outcome === 'string' && REFUSALS.includes(answer.outcome)) {
        return { outcome: answer.outcome as 'conflict' | 'not_a_member' | 'invalid_list' };
      }
      throw new Error(`ingest_share_import answered ${JSON.stringify(answer)}`);
    },
  };
}
