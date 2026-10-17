import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, households } from '@/db';
import { resetDb } from '@/test/db';
import { respondToRpc, resetSupabase, rpcCalls, rpcCallsFor, supabase } from '@/test/fake-supabase';

import { clearPushMoment, pushMomentPending } from '@/features/push/ask';

import { InviteError, type InviteErrorKind, type MyInvite } from '../invites';
import {
  clearMyInvites,
  declineInviteLabel,
  declineInvitePrompt,
  declineMyInvite,
  getMyInvites,
  householdToReplace,
  inviteCardAccessibilityLabel,
  inviteCardDetail,
  inviteCardInitial,
  inviteCardTitle,
  joinMyInvite,
  myInviteFailure,
  refreshMyInvites,
  replaceHouseholdPrompt,
  startMyInvites,
} from '../my-invites';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

const mockPullNow = jest.fn(async () => ({ pulled: 0, households: [] }));
jest.mock('@/sync/pull', () => ({ pullNow: () => mockPullNow() }));

// The foreground/reconnect triggers, captured so tests can fire them.
const mockTriggers: { onCatchUp?: () => void; onNetwork?: (online: boolean) => void; stopped: number } = { stopped: 0 };
jest.mock('@/features/categories/catch-up', () => ({
  startCatchUpTriggers: (onCatchUp: () => void, onNetwork?: (online: boolean) => void) => {
    mockTriggers.onCatchUp = onCatchUp;
    mockTriggers.onNetwork = onNetwork;
    return () => void mockTriggers.stopped++;
  },
  isOnline: () => true,
}));
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }) }));

const ROW = { id: 'i1', household_id: 'h2', household_name: 'Smith household', invited_by: 'John', member_count: 2 };
const ROW2 = { id: 'i2', household_id: 'h3', household_name: 'Cabin', invited_by: null, member_count: 1 };

const INVITE: MyInvite = { id: 'i1', householdId: 'h2', householdName: 'Smith household', invitedBy: 'John', memberCount: 2 };
const INVITE2: MyInvite = { id: 'i2', householdId: 'h3', householdName: 'Cabin', invitedBy: null, memberCount: 1 };

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

let warn: ReturnType<typeof jest.spyOn>;
let stop: (() => void) | null = null;

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockPullNow.mockClear();
  mockTriggers.onCatchUp = undefined;
  mockTriggers.onNetwork = undefined;
  mockTriggers.stopped = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stop?.();
  stop = null;
  clearMyInvites();
  warn.mockRestore();
});

/** Starts the store (as sign-in does) with `rows` from the first fetch. */
async function start(rows: unknown[]) {
  respondToRpc('my_invites', { data: rows });
  stop = startMyInvites();
  await flush();
}

describe('fetching', () => {
  test('fetches on start (sign-in) and maps the rows', async () => {
    await start([ROW, ROW2]);
    expect(rpcCallsFor('my_invites')).toHaveLength(1);
    expect(getMyInvites()).toEqual([INVITE, INVITE2]);
  });

  test('fetches again on each foreground, replacing the cards', async () => {
    await start([ROW]);
    respondToRpc('my_invites', { data: [ROW2] });
    mockTriggers.onCatchUp!();
    await flush();
    expect(rpcCallsFor('my_invites')).toHaveLength(2);
    expect(getMyInvites()).toEqual([INVITE2]);
  });

  test('a fetch with no invites empties the store', async () => {
    await start([ROW]);
    respondToRpc('my_invites', { data: [] });
    await refreshMyInvites();
    expect(getMyInvites()).toEqual([]);
  });

  test('a null response reads as no invites', async () => {
    await start([ROW]);
    respondToRpc('my_invites', { data: null });
    await refreshMyInvites();
    expect(getMyInvites()).toEqual([]);
  });

  test('a failed fetch keeps the cards already shown', async () => {
    await start([ROW]);
    respondToRpc('my_invites', { error: { message: 'Failed to fetch' } });
    await refreshMyInvites();
    expect(rpcCallsFor('my_invites')).toHaveLength(2);
    expect(getMyInvites()).toEqual([INVITE]);
  });

  test('skips fetching while offline, and fetches on the next foreground once online', async () => {
    await start([ROW]);
    mockTriggers.onNetwork!(false);
    mockTriggers.onCatchUp!();
    await flush();
    expect(rpcCallsFor('my_invites')).toHaveLength(1);

    mockTriggers.onNetwork!(true);
    respondToRpc('my_invites', { data: [ROW, ROW2] });
    mockTriggers.onCatchUp!();
    await flush();
    expect(rpcCallsFor('my_invites')).toHaveLength(2);
    expect(getMyInvites()).toEqual([INVITE, INVITE2]);
  });
});

