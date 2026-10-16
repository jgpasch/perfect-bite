// "Alex is adding" (spec 4.1, 7.2): who's adding from a list's presence state, the header pill's
// text, the throttle, the 10 s tail, and joining and leaving the list's channel (screen,
// background, offline).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { NetworkState } from 'expo-network';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { initI18n } from '@/i18n';
import { openChannels, realtimeChannels, resetSupabase, setChannelStatus, setPresence, setSupabaseConfigured, supabase, type FakeChannel } from '@/test/fake-supabase';

import {
  ADDING_TAIL_MS,
  addingPillText,
  createThrottle,
  joinListPresence,
  othersAdding,
  presenceTopic,
  PRESENCE_THROTTLE_MS,
  useAddingTail,
  useListPresence,
} from '../presence';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'me' }) }));

const mockNetwork: { listener: ((s: NetworkState) => void) | null } = { listener: null };
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: (s: NetworkState) => void) => {
    mockNetwork.listener = listener;
    return { remove: () => (mockNetwork.listener = null) };
  },
}));

const ME = 'me';
const ALEX = 'alex';
const SAM = 'sam';
const JO = 'jo';
const NAMES = new Map([
  [ALEX, 'Alex'],
  [SAM, 'Sam'],
  [JO, 'Jo'],
]);
const LIST = 'list-1';

/** Lets the leave promise chain (removeChannel, then the queued join) run. */
const flush = () => act(async () => {});

beforeEach(() => {
  resetSupabase();
  jest.useFakeTimers({ now: new Date('2026-10-16T12:00:00Z') });
});
afterEach(() => {
  jest.useRealTimers();
  initI18n('en');
});

describe('othersAdding', () => {
  test('the members adding, each once, in order, never me', () => {
    const state = {
      k1: [{ user_id: ALEX, adding: true }],
      k2: [{ user_id: ME, adding: true }],
      k3: [{ user_id: SAM, adding: false }],
      k4: [
        { user_id: JO, adding: true },
        { user_id: ALEX, adding: true },
      ],
    };
    expect(othersAdding(state, ME)).toEqual([ALEX, JO]);
  });

  test('one person on two devices counts if either is adding', () => {
    expect(othersAdding({ alex: [{ user_id: ALEX, adding: false }, { user_id: ALEX, adding: true }] }, ME)).toEqual([ALEX]);
  });

  test('my own presence on another device is ignored', () => {
    expect(othersAdding({ me: [{ user_id: ME, adding: true }, { user_id: ME, adding: true }] }, ME)).toEqual([]);
  });

  test('nobody, someone only looking, and malformed entries', () => {
    expect(othersAdding({}, ME)).toEqual([]);
    expect(othersAdding({ alex: [{ user_id: ALEX, adding: false }] }, ME)).toEqual([]);
    expect(othersAdding({ x: [{ adding: true }, { user_id: 7, adding: true }, { user_id: SAM, adding: 'yes' }] }, ME)).toEqual([]);
  });

  test('signed out (no me) still lists everyone adding', () => {
    expect(othersAdding({ alex: [{ user_id: ALEX, adding: true }] }, null)).toEqual([ALEX]);
  });
});

describe('the pill text', () => {
  test('one, two, and three or more people', () => {
    expect(addingPillText([ALEX], NAMES, ME)).toBe('Alex is adding');
    expect(addingPillText([ALEX, SAM], NAMES, ME)).toBe('Alex and Sam are adding');
    expect(addingPillText([ALEX, SAM, JO], NAMES, ME)).toBe('3 people are adding');
    expect(addingPillText([ALEX, SAM, JO, 'x'], NAMES, ME)).toBe('4 people are adding');
  });

  test('no one adding, no pill; a name not on the device is Someone', () => {
    expect(addingPillText([], NAMES, ME)).toBeNull();
    expect(addingPillText(['gone'], NAMES, ME)).toBe('Someone is adding');
  });

  test('in Spanish', () => {
    initI18n('es');
    expect(addingPillText([ALEX], NAMES, ME)).toBe('Alex está agregando');
    expect(addingPillText([ALEX, SAM], NAMES, ME)).toBe('Alex y Sam están agregando');
    expect(addingPillText([ALEX, SAM, JO], NAMES, ME)).toBe('3 personas están agregando');
  });
});

