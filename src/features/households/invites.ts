// Household invites (spec 4.7). Any member creates an invite on the server (`create_invite`) and
// shares its link; the person who opens it sees the join screen (`preview_invite`) and joins with
// `accept_invite`. An invite can name the email it's for: it then shows as pending on the household
// screen (`list_household_invites`) and in the invitee's app (`my_invites`), where they can accept
// or decline it without the link. Links use the app scheme for now; Universal Links need a hosted
// domain.
import { i18n, onLanguageChanged } from '@/i18n';
import { supabase } from '@/lib/supabase';

/** The deep link for an invite token. Opens `src/app/invite/[token].tsx`. */
export function inviteLink(token: string): string {
  return `perfectbite://invite/${token}`;
}

/** The text sent through Messages and the share sheet (More…): what it is, then the link. */
export function inviteShareMessage(householdName: string, link: string): string {
  const name = householdName.trim();
  return name ? i18n.t('invites.share', { name, link }) : i18n.t('invites.shareUnnamed', { link });
}

/** The subject of an invite sent through Mail. */
export function inviteMailSubject(householdName: string): string {
  return i18n.t('invites.mailSubject', { name: householdName.trim() || i18n.t('invites.myHousehold') });
}

/**
 * The body of an invite sent through Mail: who invited them, what joining means, the link, and
 * that signing in with the invited email finds the invite even without the link.
 */
export function inviteMailBody({
  householdName,
  inviterName,
  email,
  link,
}: {
  householdName: string;
  inviterName: string | null | undefined;
  email: string;
  link: string;
}): string {
  const household = householdName.trim() || i18n.t('invites.myHousehold');
  const inviter = inviterName?.trim();
  return [
    inviter ? i18n.t('invites.mailInvitedBy', { inviter, household }) : i18n.t('invites.mailInvited', { household }),
    i18n.t('invites.joinBody'),
    i18n.t('invites.mailLink', { link }),
    i18n.t('invites.mailSignIn', { email: normalizeEmail(email) }),
  ].join('\n\n');
}

// The same pattern as the server's check on `household_invites.invited_email`.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Whether `email`, trimmed, is an address `create_invite` accepts. */
export function isEmail(email: string | null | undefined): email is string {
  return typeof email === 'string' && EMAIL.test(email.trim());
}

/** An email as the server stores it: trimmed and lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether a link's token could be one `create_invite` made (URL-safe base64), so garbage never reaches the server. */
export function isInviteToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

export type InviteErrorKind = 'invalid' | 'used' | 'expired' | 'already-member' | 'invalid-email' | 'network';

/** A failed invite call, with what went wrong for the join screen. */
export class InviteError extends Error {
  constructor(
    readonly kind: InviteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'InviteError';
  }
}

/**
 * What the join screen and the invite sheet say for each failure. `already-member` names the email
 * and household the sheet invited.
 */
export function inviteErrorMessage(
  kind: InviteErrorKind,
  context: { email?: string | null; householdName?: string | null } = {},
): string {
  switch (kind) {
    case 'invalid':
      return i18n.t('invites.errors.invalid');
    case 'used':
      return i18n.t('invites.errors.used');
    case 'expired':
      return i18n.t('invites.errors.expired');
    case 'already-member': {
      const email = context.email?.trim();
      const household = context.householdName?.trim() || i18n.t('households.thisHousehold');
      return email
        ? i18n.t('invites.errors.alreadyMemberEmail', { email: normalizeEmail(email), household })
        : i18n.t('invites.errors.alreadyMember', { household });
    }
    case 'invalid-email':
      return i18n.t('invites.errors.invalidEmail');
    case 'network':
      return i18n.t('invites.errors.network');
  }
}

/** Maps a server error to an `InviteError` by the messages the invite functions raise. */
export function toInviteError(error: unknown): InviteError {
  const raw = (error as { message?: unknown } | null)?.message;
  const message = typeof raw === 'string' ? raw : '';
  if (message.includes('invite not found')) return new InviteError('invalid', message);
  if (message.includes('invite already used')) return new InviteError('used', message);
  if (message.includes('invite expired')) return new InviteError('expired', message);
  if (message.includes('already a member')) return new InviteError('already-member', message);
  if (message.includes('invalid email')) return new InviteError('invalid-email', message);
  return new InviteError('network', message || 'Request failed');
}

/**
 * Creates an invite to a household the caller belongs to and returns its link. With an email, the
 * invite is for that address and any open invite to it is revoked first (so this is also "Send
 * again"); without one it's a link-only invite. Throws an `InviteError` with the server's message
 * (including for a household the server doesn't have yet).
 */
export async function createInvite(householdId: string, email?: string | null): Promise<string> {
  const args: { p_household_id: string; p_email?: string } = { p_household_id: householdId };
  if (email != null) args.p_email = normalizeEmail(email);
  const { data, error } = await supabase.rpc('create_invite', args);
  if (error) throw toInviteError(error);
  if (typeof data !== 'string' || !data) throw new InviteError('network', "Couldn't create an invite");
  return inviteLink(data);
}

