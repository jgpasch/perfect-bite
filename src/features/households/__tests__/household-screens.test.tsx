// The household screens (spec 4.7): the household and its members (board 11, design S4), the invite
// sheet (designs S2, S3), the join screen an invite link opens, and the invite row (board H).
// Rendered against the in-memory database; the server calls are stubbed.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS, Alert, type AlertButton, Share } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import HouseholdInviteSheet from '@/app/household-invite';
import JoinHouseholdScreen from '@/app/invite/[token]';
import HouseholdScreen from '@/app/(tabs)/settings/households/[id]';

import type { HouseholdMember } from '../households';
import { InviteRow } from '../invite-row';
import { InviteError, type AcceptedInvite, type HouseholdInvite, type InvitePreview, type MyInvite } from '../invites';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
  };
});
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));

type Fn<A extends unknown[] = any[], R = any> = (...args: A) => R;
const mockCreateInvite = jest.fn<Fn<[string, string?], Promise<string>>>();
const mockListInvites = jest.fn<Fn<[string], Promise<HouseholdInvite[]>>>();
const mockRevokeInvite = jest.fn<Fn<[string], Promise<void>>>();
const mockPreviewInvite = jest.fn<Fn<[string], Promise<InvitePreview>>>();
const mockAcceptInvite = jest.fn<Fn<[string], Promise<AcceptedInvite>>>();
jest.mock('@/features/households/invites', () => ({
  ...(jest.requireActual('@/features/households/invites') as object),
  createInvite: (...args: [string, string?]) => mockCreateInvite(...args),
  listHouseholdInvites: (id: string) => mockListInvites(id),
  revokeInvite: (id: string) => mockRevokeInvite(id),
  previewInvite: (token: string) => mockPreviewInvite(token),
  acceptInvite: (token: string) => mockAcceptInvite(token),
}));
const mockFetchMembers = jest.fn<Fn<[string, string], Promise<HouseholdMember[]>>>();
const mockLeave = jest.fn<Fn<[string], Promise<unknown>>>();
const mockRemoveMember = jest.fn<Fn<[string, string], Promise<void>>>();
jest.mock('@/features/households/households', () => ({
  ...(jest.requireActual('@/features/households/households') as object),
  fetchHouseholdMembers: (...args: [string, string]) => mockFetchMembers(...args),
  leaveHousehold: (id: string) => mockLeave(id),
  removeMember: (...args: [string, string]) => mockRemoveMember(...args),
}));
const mockPushNow = jest.fn<Fn<[unknown], Promise<unknown>>>();
jest.mock('@/sync/push', () => ({ pushNow: (options: unknown) => mockPushNow(options) }));
const mockPullNow = jest.fn<Fn<[], Promise<unknown>>>();
jest.mock('@/sync/pull', () => ({ pullNow: () => mockPullNow() }));
const mockSmsAvailable = jest.fn<Fn<[], Promise<boolean>>>();
const mockSendSms = jest.fn<Fn>();
jest.mock('expo-sms', () => ({
  isAvailableAsync: () => mockSmsAvailable(),
  sendSMSAsync: (...args: unknown[]) => mockSendSms(...args),
}));
const mockMailAvailable = jest.fn<Fn<[], Promise<boolean>>>();
const mockCompose = jest.fn<Fn>();
jest.mock('expo-mail-composer', () => ({
  isAvailableAsync: () => mockMailAvailable(),
  composeAsync: (...args: unknown[]) => mockCompose(...args),
}));
const mockSetClipboard = jest.fn<Fn>();
jest.mock('expo-clipboard', () => ({ setStringAsync: (text: string) => mockSetClipboard(text) }));

let mockAccount: { status: 'ready'; account: { userId: string } } | { status: 'signedOut' } = {
  status: 'ready',
  account: { userId: 'user-1' },
};
jest.mock('@/features/auth/account', () => ({
  useAccountState: () => mockAccount,
  getAccount: () => (mockAccount.status === 'ready' ? mockAccount.account : null),
}));

