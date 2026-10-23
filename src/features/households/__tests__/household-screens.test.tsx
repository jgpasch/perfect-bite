// The household screens (spec 4.7): the household and its members (board 11, design S4), the invite
// sheet (designs S2, S3), the join screen an invite link opens, and the invite row (board H).
// Rendered against the in-memory database; the server calls are stubbed.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS, Alert, type AlertButton, Share } from 'react-native';
import { eq } from 'drizzle-orm';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import {
  db,
  householdCategoryOrder,
  householdStaples,
  households,
  ingredients,
  ingredientUsage,
  outbox,
  recipes,
  userHouseholdCategoryOrder,
} from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { clearPushMoment, pushMomentPending } from '@/features/push/ask';
import { initI18n } from '@/i18n';
import { resetDb } from '@/test/db';

import HouseholdInviteSheet from '@/app/household-invite';
import JoinHouseholdScreen from '@/app/invite/[token]';
import HouseholdScreen from '@/app/(tabs)/settings/households/[id]';
import AlwaysHaveScreen from '@/app/(tabs)/settings/always-have';

import { takeDeletedHousehold } from '../deleted-household-notice';
import { HouseholdActionError, type HouseholdMember } from '../households';
import { InviteRow } from '../invite-row';
import { isStaple, setStaple } from '../staples';
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
// Records the tables each screen watches, so a test can check it follows remote changes.
const mockWatched: unknown[][] = [];
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }, tables: unknown[]) => {
    mockWatched.push(tables);
    return { data: query.all(), error: undefined };
  },
}));
// The swipe: a host element whose `onSwipeableOpen` the test calls, as a full swipe would.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ children, ...props }: Record<string, any>) => createElement('Swipeable', props, children),
  };
});

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
const mockRename = jest.fn<Fn<[string, string, (string | null)?], Promise<void>>>();
const mockSetRole = jest.fn<Fn<[string, string, string], Promise<void>>>();
const mockDelete = jest.fn<Fn<[string], Promise<{ newHouseholdId: string | null }>>>();
const mockSetCombine = jest.fn<Fn<[string, boolean], Promise<void>>>();
jest.mock('@/features/households/households', () => ({
  ...(jest.requireActual('@/features/households/households') as object),
  deleteHousehold: (id: string) => mockDelete(id),
  fetchHouseholdMembers: (...args: [string, string]) => mockFetchMembers(...args),
  leaveHousehold: (id: string) => mockLeave(id),
  removeMember: (...args: [string, string]) => mockRemoveMember(...args),
  renameHousehold: (...args: [string, string, (string | null)?]) => mockRename(...args),
  setMemberRole: (...args: [string, string, string]) => mockSetRole(...args),
  setCombineLanguages: (...args: [string, boolean]) => mockSetCombine(...args),
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
    mockRename,
    mockSetRole,
    mockDelete,
    mockSetCombine,
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

const member = (over: Partial<HouseholdMember> & Pick<HouseholdMember, 'userId' | 'firstName'>): HouseholdMember => ({
  lastName: null,
  avatarUrl: null,
  role: 'member',
  joinedAt: '2026-01-01T00:00:00Z',
  isYou: false,
  ...over,
});
const ME_OWNER = member({ userId: USER, firstName: 'John', role: 'owner', isYou: true, joinedAt: '2025-01-01T00:00:00Z' });
const SAM = member({ userId: 'sam', firstName: 'Sam' });

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
      expect(sam.props.accessibilityHint).toBe('Make owner or remove.');
      await pressAsync(sam);
      const [options, callback] = sheet.mock.calls[0];
      expect(options).toMatchObject({ title: 'Sam', options: ['Make owner', 'Remove from Smith home', 'Cancel'] });
      // Cancel does nothing.
      act(() => callback(2));
      expect(alert).not.toHaveBeenCalled();
      act(() => callback(1));
      const [title, message, buttons] = alert.mock.calls[0];
      expect([title, message]).toEqual(['Remove Sam?', "They'll lose access to Smith home's lists and recipes."]);
      await act(async () => (buttons as AlertButton[]).find((b) => b.text === 'Remove')!.onPress!());
      expect(mockRemoveMember).toHaveBeenCalledWith(HOME, 'sam');
      expect(texts(root)).not.toContain('Sam');
    });

    test('rows, the sheet, the confirms and the inviter use the full name; the avatar the first name\'s initial', async () => {
      const me = { ...ME_OWNER, lastName: 'Smith' };
      const emile = member({ userId: 'emile', firstName: 'Émile', lastName: 'Zola' });
      mockFetchMembers.mockResolvedValue([me, emile]);
      mockRemoveMember.mockRejectedValue(new Error('boom'));
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      expect(texts(root)).toEqual(expect.arrayContaining(['John Smith (You)', 'Émile Zola', 'J', 'É']));
      expect(texts(root)).not.toContain('Z');

      await pressAsync(byLabel(root, 'Émile Zola'));
      expect(sheet.mock.calls[0][0]).toMatchObject({ title: 'Émile Zola' });
      act(() => sheet.mock.calls[0][1](0));
      expect(alert.mock.calls[0][0]).toBe('Make Émile Zola an owner?');
      await pressAsync(byLabel(root, 'Émile Zola'));
      act(() => sheet.mock.calls[1][1](1));
      expect(alert.mock.calls[1][0]).toBe('Remove Émile Zola?');

      await pressAsync(byLabel(root, 'Invite someone'));
      expect(mockRouter.push).toHaveBeenLastCalledWith({
        pathname: '/household-invite',
        params: { household: HOME, inviter: 'John Smith' },
      });
    });

    test('a failed remove alerts', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      mockRemoveMember.mockRejectedValue(new Error('boom'));
      const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Sam'));
      act(() => sheet.mock.calls[0][1](1));
      await act(async () => (alert.mock.calls[0][2] as AlertButton[])[1].onPress!());
      expect(alert).toHaveBeenCalledTimes(2);
      expect(texts(root)).toContain('Sam');
    });

    describe('roles', () => {
      const ANN = member({ userId: 'ann', firstName: 'Ann', role: 'owner', joinedAt: '2025-06-01T00:00:00Z' });
      const sheetSpy = () => jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
      const alertSpy = () => jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const confirmButton = (alert: ReturnType<typeof alertSpy>, call: number, text: string) =>
        (alert.mock.calls[call][2] as AlertButton[]).find((b) => b.text === text)!;

      test('Make owner confirms, calls set_member_role and reloads with the new badge', async () => {
        mockFetchMembers
          .mockResolvedValueOnce([ME_OWNER, SAM])
          .mockResolvedValueOnce([ME_OWNER, { ...SAM, role: 'owner' }]);
        mockSetRole.mockResolvedValue();
        const sheet = sheetSpy();
        const alert = alertSpy();
        const root = await render(<HouseholdScreen />);
        expect(texts(root)).toEqual(['Smith home', '0 lists · 1 recipe', 'J', 'S', 'Members', 'John (You)', 'Owner', 'Sam', 'Member', 'Household settings', 'Always have', 'None', 'Combine English and Spanish names', 'Leche and milk become one item on your lists.', 'These change it for everyone in Smith home.', 'Aisle order', 'Household', 'Shared with the household unless you keep your own.', 'Invite someone', 'Delete household', 'Leave household']);
        await pressAsync(byLabel(root, 'Sam'));
        expect(sheet.mock.calls[0][0]).toEqual({
          title: 'Sam',
          options: ['Make owner', 'Remove from Smith home', 'Cancel'],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
        });
        act(() => sheet.mock.calls[0][1](0));
        const [title, message, buttons] = alert.mock.calls[0];
        expect([title, message]).toEqual(['Make Sam an owner?', 'Owners can rename the household, remove members and delete it.']);
        expect((buttons as AlertButton[]).map((b) => [b.text, b.style])).toEqual([
          ['Cancel', 'cancel'],
          ['Make owner', 'default'],
        ]);
        await act(async () => confirmButton(alert, 0, 'Make owner').onPress!());
        expect(mockSetRole).toHaveBeenCalledWith(HOME, 'sam', 'owner');
        expect(mockFetchMembers).toHaveBeenCalledTimes(2);
        expect(texts(root)).toEqual(['Smith home', '0 lists · 1 recipe', 'J', 'S', 'Members', 'John (You)', 'Owner', 'Sam', 'Owner', 'Household settings', 'Always have', 'None', 'Combine English and Spanish names', 'Leche and milk become one item on your lists.', 'These change it for everyone in Smith home.', 'Aisle order', 'Household', 'Shared with the household unless you keep your own.', 'Invite someone', 'Delete household', 'Leave household']);
        // Sam is now another owner: the sheet offers Remove as owner.
        expect(byLabel(root, 'Sam').props.accessibilityHint).toBe('Remove as owner or remove.');
        expect(alert).toHaveBeenCalledTimes(1);
      });

      test('Cancel on the confirm changes nothing', async () => {
        mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
        const sheet = sheetSpy();
        const alert = alertSpy();
        const root = await render(<HouseholdScreen />);
        await pressAsync(byLabel(root, 'Sam'));
        act(() => sheet.mock.calls[0][1](0));
        expect(confirmButton(alert, 0, 'Cancel').onPress).toBeUndefined();
        expect(mockSetRole).not.toHaveBeenCalled();
      });

      test('Remove as owner on another owner makes them a member', async () => {
        mockFetchMembers.mockResolvedValueOnce([ME_OWNER, ANN, SAM]).mockResolvedValueOnce([ME_OWNER, { ...ANN, role: 'member' }, SAM]);
        mockSetRole.mockResolvedValue();
        const sheet = sheetSpy();
        const alert = alertSpy();
        const root = await render(<HouseholdScreen />);
        await pressAsync(byLabel(root, 'Ann'));
        expect(sheet.mock.calls[0][0]).toMatchObject({ title: 'Ann', options: ['Remove as owner', 'Remove from Smith home', 'Cancel'] });
        act(() => sheet.mock.calls[0][1](0));
        expect(alert.mock.calls[0].slice(0, 2)).toEqual(['Remove Ann as owner?', "They'll stay a member."]);
        expect(confirmButton(alert, 0, 'Remove as owner').style).toBe('destructive');
        await act(async () => confirmButton(alert, 0, 'Remove as owner').onPress!());
        expect(mockSetRole).toHaveBeenCalledWith(HOME, 'ann', 'member');
        expect(byLabel(root, 'Ann').props.accessibilityHint).toBe('Make owner or remove.');
      });

      test('your own row: Step down with a second owner, which hides the owner controls at once', async () => {
        const reload = deferred<HouseholdMember[]>();
        mockFetchMembers.mockResolvedValueOnce([ME_OWNER, ANN, SAM]).mockReturnValueOnce(reload.promise);
        mockSetRole.mockResolvedValue();
        const sheet = sheetSpy();
        const alert = alertSpy();
        const root = await render(<HouseholdScreen />);
        expect(hasA11y(root, 'Rename household')).toBe(true);
        const me = byLabel(root, 'John (You)');
        expect(me.props.accessibilityHint).toBe('Step down as owner.');
        await pressAsync(me);
        expect(sheet.mock.calls[0][0]).toEqual({
          title: 'John',
          options: ['Step down as owner', 'Cancel'],
          destructiveButtonIndex: undefined,
          cancelButtonIndex: 1,
        });
        // Cancel in the sheet does nothing.
        act(() => sheet.mock.calls[0][1](1));
        expect(alert).not.toHaveBeenCalled();
        act(() => sheet.mock.calls[0][1](0));
        expect(alert.mock.calls[0].slice(0, 2)).toEqual([
          'Step down as owner?',
          "You'll stay a member. Only owners can rename, remove members or delete the household.",
        ]);
        await act(async () => confirmButton(alert, 0, 'Step down').onPress!());
        expect(mockSetRole).toHaveBeenCalledWith(HOME, USER, 'member');
        // Before the reload answers: no pencil, and no member rows to tap.
        expect(hasA11y(root, 'Rename household')).toBe(false);
        for (const label of ['John (You)', 'Ann', 'Sam']) expect(byLabel(root, label).props.onPress).toBeUndefined();
        await act(async () => reload.resolve([ANN, { ...ME_OWNER, role: 'member' }, SAM]));
        expect(hasA11y(root, 'Rename household')).toBe(false);
        expect(byLabel(root, 'John (You)').props.onPress).toBeUndefined();
      });

      test("your own row isn't actionable when you're the only owner", async () => {
        mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
        const root = await render(<HouseholdScreen />);
        const me = byLabel(root, 'John (You)');
        expect(me.props.onPress).toBeUndefined();
        expect(me.props.accessibilityHint).toBeUndefined();
      });

      test("last owner from the server says the household needs one, and changes nothing", async () => {
        mockFetchMembers.mockResolvedValue([ME_OWNER, ANN]);
        mockSetRole.mockRejectedValue(new HouseholdActionError('last-owner', 'last owner'));
        const sheet = sheetSpy();
        const alert = alertSpy();
        const root = await render(<HouseholdScreen />);
        await pressAsync(byLabel(root, 'John (You)'));
        act(() => sheet.mock.calls[0][1](0));
        await act(async () => confirmButton(alert, 0, 'Step down').onPress!());
        expect(alert.mock.calls[1].slice(0, 2)).toEqual(["Couldn't step down as owner", 'Smith home needs at least one owner.']);
        expect(mockFetchMembers).toHaveBeenCalledTimes(1);
        expect(hasA11y(root, 'Rename household')).toBe(true);
        expect(texts(root)).toEqual(expect.arrayContaining(['John (You)', 'Owner', 'Ann']));
      });

      test("offline says so and changes nothing", async () => {
        mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
        mockSetRole.mockRejectedValue(new HouseholdActionError('offline', 'offline'));
        const sheet = sheetSpy();
        const alert = alertSpy();
        const root = await render(<HouseholdScreen />);
        await pressAsync(byLabel(root, 'Sam'));
        act(() => sheet.mock.calls[0][1](0));
        await act(async () => confirmButton(alert, 0, 'Make owner').onPress!());
        expect(alert.mock.calls[1].slice(0, 2)).toEqual(["You're offline", 'Connect to the internet and try again.']);
        expect(texts(root)).toEqual(expect.arrayContaining(['Sam', 'Member']));
      });

      test('a non-owner sees no member menus, even with several owners', async () => {
        mockFetchMembers.mockResolvedValue([ANN, member({ userId: 'bo', firstName: 'Bo', role: 'owner' }), member({ userId: USER, firstName: 'John', isYou: true }), SAM]);
        const root = await render(<HouseholdScreen />);
        for (const label of ['Ann', 'Bo', 'John (You)', 'Sam']) {
          expect(byLabel(root, label).props.onPress).toBeUndefined();
          expect(byLabel(root, label).props.accessibilityHint).toBeUndefined();
        }
      });
    });

    test("a member can't act on other members", async () => {
      mockFetchMembers.mockResolvedValue([
        member({ userId: 'owner', firstName: 'Ann', role: 'owner' }),
        member({ userId: USER, firstName: 'John', isYou: true }),
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

  describe('Delete household', () => {
    const deleteRows = (root: ReactTestRenderer) => allByLabel(root, 'Delete household');
    const confirmButton = (alert: { mock: { calls: unknown[][] } }, text: string) =>
      (alert.mock.calls[0][2] as AlertButton[]).find((b) => b.text === text)!;

    test('owners only, above Leave household, with a hint', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      const root = await render(<HouseholdScreen />);
      const row = byLabel(root, 'Delete household');
      expect(row.props.labelColor).toBe('danger');
      expect(row.props.accessibilityHint).toBe('Asks to confirm, then deletes this household for every member.');
      const labels = root.root
        .findAll((n) => typeof n.type !== 'string' && /household$/.test(String(n.props.label)))
        .map((n) => n.props.label);
      expect(labels.indexOf('Delete household')).toBeLessThan(labels.indexOf('Leave household'));
    });

    test('a plain member, and anyone before the members load, has no Delete row', async () => {
      mockFetchMembers.mockResolvedValue([member({ userId: USER, firstName: 'John', isYou: true }), { ...SAM, role: 'owner' }]);
      const root = await render(<HouseholdScreen />);
      expect(deleteRows(root)).toHaveLength(0);
      expect(allByLabel(root, 'Leave household')).toHaveLength(1);
      act(() => tree?.unmount());
      mockFetchMembers.mockReturnValue(deferred<HouseholdMember[]>().promise);
      const loading = await render(<HouseholdScreen />);
      expect(deleteRows(loading)).toHaveLength(0);
    });

    test('confirms with the counts for every member; Cancel changes nothing', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Delete household'));
      const [title, message, buttons] = alert.mock.calls[0];
      expect(title).toBe('Delete Smith home?');
      expect(message).toBe("Its 0 lists and 1 recipe will be deleted for all 2 members. This can't be undone.");
      expect((buttons as AlertButton[]).map((b) => [b.text, b.style])).toEqual([
        ['Cancel', 'cancel'],
        ['Delete', 'destructive'],
      ]);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    test('the only member of their only household is told they get a new one', async () => {
      resetDb();
      db.insert(households).values({ id: HOME, name: 'Smith home' }).run();
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Delete household'));
      expect(alert.mock.calls[0][1]).toBe(
        "Its 0 lists and 0 recipes will be deleted. This can't be undone. You'll get a new empty household.",
      );
    });

    test('Delete calls delete_household, then goes back to Settings with the name for its toast', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      const done = deferred<{ newHouseholdId: string | null }>();
      mockDelete.mockReturnValue(done.promise);
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Delete household'));
      act(() => void confirmButton(alert, 'Delete').onPress!());
      expect(mockDelete).toHaveBeenCalledWith(HOME);
      expect(hasA11y(root, 'Deleting')).toBe(true);
      // Busy: a second tap, or Leave, does nothing.
      await pressAsync(byLabel(root, 'Delete household'));
      await pressAsync(byLabel(root, 'Leave household'));
      expect(alert).toHaveBeenCalledTimes(1);
      await act(async () => done.resolve({ newHouseholdId: null }));
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
      expect(takeDeletedHousehold()).toBe('Smith home');
    });

    test('offline says so, stays, and leaves no toast', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      mockDelete.mockRejectedValue(new HouseholdActionError('offline', 'offline'));
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Delete household'));
      await act(async () => confirmButton(alert, 'Delete').onPress!());
      expect(alert.mock.calls[1].slice(0, 2)).toEqual(["You're offline", 'Connect to the internet and try again.']);
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(hasA11y(root, 'Deleting')).toBe(false);
      expect(takeDeletedHousehold()).toBeNull();
    });

    test('a failure alerts with the reason and changes nothing', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      mockDelete.mockRejectedValue(new HouseholdActionError('not-owner', 'not an owner'));
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await pressAsync(byLabel(root, 'Delete household'));
      await act(async () => confirmButton(alert, 'Delete').onPress!());
      expect(alert.mock.calls[1].slice(0, 2)).toEqual(["Couldn't delete Smith home", 'Only owners can delete a household.']);
      expect(mockRouter.back).not.toHaveBeenCalled();
      expect(texts(root)).toContain('Smith home');
      expect(allByLabel(root, 'Delete household')).toHaveLength(1);
    });
  });

  describe('Rename household', () => {
    const pencils = (root: ReactTestRenderer) =>
      root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Rename household' && n.props.onPress);
    /** Taps the pencil and returns the prompt's arguments. */
    const openPrompt = async (root: ReactTestRenderer) => {
      const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
      await pressAsync(pencils(root)[0]);
      expect(prompt).toHaveBeenCalledTimes(1);
      return prompt.mock.calls[0];
    };
    const save = async (args: unknown[], text: string) => {
      const save = (args[2] as AlertButton[]).find((b) => b.text === 'Save')!;
      await act(async () => (save.onPress as (t?: string) => void)(text));
    };

    test('an owner sees the pencil, labelled for VoiceOver', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
      const root = await render(<HouseholdScreen />);
      const [pencil] = pencils(root);
      expect(pencil.props.accessibilityRole).toBe('button');
      expect(pencil.props.accessibilityHint).toBe('Asks for a new name.');
      // 12 pt icon padded to a 44 pt tap area.
      expect(pencil.props.hitSlop).toBe(16);
    });

    test('a plain member does not, nor anyone before the members load', async () => {
      const members = deferred<HouseholdMember[]>();
      mockFetchMembers.mockReturnValue(members.promise);
      const root = await render(<HouseholdScreen />);
      expect(pencils(root)).toHaveLength(0);
      await act(async () =>
        members.resolve([member({ userId: USER, firstName: 'John', isYou: true }), member({ userId: 'ann', firstName: 'Ann', role: 'owner' })]),
      );
      expect(pencils(root)).toHaveLength(0);
    });

    test('the prompt is titled, prefilled with the name, and has Cancel and Save', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      const root = await render(<HouseholdScreen />);
      const [title, message, buttons, type, value] = await openPrompt(root);
      expect(title).toBe('Rename household');
      expect(message).toBeUndefined();
      expect((buttons as AlertButton[]).map((b) => [b.text, b.style])).toEqual([
        ['Cancel', 'cancel'],
        ['Save', undefined],
      ]);
      expect(type).toBe('plain-text');
      expect(value).toBe('Smith home');
    });

    test('Save renames with the trimmed name and the user', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockRename.mockResolvedValue();
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await save(await openPrompt(root), '  Cabin ');
      expect(mockRename).toHaveBeenCalledWith(HOME, 'Cabin', USER);
      expect(alert).not.toHaveBeenCalled();
    });

    test.each(['', '   ', undefined])('a blank name (%j) is ignored', async (text) => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      const root = await render(<HouseholdScreen />);
      await save(await openPrompt(root), text as string);
      expect(mockRename).not.toHaveBeenCalled();
    });

    test('offline says so', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      const { HouseholdActionError } = jest.requireActual('../households') as typeof import('../households');
      mockRename.mockRejectedValue(new HouseholdActionError('offline', 'offline'));
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await save(await openPrompt(root), 'Cabin');
      expect(alert).toHaveBeenCalledWith("You're offline", 'Connect to the internet and try again.');
    });

    test('a failure alerts with the reason', async () => {
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
      mockRename.mockRejectedValue({ message: 'household name is too long' });
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = await render(<HouseholdScreen />);
      await save(await openPrompt(root), 'Cabin');
      expect(alert).toHaveBeenCalledWith("Couldn't rename Smith home", 'Use a shorter name (up to 50 characters).');
    });
  });
});