/** An open invite, for the household screen. A null email is a link-only invite. */
export type HouseholdInvite = {
  id: string;
  email: string | null;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
};

type HouseholdInviteRow = {
  id: string;
  invited_email: string | null;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
};

/** A household's open, unexpired invites, newest first. Members only. Throws an `InviteError`. */
export async function listHouseholdInvites(householdId: string): Promise<HouseholdInvite[]> {
  const { data, error } = await supabase.rpc('list_household_invites', { p_household_id: householdId });
  if (error) throw toInviteError(error);
  return ((data as HouseholdInviteRow[] | null) ?? []).map((row) => ({
    id: row.id,
    email: row.invited_email,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

/** Cancels an invite so its link stops working. Any member can. Throws an `InviteError`. */
export async function revokeInvite(inviteId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_invite', { p_invite_id: inviteId });
  if (error) throw toInviteError(error);
}

/** An invite sent to the signed-in user's email, for a household they aren't in yet. */
export type MyInvite = {
  id: string;
  householdId: string;
  householdName: string;
  invitedBy: string | null;
  memberCount: number;
};

type MyInviteRow = {
  id: string;
  household_id: string;
  household_name: string;
  invited_by: string | null;
  member_count: number;
};

/** The open invites sent to the caller's email, newest first. Throws an `InviteError`. */
export async function myInvites(): Promise<MyInvite[]> {
  const { data, error } = await supabase.rpc('my_invites');
  if (error) throw toInviteError(error);
  return ((data as MyInviteRow[] | null) ?? []).map((row) => ({
    id: row.id,
    householdId: row.household_id,
    householdName: row.household_name,
    invitedBy: row.invited_by,
    memberCount: row.member_count,
  }));
}

export type InviteStatus = 'valid' | 'member' | 'used' | 'expired';

export type InvitePreview = {
  householdId: string;
  householdName: string;
  invitedBy: string | null;
  status: InviteStatus;
};

type PreviewRow = { household_id: string; household_name: string; invited_by: string | null; status: InviteStatus };

/** What an invite is for, before accepting it. Throws an `InviteError`. */
export async function previewInvite(token: string): Promise<InvitePreview> {
  if (!isInviteToken(token)) throw new InviteError('invalid', 'invite not found');
  const { data, error } = await supabase.rpc('preview_invite', { p_token: token });
  if (error) throw toInviteError(error);
  const row = (data as PreviewRow[] | null)?.[0];
  if (!row) throw new InviteError('invalid', 'invite not found');
  return { householdId: row.household_id, householdName: row.household_name, invitedBy: row.invited_by, status: row.status };
}

export type AcceptedInvite = { householdId: string; householdName: string; alreadyMember: boolean };

type AcceptRow = { household_id: string; household_name: string; already_member: boolean };

/**
 * Joins the invite's household. `alreadyMember` when the caller was in it already (the invite isn't
 * used up then). Throws an `InviteError`. The caller pulls the household in (sync).
 */
export async function acceptInvite(token: string): Promise<AcceptedInvite> {
  if (!isInviteToken(token)) throw new InviteError('invalid', 'invite not found');
  const { data, error } = await supabase.rpc('accept_invite', { p_token: token });
  if (error) throw toInviteError(error);
  const row = (data as AcceptRow[] | null)?.[0];
  if (!row) throw new InviteError('network', 'No response');
  return { householdId: row.household_id, householdName: row.household_name, alreadyMember: row.already_member };
}

/**
 * Joins the household of an invite sent to the caller's email, from its card (no link needed). Same
 * result as `acceptInvite`. Throws an `InviteError`; an invite for another email is `invalid`.
 */
export async function acceptInviteById(inviteId: string): Promise<AcceptedInvite> {
  const { data, error } = await supabase.rpc('accept_invite_by_id', { p_invite_id: inviteId });
  if (error) throw toInviteError(error);
  const row = (data as AcceptRow[] | null)?.[0];
  if (!row) throw new InviteError('network', 'No response');
  return { householdId: row.household_id, householdName: row.household_name, alreadyMember: row.already_member };
}

/** Declines an invite sent to the caller's email; its link stops working. Throws an `InviteError`. */
export async function declineInvite(inviteId: string): Promise<void> {
  const { error } = await supabase.rpc('decline_invite', { p_invite_id: inviteId });
  if (error) throw toInviteError(error);
}

/** The join screen's question for a valid invite (spec 4.7). */
export function joinTitle(householdName: string): string {
  return i18n.t('invites.join.title', { name: householdName.trim() || i18n.t('households.thisHousehold') });
}

/** What joining means (a live binding). */
export let JOIN_BODY = '';
onLanguageChanged(() => {
  JOIN_BODY = i18n.t('invites.joinBody');
});

/** The line for a status that can't be joined, or null for a valid one. */
export function inviteStatusMessage(status: InviteStatus, householdName: string): string | null {
  const name = householdName.trim() || i18n.t('households.thisHousehold');
  switch (status) {
    case 'valid':
      return null;
    case 'member':
      return i18n.t('invites.join.alreadyIn', { name });
    case 'used':
      return inviteErrorMessage('used');
    case 'expired':
      return inviteErrorMessage('expired');
  }
}
