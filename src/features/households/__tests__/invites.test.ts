import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { respondToRpc, resetSupabase, rpcCalls } from '@/test/fake-supabase';

import {
  acceptInvite,
  acceptInviteById,
  createInvite,
  declineInvite,
  InviteError,
  inviteErrorMessage,
  inviteLink,
  inviteMailBody,
  inviteMailSubject,
  inviteShareMessage,
  inviteStatusMessage,
  isEmail,
  isInviteToken,
  JOIN_BODY,
  joinTitle,
  listHouseholdInvites,
  myInvites,
  normalizeEmail,
  previewInvite,
  revokeInvite,
  toInviteError,
  type InviteErrorKind,
} from '../invites';

jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const TOKEN = 'abcDEF123_-xyzABCdef456GHIjkl789';

beforeEach(() => resetSupabase());

describe('inviteLink and inviteShareMessage', () => {
  test('builds the app-scheme link', () => {
    expect(inviteLink(TOKEN)).toBe(`perfectbite://invite/${TOKEN}`);
  });

  test('names the household, trimmed, then the link', () => {
    expect(inviteShareMessage('  Test home ', 'perfectbite://invite/t')).toBe(
      'Join “Test home” on The Perfect Bite: perfectbite://invite/t',
    );
  });

  test('falls back for a blank name', () => {
    expect(inviteShareMessage('   ', 'perfectbite://invite/t')).toBe(
      'Join my household on The Perfect Bite: perfectbite://invite/t',
    );
  });
});

describe('isInviteToken', () => {
  test('accepts URL-safe base64 tokens', () => {
    expect(isInviteToken(TOKEN)).toBe(true);
    expect(isInviteToken('a'.repeat(16))).toBe(true);
    expect(isInviteToken('a'.repeat(128))).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['too short', 'a'.repeat(15)],
    ['too long', 'a'.repeat(129)],
    ['standard base64 characters', 'abcdefghijklmnop+/'],
    ['a path', '../../etc/passwd/aaaa'],
    ['whitespace', `${TOKEN} `],
  ])('rejects %s', (_, token) => {
    expect(isInviteToken(token)).toBe(false);
  });

  test('rejects null and undefined', () => {
    expect(isInviteToken(null)).toBe(false);
    expect(isInviteToken(undefined)).toBe(false);
  });
});

describe('toInviteError', () => {
  test.each([
    ['invite not found', 'invalid'],
    ['invite already used', 'used'],
    ['invite expired', 'expired'],
    ['already a member', 'already-member'],
    ['invalid email', 'invalid-email'],
    ['not authenticated', 'network'],
    ['not a member of household h1', 'network'],
    ['TypeError: Network request failed', 'network'],
  ] as [string, InviteErrorKind][])('maps "%s" to %s', (message, kind) => {
    const err = toInviteError({ message });
    expect(err).toBeInstanceOf(InviteError);
    expect(err.kind).toBe(kind);
    expect(err.message).toBe(message);
  });

  test('treats an error without a message as a network failure', () => {
    expect(toInviteError(null)).toMatchObject({ kind: 'network', message: 'Request failed' });
    expect(toInviteError({ message: 42 })).toMatchObject({ kind: 'network', message: 'Request failed' });
  });
});

