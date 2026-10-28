// share-ingest (spec 6.12): records a shared recipe as a `share_imports` operation keyed by the
// envelope id, for share-import-worker to import. The user comes from authentication, never the
// envelope; the same id with the same user and payload is the same operation (a lost answer, or the
// background upload and the app's submit of one share). A photo share's pages go to share-images
// before it's recorded (request.ts).
import { canonicalRecipeUrl, type ShareEnvelope, shareAddsToList, shareKind } from '@shared/index.ts';

import type { RpcClient } from '../_shared/device-credentials.ts';

/** Who is submitting: a device credential's user (with its id) or a session's (null). */
export type ShareIngestAuth = { userId: string; credentialId: string | null };

export type ShareImportStatus = 'received' | 'extracting' | 'extracted' | 'committing' | 'done' | 'failed';

/** What ingest_share_import (a link) or ingest_photo_share_import (a photo) records. */
export type ShareIngestRow = {
  kind: 'link' | 'photo';
  id: string;
  userId: string;
  credentialId: string | null;
  /** Null: the list's household, else the user's default list's, else their first (the RPC decides). */
  householdId: string | null;
  listId: string | null;
  addToList: boolean;
  /** A link's URL and its canonical form; null for a photo. */
  url: string | null;
  urlKey: string | null;
  title: string | null;
  /** A photo's number of pages; null for a link. */
  pageCount: number | null;
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

/** What the check before uploading a photo share's pages answers: 'new' where it would record it. */
export type ShareIngestCheck = ShareIngestOutcome | { outcome: 'new' };

export type ShareIngestStore = {
  /** The credential's `share_ingest` limit, counting one upload: 'ok' or 'user_limit'. */
  checkLimit(credentialId: string): Promise<'ok' | 'user_limit'>;
  /** The user's `share_ingest` limit for uploads with a session, counting one: 'ok' or 'user_limit'. */
  checkUserLimit(userId: string): Promise<'ok' | 'user_limit'>;
  /** Records the operation, or answers the one already under its id. */
  ingest(row: ShareIngestRow): Promise<ShareIngestOutcome>;
  /** A photo share: answers as `ingest` would, recording nothing ('new' where it would record it). */
  check(row: ShareIngestRow): Promise<ShareIngestCheck>;
};

/** The private bucket a photo share's pages wait in until the worker imports them (spec 5). */
export const SHARE_IMAGES_BUCKET = 'share-images';

/** A photo share's pages in share-images: '<user_id>/<id>/<n>.jpg', n from 1, as the SQL names them. */
export function shareImagePaths(userId: string, id: string, pageCount: number): string[] {
  return Array.from({ length: pageCount }, (_, i) => `${userId.toLowerCase()}/${id.toLowerCase()}/${i + 1}.jpg`);
}

/** JSON with object keys sorted at every level, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An image's bytes from its (validated, standard) base64. */
export function decodeImage(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The payload hash: sha256 of the canonical (url, household, list, addToList, page), the URL by
 * its canonical form and ids lower-case, so a resubmit of the same share always matches. A photo
 * share's is of (household, list, addToList, each image's sha256 in order), never the bytes.
 */
export async function sharePayloadHash(envelope: ShareEnvelope): Promise<string> {
  const target = {
    householdId: envelope.householdId?.toLowerCase() ?? null,
    listId: envelope.listId?.toLowerCase() ?? null,
    addToList: shareAddsToList(envelope),
  };
  if (envelope.images !== undefined) {
    const images = await Promise.all(envelope.images.map((image) => sha256Hex(decodeImage(image.data))));
    return sha256Hex(canonicalJson({ ...target, images }));
  }
  return sha256Hex(
    canonicalJson({
      url: envelope.url === undefined ? null : canonicalRecipeUrl(envelope.url),
      ...target,
      page: envelope.page ?? null,
    }),
  );
}

/** The row to record for a validated envelope from `auth`'s user. */
export async function shareIngestRow(envelope: ShareEnvelope, auth: ShareIngestAuth): Promise<ShareIngestRow> {
  const photo = shareKind(envelope) === 'photo';
  const urlKey = photo || envelope.url === undefined ? null : canonicalRecipeUrl(envelope.url);
  if (!photo && urlKey === null) throw new Error('share-ingest: the envelope URL was not validated');
  return {
    kind: photo ? 'photo' : 'link',
    id: envelope.id.toLowerCase(),
    userId: auth.userId,
    credentialId: auth.credentialId,
    householdId: envelope.householdId?.toLowerCase() ?? null,
    listId: envelope.listId?.toLowerCase() ?? null,
    addToList: shareAddsToList(envelope),
    url: photo ? null : (envelope.url?.trim() ?? null),
    urlKey,
    title: envelope.page?.title?.trim() || null,
    pageCount: photo ? (envelope.images?.length ?? null) : null,
    payloadHash: await sharePayloadHash(envelope),
    page: envelope.page ?? null,
    clientCreatedAt: envelope.createdAt,
    appVersion: envelope.appVersion,
    source: envelope.source,
  };
}

const STATUSES: readonly string[] = ['received', 'extracting', 'extracted', 'committing', 'done', 'failed'];
const REFUSALS: readonly string[] = ['conflict', 'not_a_member', 'invalid_list'];

/** One answer of ingest_share_import or ingest_photo_share_import ('new' only from a check). */
function readOutcome(fn: string, data: unknown, check: boolean): ShareIngestCheck {
  const answer = (Array.isArray(data) ? data[0] : data) as { outcome?: unknown; status?: unknown } | null;
  if (answer?.outcome === 'accepted' && typeof answer.status === 'string' && STATUSES.includes(answer.status)) {
    return { outcome: 'accepted', status: answer.status as ShareImportStatus };
  }
  if (typeof answer?.outcome === 'string' && REFUSALS.includes(answer.outcome)) {
    return { outcome: answer.outcome as 'conflict' | 'not_a_member' | 'invalid_list' };
  }
  if (check && answer?.outcome === 'new') return { outcome: 'new' };
  throw new Error(`${fn} answered ${JSON.stringify(answer)}`);
}

async function ingestPhoto(admin: RpcClient, row: ShareIngestRow, checkOnly: boolean): Promise<ShareIngestCheck> {
  if (row.kind !== 'photo' || row.pageCount === null) throw new Error('share-ingest: not a photo share');
  const { data, error } = await admin.rpc('ingest_photo_share_import', {
    p_id: row.id,
    p_user_id: row.userId,
    p_credential_id: row.credentialId,
    p_household_id: row.householdId,
    p_list_id: row.listId,
    p_add_to_list: row.addToList,
    p_payload_hash: row.payloadHash,
    p_page_count: row.pageCount,
    p_client_created_at: row.clientCreatedAt,
    p_app_version: row.appVersion,
    p_source: row.source,
    p_check_only: checkOnly,
  });
  if (error) throw new Error(`ingest_photo_share_import failed: ${error.message}`);
  return readOutcome('ingest_photo_share_import', data, checkOnly);
}

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
      if (row.kind === 'photo') return (await ingestPhoto(admin, row, false)) as ShareIngestOutcome;
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
      return readOutcome('ingest_share_import', data, false) as ShareIngestOutcome;
    },
    check(row) {
      return ingestPhoto(admin, row, true);
    },
  };
}