describe('createThrottle', () => {
  test('the first value goes at once, then at most one a second, the latest at the end of the window', () => {
    const sent: number[] = [];
    const throttle = createThrottle<number>((v) => sent.push(v));
    throttle.push(1);
    expect(sent).toEqual([1]);
    throttle.push(2);
    throttle.push(3);
    expect(sent).toEqual([1]);
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS - 1);
    expect(sent).toEqual([1]);
    jest.advanceTimersByTime(1);
    expect(sent).toEqual([1, 3]);
    // The window starts again from that send.
    throttle.push(4);
    expect(sent).toEqual([1, 3]);
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(sent).toEqual([1, 3, 4]);
  });

  test('after a quiet second the next value goes at once', () => {
    const sent: boolean[] = [];
    const throttle = createThrottle<boolean>((v) => sent.push(v));
    throttle.push(true);
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS + 500);
    throttle.push(false);
    expect(sent).toEqual([true, false]);
  });

  test('cancel drops what is waiting', () => {
    const sent: number[] = [];
    const throttle = createThrottle<number>((v) => sent.push(v));
    throttle.push(1);
    throttle.push(2);
    throttle.cancel();
    jest.advanceTimersByTime(5000);
    expect(sent).toEqual([1]);
  });
});

describe('joinListPresence', () => {
  const only = (): FakeChannel => {
    expect(openChannels()).toHaveLength(1);
    return openChannels()[0];
  };

  test('joins the list\'s private topic, with presence keyed by the user', () => {
    joinListPresence(LIST, ME, false, () => {});
    const ch = only();
    expect(ch.name).toBe('list:list-1');
    expect(presenceTopic(LIST)).toBe('list:list-1');
    expect(ch.opts).toEqual({ config: { private: true, presence: { key: ME, enabled: true } } });
  });

  test('tracks { user_id, adding } once subscribed, and nothing before', () => {
    const session = joinListPresence(LIST, ME, true, () => {});
    const ch = only();
    session.setAdding(false);
    session.setAdding(true);
    expect(ch.tracked).toEqual([]);
    setChannelStatus('SUBSCRIBED', ch);
    expect(ch.tracked).toEqual([{ user_id: ME, adding: true }]);
  });

  test('only who and whether: never what is typed', () => {
    const session = joinListPresence(LIST, ME, false, () => {});
    const ch = only();
    setChannelStatus('SUBSCRIBED', ch);
    session.setAdding(true);
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    for (const payload of ch.tracked) expect(Object.keys(payload).sort()).toEqual(['adding', 'user_id']);
  });

  test('changes are throttled to one a second, the latest winning', () => {
    const session = joinListPresence(LIST, ME, false, () => {});
    const ch = only();
    setChannelStatus('SUBSCRIBED', ch);
    expect(ch.tracked.map((p) => p.adding)).toEqual([false]);
    session.setAdding(true);
    session.setAdding(false);
    session.setAdding(true);
    expect(ch.tracked.map((p) => p.adding)).toEqual([false]);
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(ch.tracked.map((p) => p.adding)).toEqual([false, true]);
    // The same value again sends nothing.
    session.setAdding(true);
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS * 3);
    expect(ch.tracked.map((p) => p.adding)).toEqual([false, true]);
  });

  test('tracks again after a rejoin, since the server forgot this device', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    joinListPresence(LIST, ME, true, () => {});
    const ch = only();
    setChannelStatus('SUBSCRIBED', ch);
    setChannelStatus('CHANNEL_ERROR', ch);
    expect(warn).toHaveBeenCalledWith('[presence] list:list-1: CHANNEL_ERROR', undefined);
    warn.mockRestore();
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    setChannelStatus('SUBSCRIBED', ch);
    expect(ch.tracked).toEqual([
      { user_id: ME, adding: true },
      { user_id: ME, adding: true },
    ]);
  });

  test('reports the other members adding on each sync, not me', () => {
    const seen: string[][] = [];
    joinListPresence(LIST, ME, false, (ids) => seen.push(ids));
    const ch = only();
    setPresence(ch, { alex: [{ user_id: ALEX, adding: true }], me: [{ user_id: ME, adding: true }] });
    setPresence(ch, { alex: [{ user_id: ALEX, adding: true }], sam: [{ user_id: SAM, adding: true }] });
    setPresence(ch, {});
    expect(seen).toEqual([[ALEX], [ALEX, SAM], []]);
  });

  test('leaving removes the channel and stops everything', () => {
    const seen: string[][] = [];
    const session = joinListPresence(LIST, ME, false, (ids) => seen.push(ids));
    const ch = only();
    setChannelStatus('SUBSCRIBED', ch);
    session.setAdding(true);
    session.leave();
    expect(supabase.removeChannel).toHaveBeenCalledWith(ch);
    expect(openChannels()).toEqual([]);
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS * 2);
    expect(ch.tracked).toEqual([{ user_id: ME, adding: false }]);
    setPresence(ch, { alex: [{ user_id: ALEX, adding: true }] });
    expect(seen).toEqual([]);
    session.leave();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  test('joining again waits for the last leave of that topic to finish', async () => {
    let finish: (v: string) => void = () => {};
    supabase.removeChannel.mockImplementationOnce((ch: FakeChannel) => {
      ch.removed = true;
      return new Promise<string>((resolve) => (finish = resolve));
    });
    joinListPresence(LIST, ME, false, () => {}).leave();
    joinListPresence(LIST, ME, false, () => {});
    expect(realtimeChannels).toHaveLength(1);
    finish('ok');
    await flush();
    expect(realtimeChannels).toHaveLength(2);
    expect(openChannels()).toHaveLength(1);
  });

  test('leaving before the wait is over never joins', async () => {
    let finish: (v: string) => void = () => {};
    supabase.removeChannel.mockImplementationOnce((ch: FakeChannel) => {
      ch.removed = true;
      return new Promise<string>((resolve) => (finish = resolve));
    });
    joinListPresence(LIST, ME, false, () => {}).leave();
    joinListPresence(LIST, ME, false, () => {}).leave();
    finish('ok');
    await flush();
    expect(realtimeChannels).toHaveLength(1);
  });
});