describe('Household settings: Combine English and Spanish names (spec 4.15)', () => {
  const combineSwitch = (root: ReactTestRenderer) =>
    root.root.find((n) => n.props.accessibilityLabel === 'Combine English and Spanish names in Smith home' && n.props.onValueChange);
  const setLocal = (on: boolean) => db.update(households).set({ combineLanguages: on }).where(eq(households.id, HOME)).run();

  beforeEach(() => {
    mockParams.id = HOME;
    mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
  });

  test('a switch for this household, off by default, with its detail', async () => {
    const root = await render(<HouseholdScreen />);
    expect(combineSwitch(root).props.value).toBe(false);
    expect(combineSwitch(root).props.accessibilityHint).toBe('Leche and milk become one item on your lists.');
    setLocal(true);
    await act(async () => tree!.update(<HouseholdScreen />));
    expect(combineSwitch(root).props.value).toBe(true);
  });

  test('shows the new value while the server is asked', async () => {
    const save = deferred<void>();
    mockSetCombine.mockReturnValue(save.promise);
    const root = await render(<HouseholdScreen />);
    act(() => combineSwitch(root).props.onValueChange(true));
    expect(mockSetCombine.mock.calls).toEqual([[HOME, true]]);
    expect(combineSwitch(root).props).toMatchObject({ value: true, disabled: true });
    setLocal(true);
    await act(async () => save.resolve());
    await act(async () => tree!.update(<HouseholdScreen />));
    expect(combineSwitch(root).props).toMatchObject({ value: true, disabled: false });
  });

  test('a failure puts it back and says why', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockSetCombine.mockRejectedValue(new HouseholdActionError('offline', 'offline'));
    const root = await render(<HouseholdScreen />);
    await act(async () => combineSwitch(root).props.onValueChange(true));
    expect(alert).toHaveBeenCalledWith("You're offline", 'Connect to the internet and try again.');
    expect(combineSwitch(root).props).toMatchObject({ value: false, disabled: false });
  });
});

