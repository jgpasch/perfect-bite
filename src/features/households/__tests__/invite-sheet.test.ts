import { describe, expect, it, jest } from '@jest/globals';

import {
  canSubmitInvite,
  emailNamePart,
  initialInviteSheetState,
  inviteChannelLabel,
  inviteChannels,
  inviteSendTitle,
  inviteSheetError,
  inviteSheetReducer,
  inviteSheetStartState,
  inviteSheetTitle,
  inviteSkipNote,
  type InviteSheetState,
} from '@/features/households/invite-sheet';
import { InviteError } from '@/features/households/invites';

jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const typed = (email: string): InviteSheetState => inviteSheetReducer(initialInviteSheetState, { type: 'edit', email });

describe('inviteSheetReducer', () => {
  it('starts on step 1 with an empty email', () => {
    expect(initialInviteSheetState).toEqual({ step: 'email', email: '', submitting: false, error: null });
  });

  it('edits the email and clears an error', () => {
    const failed: InviteSheetState = { step: 'email', email: 'a@b.co', submitting: false, error: 'Nope' };
    expect(inviteSheetReducer(failed, { type: 'edit', email: 'a@b.com' })).toEqual({
      step: 'email',
      email: 'a@b.com',
      submitting: false,
      error: null,
    });
  });

  it('ignores edits while submitting and on step 2', () => {
    const submitting: InviteSheetState = { step: 'email', email: 'a@b.co', submitting: true, error: null };
    expect(inviteSheetReducer(submitting, { type: 'edit', email: 'x' })).toBe(submitting);
    const send: InviteSheetState = { step: 'send', email: 'a@b.co', link: 'perfectbite://invite/x' };
    expect(inviteSheetReducer(send, { type: 'edit', email: 'x' })).toBe(send);
  });

  it('submits only a valid email, once', () => {
    expect(inviteSheetReducer(typed('sam'), { type: 'submit' })).toEqual(typed('sam'));
    const submitting = inviteSheetReducer(typed('sam@x.com'), { type: 'submit' });
    expect(submitting).toEqual({ step: 'email', email: 'sam@x.com', submitting: true, error: null });
    expect(inviteSheetReducer(submitting, { type: 'submit' })).toBe(submitting);
  });

  it('moves to step 2 with the normalized email and the link once created', () => {
    const submitting = inviteSheetReducer(typed('  Sam.Lee@Gmail.com '), { type: 'submit' });
    expect(inviteSheetReducer(submitting, { type: 'created', link: 'perfectbite://invite/abc' })).toEqual({
      step: 'send',
      email: 'sam.lee@gmail.com',
      link: 'perfectbite://invite/abc',
    });
  });

  it('ignores a created link when not submitting', () => {
    const idle = typed('sam@x.com');
    expect(inviteSheetReducer(idle, { type: 'created', link: 'l' })).toBe(idle);
  });

  it('shows a failure under the field and keeps the email', () => {
    const submitting = inviteSheetReducer(typed('sam@x.com'), { type: 'submit' });
    expect(inviteSheetReducer(submitting, { type: 'failed', message: 'sam@x.com is already in Home.' })).toEqual({
      step: 'email',
      email: 'sam@x.com',
      submitting: false,
      error: 'sam@x.com is already in Home.',
    });
  });

  it('ignores a failure on step 2', () => {
    const send: InviteSheetState = { step: 'send', email: 'a@b.co', link: 'l' };
    expect(inviteSheetReducer(send, { type: 'failed', message: 'x' })).toBe(send);
  });

  it('goes back to step 1 with the email kept, ready to re-invite', () => {
    const send: InviteSheetState = { step: 'send', email: 'sam@x.com', link: 'l' };
    const back = inviteSheetReducer(send, { type: 'back' });
    expect(back).toEqual({ step: 'email', email: 'sam@x.com', submitting: false, error: null });
    expect(canSubmitInvite(back)).toBe(true);
    expect(inviteSheetReducer(back, { type: 'submit' })).toEqual({ ...back, submitting: true });
  });

  it('ignores back on step 1', () => {
    const idle = typed('sam@x.com');
    expect(inviteSheetReducer(idle, { type: 'back' })).toBe(idle);
  });
});

describe('canSubmitInvite', () => {
  it('needs a valid email', () => {
    expect(canSubmitInvite(initialInviteSheetState)).toBe(false);
    expect(canSubmitInvite(typed('sam'))).toBe(false);
    expect(canSubmitInvite(typed('sam@gmail'))).toBe(false);
    expect(canSubmitInvite(typed('sam lee@gmail.com'))).toBe(false);
    expect(canSubmitInvite(typed(' sam@gmail.com '))).toBe(true);
  });

  it('is false while submitting and on step 2', () => {
    expect(canSubmitInvite({ step: 'email', email: 'sam@x.com', submitting: true, error: null })).toBe(false);
    expect(canSubmitInvite({ step: 'send', email: 'sam@x.com', link: 'l' })).toBe(false);
  });
});