const mockParams: Record<string, string | undefined> = {};
const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  replace: jest.fn(),
  canGoBack: jest.fn(() => true),
};
jest.mock('expo-router', () => {
  const { createElement, Fragment, useEffect } = require('react');
  const passThrough = () =>
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    };
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(passThrough(), { Button: host('ToolbarButton'), View: host('ToolbarView') });
  return {
    Stack: { Screen: () => null, Toolbar },
    router: {
      push: (...args: unknown[]) => mockRouter.push(...args),
      back: () => mockRouter.back(),
      replace: (...args: unknown[]) => mockRouter.replace(...args),
      canGoBack: () => mockRouter.canGoBack(),
    },
    // Focus is mount.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => mockParams,
  };
});

const USER = 'user-1';
const HOME = 'home';
const TOKEN = 'a'.repeat(32);
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  db.insert(households).values({ id: HOME, name: 'Smith home' }).run();
  db.insert(recipes).values({ id: 'r1', householdId: HOME, name: 'Tacos' }).run();
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockAccount = { status: 'ready', account: { userId: USER } };
  for (const fn of [
    mockCreateInvite,
    mockListInvites,
    mockRevokeInvite,
    mockPreviewInvite,
    mockAcceptInvite,
    mockFetchMembers,
    mockLeave,
    mockRemoveMember,
    mockPushNow,
    mockPullNow,
    mockSmsAvailable,
    mockSendSms,
    mockMailAvailable,
    mockCompose,
    mockSetClipboard,
  ]) {
    fn.mockReset();
  }
  mockPushNow.mockResolvedValue({ status: 'idle' });
  mockPullNow.mockResolvedValue({ status: 'idle' });
  mockListInvites.mockResolvedValue([]);
  mockSmsAvailable.mockResolvedValue(true);
  mockMailAvailable.mockResolvedValue(true);
  mockSetClipboard.mockResolvedValue(true);
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
  mockRouter.replace.mockClear();
  mockRouter.canGoBack.mockReset().mockReturnValue(true);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  await act(async () => {
    tree = create(element);
  });
  return tree!;
}

