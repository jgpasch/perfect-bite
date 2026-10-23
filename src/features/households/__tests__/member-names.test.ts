// Members' names on the device (spec 4.7, 5): the cache filled from `get_household_members`, and
// the short names, "You" and "Someone" built from it.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { db, householdMemberNames } from '@/db';
import { memberHue } from '@/domain/aisle-color';
import { clearPushMoment, pushMomentPending, setPushAsked } from '@/features/push/ask';
import { initI18n } from '@/i18n';
import { resetDb } from '@/test/db';
import { respondToRpc, resetSupabase, rpcCalls } from '@/test/fake-supabase';

import {
  memberName,
  nameOf,
  refreshAllMemberNames,
  refreshMemberNames,
  shortMemberNames,
  useMemberNames,
  type MemberNames,
} from '../member-names';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
const mockAuth: { account: { userId: string } | null } = { account: { userId: 'me' } };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAuth.account }));

const H1 = 'h1';
const H2 = 'h2';
/** A server row; "Jo Doe" is first name "Jo", last name "Doe" (none for one word). */
const row = (user_id: string, name: string | null, joined_at = '2026-10-01T00:00:00+00:00') => ({
  user_id,
  first_name: name === null ? null : name.split(' ')[0],
  last_name: name?.split(' ').slice(1).join(' ') || null,
  avatar_url: null,
  role: 'member',
  joined_at,
});
const cached = (householdId?: string) =>
  db
    .select()
    .from(householdMemberNames)
    .all()
    .filter((r) => !householdId || r.householdId === householdId)
    .sort((a, b) => a.userId.localeCompare(b.userId));
const names = (members: [string, string, string?][]) =>
  shortMemberNames(members.map(([userId, firstName, lastName]) => ({ userId, firstName, lastName: lastName ?? null })));

beforeEach(() => {
  resetDb();
  resetSupabase();
  initI18n('en');
  mockAuth.account = { userId: 'me' };
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('refreshMemberNames', () => {
  test("fills a household's names from get_household_members", async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo Doe', '2026-09-01T10:00:00+00:00'), row('u2', 'Alex Rivera')] });

    expect(await refreshMemberNames(H1)).toBe(true);

    expect(rpcCalls).toEqual([{ fn: 'get_household_members', args: { p_household_id: H1 } }]);
    expect(cached()).toEqual([
      { householdId: H1, userId: 'me', firstName: 'Jo', lastName: 'Doe', joinedAt: '2026-09-01T10:00:00+00:00' },
      { householdId: H1, userId: 'u2', firstName: 'Alex', lastName: 'Rivera', joinedAt: '2026-10-01T00:00:00+00:00' },
    ]);
  });

  test('stores first and last names as the server has them: a two-word first name stays whole, no last name is null', async () => {
    respondToRpc('get_household_members', {
      data: [
        { ...row('u2', null), first_name: 'Mary Ann', last_name: 'de la Cruz' },
        { ...row('u3', null), first_name: 'Cher', last_name: null },
      ],
    });
    await refreshMemberNames(H1);
    expect(cached(H1).map((r) => [r.userId, r.firstName, r.lastName])).toEqual([
      ['u2', 'Mary Ann', 'de la Cruz'],
      ['u3', 'Cher', null],
    ]);
  });

  test("replaces only that household's rows: a member who left goes, a new one and a rename come", async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u2', 'Alex'), row('u3', 'Sam')] });
    await refreshMemberNames(H1);
    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u4', 'Kim')] });
    await refreshMemberNames(H2);

    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u2', 'Alexandra'), row('u5', 'Lee')] });
    await refreshMemberNames(H1);

    expect(cached(H1).map((r) => [r.userId, r.firstName])).toEqual([
      ['me', 'Jo'],
      ['u2', 'Alexandra'],
      ['u5', 'Lee'],
    ]);
    expect(cached(H2).map((r) => r.userId)).toEqual(['me', 'u4']);
  });

  test('a failed call keeps the names it had, and never throws', async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u2', 'Alex')] });
    await refreshMemberNames(H1);

    respondToRpc('get_household_members', { error: { message: 'not a member of household h1', code: '42501' } });
    expect(await refreshMemberNames(H1)).toBe(false);
    expect(cached(H1).map((r) => r.userId)).toEqual(['me', 'u2']);
  });

  test('a null answer empties the household; a null first name is stored blank, a blank last name as null', async () => {
    respondToRpc('get_household_members', { data: [{ ...row('u2', null), last_name: '' }] });
    await refreshMemberNames(H1);
    expect(cached(H1)).toEqual([expect.objectContaining({ userId: 'u2', firstName: '', lastName: null })]);

    respondToRpc('get_household_members', { data: null });
    expect(await refreshMemberNames(H1)).toBe(true);
    expect(cached(H1)).toEqual([]);
  });

  test('refreshAllMemberNames loads each household in turn and goes on past a failure', async () => {
    respondToRpc('get_household_members', { error: { message: 'Failed to fetch' } }, { data: [row('u4', 'Kim')] });
    await refreshAllMemberNames([H1, H2]);
    expect(rpcCalls.map((c) => c.args)).toEqual([{ p_household_id: H1 }, { p_household_id: H2 }]);
    expect(cached().map((r) => [r.householdId, r.userId])).toEqual([[H2, 'u4']]);
  });
});