describe('Aisle order row (spec 4.3.3, 4.7)', () => {
  const rerender = async () => {
    await act(async () => tree!.update(<HouseholdScreen />));
  };

  beforeEach(() => {
    mockParams.id = HOME;
    mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
  });

  test('sits under the Household settings card, with its own footnote, for a member too', async () => {
    mockFetchMembers.mockResolvedValue([{ ...ME_OWNER, role: 'member' }, { ...SAM, role: 'owner' }]);
    const root = await render(<HouseholdScreen />);
    const all = texts(root);
    const at = all.indexOf('These change it for everyone in Smith home.');
    expect(all.slice(at + 1, at + 4)).toEqual(['Aisle order', 'Household', 'Shared with the household unless you keep your own.']);
    expect(all.indexOf('Aisle order')).toBeLessThan(all.indexOf('Invite someone'));
  });

  test('says Household with no order saved, and while following a saved household order', async () => {
    const root = await render(<HouseholdScreen />);
    expect(byLabel(root, 'Aisle order').props.value).toBe('Household');
    db.insert(householdCategoryOrder).values({ householdId: HOME, categoryIds: [] }).run();
    await rerender();
    expect(byLabel(root, 'Aisle order').props.value).toBe('Household');
  });

  test('says Your own while the user keeps their own order for this household, and Household again once it goes', async () => {
    db.insert(householdCategoryOrder).values({ householdId: HOME, categoryIds: [] }).run();
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [] }).run();
    const root = await render(<HouseholdScreen />);
    expect(byLabel(root, 'Aisle order').props.value).toBe('Your own');
    db.delete(userHouseholdCategoryOrder).run();
    await rerender();
    expect(byLabel(root, 'Aisle order').props.value).toBe('Household');
  });

  test("another household's own order, or another user's, doesn't count", async () => {
    db.insert(households).values({ id: 'cabin', name: 'Cabin' }).run();
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: 'cabin', categoryIds: [] }).run();
    db.insert(userHouseholdCategoryOrder).values({ userId: 'sam', householdId: HOME, categoryIds: [] }).run();
    const root = await render(<HouseholdScreen />);
    expect(byLabel(root, 'Aisle order').props.value).toBe('Household');
  });

  test('opens the Aisle order screen for this household', async () => {
    const root = await render(<HouseholdScreen />);
    await pressAsync(byLabel(root, 'Aisle order'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/category-order', params: { householdId: HOME } });
  });

  test('follows either order changing, here or pulled', async () => {
    await render(<HouseholdScreen />);
    expect(mockWatched).toEqual(expect.arrayContaining([[userHouseholdCategoryOrder], [householdCategoryOrder]]));
  });
});