describe('sign-out', () => {
  test('the cleanup stops the triggers and clears the cards', async () => {
    await start([ROW]);
    stop!();
    stop = null;
    expect(mockTriggers.stopped).toBe(1);
    expect(getMyInvites()).toEqual([]);
  });

  test("a fetch that finishes after sign-out doesn't bring the cards back", async () => {
    let answer!: (result: { data: unknown }) => void;
    supabase.rpc.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never);
    const pending = refreshMyInvites();
    clearMyInvites();
    answer({ data: [ROW] });
    await pending;
    expect(getMyInvites()).toEqual([]);
  });
});

describe('joinMyInvite', () => {
  test('accepts by id, pulls, then removes only that card', async () => {
    await start([ROW, ROW2]);
    respondToRpc('accept_invite_by_id', {
      data: [{ household_id: 'h2', household_name: 'Smith household', already_member: false }],
    });
    await expect(joinMyInvite(INVITE)).resolves.toEqual({ ok: true });
    expect(rpcCallsFor('accept_invite_by_id')).toEqual([{ fn: 'accept_invite_by_id', args: { p_invite_id: 'i1' } }]);
    expect(mockPullNow).toHaveBeenCalledTimes(1);
    expect(getMyInvites()).toEqual([INVITE2]);
  });

  test('a join is the moment to offer notifications (spec 4.13); a failed one is not', async () => {
    clearPushMoment();
    await start([ROW, ROW2]);
    respondToRpc('accept_invite_by_id', { error: { message: 'Failed to fetch' } });
    await joinMyInvite(INVITE);
    expect(pushMomentPending()).toBe(false);
    respondToRpc('accept_invite_by_id', {
      data: [{ household_id: 'h2', household_name: 'Smith household', already_member: false }],
    });
    await joinMyInvite(INVITE);
    expect(pushMomentPending()).toBe(true);
    clearPushMoment();
  });

  test("a network failure keeps the card, says so and doesn't pull", async () => {
    await start([ROW]);
    respondToRpc('accept_invite_by_id', { error: { message: 'Failed to fetch' } });
    await expect(joinMyInvite(INVITE)).resolves.toEqual({
      ok: false,
      message: "Couldn't reach the server. Check your connection and try again.",
      removed: false,
    });
    expect(mockPullNow).not.toHaveBeenCalled();
    expect(getMyInvites()).toEqual([INVITE]);
  });

  test('an invite revoked meanwhile removes the card with "This invite was cancelled."', async () => {
    await start([ROW, ROW2]);
    respondToRpc('accept_invite_by_id', { error: { message: 'invite already used' } });
    await expect(joinMyInvite(INVITE)).resolves.toEqual({
      ok: false,
      message: 'This invite was cancelled.',
      removed: true,
    });
    expect(getMyInvites()).toEqual([INVITE2]);
  });

  test('an expired invite removes the card and says it expired', async () => {
    await start([ROW]);
    respondToRpc('accept_invite_by_id', { error: { message: 'invite expired' } });
    await expect(joinMyInvite(INVITE)).resolves.toEqual({
      ok: false,
      message: 'This invite has expired. Ask for a new one.',
      removed: true,
    });
    expect(getMyInvites()).toEqual([]);
  });
});