describe('messages', () => {
  test('each error kind has its own message', () => {
    expect(inviteErrorMessage('invalid')).toBe("This invite link isn't valid. Ask for a new one.");
    expect(inviteErrorMessage('used')).toBe('This invite has already been used. Ask for a new one.');
    expect(inviteErrorMessage('expired')).toBe('This invite has expired. Ask for a new one.');
    expect(inviteErrorMessage('network')).toBe("Couldn't reach the server. Check your connection and try again.");
    expect(inviteErrorMessage('invalid-email')).toBe("That doesn't look like an email address.");
  });

  test('already-member names the email and household', () => {
    expect(inviteErrorMessage('already-member', { email: 'sam@example.com', householdName: 'Test home' })).toBe(
      'sam@example.com is already in Test home.',
    );
    expect(inviteErrorMessage('already-member', { email: '  Sam@Example.COM ', householdName: ' Test home ' })).toBe(
      'sam@example.com is already in Test home.',
    );
  });

  test('already-member falls back without a household name or email', () => {
    expect(inviteErrorMessage('already-member', { email: 'sam@example.com', householdName: '  ' })).toBe(
      'sam@example.com is already in this household.',
    );
    expect(inviteErrorMessage('already-member', { email: 'sam@example.com', householdName: null })).toBe(
      'sam@example.com is already in this household.',
    );
    expect(inviteErrorMessage('already-member', { householdName: 'Test home' })).toBe("They're already in Test home.");
    expect(inviteErrorMessage('already-member', { email: ' ', householdName: 'Test home' })).toBe(
      "They're already in Test home.",
    );
    expect(inviteErrorMessage('already-member')).toBe("They're already in this household.");
  });

  test('other kinds ignore the context', () => {
    expect(inviteErrorMessage('used', { email: 'sam@example.com', householdName: 'Test home' })).toBe(
      'This invite has already been used. Ask for a new one.',
    );
  });

  test('joinTitle asks about the household (spec 4.7)', () => {
    expect(joinTitle("John's household")).toBe("Join John's household?");
    expect(joinTitle('  ')).toBe('Join this household?');
    expect(JOIN_BODY).toBe("You'll share its lists and recipes. Your other households aren't affected.");
  });

  test('inviteStatusMessage: null when joinable, otherwise why not', () => {
    expect(inviteStatusMessage('valid', 'Test home')).toBeNull();
    expect(inviteStatusMessage('member', 'Test home')).toBe("You're already in Test home.");
    expect(inviteStatusMessage('member', '')).toBe("You're already in this household.");
    expect(inviteStatusMessage('used', 'Test home')).toBe(inviteErrorMessage('used'));
    expect(inviteStatusMessage('expired', 'Test home')).toBe(inviteErrorMessage('expired'));
  });
});

describe('isEmail and normalizeEmail', () => {
  test.each(['sam@example.com', '  sam@example.com  ', 'Sam.Lee+food@Mail.Example.co.uk', 'a@b.c'])(
    'accepts %p',
    (email) => {
      expect(isEmail(email)).toBe(true);
    },
  );

  test.each([
    ['empty', ''],
    ['blank', '   '],
    ['no @', 'sam.example.com'],
    ['no domain dot', 'sam@example'],
    ['two @', 'sam@lee@example.com'],
    ['nothing before @', '@example.com'],
    ['a space inside', 'sam lee@example.com'],
    ['a dot right after @', 'sam@.com'],
    ['a trailing dot', 'sam@example.'],
  ])('rejects %s', (_, email) => {
    expect(isEmail(email)).toBe(false);
  });

  test('rejects null and undefined', () => {
    expect(isEmail(null)).toBe(false);
    expect(isEmail(undefined)).toBe(false);
  });

  test('normalizes like the server: trimmed and lower-cased', () => {
    expect(normalizeEmail('  Sam.Lee@Example.COM ')).toBe('sam.lee@example.com');
    expect(normalizeEmail('sam@example.com')).toBe('sam@example.com');
  });
});

