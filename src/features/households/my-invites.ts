// Invites waiting in the app (spec 4.7, design R2b): the open invites sent to the signed-in user's
// email, shown at the top of the Your lists sheet. Fetched after sign-in, on each foreground and on
// reconnect, kept in memory only (nothing in SQLite) and cleared on sign-out.
import { useSyncExternalStore } from 'react';

import { db, households } from '@/db';
import { startCatchUpTriggers } from '@/features/categories/catch-up';
import { i18n } from '@/i18n';
import { pullNow } from '@/sync/pull';

import { avatarInitial, deleteHousehold, fetchHouseholdMembers } from './households';
import {
  acceptInviteById,
  declineInvite,
  InviteError,
  inviteErrorMessage,
  myInvites,
  type MyInvite,
} from './invites';

let invites: MyInvite[] = [];
const listeners = new Set<() => void>();
/** Bumped on sign-out, so a fetch that started before it can't bring the cards back. */
let generation = 0;
/** Last known connectivity; null until the OS reports it. */
let online: boolean | null = null;

function setInvites(next: MyInvite[]) {
  invites = next;
  for (const listener of [...listeners]) listener();
}

export function getMyInvites(): MyInvite[] {
  return invites;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useMyInvites(): MyInvite[] {
  return useSyncExternalStore(subscribe, getMyInvites);
}

/** The fetch under way, which callers share; null when none is. */
let inFlight: Promise<void> | null = null;

/**
 * Fetches the caller's invites into the store. Skipped while the OS says there's no connection; a
 * failed fetch keeps the cards already shown. A call while a fetch is under way waits for that one.
 * Never throws.
 */
export function refreshMyInvites(): Promise<void> {
  if (online === false) return Promise.resolve();
  if (inFlight) return inFlight;
  const current = generation;
  const run: Promise<void> = myInvites().then(
    (next) => {
      if (current === generation) setInvites(next);
    },
    (err) => console.warn('[invites] my_invites failed', err),
  );
  inFlight = run.finally(() => {
    if (current === generation) inFlight = null;
  });
  return inFlight;
}

/** Empties the store (sign-out). */
export function clearMyInvites(): void {
  generation++;
  inFlight = null;
  if (invites.length > 0) setInvites([]);
}

function removeMyInvite(inviteId: string) {
  if (invites.some((i) => i.id === inviteId)) setInvites(invites.filter((i) => i.id !== inviteId));
}

/**
 * Fetches now, then on every foreground and reconnect. Call while signed in; the cleanup stops the
 * triggers and clears the store.
 */
export function startMyInvites(): () => void {
  const stopTriggers = startCatchUpTriggers(
    () => void refreshMyInvites(),
    (now) => {
      online = now;
    },
  );
  void refreshMyInvites();
  return () => {
    stopTriggers();
    online = null;
    clearMyInvites();
  };
}

/**
 * What a card's Join or Decline did. A failure says why, and whether the card went away. A success
 * can carry a notice (joined, but the household to delete couldn't be).
 */
export type MyInviteResult = { ok: true; notice?: string } | { ok: false; message: string; removed: boolean };

/**
 * A failed Join or Decline. An invite that can't be used any more (revoked, used or declined
 * elsewhere, which the server reports as used; or gone) is cancelled as far as the card goes, so
 * its card is removed; an expired one too. Anything else (offline) keeps the card.
 */
export function myInviteFailure(err: unknown): { message: string; removed: boolean } {
  const kind = err instanceof InviteError ? err.kind : 'network';
  if (kind === 'used' || kind === 'invalid') return { message: i18n.t('invites.errors.cancelled'), removed: true };
  if (kind === 'expired') return { message: inviteErrorMessage('expired'), removed: true };
  return { message: inviteErrorMessage(kind), removed: false };
}

async function act(invite: MyInvite, run: () => Promise<unknown>, label: string): Promise<MyInviteResult> {
  try {
    await run();
    removeMyInvite(invite.id);
    return { ok: true };
  } catch (err) {
    console.warn(`[invites] ${label} failed`, err);
    const failure = myInviteFailure(err);
    if (failure.removed) removeMyInvite(invite.id);
    return { ok: false, ...failure };
  }
}

/**
 * Joins the invite's household, pulls it in (like the join screen) and removes the card. With
 * `replacing`, then deletes that household (see `householdToReplace`); joining first, so the user is
 * never left with none and given a new personal one.
 */
export async function joinMyInvite(
  invite: MyInvite,
  replacing?: { id: string; name: string },
): Promise<MyInviteResult> {
  const result = await act(
    invite,
    async () => {
      await acceptInviteById(invite.id);
      // The new membership syncs the household in; wait for it so its section appears with the card gone.
      await pullNow();
    },
    'accept',
  );
  if (!result.ok || !replacing) return result;
  return (await deleteReplaced(replacing)) ?? result;
}

/** Deletes the household a join replaces. Null when it went, else a notice saying it didn't. */
export async function deleteReplaced(replacing: { id: string; name: string }): Promise<MyInviteResult | null> {
  try {
    await deleteHousehold(replacing.id);
    return null;
  } catch (err) {
    console.warn('[invites] delete replaced household failed', err);
    return { ok: true, notice: i18n.t('invites.replace.deleteFailed', { name: replacing.name }) };
  }
}

/**
 * The household joining `householdId` could replace: the user's only other household, when they're
 * its only member (the personal one they started with, typically), so deleting it affects nobody.
 * Null otherwise, or when its members can't be fetched (then joining just keeps it).
 */
export async function householdToReplace(
  householdId: string,
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const others = db
    .select({ id: households.id, name: households.name })
    .from(households)
    .all()
    .filter((h) => h.id !== householdId);
  if (others.length !== 1) return null;
  try {
    const members = await fetchHouseholdMembers(others[0].id, userId);
    return members.length === 1 && members[0].isYou ? others[0] : null;
  } catch (err) {
    console.warn('[invites] members fetch failed', err);
    return null;
  }
}

/** The Join prompt when there's a household to replace: keep it, or delete it. */
export function replaceHouseholdPrompt(
  joining: string,
  replacing: { name: string },
): { title: string; message: string; keep: string; remove: string } {
  const name = replacing.name.trim() || i18n.t('invites.card.aHousehold');
  const household = joining.trim() || i18n.t('invites.card.aHousehold');
  return {
    title: i18n.t('invites.replace.title', { name }),
    message: i18n.t('invites.replace.message', { name, household }),
    keep: i18n.t('invites.replace.keep'),
    remove: i18n.t('invites.replace.delete', { name }),
  };
}

/** Declines the invite (its link stops working) and removes the card. Confirm first. */
export function declineMyInvite(invite: MyInvite): Promise<MyInviteResult> {
  return act(invite, () => declineInvite(invite.id), 'decline');
}

// --- The card's text -----------------------------------------------------------------------

/** "John invited you", or "You're invited" when the inviter has no name. */
export function inviteCardTitle(invite: MyInvite): string {
  const inviter = invite.invitedBy?.trim();
  return inviter ? i18n.t('invites.card.title', { name: inviter }) : i18n.t('invites.card.titleUnnamed');
}

function householdLabel(invite: MyInvite): string {
  return invite.householdName.trim() || i18n.t('invites.card.aHousehold');
}

/** The Decline button's VoiceOver label: "Decline invite to Smith household". */
export function declineInviteLabel(invite: MyInvite): string {
  return i18n.t('invites.card.declineLabel', { household: householdLabel(invite) });
}

/** "to Smith household · 2 members". */
export function inviteCardDetail(invite: MyInvite): string {
  return i18n.t('invites.card.detail', { household: householdLabel(invite), count: invite.memberCount });
}

/** What VoiceOver reads for the card: "John invited you to Smith household". */
export function inviteCardAccessibilityLabel(invite: MyInvite): string {
  return i18n.t('invites.card.label', { title: inviteCardTitle(invite), household: householdLabel(invite) });
}

/** The letter in the card's avatar: the inviter's initial, else the household's. */
export function inviteCardInitial(invite: MyInvite): string {
  return avatarInitial(invite.invitedBy?.trim() || invite.householdName);
}

/** The Decline confirmation: "Decline the invite to Smith household?" / "John can send a new one." */
export function declineInvitePrompt(invite: MyInvite): { title: string; message: string } {
  const inviter = invite.invitedBy?.trim();
  return {
    title: i18n.t('invites.card.declineTitle', { household: householdLabel(invite) }),
    message: inviter
      ? i18n.t('invites.card.declineMessage', { name: inviter })
      : i18n.t('invites.card.declineMessageUnnamed'),
  };
}