// --- The hooks, through a probe component ----------------------------------------------

const presenceRef: { current: string[] } = { current: [] };
const seePresence = (value: string[]) => {
  presenceRef.current = value;
};
function PresenceProbe({
  listId,
  watching,
  userId,
  adding,
  see,
}: {
  listId: string;
  watching: boolean;
  userId: string | null;
  adding: boolean;
  see: (value: string[]) => void;
}) {
  see(useListPresence(listId, watching, userId, adding));
  return null;
}

describe('useListPresence', () => {
  let tree: ReactTestRenderer;
  const render = (props: { listId?: string; watching?: boolean; userId?: string | null; adding?: boolean }) => {
    const element = <PresenceProbe listId={LIST} watching userId={ME} adding={false} see={seePresence} {...props} />;
    act(() => {
      if (tree) tree.update(element);
      else tree = create(element);
    });
  };
  const online = (connected: boolean) => act(() => mockNetwork.listener?.({ isConnected: connected, isInternetReachable: connected } as NetworkState));
  beforeEach(() => {
    presenceRef.current = [];
    tree = undefined as unknown as ReactTestRenderer;
  });
  afterEach(() => {
    act(() => tree?.unmount());
  });

  test('while the list is on screen and in the foreground, joins and shows who else is adding', () => {
    render({});
    expect(openChannels().map((c) => c.name)).toEqual(['list:list-1']);
    const ch = openChannels()[0];
    act(() => setChannelStatus('SUBSCRIBED', ch));
    expect(ch.tracked).toEqual([{ user_id: ME, adding: false }]);
    act(() => setPresence(ch, { alex: [{ user_id: ALEX, adding: true }], me: [{ user_id: ME, adding: true }] }));
    expect(presenceRef.current).toEqual([ALEX]);
  });

  test('tracks the add field\'s state as it changes', () => {
    render({});
    const ch = openChannels()[0];
    act(() => setChannelStatus('SUBSCRIBED', ch));
    render({ adding: true });
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    render({ adding: false });
    jest.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(ch.tracked.map((p) => p.adding)).toEqual([false, true, false]);
  });

  test('leaving the list (or the app going to the background) leaves the channel and clears the pill', () => {
    render({});
    const ch = openChannels()[0];
    act(() => setPresence(ch, { alex: [{ user_id: ALEX, adding: true }] }));
    expect(presenceRef.current).toEqual([ALEX]);
    render({ watching: false });
    expect(ch.removed).toBe(true);
    expect(openChannels()).toEqual([]);
    expect(presenceRef.current).toEqual([]);
  });

  test('coming back joins again', async () => {
    render({});
    render({ watching: false });
    await flush();
    render({ watching: true });
    expect(realtimeChannels).toHaveLength(2);
    expect(openChannels()).toHaveLength(1);
  });

  test('another list leaves the old topic and joins the new one', async () => {
    render({});
    render({ listId: 'list-2' });
    await flush();
    expect(openChannels().map((c) => c.name)).toEqual(['list:list-2']);
  });

  test('offline leaves; back online joins again', async () => {
    render({});
    online(false);
    expect(openChannels()).toEqual([]);
    expect(presenceRef.current).toEqual([]);
    await flush();
    online(true);
    expect(openChannels().map((c) => c.name)).toEqual(['list:list-1']);
  });

  test('offline from the start never joins', () => {
    render({ watching: false });
    online(false);
    render({ watching: true });
    expect(realtimeChannels).toEqual([]);
  });

  test('signed out, or Supabase not configured: no channel', () => {
    render({ userId: null });
    expect(realtimeChannels).toEqual([]);
    act(() => tree.unmount());
    tree = undefined as unknown as ReactTestRenderer;
    setSupabaseConfigured(false);
    render({});
    expect(realtimeChannels).toEqual([]);
  });

  test('unmounting leaves', () => {
    render({});
    const ch = openChannels()[0];
    act(() => tree.unmount());
    tree = undefined as unknown as ReactTestRenderer;
    expect(ch.removed).toBe(true);
  });
});