describe('Mail builders', () => {
  const LINK = 'perfectbite://invite/t';

  test('the subject names the household, trimmed', () => {
    expect(inviteMailSubject('  Smith household ')).toBe('Join Smith household on The Perfect Bite');
  });

  test('the subject falls back for a blank name', () => {
    expect(inviteMailSubject('  ')).toBe('Join my household on The Perfect Bite');
  });

  test('the body says who invited, what joining means, the link and the email to sign in with', () => {
    expect(inviteMailBody({ householdName: 'Smith household', inviterName: 'John', email: 'sam@example.com', link: LINK }))
      .toBe(
        'John invited you to join Smith household on The Perfect Bite.\n\n' +
          "You'll share its lists and recipes. Your other households aren't affected.\n\n" +
          'Open this link to join: perfectbite://invite/t\n\n' +
          'Sign in with sam@example.com and the invite will be waiting.',
      );
  });

  test('the body trims names and normalizes the email', () => {
    const body = inviteMailBody({
      householdName: ' Smith household ',
      inviterName: ' John ',
      email: ' Sam@Example.COM ',
      link: LINK,
    });
    expect(body.split('\n\n')[0]).toBe('John invited you to join Smith household on The Perfect Bite.');
    expect(body.split('\n\n')[3]).toBe('Sign in with sam@example.com and the invite will be waiting.');
  });

  test.each([null, undefined, '   '])('the body works without an inviter name (%p)', (inviterName) => {
    const body = inviteMailBody({ householdName: '', inviterName, email: 'sam@example.com', link: LINK });
    expect(body.split('\n\n')[0]).toBe("You're invited to join my household on The Perfect Bite.");
    expect(body).toContain('Open this link to join: perfectbite://invite/t');
  });
});