/** Every host Text's full string (nested Text included), outermost only, in order. */
const texts = (root: ReactTestRenderer) => {
  const out: string[] = [];
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : node && typeof node === 'object' ? ((node as { children?: unknown[] }).children ?? []).map(flat).join('') : '';
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type: string; children?: unknown[] };
    if (n.type === 'Text') {
      const s = flat(n);
      if (s) out.push(s);
      return;
    }
    n.children?.forEach(walk);
  };
  walk(root.toJSON());
  return out;
};
const byType = (root: ReactTestRenderer, type: string) => root.root.findAll((n) => n.type === type);
const allByLabel = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === label);
const byLabel = (root: ReactTestRenderer, label: string) => {
  const found = allByLabel(root, label);
  if (!found.length) throw new Error(`No element labelled ${label}; texts: ${texts(root).join(' | ')}`);
  return found[0];
};
const hasA11y = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => n.props.accessibilityLabel === label).length > 0;
const pressAsync = async (n: ReactTestInstance) => {
  await act(async () => {
    await n.props.onPress();
  });
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const member = (over: Partial<HouseholdMember> & Pick<HouseholdMember, 'userId' | 'displayName'>): HouseholdMember => ({
  avatarUrl: null,
  role: 'member',
  joinedAt: '2026-01-01T00:00:00Z',
  isYou: false,
  ...over,
});
const ME_OWNER = member({ userId: USER, displayName: 'John', role: 'owner', isYou: true, joinedAt: '2025-01-01T00:00:00Z' });
const SAM = member({ userId: 'sam', displayName: 'Sam' });

const pendingInvite = (over: Partial<HouseholdInvite> = {}): HouseholdInvite => ({
  id: 'inv-1',
  email: 'pat@example.com',
  invitedBy: 'John',
  createdAt: '2026-10-10T00:00:00Z',
  expiresAt: '2026-10-17T12:00:00Z',
  ...over,
});

describe('HouseholdScreen', () => {
  beforeEach(() => {
    mockParams.id = HOME;
  });

  test('shows the name and counts, a spinner while members load, then the members', async () => {
    const members = deferred<HouseholdMember[]>();
    mockFetchMembers.mockReturnValue(members.promise);
    const root = await render(<HouseholdScreen />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Smith home', '0 lists · 1 recipe']));
    expect(hasA11y(root, 'Loading members')).toBe(true);
    expect(mockFetchMembers).toHaveBeenCalledWith(HOME, USER);
    expect(mockListInvites).toHaveBeenCalledWith(HOME);
    // No Leave household until the members are known.
    expect(allByLabel(root, 'Leave household')).toHaveLength(0);

    await act(async () => members.resolve([ME_OWNER, SAM]));
    expect(hasA11y(root, 'Loading members')).toBe(false);
    expect(texts(root)).toEqual(expect.arrayContaining(['John (You)', 'Owner', 'Sam', 'Member', 'J', 'S']));
    expect(allByLabel(root, 'Leave household')).toHaveLength(1);
  });

  test('a failed load shows the error, and Retry loads again', async () => {
    mockFetchMembers.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([ME_OWNER]);
    const root = await render(<HouseholdScreen />);
    expect(texts(root)).toContain("Couldn't load members. Check your connection.");
    await pressAsync(byLabel(root, 'Retry'));
    expect(mockFetchMembers).toHaveBeenCalledTimes(2);
    expect(texts(root)).toContain('John (You)');
  });

  test('signed out: the error without asking the server', async () => {
    mockAccount = { status: 'signedOut' };
    const root = await render(<HouseholdScreen />);
    expect(mockFetchMembers).not.toHaveBeenCalled();
    expect(texts(root)).toContain("Couldn't load members. Check your connection.");
  });

  test('Invite someone opens the sheet with the inviter once members have loaded', async () => {
    const members = deferred<HouseholdMember[]>();
    mockFetchMembers.mockReturnValue(members.promise);
    const root = await render(<HouseholdScreen />);
    await pressAsync(byLabel(root, 'Invite someone'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/household-invite', params: { household: HOME } });
    await act(async () => members.resolve([ME_OWNER]));
    await pressAsync(byLabel(root, 'Invite someone'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/household-invite',
      params: { household: HOME, inviter: 'John' },
    });
  });

  test('an unknown household: no name, and Invite someone is disabled', async () => {
    mockParams.id = 'gone';
    mockFetchMembers.mockResolvedValue([]);
    const root = await render(<HouseholdScreen />);
    expect(byLabel(root, 'Invite someone').props.disabled).toBe(true);
    expect(allByLabel(root, 'Leave household')).toHaveLength(0);
  });

  describe('the Invited section', () => {
    test('lists open invites with a Pending badge; hidden when there are none', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockListInvites.mockResolvedValue([pendingInvite(), pendingInvite({ id: 'inv-2', email: null })]);
      const root = await render(<HouseholdScreen />);
      expect(texts(root)).toEqual(expect.arrayContaining(['Invited', 'pat@example.com', 'Invite link', 'Pending']));
      expect(texts(root).filter((t) => t === 'Pending')).toHaveLength(2);
      expect(texts(root).find((t) => t.startsWith('Sent by John · expires'))).toBeDefined();
    });

    test('hidden when invites fail to load', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockListInvites.mockRejectedValue(new Error('offline'));
      const root = await render(<HouseholdScreen />);
      expect(texts(root)).not.toContain('Invited');
    });

    test('Cancel invite revokes it and drops the row', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockListInvites.mockResolvedValue([pendingInvite()]);
      mockRevokeInvite.mockResolvedValue();
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'pat@example.com'));
      const [options, callback] = sheet.mock.calls[0];
      expect(options).toMatchObject({ title: 'pat@example.com', options: ['Send again', 'Cancel invite', 'Cancel'] });
      await act(async () => callback(1));
      expect(mockRevokeInvite).toHaveBeenCalledWith('inv-1');
      expect(texts(root)).not.toContain('pat@example.com');
    });

    test('a link-only invite offers only Cancel invite', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockListInvites.mockResolvedValue([pendingInvite({ email: null })]);
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Invite link'));
      expect(sheet.mock.calls[0][0].options).toEqual(['Cancel invite', 'Cancel']);
    });

    test('a failed cancel alerts and keeps the row', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockListInvites.mockResolvedValue([pendingInvite()]);
      mockRevokeInvite.mockRejectedValue(new Error('boom'));
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'pat@example.com'));
      await act(async () => sheet.mock.calls[0][1](1));
      expect(alert).toHaveBeenCalledWith(
        "Couldn't cancel the invite",
        "Couldn't reach the server. Check your connection and try again.",
      );
      expect(texts(root)).toContain('pat@example.com');
    });

    test('Send again re-creates the invite and opens the sheet on step 2', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockListInvites.mockResolvedValue([pendingInvite()]);
      mockCreateInvite.mockResolvedValue('perfectbite://invite/new');
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'pat@example.com'));
      await act(async () => sheet.mock.calls[0][1](0));
      expect(mockCreateInvite).toHaveBeenCalledWith(HOME, 'pat@example.com');
      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/household-invite',
        params: { household: HOME, inviter: 'John', email: 'pat@example.com', link: 'perfectbite://invite/new' },
      });
    });

    test('a failed Send again alerts with the reason', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockListInvites.mockResolvedValue([pendingInvite()]);
      mockCreateInvite.mockRejectedValue(new InviteError('already-member', 'already a member'));
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'pat@example.com'));
      await act(async () => sheet.mock.calls[0][1](0));
      expect(alert).toHaveBeenCalledWith("Couldn't send the invite again", 'pat@example.com is already in Smith home.');
      expect(mockRouter.push).not.toHaveBeenCalled();
    });
  });

  describe('members', () => {
    test("an owner can remove another member after confirming; their own row isn't actionable", async () => {
      mockFetchMembers.mockResolvedValueOnce([ME_OWNER, SAM]).mockResolvedValueOnce([ME_OWNER]);
      mockRemoveMember.mockResolvedValue();
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      expect(byLabel(root, 'John (You)').props.onPress).toBeUndefined();
      const sam = byLabel(root, 'Sam');
      expect(sam.props.accessibilityHint).toBe('Shows the option to remove this member.');
      await pressAsync(sam);
      const [options, callback] = sheet.mock.calls[0];
      expect(options).toMatchObject({ title: 'Sam', options: ['Remove from Smith home', 'Cancel'] });
      // Cancel does nothing.
      act(() => callback(1));
      expect(alert).not.toHaveBeenCalled();
      act(() => callback(0));
      const [title, message, buttons] = alert.mock.calls[0];
      expect([title, message]).toEqual(['Remove Sam?', "They'll lose access to Smith home's lists and recipes."]);
      await act(async () => (buttons as AlertButton[]).find((b) => b.text === 'Remove')!.onPress!());
      expect(mockRemoveMember).toHaveBeenCalledWith(HOME, 'sam');
      expect(texts(root)).not.toContain('Sam');
    });

    test('a failed remove alerts', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      mockRemoveMember.mockRejectedValue(new Error('boom'));
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Sam'));
      act(() => sheet.mock.calls[0][1](0));
      await act(async () => (alert.mock.calls[0][2] as AlertButton[])[1].onPress!());
      expect(alert).toHaveBeenCalledTimes(2);
      expect(texts(root)).toContain('Sam');
    });

    test("a member can't act on other members", async () => {
      mockFetchMembers.mockResolvedValue([
        member({ userId: 'owner', displayName: 'Ann', role: 'owner' }),
        member({ userId: USER, displayName: 'John', isYou: true }),
      ]);
      const root = await render(<HouseholdScreen />);
      expect(byLabel(root, 'Ann').props.onPress).toBeUndefined();
    });
  });

  describe('Leave household', () => {
    test('confirms for the case, then leaves and goes back', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      mockLeave.mockResolvedValue({ outcome: 'promoted', newHouseholdId: null });
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Leave household'));
      const [title, message, buttons] = alert.mock.calls[0];
      expect(title).toBe('Leave Smith home?');
      expect(message).toBe("You'll lose access to its lists and recipes. They stay with the household. Sam will become the owner.");
      await act(async () => (buttons as AlertButton[]).find((b) => b.text === 'Leave')!.onPress!());
      expect(mockLeave).toHaveBeenCalledWith(HOME);
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });

    test('the only member is told the household will be deleted', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Leave household'));
      expect(alert.mock.calls[0][0]).toBe('Leave and delete Smith home?');
      expect((alert.mock.calls[0][2] as AlertButton[]).map((b) => b.text)).toEqual(['Cancel', 'Leave and Delete']);
    });

    test('a failed leave alerts and stays', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      mockLeave.mockRejectedValue(new Error('boom'));
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Leave household'));
      await act(async () => (alert.mock.calls[0][2] as AlertButton[])[1].onPress!());
      expect(alert).toHaveBeenCalledTimes(2);
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(hasA11y(root, 'Leaving')).toBe(false);
    });
  });
});

