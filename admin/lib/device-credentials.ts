// The wording of device credentials on a user's page (spec 4.12, 6.12): the Devices card and the
// Revoke dialog's message, kept out of the components so they can be tested.

/** "Revoked 2 device credentials for ann@example.com", or that there were none. */
export function revokedCredentialsMessage(email: string | null, revoked: number): string {
  const who = email ?? "the user";
  if (revoked <= 0) return `No device credentials to revoke for ${who}`;
  return `Revoked ${revoked.toLocaleString("en-US")} device ${revoked === 1 ? "credential" : "credentials"} for ${who}`;
}