describe('Always have', () => {
  const rerender = async (element: React.ReactElement) => {
    await act(async () => tree!.update(element));
  };
  const toolbarButton = (root: ReactTestRenderer, label: string) =>
    byType(root, 'ToolbarButton').find((b) => b.props.children === label);
  const field = (root: ReactTestRenderer) => root.root.findAll((n) => n.props.accessibilityLabel === 'Add an ingredient')[0];
  const type = async (root: ReactTestRenderer, text: string) => {
    await act(async () => field(root).props.onChangeText(text));
  };
  const submit = async (root: ReactTestRenderer) => {
    await act(async () => field(root).props.onSubmitEditing());
  };
  // The outermost element with the label: the Pressable (with `onPress`) or the View (with its accessibility props).
  const byA11y = (root: ReactTestRenderer, label: string) => root.root.findAll((n) => n.props.accessibilityLabel === label)[0];
  const outboxCount = () => db.select().from(outbox).all().length;

  describe('on the household screen', () => {
    beforeEach(() => {
      mockParams.id = HOME;
      mockFetchMembers.mockResolvedValue([ME_OWNER]);
    });

    test('a row with the count ("None" when empty) that opens the Always have screen', async () => {
      const root = await render(<HouseholdScreen />);
      expect(byLabel(root, 'Always have').props.value).toBe('None');
      expect(texts(root)).toContain('None');

      setStaple(HOME, 'salt', true, USER);
      setStaple(HOME, 'pepper', true, USER);
      // Another household's staples don't count.
      db.insert(households).values({ id: 'cabin', name: 'Cabin' }).run();
      setStaple('cabin', 'water', true, USER);
      await rerender(<HouseholdScreen />);
      expect(byLabel(root, 'Always have').props.value).toBe('2');

      await pressAsync(byLabel(root, 'Always have'));
      expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/settings/always-have', params: { household: HOME } });
    });

    test('an unmarked staple no longer counts', async () => {
      setStaple(HOME, 'salt', true, USER);
      setStaple(HOME, 'salt', false, USER);
      const root = await render(<HouseholdScreen />);
      expect(byLabel(root, 'Always have').props.value).toBe('None');
    });
  });

  describe('the screen', () => {
    beforeEach(() => {
      mockParams.household = HOME;
      mockWatched.length = 0;
    });

    test('empty: the message, and no Edit', async () => {
      const root = await render(<AlwaysHaveScreen />);
      expect(texts(root)).toContain('Nothing yet. Ingredients you always have are left off when you add a recipe.');
      expect(toolbarButton(root, 'Edit')).toBeUndefined();
      expect(field(root).props.placeholder).toBe('Add an ingredient');
      expect(field(root).props.accessibilityLabel).toBe('Add an ingredient');
    });

    test("lists the household's staples by display name, in sentence case", async () => {
      db.insert(ingredientUsage)
        .values({ householdId: HOME, ingredientName: 'olive oil', displayName: 'extra virgin olive oil', lastUsedAt: new Date() })
        .run();
      setStaple(HOME, 'salt', true, USER);
      setStaple(HOME, 'olive oil', true, USER);
      setStaple(HOME, 'water', true, USER);
      setStaple(HOME, 'water', false, USER);
      db.insert(households).values({ id: 'cabin', name: 'Cabin' }).run();
      setStaple('cabin', 'garlic', true, USER);
      const root = await render(<AlwaysHaveScreen />);
      const names = ['Extra virgin olive oil', 'Garlic', 'Salt', 'Water'];
      expect(texts(root).filter((t) => names.includes(t))).toEqual(['Extra virgin olive oil', 'Salt']);
      expect(texts(root)).not.toContain('Nothing yet. Ingredients you always have are left off when you add a recipe.');
    });

    test('watches the staples table, so another member\'s change shows without leaving', async () => {
      const root = await render(<AlwaysHaveScreen />);
      expect(mockWatched.some((tables) => tables.includes(householdStaples))).toBe(true);
      // A pull or Realtime writes the row; the live query re-reads it.
      db.insert(householdStaples).values({ householdId: HOME, ingredientName: 'salt', createdBy: 'sam' }).run();
      await rerender(<AlwaysHaveScreen />);
      expect(texts(root)).toContain('Salt');
    });

    test('the field marks a name as typed, amount ignored, and clears', async () => {
      const root = await render(<AlwaysHaveScreen />);
      await type(root, '2 tbsp Olive oils');
      await submit(root);
      expect(isStaple(HOME, 'olive oil')).toBe(true);
      expect(field(root).props.value).toBe('');
      expect(texts(root)).toContain('Olive oil');
    });

    test('adding one already there does nothing', async () => {
      setStaple(HOME, 'salt', true, USER);
      const root = await render(<AlwaysHaveScreen />);
      const start = outboxCount();
      await type(root, 'Salt');
      await submit(root);
      expect(outboxCount()).toBe(start);
      expect(byType(root, 'Swipeable')).toHaveLength(1);
    });

    test('blank text adds nothing', async () => {
      const root = await render(<AlwaysHaveScreen />);
      const start = outboxCount();
      await type(root, '   ');
      await submit(root);
      expect(outboxCount()).toBe(start);
      expect(byType(root, 'Swipeable')).toHaveLength(0);
    });

    test('history and catalog chips, as the add bar; tapping one marks it', async () => {
      db.insert(ingredientUsage)
        .values({ householdId: HOME, ingredientName: 'chicken thighs', displayName: 'chicken thighs', lastUsedAt: new Date() })
        .run();
      db.insert(ingredients)
        .values({
          normalizedName: 'chickpea',
          displayName: 'chickpeas',
          isGroceryItem: true,
        })
        .run();
      const root = await render(<AlwaysHaveScreen />);
      expect(root.root.findAll((n) => n.props.accessibilityLabel === 'Add Chicken thighs')).toHaveLength(0);
      await type(root, '2 chi');
      const history = byA11y(root, 'Add Chicken thighs');
      // Only history can be removed from suggestions.
      expect(history.props.accessibilityHint).toBe('Long press to remove from suggestions');
      expect(byA11y(root, 'Add Chickpeas').props.accessibilityHint).toBeUndefined();
      await pressAsync(history);
      expect(isStaple(HOME, 'chicken thigh')).toBe(true);
      expect(field(root).props.value).toBe('');
    });

    test('swipe left removes with no confirm, "Removed Salt" with Undo brings it back', async () => {
      setStaple(HOME, 'salt', true, USER);
      setStaple(HOME, 'pepper', true, USER);
      const alert = jest.spyOn(Alert, 'alert');
      const root = await render(<AlwaysHaveScreen />);
      const salt = byType(root, 'Swipeable')[1];
      expect(salt.props.enabled).toBe(true);
      await act(async () => salt.props.onSwipeableOpen());
      expect(alert).not.toHaveBeenCalled();
      expect(isStaple(HOME, 'salt')).toBe(false);
      expect(isStaple(HOME, 'pepper')).toBe(true);
      await rerender(<AlwaysHaveScreen />);
      expect(texts(root)).toContain('Removed Salt');
      expect(texts(root)).not.toContain('Salt');
      await pressAsync(byA11y(root, 'Undo'));
      expect(isStaple(HOME, 'salt')).toBe(true);
      expect(texts(root)).not.toContain('Removed Salt');
      expect(texts(root)).toContain('Salt');
    });

    test('Edit shows a delete button per row; Done leaves', async () => {
      setStaple(HOME, 'salt', true, USER);
      setStaple(HOME, 'pepper', true, USER);
      const root = await render(<AlwaysHaveScreen />);
      expect(root.root.findAll((n) => n.props.accessibilityLabel === 'Delete Salt')).toHaveLength(0);
      await pressAsync(toolbarButton(root, 'Edit')!);
      expect(byType(root, 'Swipeable').every((s) => s.props.enabled === false)).toBe(true);
      await pressAsync(byA11y(root, 'Delete Salt'));
      expect(isStaple(HOME, 'salt')).toBe(false);
      expect(texts(root)).toContain('Removed Salt');
      expect(toolbarButton(root, 'Done')).toBeDefined();
      await pressAsync(toolbarButton(root, 'Done')!);
      expect(root.root.findAll((n) => n.props.accessibilityLabel === 'Delete Pepper')).toHaveLength(0);
      expect(toolbarButton(root, 'Edit')).toBeDefined();
    });

    test('removing the last one leaves Edit and shows the empty message', async () => {
      setStaple(HOME, 'salt', true, USER);
      const root = await render(<AlwaysHaveScreen />);
      await pressAsync(toolbarButton(root, 'Edit')!);
      await pressAsync(byA11y(root, 'Delete Salt'));
      expect(texts(root)).toContain('Nothing yet. Ingredients you always have are left off when you add a recipe.');
      expect(toolbarButton(root, 'Edit')).toBeUndefined();
      expect(toolbarButton(root, 'Done')).toBeUndefined();
    });

    test('VoiceOver: each row is a text with a Delete action', async () => {
      setStaple(HOME, 'salt', true, USER);
      const root = await render(<AlwaysHaveScreen />);
      const row = byA11y(root, 'Salt');
      expect(row.props.accessibilityRole).toBe('text');
      expect(row.props.accessibilityActions).toEqual([{ name: 'delete', label: 'Delete' }]);
      await act(async () => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
      expect(isStaple(HOME, 'salt')).toBe(true);
      await act(async () => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } }));
      expect(isStaple(HOME, 'salt')).toBe(false);
      expect(texts(root)).toContain('Removed Salt');
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
      await pressAsync(byType(root, 'ToolbarButton').find((b) => b.props.children === 'Done')!);
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

  test('a join is the moment to offer notifications (spec 4.13)', async () => {
    clearPushMoment();
    mockPreviewInvite.mockResolvedValue(preview());
    mockAcceptInvite.mockResolvedValue({ householdId: HOME, householdName: 'Smith home', alreadyMember: false });
    const root = await render(<JoinHouseholdScreen />);
    await pressAsync(byLabel(root, 'Join'));
    expect(pushMomentPending()).toBe(true);
    clearPushMoment();
  });

  test('joining a household already joined is not a moment to offer notifications', async () => {
    clearPushMoment();
    mockPreviewInvite.mockResolvedValue(preview());
    mockAcceptInvite.mockResolvedValue({ householdId: HOME, householdName: 'Smith home', alreadyMember: true });
    const root = await render(<JoinHouseholdScreen />);
    await pressAsync(byLabel(root, 'Join'));
    expect(pushMomentPending()).toBe(false);
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

// Spec 4.15: the same screens with the app in Spanish.
describe('in Spanish', () => {
  beforeEach(() => initI18n('es'));
  afterEach(() => initI18n('en'));

  test('the household screen: counts, members, roles, the Invited section and its rows', async () => {
    mockParams.id = HOME;
    mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
    mockListInvites.mockResolvedValue([pendingInvite(), pendingInvite({ id: 'inv-2', email: null, invitedBy: null })]);
    const root = await render(<HouseholdScreen />);
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        '0 listas · 1 receta',
        'Miembros',
        'John (Tú)',
        'Dueño',
        'Miembro',
        'Invitados',
        'Enviada por John · vence 17 oct',
        'Enlace de invitación',
        'Enviada · vence 17 oct',
        'Siempre tengo',
        'Ninguno',
        'Orden de pasillos',
        'Del hogar',
        'Se comparte con el hogar, salvo que tengas el tuyo.',
      ]),
    );
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [] }).run();
    await act(async () => tree!.update(<HouseholdScreen />));
    expect(byLabel(root, 'Orden de pasillos').props.value).toBe('El tuyo');
    expect(hasA11y(root, 'Cambiar nombre del hogar')).toBe(true);
    expect(hasA11y(root, 'Sam, Miembro')).toBe(true);
    expect(hasA11y(root, 'pat@example.com, Enviada por John · vence 17 oct, Pendiente')).toBe(true);
    expect(byLabel(root, 'Invitar a alguien')).toBeDefined();
    expect(byLabel(root, 'Eliminar hogar').props.accessibilityHint).toBe(
      'Te pide confirmar y luego elimina este hogar para todos sus miembros.',
    );
    expect(byLabel(root, 'Salir del hogar').props.accessibilityHint).toBe('Te pide confirmar y luego sales de este hogar.');
  });

  test('the household screen: a failed load and Reintentar', async () => {
    mockParams.id = HOME;
    mockFetchMembers.mockRejectedValue(new Error('offline'));
    const root = await render(<HouseholdScreen />);
    expect(texts(root)).toContain('No se pudieron cargar los miembros. Revisa tu conexión.');
    expect(byLabel(root, 'Reintentar')).toBeDefined();
  });

  test('a member row opens the Spanish sheet, and Quitar asks in Spanish', async () => {
    mockParams.id = HOME;
    mockFetchMembers.mockResolvedValue([ME_OWNER, SAM]);
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = await render(<HouseholdScreen />);
    const samRow = byLabel(root, 'Sam');
    expect(samRow.props.accessibilityHint).toBe('Hacer dueño o quitar del hogar.');
    act(() => samRow.props.onPress());
    const [options, onChoose] = sheet.mock.calls[0];
    expect(options.options).toEqual(['Hacer dueño', 'Quitar de Smith home', 'Cancelar']);
    act(() => onChoose(1));
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe('¿Quitar a Sam?');
    expect(message).toBe('Ya no tendrá acceso a las listas y recetas de Smith home.');
    expect((buttons as AlertButton[]).map((b) => b.text)).toEqual(['Cancelar', 'Quitar']);
  });

  test('the invite sheet: both steps', async () => {
    mockParams.household = HOME;
    mockCreateInvite.mockResolvedValue('perfectbite://invite/abc');
    const root = await render(<HouseholdInviteSheet />);
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        'Invitar a Smith home',
        'Compartirá sus listas y recetas. Sus otros hogares no cambian.',
        'Usa el correo con el que inicia sesión (su cuenta de Google).',
      ]),
    );
    const field = root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Su correo');
    expect(field.props.placeholder).toBe('nombre@ejemplo.com');
    expect(byLabel(root, '¿No sabes su correo? Mejor comparte un enlace')).toBeDefined();
    const next = () => byType(root, 'ToolbarButton').find((n) => n.props.children === 'Siguiente')!;
    act(() => field.props.onChangeText('pat@example.com'));
    await act(async () => {
      await next().props.onPress();
    });
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        'Avísale a Pat',
        'La invitación vence en 7 días',
        'Envíala por',
        'Mensajes',
        'Copiar enlace',
        'Más…',
        'También puedes saltarte esto. Si Pat inicia sesión con este correo, verá la invitación en la app.',
      ]),
    );
    expect(byType(root, 'ToolbarButton').some((b) => b.props.children === 'Listo')).toBe(true);
  });

  test('the join screen: a valid invite, and one that can no longer be used', async () => {
    mockParams.token = TOKEN;
    mockPreviewInvite.mockResolvedValue({ householdId: HOME, householdName: 'Smith home', invitedBy: 'John', status: 'valid' });
    const root = await render(<JoinHouseholdScreen />);
    expect(texts(root)).toEqual([
      '¿Unirte a Smith home?',
      'Te invitó John',
      'Compartirás sus listas y recetas. Tus otros hogares no cambian.',
      'Unirme',
      'Ahora no',
    ]);
    act(() => tree?.unmount());
    mockPreviewInvite.mockReset().mockRejectedValue(new InviteError('expired', 'invite expired'));
    const expired = await render(<JoinHouseholdScreen />);
    expect(texts(expired)).toEqual(['No puedes unirte', 'Esta invitación ya venció. Pide una nueva.', 'Cerrar']);
  });

  test('the invite row', async () => {
    const invite: MyInvite = { id: 'i1', householdId: HOME, householdName: 'Smith household', invitedBy: 'John', memberCount: 1 };
    const root = await render(<InviteRow invite={invite} busy={null} onJoin={() => {}} onDecline={() => {}} />);
    expect(texts(root)).toEqual(['J', 'John te invitó', 'a Smith household · 1 miembro', 'Unirme']);
    expect(hasA11y(root, 'John te invitó a Smith household')).toBe(true);
    expect(hasA11y(root, 'Rechazar la invitación a Smith household')).toBe(true);
    expect(hasA11y(root, 'Unirme')).toBe(true);
  });

  test('Always have: the field, the empty state, and the removed toast', async () => {
    mockParams.household = HOME;
    const root = await render(<AlwaysHaveScreen />);
    const field = root.root.find((n) => String(n.type) === 'TextInput');
    expect(field.props.placeholder).toBe('Agrega un ingrediente');
    expect(field.props.accessibilityLabel).toBe('Agrega un ingrediente');
    expect(texts(root)).toContain('Nada todavía. Los ingredientes que siempre tienes se omiten al agregar una receta.');
  });
});