describe('HouseholdInviteSheet', () => {
  beforeEach(() => {
    mockParams.household = HOME;
    mockParams.inviter = 'John';
  });

  const emailField = (root: ReactTestRenderer) =>
    root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Their email');
  const toolbar = (root: ReactTestRenderer, text: string) =>
    byType(root, 'ToolbarButton').find((n) => n.props.children === text || n.props.accessibilityLabel === text)!;

  test('step 1: the title, and Next enabled only for a valid email', async () => {
    const root = await render(<HouseholdInviteSheet />);
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        'Invite to Smith home',
        "They'll share its lists and recipes. Their other households aren't affected.",
        'Use the email they sign in with (their Google account).',
      ]),
    );
    expect(toolbar(root, 'Next').props.disabled).toBe(true);
    act(() => emailField(root).props.onChangeText('pat@'));
    expect(toolbar(root, 'Next').props.disabled).toBe(true);
    act(() => emailField(root).props.onChangeText('pat@example.com'));
    expect(toolbar(root, 'Next').props.disabled).toBe(false);
  });

  test('Next pushes, creates the invite, and moves to step 2 with the channels', async () => {
    const created = deferred<string>();
    mockCreateInvite.mockReturnValue(created.promise);
    const root = await render(<HouseholdInviteSheet />);
    act(() => emailField(root).props.onChangeText('Pat.Lee@Example.com'));
    act(() => {
      void toolbar(root, 'Next').props.onPress();
    });
    await act(async () => {});
    expect(mockPushNow).toHaveBeenCalledWith({ force: true });
    expect(byType(root, 'ToolbarView')[0].props.hidden).toBe(false);
    expect(toolbar(root, 'Next').props.hidden).toBe(true);
    expect(emailField(root).props.editable).toBe(false);
    await act(async () => created.resolve('perfectbite://invite/abc'));
    expect(mockCreateInvite).toHaveBeenCalledWith(HOME, 'Pat.Lee@Example.com');
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        'Let Pat know',
        'pat.lee@example.com',
        'Invite expires in 7 days',
        'Send it with',
        'Messages',
        'Mail',
        'Copy link',
        'More…',
      ]),
    );
  });

  test('a failed create shows the reason under the field; editing clears it', async () => {
    mockCreateInvite.mockRejectedValue(new InviteError('already-member', 'already a member'));
    const root = await render(<HouseholdInviteSheet />);
    act(() => emailField(root).props.onChangeText('pat@example.com'));
    await pressAsync(toolbar(root, 'Next'));
    expect(texts(root)).toContain('pat@example.com is already in Smith home.');
    expect(emailField(root).props.editable).toBe(true);
    act(() => emailField(root).props.onChangeText('sam@example.com'));
    expect(texts(root)).not.toContain('pat@example.com is already in Smith home.');
  });

  test('a failed push shows the offline message', async () => {
    mockPushNow.mockRejectedValue(new Error('no network'));
    const root = await render(<HouseholdInviteSheet />);
    act(() => emailField(root).props.onChangeText('pat@example.com'));
    await pressAsync(toolbar(root, 'Next'));
    expect(mockCreateInvite).not.toHaveBeenCalled();
    expect(texts(root)).toContain("Couldn't reach the server. Check your connection and try again.");
  });

  test('"Share a link instead" makes a link-only invite, opens the share sheet and closes', async () => {
    mockCreateInvite.mockResolvedValue('perfectbite://invite/link');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const root = await render(<HouseholdInviteSheet />);
    await pressAsync(byLabel(root, "Don't know their email? Share a link instead"));
    expect(mockCreateInvite).toHaveBeenCalledWith(HOME);
    expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('perfectbite://invite/link') });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  test('while the link is being made it says so; a failure shows the error', async () => {
    const created = deferred<string>();
    mockCreateInvite.mockReturnValue(created.promise);
    const root = await render(<HouseholdInviteSheet />);
    act(() => {
      void byLabel(root, "Don't know their email? Share a link instead").props.onPress();
    });
    await act(async () => {});
    expect(byLabel(root, 'Creating link…').props.disabled).toBe(true);
    await act(async () => created.reject(new Error('boom')));
    expect(texts(root)).toContain("Couldn't reach the server. Check your connection and try again.");
    expect(byLabel(root, "Don't know their email? Share a link instead").props.disabled).toBe(false);
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  test('Cancel closes', async () => {
    const root = await render(<HouseholdInviteSheet />);
    act(() => toolbar(root, 'Cancel').props.onPress());
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  describe('step 2', () => {
    beforeEach(() => {
      mockParams.email = 'pat@example.com';
      mockParams.link = 'perfectbite://invite/abc';
    });

    test('opened from Send again it starts on step 2; Back returns to step 1 with the email kept', async () => {
      const root = await render(<HouseholdInviteSheet />);
      expect(texts(root)).toContain('Let Pat know');
      expect(texts(root)).toContain("You can also skip this. If Pat signs in with this email, they'll see the invite in the app.");
      act(() => toolbar(root, 'Back').props.onPress());
      expect(emailField(root).props.value).toBe('pat@example.com');
    });

    test('Messages and Mail show only when the device can send them', async () => {
      mockSmsAvailable.mockResolvedValue(false);
      mockMailAvailable.mockRejectedValue(new Error('no'));
      const root = await render(<HouseholdInviteSheet />);
      expect(texts(root)).not.toContain('Messages');
      expect(texts(root)).not.toContain('Mail');
      expect(texts(root)).toEqual(expect.arrayContaining(['Copy link', 'More…']));
    });

    test('each channel sends the link its own way', async () => {
      const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
      const root = await render(<HouseholdInviteSheet />);
      await pressAsync(byLabel(root, 'Messages'));
      expect(mockSendSms).toHaveBeenCalledWith([], expect.stringContaining('perfectbite://invite/abc'));
      await pressAsync(byLabel(root, 'Mail'));
      expect(mockCompose).toHaveBeenCalledWith(
        expect.objectContaining({ recipients: ['pat@example.com'], body: expect.stringContaining('John') }),
      );
      await pressAsync(byLabel(root, 'More…'));
      expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('perfectbite://invite/abc') });
    });

    test('Copy link copies and says so', async () => {
      const root = await render(<HouseholdInviteSheet />);
      await pressAsync(byLabel(root, 'Copy link'));
      expect(mockSetClipboard).toHaveBeenCalledWith('perfectbite://invite/abc');
      expect(texts(root)).toContain('Link copied');
    });

    test("a channel that fails doesn't break the sheet", async () => {
      mockSendSms.mockRejectedValue(new Error('cancelled'));
      const root = await render(<HouseholdInviteSheet />);
      await pressAsync(byLabel(root, 'Messages'));
      expect(texts(root)).toContain('Let Pat know');
    });

    test('Done closes', async () => {
      const root = await render(<HouseholdInviteSheet />);
      await pressAsync(byLabel(root, 'Done'));
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });
  });
});