describe('inviteChannels', () => {
  it('shows all four rows when Messages and Mail are available', () => {
    expect(inviteChannels({ sms: true, mail: true })).toEqual(['messages', 'mail', 'copy', 'more']);
  });

  it('hides Messages and Mail when unavailable', () => {
    expect(inviteChannels({ sms: false, mail: true })).toEqual(['mail', 'copy', 'more']);
    expect(inviteChannels({ sms: true, mail: false })).toEqual(['messages', 'copy', 'more']);
    expect(inviteChannels({ sms: false, mail: false })).toEqual(['copy', 'more']);
  });

  it('hides them while availability is still unknown', () => {
    expect(inviteChannels({ sms: null, mail: null })).toEqual(['copy', 'more']);
  });
});

describe('inviteChannelLabel', () => {
  it('names each row for its channel', () => {
    expect(inviteChannelLabel('messages')).toBe('Messages');
    expect(inviteChannelLabel('mail')).toBe('Mail');
    expect(inviteChannelLabel('copy')).toBe('Copy link');
    expect(inviteChannelLabel('more')).toBe('More…');
  });
});

describe('emailNamePart', () => {
  it('takes the first word of the local part, capitalized', () => {
    expect(emailNamePart('sam.lee@gmail.com')).toBe('Sam');
    expect(emailNamePart('Alex_Smith@x.com')).toBe('Alex');
    expect(emailNamePart('jo-ann@x.com')).toBe('Jo');
    expect(emailNamePart('kim+lists@x.com')).toBe('Kim');
    expect(emailNamePart('riley42@x.com')).toBe('Riley');
    expect(emailNamePart('  JGPASCH@gmail.com ')).toBe('Jgpasch');
  });

  it('skips leading separators and digits', () => {
    expect(emailNamePart('.sam@x.com')).toBe('Sam');
    expect(emailNamePart('42sam@x.com')).toBe('Sam');
  });

  it('falls back to the local part, then null', () => {
    expect(emailNamePart('42@x.com')).toBe('42');
    expect(emailNamePart('@x.com')).toBeNull();
    expect(emailNamePart('')).toBeNull();
  });
});

describe('sheet copy', () => {
  it('titles step 1 with the household', () => {
    expect(inviteSheetTitle('Smith household')).toBe('Invite to Smith household');
    expect(inviteSheetTitle('  Home ')).toBe('Invite to Home');
    expect(inviteSheetTitle('')).toBe('Invite to your household');
    expect(inviteSheetTitle(null)).toBe('Invite to your household');
  });

  it('titles step 2 with their name', () => {
    expect(inviteSendTitle('sam.lee@gmail.com')).toBe('Let Sam know');
    expect(inviteSendTitle('@x.com')).toBe('Let them know');
  });

  it('names them in the skip note', () => {
    expect(inviteSkipNote('sam.lee@gmail.com')).toBe(
      "You can also skip this. If Sam signs in with this email, they'll see the invite in the app.",
    );
    expect(inviteSkipNote('@x.com')).toBe(
      "You can also skip this. If they sign in with this email, they'll see the invite in the app.",
    );
  });
});

describe('inviteSheetError', () => {
  it('names the email and household for an existing member', () => {
    expect(
      inviteSheetError(new InviteError('already-member', 'already a member'), {
        email: 'Sam@X.com',
        householdName: 'Home',
      }),
    ).toBe('sam@x.com is already in Home.');
  });

  it('says offline for a network error and for anything else', () => {
    const offline = "Couldn't reach the server. Check your connection and try again.";
    expect(inviteSheetError(new InviteError('network', 'fetch failed'), { email: 'a@b.co', householdName: 'Home' })).toBe(
      offline,
    );
    expect(inviteSheetError(new Error('push failed'), { householdName: 'Home' })).toBe(offline);
    expect(inviteSheetError(undefined, {})).toBe(offline);
  });

  it('passes through a rejected email', () => {
    expect(inviteSheetError(new InviteError('invalid-email', 'invalid email'), { email: 'x' })).toBe(
      "That doesn't look like an email address.",
    );
  });
});

describe('inviteSheetStartState', () => {
  const LINK = 'perfectbite://invite/abcdefghijklmnop';

  it('opens on step 2 for Send again, with the email normalized', () => {
    expect(inviteSheetStartState({ email: ' Sam.Lee@Gmail.com ', link: LINK })).toEqual({
      step: 'send',
      email: 'sam.lee@gmail.com',
      link: LINK,
    });
  });

  it('opens on an empty step 1 otherwise', () => {
    expect(inviteSheetStartState({})).toBe(initialInviteSheetState);
    expect(inviteSheetStartState({ email: 'sam@x.com' })).toBe(initialInviteSheetState);
    expect(inviteSheetStartState({ link: LINK })).toBe(initialInviteSheetState);
    expect(inviteSheetStartState({ email: 'sam@x.com', link: '  ' })).toBe(initialInviteSheetState);
    expect(inviteSheetStartState({ email: 'not an email', link: LINK })).toBe(initialInviteSheetState);
  });

  it('goes Back from Send again to step 1 with the email kept, ready to submit', () => {
    const back = inviteSheetReducer(inviteSheetStartState({ email: 'sam@x.com', link: LINK }), { type: 'back' });
    expect(back).toEqual({ step: 'email', email: 'sam@x.com', submitting: false, error: null });
    expect(canSubmitInvite(back)).toBe(true);
  });
});