describe('joining instead of keeping your own household', () => {
  test('joins first, then deletes the household it replaces', async () => {
    await start([ROW]);
    respondToRpc('accept_invite_by_id', {
      data: [{ household_id: 'h2', household_name: 'Smith household', already_member: false }],
    });
    respondToRpc('delete_household', { data: { new_household_id: null } });
    await expect(joinMyInvite(INVITE, { id: 'h1', name: 'Personal' })).resolves.toEqual({ ok: true });
    expect(rpcCalls.map((c) => c.fn).filter((fn) => fn !== 'my_invites')).toEqual(['accept_invite_by_id', 'delete_household']);
    expect(rpcCallsFor('delete_household')).toEqual([{ fn: 'delete_household', args: { p_household_id: 'h1' } }]);
  });

  test("a delete that fails still joins, with a notice", async () => {
    await start([ROW]);
    respondToRpc('accept_invite_by_id', {
      data: [{ household_id: 'h2', household_name: 'Smith household', already_member: false }],
    });
    respondToRpc('delete_household', { error: { message: 'Failed to fetch' } });
    await expect(joinMyInvite(INVITE, { id: 'h1', name: 'Personal' })).resolves.toEqual({
      ok: true,
      notice: "Joined, but Personal couldn't be deleted. You can delete it in Settings.",
    });
    expect(getMyInvites()).toEqual([]);
  });

  test("a failed join doesn't delete anything", async () => {
    await start([ROW]);
    respondToRpc('accept_invite_by_id', { error: { message: 'invite expired' } });
    await expect(joinMyInvite(INVITE, { id: 'h1', name: 'Personal' })).resolves.toMatchObject({ ok: false });
    expect(rpcCallsFor('delete_household')).toEqual([]);
  });

  const member = (id: string) => ({ user_id: id, display_name: id, avatar_url: null, role: 'owner', joined_at: '2026-10-01T00:00:00Z' });

  test('offers your only household when you are its only member', async () => {
    db.insert(households).values({ id: 'h1', name: 'Personal' }).run();
    respondToRpc('get_household_members', { data: [member('u1')] });
    await expect(householdToReplace('h2', 'u1')).resolves.toEqual({ id: 'h1', name: 'Personal' });
  });

  test('not when someone else is in it, you have several, or the members fetch fails', async () => {
    db.insert(households).values({ id: 'h1', name: 'Personal' }).run();
    respondToRpc('get_household_members', { data: [member('u1'), member('u2')] });
    await expect(householdToReplace('h2', 'u1')).resolves.toBeNull();
    respondToRpc('get_household_members', { error: { message: 'Failed to fetch' } });
    await expect(householdToReplace('h2', 'u1')).resolves.toBeNull();
    db.insert(households).values({ id: 'h3', name: 'Cabin' }).run();
    respondToRpc('get_household_members', { data: [member('u1')] });
    await expect(householdToReplace('h2', 'u1')).resolves.toBeNull();
  });

  test('not when you have no household yet', async () => {
    await expect(householdToReplace('h2', 'u1')).resolves.toBeNull();
    expect(rpcCallsFor('get_household_members')).toEqual([]);
  });

  test('the prompt names both households', () => {
    expect(replaceHouseholdPrompt('Smith household', { name: 'Personal' })).toEqual({
      title: 'Keep Personal?',
      message: "You'll share Smith household's lists and recipes. You can keep Personal too, or delete it with its lists and recipes.",
      keep: 'Join and keep it',
      remove: 'Join and delete Personal',
    });
  });
});

describe('refreshMyInvites', () => {
  test('a call while a fetch is under way shares it', async () => {
    respondToRpc('my_invites', { data: [ROW] });
    const a = refreshMyInvites();
    const b = refreshMyInvites();
    expect(a).toBe(b);
    await a;
    expect(rpcCallsFor('my_invites')).toHaveLength(1);
    expect(getMyInvites()).toEqual([INVITE]);
  });
});

