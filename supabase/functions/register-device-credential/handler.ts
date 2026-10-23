// register-device-credential (spec 6.12): replaces the signed-in user's credential for an app
// installation and returns the new token once. The old one keeps a 24 h grace (in the RPC); the
// token is stored only as its sha256 and never logged.
import { hashDeviceToken, newDeviceToken, type RpcClient } from '../_shared/device-credentials.ts';

export type RegisterDeviceCredentialRequest = { installationId: string };
export type RegisterDeviceCredentialResponse = { token: string; expiresAt: string };

export type RegisterDeviceCredentialStore = {
  /** Replaces the live credential for (user, installation) with one of this sha256 (hex); its expires_at. */
  register(installationId: string, tokenHash: string): Promise<string>;
};

export type RegisterDeviceCredentialDeps = {
  store: RegisterDeviceCredentialStore;
  /** Fills the buffer with random bytes; crypto.getRandomValues outside tests. */
  random?: (bytes: Uint8Array) => Uint8Array;
};

export async function registerDeviceCredential(
  request: RegisterDeviceCredentialRequest,
  deps: RegisterDeviceCredentialDeps,
): Promise<RegisterDeviceCredentialResponse> {
  const token = newDeviceToken(deps.random);
  const hash = await hashDeviceToken(token);
  if (hash === null) throw new Error('made a malformed token');
  const expiresAt = await deps.store.register(request.installationId, hash);
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

/** The store over the service-role client, for `userId`. */
export function createRegisterStore(admin: RpcClient, userId: string): RegisterDeviceCredentialStore {
  return {
    async register(installationId, tokenHash) {
      const { data, error } = await admin.rpc('register_device_credential', {
        p_user_id: userId,
        p_installation_id: installationId,
        p_token_hash: tokenHash,
      });
      if (error) throw new Error(`register_device_credential failed: ${error.message}`);
      if (typeof data !== 'string') throw new Error('register_device_credential returned no expiry');
      return data;
    },
  };
}