describe('refreshMemberNames and the push moment (spec 4.13)', () => {
  beforeEach(() => clearPushMoment());
  afterEach(() => clearPushMoment());

  test('a household-mate joining a household that was just yours is the moment', async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo')] });
    await refreshMemberNames(H1);
    expect(pushMomentPending()).toBe(false);

    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u2', 'Alex')] });
    await refreshMemberNames(H1);
    expect(pushMomentPending()).toBe(true);
  });

  test('filling the cache from empty (sign-in, a household just pulled in) is not', async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u2', 'Alex')] });
    await refreshMemberNames(H1);
    expect(pushMomentPending()).toBe(false);
  });

  test('a third member joining, or a failed refresh, is not', async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u2', 'Alex')] });
    await refreshMemberNames(H1);
    respondToRpc('get_household_members', { data: [row('me', 'Jo'), row('u2', 'Alex'), row('u3', 'Sam')] });
    await refreshMemberNames(H1);
    respondToRpc('get_household_members', { data: [row('me', 'Jo')] });
    await refreshMemberNames(H2);
    respondToRpc('get_household_members', { error: { message: 'Failed to fetch' } });
    await refreshMemberNames(H2);
    expect(pushMomentPending()).toBe(false);
  });

  test('once the prompt has shown on this device, never again', async () => {
    setPushAsked();
    respondToRpc('get_household_members', { data: [row('me', 'Jo')] }, { data: [row('me', 'Jo'), row('u2', 'Alex')] });
    await refreshMemberNames(H1);
    await refreshMemberNames(H1);
    expect(pushMomentPending()).toBe(false);
  });
});

describe('shortMemberNames', () => {
  test('a unique first name as it is, two words and all, with no initial', () => {
    const result = names([
      ['u1', 'Alex', 'Rivera'],
      ['u2', '  Sam  '],
      ['u3', 'María José', 'García'],
      ['u4', 'Mary Ann', 'Smith'],
    ]);
    expect([...result]).toEqual([
      ['u1', 'Alex'],
      ['u2', 'Sam'],
      ['u3', 'María José'],
      ['u4', 'Mary Ann'],
    ]);
  });

  test("members who share a first name (any case) get their last name's first letter, uppercased", () => {
    const result = names([
      ['u1', 'Alex', 'Rivera'],
      ['u2', 'alex', 'mendez'],
      ['u3', 'Sam', 'Lee'],
      ['u4', 'Alex', 'de la Óvalo'],
      ['u5', 'Mary Ann', 'Smith'],
      ['u6', 'mary ann', 'Jones'],
    ]);
    expect(result.get('u1')).toBe('Alex R.');
    expect(result.get('u2')).toBe('alex M.');
    expect(result.get('u3')).toBe('Sam');
    expect(result.get('u4')).toBe('Alex D.');
    expect(result.get('u5')).toBe('Mary Ann S.');
    expect(result.get('u6')).toBe('mary ann J.');
  });

  test('only the whole first name clashes: "Mary Ann" and "Mary" are different', () => {
    const result = names([
      ['u1', 'Mary Ann', 'Smith'],
      ['u2', 'Mary', 'Jones'],
    ]);
    expect(result.get('u1')).toBe('Mary Ann');
    expect(result.get('u2')).toBe('Mary');
  });

  test('a clash with no last name (or a blank one) keeps the first name', () => {
    const result = names([
      ['u1', 'Alex'],
      ['u2', 'Alex', 'Rivera'],
      ['u3', 'Alex', '  '],
    ]);
    expect(result.get('u1')).toBe('Alex');
    expect(result.get('u2')).toBe('Alex R.');
    expect(result.get('u3')).toBe('Alex');
  });

  test("a blank first name gets no entry and doesn't count as a clash", () => {
    const result = names([
      ['u1', '   ', 'Rivera'],
      ['u2', '', 'Lee'],
      ['u3', 'Sam', 'Lee'],
    ]);
    expect(result.has('u1')).toBe(false);
    expect(result.has('u2')).toBe(false);
    expect(result.get('u3')).toBe('Sam');
  });
});

