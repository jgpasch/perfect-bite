// The invite sheet (spec 4.7, designs S2 and S3): step 1 asks for the invitee's email and creates
// the invite; step 2 offers ways to tell them. This is the sheet's pure logic: its step state, which
// channel rows show, and its copy. The screen is `src/app/household-invite.tsx`.
import { InviteError, inviteErrorMessage, isEmail, normalizeEmail } from '@/features/households/invites';
import { i18n } from '@/i18n';

export type InviteSheetState =
  | { step: 'email'; email: string; submitting: boolean; error: string | null }
  | { step: 'send'; email: string; link: string };

export type InviteSheetAction =
  | { type: 'edit'; email: string }
  | { type: 'submit' }
  | { type: 'created'; link: string }
  | { type: 'failed'; message: string }
  | { type: 'back' };

export const initialInviteSheetState: InviteSheetState = { step: 'email', email: '', submitting: false, error: null };

/**
 * Where the sheet opens. "Send again" on the household screen re-creates the invite first and passes
 * its email and link, so the sheet opens on step 2 (Back still reaches step 1 with the email kept);
 * anything else opens on an empty step 1.
 */
export function inviteSheetStartState(params: { email?: string | null; link?: string | null }): InviteSheetState {
  const link = params.link?.trim();
  if (link && isEmail(params.email)) return { step: 'send', email: normalizeEmail(params.email), link };
  return initialInviteSheetState;
}

/**
 * Step 1 edits the email and submits it; `created` moves to step 2 with the invite's link, `failed`
 * shows the error under the field. `back` returns to step 1 with the email kept (submitting it again
 * re-invites, which revokes the earlier link). Actions that don't apply to the current step are ignored.
 */
export function inviteSheetReducer(state: InviteSheetState, action: InviteSheetAction): InviteSheetState {
  switch (action.type) {
    case 'edit':
      if (state.step !== 'email' || state.submitting) return state;
      return { ...state, email: action.email, error: null };
    case 'submit':
      if (state.step !== 'email' || !canSubmitInvite(state)) return state;
      return { ...state, submitting: true, error: null };
    case 'created':
      if (state.step !== 'email' || !state.submitting) return state;
      return { step: 'send', email: normalizeEmail(state.email), link: action.link };
    case 'failed':
      if (state.step !== 'email') return state;
      return { ...state, submitting: false, error: action.message };
    case 'back':
      if (state.step !== 'send') return state;
      return { step: 'email', email: state.email, submitting: false, error: null };
  }
}

/** Whether step 1's Next is enabled: a valid email, and not already creating the invite. */
export function canSubmitInvite(state: InviteSheetState): boolean {
  return state.step === 'email' && !state.submitting && isEmail(state.email);
}

export type InviteChannel = 'messages' | 'mail' | 'copy' | 'more';

/**
 * Step 2's rows, in order. Messages and Mail show only once the device says it can send them
 * (`isAvailableAsync`; null while still asking); Copy link and More… always show.
 */
export function inviteChannels(available: { sms: boolean | null; mail: boolean | null }): InviteChannel[] {
  const rows: InviteChannel[] = [];
  if (available.sms === true) rows.push('messages');
  if (available.mail === true) rows.push('mail');
  rows.push('copy', 'more');
  return rows;
}

/** Each row's label, which is also what VoiceOver reads for its button. */
export function inviteChannelLabel(channel: InviteChannel): string {
  switch (channel) {
    case 'messages':
      return i18n.t('invites.sheet.messages');
    case 'mail':
      return i18n.t('invites.sheet.mail');
    case 'copy':
      return i18n.t('invites.sheet.copy');
    case 'more':
      return i18n.t('invites.sheet.more');
  }
}

/**
 * A first name guessed from an email for step 2's copy: the local part's first word ("sam.lee@…" →
 * "Sam"), capitalized. Falls back to the whole local part ("42@…" → "42"); null without one.
 */
export function emailNamePart(email: string): string | null {
  const local = normalizeEmail(email).split('@')[0] ?? '';
  const name = local.split(/[._+\-\d]+/).find((part) => part.length > 0) ?? local;
  if (!name) return null;
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/** Step 1's title. */
export function inviteSheetTitle(householdName: string | null | undefined): string {
  return i18n.t('invites.sheet.title', { name: householdName?.trim() || i18n.t('invites.sheet.yourHousehold') });
}

/** Step 2's title: "Let Sam know". */
export function inviteSendTitle(email: string): string {
  return i18n.t('invites.sheet.sendTitle', { name: emailNamePart(email) ?? i18n.t('invites.sheet.them') });
}

/** Step 2's note under the rows: the invite reaches them in the app even if nothing is sent. */
export function inviteSkipNote(email: string): string {
  const name = emailNamePart(email);
  return name ? i18n.t('invites.sheet.skipNote', { name }) : i18n.t('invites.sheet.skipNoteUnnamed');
}

/**
 * What step 1 says under the field when creating the invite fails: the invite error's message, or
 * the offline one for anything else (e.g. the push before it failing).
 */
export function inviteSheetError(error: unknown, context: { email?: string | null; householdName?: string | null }): string {
  return inviteErrorMessage(error instanceof InviteError ? error.kind : 'network', context);
}