describe('declineMyInvite', () => {
  test('declines by id and removes the card, without a pull', async () => {
    await start([ROW, ROW2]);
    respondToRpc('decline_invite', { data: null });
    await expect(declineMyInvite(INVITE2)).resolves.toEqual({ ok: true });
    expect(rpcCalls.filter((c) => c.fn === 'decline_invite')).toEqual([{ fn: 'decline_invite', args: { p_invite_id: 'i2' } }]);
    expect(mockPullNow).not.toHaveBeenCalled();
    expect(getMyInvites()).toEqual([INVITE]);
  });

  test('a network failure keeps the card', async () => {
    await start([ROW]);
    respondToRpc('decline_invite', { error: { message: 'Failed to fetch' } });
    const result = await declineMyInvite(INVITE);
    expect(result).toEqual({
      ok: false,
      message: "Couldn't reach the server. Check your connection and try again.",
      removed: false,
    });
    expect(getMyInvites()).toEqual([INVITE]);
  });

  test('an invite that is gone removes the card', async () => {
    await start([ROW]);
    respondToRpc('decline_invite', { error: { message: 'invite not found' } });
    await expect(declineMyInvite(INVITE)).resolves.toEqual({ ok: false, message: 'This invite was cancelled.', removed: true });
    expect(getMyInvites()).toEqual([]);
  });

  test('an invite no longer in the store is a no-op on the cards', async () => {
    await start([ROW]);
    respondToRpc('decline_invite', { data: null });
    await expect(declineMyInvite(INVITE2)).resolves.toEqual({ ok: true });
    expect(getMyInvites()).toEqual([INVITE]);
  });
});

describe('myInviteFailure', () => {
  test.each<[InviteErrorKind, string, boolean]>([
    ['used', 'This invite was cancelled.', true],
    ['invalid', 'This invite was cancelled.', true],
    ['expired', 'This invite has expired. Ask for a new one.', true],
    ['network', "Couldn't reach the server. Check your connection and try again.", false],
  ])('%s → %s (removed: %s)', (kind, message, removed) => {
    expect(myInviteFailure(new InviteError(kind, 'x'))).toEqual({ message, removed });
  });

  test('a non-InviteError reads as a network failure', () => {
    expect(myInviteFailure(new Error('boom'))).toEqual({
      message: "Couldn't reach the server. Check your connection and try again.",
      removed: false,
    });
  });
});

describe("the card's text", () => {
  test('names the inviter, the household and the member count', () => {
    expect(inviteCardTitle(INVITE)).toBe('John invited you');
    expect(inviteCardDetail(INVITE)).toBe('to Smith household · 2 members');
    expect(inviteCardAccessibilityLabel(INVITE)).toBe('John invited you to Smith household');
    expect(inviteCardInitial(INVITE)).toBe('J');
  });

  test('one member is singular', () => {
    expect(inviteCardDetail({ ...INVITE, memberCount: 1 })).toBe('to Smith household · 1 member');
  });

  test('trims the names', () => {
    const invite = { ...INVITE, invitedBy: '  ana ', householdName: '  Home ' };
    expect(inviteCardTitle(invite)).toBe('ana invited you');
    expect(inviteCardDetail(invite)).toBe('to Home · 2 members');
    expect(inviteCardInitial(invite)).toBe('A');
  });

  test('without an inviter name: "You\'re invited" and the household\'s initial', () => {
    expect(inviteCardTitle(INVITE2)).toBe("You're invited");
    expect(inviteCardAccessibilityLabel(INVITE2)).toBe("You're invited to Cabin");
    expect(inviteCardInitial(INVITE2)).toBe('C');
    expect(inviteCardTitle({ ...INVITE, invitedBy: '   ' })).toBe("You're invited");
  });

  test('a blank household name reads as "a household"', () => {
    const invite = { ...INVITE2, householdName: '  ' };
    expect(inviteCardDetail(invite)).toBe('to a household · 1 member');
    expect(inviteCardAccessibilityLabel(invite)).toBe("You're invited to a household");
    expect(inviteCardInitial(invite)).toBe('?');
  });

  test('the Decline confirmation names the household and the inviter', () => {
    expect(declineInvitePrompt(INVITE)).toEqual({
      title: 'Decline the invite to Smith household?',
      message: 'John can send a new one.',
    });
    expect(declineInvitePrompt(INVITE2)).toEqual({
      title: 'Decline the invite to Cabin?',
      message: 'They can send a new one.',
    });
  });

  test('the Decline button names the household for VoiceOver', () => {
    expect(declineInviteLabel(INVITE)).toBe('Decline invite to Smith household');
    expect(declineInviteLabel({ ...INVITE2, householdName: '  Cabin ' })).toBe('Decline invite to Cabin');
    expect(declineInviteLabel({ ...INVITE2, householdName: '  ' })).toBe('Decline invite to a household');
  });
});
