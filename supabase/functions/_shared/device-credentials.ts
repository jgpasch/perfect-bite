// Device credentials (spec 6.12): a scoped token the share extension uploads with, never a Supabase
// session. A token is 32 random bytes, sent as base64url; the database keeps only the sha256 of the
// bytes (hex over the RPCs). The token is never logged.

/** The scopes a credential can carry; `share-ingest` accepts `share.ingest`. */
export type DeviceCredentialScope = 'share.ingest' | 'siri.add';

/** What these helpers need of the service-role client, so tests can pass a fake. */
export type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export const TOKEN_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A new token: 32 random bytes as base64url (43 characters). */
export function newDeviceToken(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return toBase64Url(random(new Uint8Array(TOKEN_BYTES)));
}

/** The token's sha256 as lowercase hex, or null for anything but 32 bytes in base64url. */
export async function hashDeviceToken(token: string): Promise<string | null> {
  const bytes = fromBase64Url(token);
  if (bytes === null || bytes.length !== TOKEN_BYTES) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The user id of the credential `token` belongs to, or null for an unknown, revoked, expired or
 * out-of-scope token (or one that isn't a token at all). Updates the credential's `last_used_at`.
 * A database error throws: it isn't a bad credential.
 */
export async function verifyDeviceCredential(admin: RpcClient, token: string, scope: DeviceCredentialScope): Promise<string | null> {
  const hash = await hashDeviceToken(token);
  if (hash === null) return null;
  const { data, error } = await admin.rpc('use_device_credential', { p_token_hash: hash, p_scope: scope });
  if (error) throw new Error(`use_device_credential failed: ${error.message}`);
  return typeof data === 'string' ? data : null;
}