describe('nameOf', () => {
  const known: MemberNames = new Map([
    ['me', 'Jo'],
    ['u2', 'Alex'],
  ]);

  test('the current user is You (Tú)', () => {
    expect(nameOf(known, 'me', 'me')).toBe('You');
    initI18n('es');
    expect(nameOf(known, 'me', 'me')).toBe('Tú');
  });

  test('another member by their short name', () => {
    expect(nameOf(known, 'u2', 'me')).toBe('Alex');
    // Signed out, no one is "You".
    expect(nameOf(known, 'me', null)).toBe('Jo');
  });

  test('an unknown, removed or null id is Someone (Alguien)', () => {
    expect(nameOf(known, 'u-gone', 'me')).toBe('Someone');
    expect(nameOf(known, null, 'me')).toBe('Someone');
    expect(nameOf(known, undefined, null)).toBe('Someone');
    initI18n('es');
    expect(nameOf(known, 'u-gone', 'me')).toBe('Alguien');
  });
});

describe('memberName', () => {
  beforeEach(async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo Doe'), row('u2', 'Alex Rivera'), row('u3', 'Alex Mendez')] });
    await refreshMemberNames(H1);
    respondToRpc('get_household_members', { data: [row('u2', 'Alex Rivera')] });
    await refreshMemberNames(H2);
  });

  test("reads the household's names, with the clash rule inside the household", () => {
    expect(memberName(H1, 'u2')).toBe('Alex R.');
    expect(memberName(H1, 'u3')).toBe('Alex M.');
    // No other Alex in H2.
    expect(memberName(H2, 'u2')).toBe('Alex');
  });

  test('the signed-in user is You; an id from another household or none is Someone', () => {
    expect(memberName(H1, 'me')).toBe('You');
    expect(memberName(H2, 'u3')).toBe('Someone');
    expect(memberName('h-unknown', 'u2')).toBe('Someone');
    expect(memberName(H1, null)).toBe('Someone');
    mockAuth.account = null;
    expect(memberName(H1, 'me')).toBe('Jo');
  });
});

describe('useMemberNames', () => {
  let seen: MemberNames | null = null;
  function Probe({ householdId }: { householdId: string | null }) {
    seen = useMemberNames(householdId);
    return null;
  }

  test("the household's short names, and none for a null household", async () => {
    respondToRpc('get_household_members', { data: [row('me', 'Jo Doe'), row('u2', 'Alex Rivera')] });
    await refreshMemberNames(H1);
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(createElement(Probe, { householdId: H1 }));
    });
    expect([...seen!]).toEqual([
      ['me', 'Jo'],
      ['u2', 'Alex'],
    ]);
    act(() => tree.update(createElement(Probe, { householdId: null })));
    expect(seen!.size).toBe(0);
    act(() => tree.unmount());
  });
});

describe('memberHue', () => {
  test('is stable for a user id and one of the avatar hues', () => {
    // The same hash as a household's colour, so the same id gives the same hue.
    expect(memberHue('a')).toBe('blue');
    expect(memberHue('d')).toBe('green');
    expect(memberHue('u2')).toBe(memberHue('u2'));
    for (const id of ['u1', 'u2', 'u3', 'me']) expect(['green', 'blue', 'rose', 'amber']).toContain(memberHue(id));
  });
});
