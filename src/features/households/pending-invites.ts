// The household screen's Invited section (spec 4.7, design S4): one row per open invite, with what
// it's for over who sent it and when it expires, and a Pending badge. This is the rows' copy and
// their action sheet; the screen is `src/app/(tabs)/settings/households/[id].tsx`.
import type { HouseholdInvite } from '@/features/households/invites';
import { i18n } from '@/i18n';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A short local date for an invite's expiry: "Oct 18", with the year when it isn't `now`'s year
 * ("Jan 2, 2027"). Null for a timestamp that doesn't parse.
 */
export function inviteDateLabel(iso: string, now: Date = new Date()): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** The row's first line: the invited email, or "Invite link" for a link-only invite. */
export function pendingInviteTitle(invite: Pick<HouseholdInvite, 'email'>): string {
  return invite.email?.trim() || i18n.t('invites.pending.link');
}

/** The row's second line: "Sent by Sam · expires Oct 18", leaving out whatever is unknown. */
export function pendingInviteDetail(
  invite: Pick<HouseholdInvite, 'invitedBy' | 'expiresAt'>,
  now: Date = new Date(),
): string {
  const by = invite.invitedBy?.trim();
  const expires = inviteDateLabel(invite.expiresAt, now);
  const parts = [
    by ? i18n.t('invites.pending.sentBy', { name: by }) : i18n.t('invites.pending.sent'),
    expires ? i18n.t('invites.pending.expires', { date: expires }) : null,
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/** What VoiceOver reads for the row (a button): both lines, then the badge. */
export function pendingInviteAccessibilityLabel(invite: HouseholdInvite, now: Date = new Date()): string {
  return i18n.t('invites.pending.label', { title: pendingInviteTitle(invite), detail: pendingInviteDetail(invite, now) });
}

export type PendingInviteAction = 'send-again' | 'revoke';

/**
 * The row's action sheet, in order, with Cancel last: Send again (email invites only, since a
 * link-only invite has no one to send it to), then the destructive Cancel invite.
 */
export function pendingInviteActions(invite: Pick<HouseholdInvite, 'email'>): {
  options: string[];
  actions: (PendingInviteAction | null)[];
  destructiveButtonIndex: number;
  cancelButtonIndex: number;
} {
  const actions: (PendingInviteAction | null)[] = invite.email ? ['send-again', 'revoke', null] : ['revoke', null];
  const label = (action: PendingInviteAction | null) =>
    action === 'send-again'
      ? i18n.t('invites.pending.sendAgain')
      : action === 'revoke'
        ? i18n.t('invites.pending.cancelInvite')
        : i18n.t('common.cancel');
  return {
    options: actions.map(label),
    actions,
    destructiveButtonIndex: actions.indexOf('revoke'),
    cancelButtonIndex: actions.length - 1,
  };
}

/** The alert title when Send again or Cancel invite fails. */
export function pendingInviteErrorTitle(action: PendingInviteAction): string {
  return action === 'send-again' ? i18n.t('invites.pending.sendAgainFailed') : i18n.t('invites.pending.cancelFailed');
}