describe('createInvite', () => {
  test('calls create_invite and returns the link for its token', async () => {
    respondToRpc('create_invite', { data: TOKEN });
    await expect(createInvite('h1')).resolves.toBe(`perfectbite://invite/${TOKEN}`);
    expect(rpcCalls).toEqual([{ fn: 'create_invite', args: { p_household_id: 'h1' } }]);
  });

  test('sends the email, trimmed and lower-cased', async () => {
    respondToRpc('create_invite', { data: TOKEN });
    await expect(createInvite('h1', '  Sam@Example.COM ')).resolves.toBe(`perfectbite://invite/${TOKEN}`);
    expect(rpcCalls).toEqual([{ fn: 'create_invite', args: { p_household_id: 'h1', p_email: 'sam@example.com' } }]);
  });

  test('a null email is a link-only invite', async () => {
    respondToRpc('create_invite', { data: TOKEN });
    await createInvite('h1', null);
    expect(rpcCalls).toEqual([{ fn: 'create_invite', args: { p_household_id: 'h1' } }]);
  });

  test("throws the server's message", async () => {
    respondToRpc('create_invite', { error: { message: 'not a member of household h1' } });
    await expect(createInvite('h1')).rejects.toThrow('not a member of household h1');
  });

  test.each([
    ['already a member', 'already-member'],
    ['invalid email', 'invalid-email'],
    ['not a member of household h1', 'network'],
    ['Failed to fetch', 'network'],
  ] as [string, InviteErrorKind][])('maps "%s" to %s', async (message, kind) => {
    respondToRpc('create_invite', { error: { message } });
    const err = await createInvite('h1', 'sam@example.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InviteError);
    expect(err).toMatchObject({ kind, message });
  });

  test('throws when the server returns no token', async () => {
    respondToRpc('create_invite', { data: null });
    await expect(createInvite('h1')).rejects.toThrow("Couldn't create an invite");
    respondToRpc('create_invite', { data: '' });
    await expect(createInvite('h1')).rejects.toMatchObject({ kind: 'network', message: "Couldn't create an invite" });
  });
});

describe('listHouseholdInvites', () => {
  test('maps the rows in order, keeping link-only invites and missing inviters as null', async () => {
    respondToRpc('list_household_invites', {
      data: [
        {
          id: 'i2',
          invited_email: 'sam@example.com',
          invited_by: 'John',
          created_at: '2026-10-11T10:00:00Z',
          expires_at: '2026-10-18T10:00:00Z',
        },
        {
          id: 'i1',
          invited_email: null,
          invited_by: null,
          created_at: '2026-10-10T09:00:00Z',
          expires_at: '2026-10-17T09:00:00Z',
        },
      ],
    });
    await expect(listHouseholdInvites('h1')).resolves.toEqual([
      {
        id: 'i2',
        email: 'sam@example.com',
        invitedBy: 'John',
        createdAt: '2026-10-11T10:00:00Z',
        expiresAt: '2026-10-18T10:00:00Z',
      },
      { id: 'i1', email: null, invitedBy: null, createdAt: '2026-10-10T09:00:00Z', expiresAt: '2026-10-17T09:00:00Z' },
    ]);
    expect(rpcCalls).toEqual([{ fn: 'list_household_invites', args: { p_household_id: 'h1' } }]);
  });

  test('returns an empty list for no rows', async () => {
    respondToRpc('list_household_invites', { data: [] });
    await expect(listHouseholdInvites('h1')).resolves.toEqual([]);
    respondToRpc('list_household_invites', { data: null });
    await expect(listHouseholdInvites('h1')).resolves.toEqual([]);
  });

  test('maps server errors', async () => {
    respondToRpc('list_household_invites', { error: { message: 'not a member of household h1' } });
    await expect(listHouseholdInvites('h1')).rejects.toMatchObject({
      kind: 'network',
      message: 'not a member of household h1',
    });
  });
});

describe('revokeInvite', () => {
  test('calls revoke_invite with the id', async () => {
    respondToRpc('revoke_invite', { data: null });
    await expect(revokeInvite('i1')).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([{ fn: 'revoke_invite', args: { p_invite_id: 'i1' } }]);
  });

  test.each([
    ['invite not found', 'invalid'],
    ['Failed to fetch', 'network'],
  ] as [string, InviteErrorKind][])('maps "%s" to %s', async (message, kind) => {
    respondToRpc('revoke_invite', { error: { message } });
    await expect(revokeInvite('i1')).rejects.toMatchObject({ kind, message });
  });
});

describe('myInvites', () => {
  test('maps the rows', async () => {
    respondToRpc('my_invites', {
      data: [
        { id: 'i1', household_id: 'h2', household_name: 'Smith household', invited_by: 'John', member_count: 2 },
        { id: 'i3', household_id: 'h3', household_name: 'Cabin', invited_by: null, member_count: 1 },
      ],
    });
    await expect(myInvites()).resolves.toEqual([
      { id: 'i1', householdId: 'h2', householdName: 'Smith household', invitedBy: 'John', memberCount: 2 },
      { id: 'i3', householdId: 'h3', householdName: 'Cabin', invitedBy: null, memberCount: 1 },
    ]);
    expect(rpcCalls).toEqual([{ fn: 'my_invites', args: undefined }]);
  });

  test('returns an empty list for no rows', async () => {
    respondToRpc('my_invites', { data: null });
    await expect(myInvites()).resolves.toEqual([]);
  });

  test('maps server errors', async () => {
    respondToRpc('my_invites', { error: { message: 'not authenticated' } });
    await expect(myInvites()).rejects.toMatchObject({ kind: 'network', message: 'not authenticated' });
  });
});

describe('acceptInviteById', () => {
  test('joins and maps the row', async () => {
    respondToRpc('accept_invite_by_id', {
      data: [{ household_id: 'h2', household_name: 'Smith household', already_member: false }],
    });
    await expect(acceptInviteById('i1')).resolves.toEqual({
      householdId: 'h2',
      householdName: 'Smith household',
      alreadyMember: false,
    });
    expect(rpcCalls).toEqual([{ fn: 'accept_invite_by_id', args: { p_invite_id: 'i1' } }]);
  });

  test('reports an existing membership', async () => {
    respondToRpc('accept_invite_by_id', {
      data: [{ household_id: 'h2', household_name: 'Smith household', already_member: true }],
    });
    await expect(acceptInviteById('i1')).resolves.toMatchObject({ alreadyMember: true });
  });

  test.each([
    ['invite not found', 'invalid'],
    ['invite already used', 'used'],
    ['invite expired', 'expired'],
    ['Failed to fetch', 'network'],
  ] as [string, InviteErrorKind][])('maps "%s" to %s', async (message, kind) => {
    respondToRpc('accept_invite_by_id', { error: { message } });
    await expect(acceptInviteById('i1')).rejects.toMatchObject({ kind });
  });

  test('treats an empty result as a failed request', async () => {
    respondToRpc('accept_invite_by_id', { data: [] });
    await expect(acceptInviteById('i1')).rejects.toMatchObject({ kind: 'network', message: 'No response' });
  });
});

describe('declineInvite', () => {
  test('calls decline_invite with the id', async () => {
    respondToRpc('decline_invite', { data: null });
    await expect(declineInvite('i1')).resolves.toBeUndefined();
    expect(rpcCalls).toEqual([{ fn: 'decline_invite', args: { p_invite_id: 'i1' } }]);
  });

  test.each([
    ['invite not found', 'invalid'],
    ['invite already used', 'used'],
    ['Failed to fetch', 'network'],
  ] as [string, InviteErrorKind][])('maps "%s" to %s', async (message, kind) => {
    respondToRpc('decline_invite', { error: { message } });
    await expect(declineInvite('i1')).rejects.toMatchObject({ kind, message });
  });
});

describe('previewInvite', () => {
  test('maps the row', async () => {
    respondToRpc('preview_invite', {
      data: [{ household_id: 'h2', household_name: 'Test home', invited_by: 'Sam', status: 'valid' }],
    });
    await expect(previewInvite(TOKEN)).resolves.toEqual({
      householdId: 'h2',
      householdName: 'Test home',
      invitedBy: 'Sam',
      status: 'valid',
    });
    expect(rpcCalls).toEqual([{ fn: 'preview_invite', args: { p_token: TOKEN } }]);
  });

  test('keeps a missing inviter as null and passes other statuses through', async () => {
    respondToRpc('preview_invite', {
      data: [{ household_id: 'h2', household_name: 'Test home', invited_by: null, status: 'expired' }],
    });
    await expect(previewInvite(TOKEN)).resolves.toMatchObject({ invitedBy: null, status: 'expired' });
  });

  test("rejects a malformed token without calling the server", async () => {
    await expect(previewInvite('nope')).rejects.toMatchObject({ kind: 'invalid' });
    expect(rpcCalls).toEqual([]);
  });

  test('maps server errors', async () => {
    respondToRpc('preview_invite', { error: { message: 'invite not found' } });
    await expect(previewInvite(TOKEN)).rejects.toMatchObject({ kind: 'invalid' });
    respondToRpc('preview_invite', { error: { message: 'fetch failed' } });
    await expect(previewInvite(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });

  test('treats an empty result as invalid', async () => {
    respondToRpc('preview_invite', { data: [] });
    await expect(previewInvite(TOKEN)).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('acceptInvite', () => {
  test('joins and maps the row', async () => {
    respondToRpc('accept_invite', { data: [{ household_id: 'h2', household_name: 'Test home', already_member: false }] });
    await expect(acceptInvite(TOKEN)).resolves.toEqual({ householdId: 'h2', householdName: 'Test home', alreadyMember: false });
    expect(rpcCalls).toEqual([{ fn: 'accept_invite', args: { p_token: TOKEN } }]);
  });

  test('reports an existing membership', async () => {
    respondToRpc('accept_invite', { data: [{ household_id: 'h2', household_name: 'Test home', already_member: true }] });
    await expect(acceptInvite(TOKEN)).resolves.toMatchObject({ alreadyMember: true });
  });

  test.each([
    ['invite already used', 'used'],
    ['invite expired', 'expired'],
    ['invite not found', 'invalid'],
    ['Failed to fetch', 'network'],
  ] as [string, InviteErrorKind][])('maps "%s" to %s', async (message, kind) => {
    respondToRpc('accept_invite', { error: { message } });
    await expect(acceptInvite(TOKEN)).rejects.toMatchObject({ kind });
  });

  test('rejects a malformed token without calling the server', async () => {
    await expect(acceptInvite('')).rejects.toMatchObject({ kind: 'invalid' });
    expect(rpcCalls).toEqual([]);
  });

  test('treats an empty result as a failed request', async () => {
    respondToRpc('accept_invite', { data: null });
    await expect(acceptInvite(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });
});