describe('JoinHouseholdScreen', () => {
  beforeEach(() => {
    mockParams.token = TOKEN;
  });

  const preview = (over: Partial<InvitePreview> = {}): InvitePreview => ({
    householdId: HOME,
    householdName: 'Smith home',
    invitedBy: 'John',
    status: 'valid',
    ...over,
  });

  test('loading, then "Join Smith home?" with who invited', async () => {
    const loaded = deferred<InvitePreview>();
    mockPreviewInvite.mockReturnValue(loaded.promise);
    const root = await render(<JoinHouseholdScreen />);
    expect(hasA11y(root, 'Loading invite')).toBe(true);
    expect(mockPreviewInvite).toHaveBeenCalledWith(TOKEN);
    await act(async () => loaded.resolve(preview()));
    expect(texts(root)).toEqual([
      'Join Smith home?',
      'Invited by John',
      "You'll share its lists and recipes. Your other households aren't affected.",
      'Join',
      'Not now',
    ]);
  });

  test('Join accepts, pulls, and opens the Lists tab', async () => {
    mockPreviewInvite.mockResolvedValue(preview());
    const accepted = deferred<AcceptedInvite>();
    mockAcceptInvite.mockReturnValue(accepted.promise);
    const root = await render(<JoinHouseholdScreen />);
    act(() => {
      void byLabel(root, 'Join').props.onPress();
    });
    expect(byLabel(root, 'Joining…').props.disabled).toBe(true);
    expect(byLabel(root, 'Not now').props.disabled).toBe(true);
    await act(async () => accepted.resolve({ householdId: HOME, householdName: 'Smith home', alreadyMember: false }));
    expect(mockAcceptInvite).toHaveBeenCalledWith(TOKEN);
    expect(mockPullNow).toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/lists');
  });

  test('joining a household already joined opens it', async () => {
    mockPreviewInvite.mockResolvedValue(preview());
    mockAcceptInvite.mockResolvedValue({ householdId: HOME, householdName: 'Smith home', alreadyMember: true });
    const root = await render(<JoinHouseholdScreen />);
    await pressAsync(byLabel(root, 'Join'));
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/settings/households/[id]', params: { id: HOME } });
  });

  test('a failed join shows why', async () => {
    mockPreviewInvite.mockResolvedValue(preview());
    mockAcceptInvite.mockRejectedValue(new InviteError('expired', 'invite expired'));
    const root = await render(<JoinHouseholdScreen />);
    await pressAsync(byLabel(root, 'Join'));
    expect(texts(root)).toEqual(["Can't join", 'This invite has expired. Ask for a new one.', 'Close']);
  });

  test('Not now goes back, or to the Lists tab when there is nowhere to go back to', async () => {
    mockPreviewInvite.mockResolvedValue(preview());
    const root = await render(<JoinHouseholdScreen />);
    await pressAsync(byLabel(root, 'Not now'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    mockRouter.canGoBack.mockReturnValue(false);
    await pressAsync(byLabel(root, 'Not now'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/lists');
  });

  test('an invite for a household the user is in says so and offers to open it', async () => {
    mockPreviewInvite.mockResolvedValue(preview({ status: 'member' }));
    const root = await render(<JoinHouseholdScreen />);
    expect(texts(root)).toEqual(['Smith home', "You're already in Smith home.", 'Open household', 'Close']);
    await pressAsync(byLabel(root, 'Open household'));
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/settings/households/[id]', params: { id: HOME } });
  });

  test.each<[InvitePreview['status'], string]>([
    ['used', 'This invite has already been used. Ask for a new one.'],
    ['expired', 'This invite has expired. Ask for a new one.'],
  ])('a %s invite can only be closed', async (status, message) => {
    mockPreviewInvite.mockResolvedValue(preview({ status }));
    const root = await render(<JoinHouseholdScreen />);
    expect(texts(root)).toEqual(['Smith home', message, 'Close']);
  });

  test('an invalid link: "Can\'t join" with Close only', async () => {
    mockPreviewInvite.mockRejectedValue(new InviteError('invalid', 'invite not found'));
    const root = await render(<JoinHouseholdScreen />);
    expect(texts(root)).toEqual(["Can't join", "This invite link isn't valid. Ask for a new one.", 'Close']);
  });

  test('a network failure offers Try again, which loads it again', async () => {
    mockPreviewInvite.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(preview());
    const root = await render(<JoinHouseholdScreen />);
    expect(texts(root)).toEqual([
      "Couldn't load the invite",
      "Couldn't reach the server. Check your connection and try again.",
      'Try again',
      'Close',
    ]);
    await pressAsync(byLabel(root, 'Try again'));
    expect(texts(root)[0]).toBe('Join Smith home?');
  });

  test('without an inviter there is no "Invited by" line', async () => {
    mockPreviewInvite.mockResolvedValue(preview({ invitedBy: null }));
    const root = await render(<JoinHouseholdScreen />);
    expect(texts(root).some((t) => t.startsWith('Invited by'))).toBe(false);
  });
});

describe('InviteRow', () => {
  const invite: MyInvite = { id: 'i1', householdId: HOME, householdName: 'Smith household', invitedBy: 'John', memberCount: 2 };
  const DECLINE = 'Decline invite to Smith household';
  const buttons = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && !!n.props.onPress && !!n.props.accessibilityLabel);
  const button = (root: ReactTestRenderer, label: string) => buttons(root).find((n) => n.props.accessibilityLabel === label)!;

  test('shows who invited and to where, a round Decline and a Join pill', async () => {
    const onJoin = jest.fn();
    const onDecline = jest.fn();
    const root = await render(<InviteRow invite={invite} busy={null} onJoin={onJoin} onDecline={onDecline} />);
    expect(texts(root)).toEqual(['J', 'John invited you', 'to Smith household · 2 members', 'Join']);
    expect(hasA11y(root, 'John invited you to Smith household')).toBe(true);
    // Decline is an icon: its label names the household.
    expect(button(root, DECLINE)).toBeDefined();
    act(() => button(root, 'Join').props.onPress());
    act(() => button(root, DECLINE).props.onPress());
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  test('without an inviter: "You\'re invited" with the household\'s initial', async () => {
    const root = await render(
      <InviteRow invite={{ ...invite, invitedBy: null, memberCount: 1 }} busy={null} onJoin={() => {}} onDecline={() => {}} />,
    );
    expect(texts(root)).toEqual(['S', "You're invited", 'to Smith household · 1 member', 'Join']);
  });

  test.each(['join', 'decline'] as const)('busy %s: that button spins and both are disabled', async (busy) => {
    const root = await render(<InviteRow invite={invite} busy={busy} onJoin={() => {}} onDecline={() => {}} />);
    const [join, decline] = [button(root, 'Join'), button(root, DECLINE)];
    expect(join.props.disabled).toBe(true);
    expect(decline.props.disabled).toBe(true);
    expect(join.props.accessibilityState).toEqual({ disabled: true, busy: busy === 'join' });
    expect(decline.props.accessibilityState).toEqual({ disabled: true, busy: busy === 'decline' });
    // The busy one shows a spinner in place of its label or icon.
    expect(byType(root, 'ActivityIndicator')).toHaveLength(1);
    expect(texts(root)).toEqual(['J', 'John invited you', 'to Smith household · 2 members', ...(busy === 'join' ? [] : ['Join'])]);
  });
});
