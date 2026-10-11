import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { respondToRpc, resetSupabase, rpcCalls } from '@/test/fake-supabase';

import {
  acceptInvite,
  createInvite,
  InviteError,
  inviteErrorMessage,
  inviteLink,
  inviteShareMessage,
  inviteStatusMessage,
  isInviteToken,
  JOIN_BODY,
  joinTitle,
  previewInvite,
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
    ['not authenticated', 'network'],
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

describe('createInvite', () => {
  test('calls create_invite and returns the link for its token', async () => {
    respondToRpc('create_invite', { data: TOKEN });
    await expect(createInvite('h1')).resolves.toBe(`perfectbite://invite/${TOKEN}`);
    expect(rpcCalls).toEqual([{ fn: 'create_invite', args: { p_household_id: 'h1' } }]);
  });

  test("throws the server's message", async () => {
    respondToRpc('create_invite', { error: { message: 'not a member of household h1' } });
    await expect(createInvite('h1')).rejects.toThrow('not a member of household h1');
  });

  test('throws when the server returns no token', async () => {
    respondToRpc('create_invite', { data: null });
    await expect(createInvite('h1')).rejects.toThrow("Couldn't create an invite");
    respondToRpc('create_invite', { data: '' });
    await expect(createInvite('h1')).rejects.toThrow("Couldn't create an invite");
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