const tailRef: { current: { adding: boolean; noteAdd: () => void } } = { current: { adding: false, noteAdd: () => {} } };
const seeTail = (value: typeof tailRef.current) => {
  tailRef.current = value;
};
function TailProbe({ focused, see }: { focused: boolean; see: typeof seeTail }) {
  see(useAddingTail(focused));
  return null;
}

describe('useAddingTail', () => {
  let tree: ReactTestRenderer;
  const render = (focused: boolean) =>
    act(() => {
      if (tree) tree.update(<TailProbe focused={focused} see={seeTail} />);
      else tree = create(<TailProbe focused={focused} see={seeTail} />);
    });
  beforeEach(() => {
    tree = undefined as unknown as ReactTestRenderer;
  });
  afterEach(() => {
    act(() => tree?.unmount());
  });

  test('adding while the field is focused, not otherwise', () => {
    render(false);
    expect(tailRef.current.adding).toBe(false);
    render(true);
    expect(tailRef.current.adding).toBe(true);
    render(false);
    expect(tailRef.current.adding).toBe(false);
  });

  test('still adding for 10 s after the last add, once the field is left', () => {
    render(true);
    act(() => tailRef.current.noteAdd());
    render(false);
    expect(tailRef.current.adding).toBe(true);
    act(() => jest.advanceTimersByTime(ADDING_TAIL_MS - 1));
    expect(tailRef.current.adding).toBe(true);
    act(() => jest.advanceTimersByTime(1));
    expect(tailRef.current.adding).toBe(false);
  });

  test('another add starts the 10 s again', () => {
    render(false);
    act(() => tailRef.current.noteAdd());
    act(() => jest.advanceTimersByTime(ADDING_TAIL_MS - 1000));
    act(() => tailRef.current.noteAdd());
    act(() => jest.advanceTimersByTime(ADDING_TAIL_MS - 1));
    expect(tailRef.current.adding).toBe(true);
    act(() => jest.advanceTimersByTime(1));
    expect(tailRef.current.adding).toBe(false);
  });
});
