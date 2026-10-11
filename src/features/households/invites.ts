// Household invites (spec 4.7). Any member creates an invite on the server (`create_invite`) and
// shares its link; the person who opens it sees the join screen (`preview_invite`) and joins with
// `accept_invite`. Links use the app scheme for now; Universal Links need a hosted domain.
import { supabase } from '@/lib/supabase';

/** The deep link for an invite token. Opens `src/app/invite/[token].tsx`. */
export function inviteLink(token: string): string {
  return `perfectbite://invite/${token}`;
}

/** The text shared through the share sheet: what it is, then the link. */
export function inviteShareMessage(householdName: string, link: string): string {
  const name = householdName.trim();
  return name ? `Join “${name}” on The Perfect Bite: ${link}` : `Join my household on The Perfect Bite: ${link}`;
}

/** Whether a link's token could be one `create_invite` made (URL-safe base64), so garbage never reaches the server. */
export function isInviteToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

export type InviteErrorKind = 'invalid' | 'used' | 'expired' | 'network';

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

/** What the join screen says for each failure. */
export function inviteErrorMessage(kind: InviteErrorKind): string {
  switch (kind) {
    case 'invalid':
      return "This invite link isn't valid. Ask for a new one.";
    case 'used':
      return 'This invite has already been used. Ask for a new one.';
    case 'expired':
      return 'This invite has expired. Ask for a new one.';
    case 'network':
      return "Couldn't reach the server. Check your connection and try again.";
  }
}

/** Maps a server error to an `InviteError` by the messages the invite functions raise. */
export function toInviteError(error: unknown): InviteError {
  const raw = (error as { message?: unknown } | null)?.message;
  const message = typeof raw === 'string' ? raw : '';
  if (message.includes('invite not found')) return new InviteError('invalid', message);
  if (message.includes('invite already used')) return new InviteError('used', message);
  if (message.includes('invite expired')) return new InviteError('expired', message);
  return new InviteError('network', message || 'Request failed');
}

/**
 * Creates an invite to a household the caller belongs to and returns its link. Throws an `Error`
 * with the server's message on failure (including a household the server doesn't have yet).
 */
export async function createInvite(householdId: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_invite', { p_household_id: householdId });
  if (error || typeof data !== 'string' || !data) {
    const raw = (error as { message?: unknown } | null)?.message;
    throw new Error(typeof raw === 'string' && raw ? raw : "Couldn't create an invite");
  }
  return inviteLink(data);
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

/** The join screen's question for a valid invite (spec 4.7). */
export function joinTitle(householdName: string): string {
  return `Join ${householdName.trim() || 'this household'}?`;
}

export const JOIN_BODY = "You'll share its lists and recipes. Your other households aren't affected.";

/** The line for a status that can't be joined, or null for a valid one. */
export function inviteStatusMessage(status: InviteStatus, householdName: string): string | null {
  const name = householdName.trim() || 'this household';
  switch (status) {
    case 'valid':
      return null;
    case 'member':
      return `You're already in ${name}.`;
    case 'used':
      return inviteErrorMessage('used');
    case 'expired':
      return inviteErrorMessage('expired');
  }
}
