import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { db, households } from '@/db';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';
import { respondToRpc, resetSupabase, rpcCallsFor, setSupabaseConfigured } from '@/test/fake-supabase';

import {
  DEFAULT_FEATURES,
  FEATURES,
  getHouseholdFeatures,
  hasAnyHouseholdFeature,
  hasFeature,
  onFeaturesChange,
  parseHouseholdFeatures,
  setHouseholdFeatures,
  useAnyHouseholdFeature,
  useFeature,
} from '../features';
import { clearFeatures, FEATURES_KEY, lostFeature, membershipsRead, refreshFeatures, startFeatures } from '../load';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

// The foreground/reconnect triggers, captured so tests can fire them.
const mockTriggers: { onCatchUp?: () => void; onNetwork?: (online: boolean) => void; stopped: number } = { stopped: 0 };
jest.mock('@/features/categories/catch-up', () => ({
  startCatchUpTriggers: (onCatchUp: () => void, onNetwork?: (online: boolean) => void) => {
    mockTriggers.onCatchUp = onCatchUp;
    mockTriggers.onNetwork = onNetwork;
    return () => void mockTriggers.stopped++;
  },
}));

// The local households table's change listener, for useAnyHouseholdFeature's live query.
type ChangeListener = (event: { tableName: string }) => void;
const mockChangeListeners = new Set<ChangeListener>();
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (l: ChangeListener) => {
    mockChangeListeners.add(l);
    return { remove: () => mockChangeListeners.delete(l) };
  },
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const HOME = '11111111-1111-4111-8111-111111111111';
const CABIN = '22222222-2222-4222-8222-222222222222';
const NEW = '33333333-3333-4333-8333-333333333333';

let warn: ReturnType<typeof jest.spyOn>;
let stop: (() => void) | null = null;

beforeEach(() => {
  resetDb();
  resetSupabase();
  clearFeatures();
  mockTriggers.onCatchUp = undefined;
  mockTriggers.onNetwork = undefined;
  mockTriggers.stopped = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stop?.();
  stop = null;
  warn.mockRestore();
});

const answer = (households: Record<string, string[]>) => ({ households });

/** Renders `hook` in a probe component; `result.current` is its last value. */
function renderHook<P extends object>(hook: (props: P) => boolean, { initialProps }: { initialProps: P }) {
  const result: { current?: boolean } = {};
  function Probe(props: P) {
    result.current = hook(props);
    return null;
  }
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(Probe, initialProps));
  });
  renderers.push(renderer!);
  return { result, rerender: (props: P) => act(() => renderer.update(createElement(Probe, props))) };
}
const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  for (const r of renderers.splice(0)) act(() => r.unmount());
});

async function start(userId: string, ...answers: unknown[]) {
  for (const data of answers) respondToRpc('my_household_features', { data });
  stop = startFeatures(userId);
  await flush();
}

describe('before the first load', () => {
  test('assumes the default plan, founding: both features, for any household', () => {
    expect(FEATURES).toEqual(['recipe_import', 'recipe_photo_ai']);
    expect(DEFAULT_FEATURES).toEqual(['recipe_import', 'recipe_photo_ai']);
    expect(getHouseholdFeatures()).toBeNull();
    for (const feature of FEATURES) expect(hasFeature(feature, HOME)).toBe(true);
  });

  test('starting with no cache and a failing load keeps the default', async () => {
    respondToRpc('my_household_features', { data: null, error: { message: 'boom' } });
    stop = startFeatures('u1');
    await flush();
    expect(rpcCallsFor('my_household_features')).toHaveLength(1);
    expect(getHouseholdFeatures()).toBeNull();
    expect(hasFeature('recipe_import', HOME)).toBe(true);
  });
});

describe('loading', () => {
  test('loads on sign-in, calling my_household_features', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'], [CABIN]: [] }));
    expect(rpcCallsFor('my_household_features')).toEqual([{ fn: 'my_household_features', args: undefined }]);
    expect(getHouseholdFeatures()).toEqual({ [HOME]: ['recipe_import'], [CABIN]: [] });
  });

  test('answers per household', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import', 'recipe_photo_ai'], [CABIN]: ['recipe_photo_ai'] }));
    expect(hasFeature('recipe_import', HOME)).toBe(true);
    expect(hasFeature('recipe_photo_ai', HOME)).toBe(true);
    expect(hasFeature('recipe_import', CABIN)).toBe(false);
    expect(hasFeature('recipe_photo_ai', CABIN)).toBe(true);
  });

  test("a household the answer doesn't have yet assumes the default plan", async () => {
    await start('u1', answer({ [HOME]: [] }));
    expect(hasFeature('recipe_import', HOME)).toBe(false);
    expect(hasFeature('recipe_import', NEW)).toBe(true);
    expect(hasFeature('recipe_photo_ai', NEW)).toBe(true);
  });

  test('loads again on each foreground and reconnect', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    respondToRpc('my_household_features', { data: answer({ [HOME]: [] }) });
    mockTriggers.onCatchUp!();
    await flush();
    expect(rpcCallsFor('my_household_features')).toHaveLength(2);
    expect(hasFeature('recipe_import', HOME)).toBe(false);

    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'] }) });
    mockTriggers.onNetwork!(true);
    mockTriggers.onCatchUp!();
    await flush();
    expect(rpcCallsFor('my_household_features')).toHaveLength(3);
    expect(hasFeature('recipe_import', HOME)).toBe(true);
  });

  test('sorts each list, drops duplicates and unknown keys, including the old ones', async () => {
    await start('u1', answer({ [HOME]: ['recipe_photo_ai', 'categorize', 'recipe_import', 'recipe_import', 'recipe_import_photo'] }));
    expect(getHouseholdFeatures()).toEqual({ [HOME]: ['recipe_import', 'recipe_photo_ai'] });
  });

  test('saves each answer in device settings for the user', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'], [CABIN]: [] }));
    expect(getDeviceSetting(FEATURES_KEY, null)).toEqual({
      userId: 'u1',
      households: { [HOME]: ['recipe_import'], [CABIN]: [] },
    });
  });

  test.each([
    ['a plain list (the old my_features shape)', ['recipe_import']],
    ['a string', 'founding'],
    ['a household that is not a list', { households: { [HOME]: 'recipe_import' } }],
    ['a list with a non-string', { households: { [HOME]: ['recipe_import', 1] } }],
    ['households as a list', { households: [] }],
  ])('a malformed answer (%s) changes nothing', async (_name, data) => {
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    respondToRpc('my_household_features', { data });
    await refreshFeatures();
    expect(getHouseholdFeatures()).toEqual({ [HOME]: ['recipe_import'] });
    expect(warn).toHaveBeenCalled();
  });

  test('without Supabase configured nothing is asked', async () => {
    setSupabaseConfigured(false);
    await start('u1');
    expect(rpcCallsFor('my_household_features')).toEqual([]);
    expect(getHouseholdFeatures()).toBeNull();
  });

  test('tells listeners only when the answer changes', async () => {
    const listener = jest.fn();
    const off = onFeaturesChange(listener);
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    expect(listener).toHaveBeenCalledTimes(1);
    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'] }) });
    await refreshFeatures();
    expect(listener).toHaveBeenCalledTimes(1);
    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'], [CABIN]: [] }) });
    await refreshFeatures();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('membership changes (membershipsRead, from a full pull)', () => {
  test('a household the answer lacks (joined, or made) reloads', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'], [NEW]: [] }) });
    await membershipsRead([HOME, NEW]);
    expect(rpcCallsFor('my_household_features')).toHaveLength(2);
    expect(hasFeature('recipe_import', NEW)).toBe(false);
  });

  test('a household the answer has and the pull lacks (left or deleted) reloads', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'], [CABIN]: [] }));
    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'] }) });
    await membershipsRead([HOME]);
    expect(rpcCallsFor('my_household_features')).toHaveLength(2);
    expect(getHouseholdFeatures()).toEqual({ [HOME]: ['recipe_import'] });
  });

  test('the same households, in any order, reload nothing', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'], [CABIN]: [] }));
    await membershipsRead([CABIN, HOME]);
    expect(rpcCallsFor('my_household_features')).toHaveLength(1);
  });

  test('before the first answer, nothing (that load is on its way)', async () => {
    await start('u1', undefined);
    await membershipsRead([HOME]);
    expect(rpcCallsFor('my_household_features')).toHaveLength(1);
  });
});

describe('offline', () => {
  test('an offline launch uses the cached answer', async () => {
    setDeviceSetting(FEATURES_KEY, { userId: 'u1', households: { [HOME]: [] } });
    stop = startFeatures('u1');
    mockTriggers.onNetwork!(false);
    // The load started at once fails (no network); the cached value stays.
    respondToRpc('my_household_features', { data: null, error: { message: 'Network request failed' } });
    await flush();
    expect(getHouseholdFeatures()).toEqual({ [HOME]: [] });
    expect(hasFeature('recipe_import', HOME)).toBe(false);
  });

  test('while offline, foregrounds ask nothing and keep the cached value', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    mockTriggers.onNetwork!(false);
    mockTriggers.onCatchUp!();
    await refreshFeatures();
    expect(rpcCallsFor('my_household_features')).toHaveLength(1);
    expect(getHouseholdFeatures()).toEqual({ [HOME]: ['recipe_import'] });
  });

  test("another user's cached answer isn't used", async () => {
    setDeviceSetting(FEATURES_KEY, { userId: 'u2', households: { [HOME]: [] } });
    // The load fails, so only the cache could have changed the default.
    await start('u1', undefined);
    expect(getHouseholdFeatures()).toBeNull();
    expect(hasFeature('recipe_import', HOME)).toBe(true);
  });

  test('a cached answer in the old shape (one list for the user) is ignored', async () => {
    setDeviceSetting(FEATURES_KEY, { userId: 'u1', features: [] });
    await start('u1', undefined);
    expect(getHouseholdFeatures()).toBeNull();
    expect(hasFeature('recipe_import', HOME)).toBe(true);
  });
});

describe('sign-out', () => {
  test('clears the store and the cache, back to the default', async () => {
    await start('u1', answer({ [HOME]: [] }));
    clearFeatures();
    expect(getHouseholdFeatures()).toBeNull();
    expect(hasFeature('recipe_import', HOME)).toBe(true);
    expect(getDeviceSetting(FEATURES_KEY, null)).toBeNull();
  });

  test("a load that finishes after sign-out doesn't bring the features back", async () => {
    await start('u1', answer({ [HOME]: [] }));
    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'] }) });
    const late = refreshFeatures();
    clearFeatures();
    await late;
    expect(getHouseholdFeatures()).toBeNull();
    expect(getDeviceSetting(FEATURES_KEY, null)).toBeNull();
  });

  test('signed out, nothing is loaded', async () => {
    await refreshFeatures();
    expect(rpcCallsFor('my_household_features')).toEqual([]);
  });

  test('the cleanup stops the triggers', async () => {
    await start('u1', answer({ [HOME]: [] }));
    stop!();
    stop = null;
    expect(mockTriggers.stopped).toBe(1);
  });
});

describe('lostFeature (a not_entitled answer)', () => {
  test('drops the feature for that household only, at once, saves it and reloads', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import', 'recipe_photo_ai'], [CABIN]: ['recipe_import'] }));
    respondToRpc('my_household_features', { data: null, error: { message: 'Network request failed' } });
    const done = lostFeature('recipe_import', HOME);
    expect(hasFeature('recipe_import', HOME)).toBe(false);
    expect(hasFeature('recipe_photo_ai', HOME)).toBe(true);
    expect(hasFeature('recipe_import', CABIN)).toBe(true);
    expect(getDeviceSetting(FEATURES_KEY, null)).toEqual({
      userId: 'u1',
      households: { [HOME]: ['recipe_photo_ai'], [CABIN]: ['recipe_import'] },
    });
    await done;
    expect(rpcCallsFor('my_household_features')).toHaveLength(2);
  });

  test("a household the answer doesn't have yet loses it from the default", async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    respondToRpc('my_household_features', { data: null, error: { message: 'Network request failed' } });
    await lostFeature('recipe_photo_ai', NEW);
    expect(hasFeature('recipe_photo_ai', NEW)).toBe(false);
    expect(hasFeature('recipe_import', NEW)).toBe(true);
    expect(hasFeature('recipe_import', HOME)).toBe(true);
  });

  test('the reload has the last word', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'] }) });
    await lostFeature('recipe_import', HOME);
    expect(hasFeature('recipe_import', HOME)).toBe(true);
  });

  test('with no household, only reloads', async () => {
    await start('u1', answer({ [HOME]: ['recipe_import'] }));
    respondToRpc('my_household_features', { data: answer({ [HOME]: ['recipe_import'] }) });
    await lostFeature('recipe_import', undefined);
    expect(rpcCallsFor('my_household_features')).toHaveLength(2);
    expect(getHouseholdFeatures()).toEqual({ [HOME]: ['recipe_import'] });
  });

  test('signed out, changes nothing', async () => {
    await lostFeature('recipe_import', HOME);
    expect(getHouseholdFeatures()).toBeNull();
    expect(rpcCallsFor('my_household_features')).toEqual([]);
  });
});

describe('hasAnyHouseholdFeature', () => {
  test('with no households known, the default plan', () => {
    expect(hasAnyHouseholdFeature('recipe_import', [])).toBe(true);
  });

  test("any of the answer's households", () => {
    setHouseholdFeatures({ [HOME]: [], [CABIN]: ['recipe_import'] });
    expect(hasAnyHouseholdFeature('recipe_import', [])).toBe(true);
    expect(hasAnyHouseholdFeature('recipe_photo_ai', [])).toBe(false);
    setHouseholdFeatures({ [HOME]: [], [CABIN]: [] });
    expect(hasAnyHouseholdFeature('recipe_import', [HOME, CABIN])).toBe(false);
  });

  test("a device household the answer doesn't have yet counts as the default plan", () => {
    setHouseholdFeatures({ [HOME]: [] });
    expect(hasAnyHouseholdFeature('recipe_import', [HOME])).toBe(false);
    expect(hasAnyHouseholdFeature('recipe_import', [HOME, NEW])).toBe(true);
  });
});

describe('hooks', () => {
  test('useFeature follows the household and the answer', () => {
    setHouseholdFeatures({ [HOME]: ['recipe_import'], [CABIN]: [] });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useFeature('recipe_import', id), {
      initialProps: { id: HOME },
    });
    expect(result.current).toBe(true);
    rerender({ id: CABIN });
    expect(result.current).toBe(false);
    act(() => setHouseholdFeatures({ [HOME]: ['recipe_import'], [CABIN]: ['recipe_import'] }));
    expect(result.current).toBe(true);
  });

  test("useAnyHouseholdFeature reads the device's households", async () => {
    setHouseholdFeatures({ [HOME]: [] });
    db.insert(households).values({ id: HOME, name: 'Home' }).run();
    const { result } = renderHook(() => useAnyHouseholdFeature('recipe_import'), { initialProps: {} });
    await act(async () => {
      await flush();
    });
    expect(result.current).toBe(false);
    // A household just made on the device isn't in the answer yet: the default plan.
    db.insert(households).values({ id: NEW, name: 'New' }).run();
    await act(async () => {
      for (const l of [...mockChangeListeners]) l({ tableName: 'households' });
      await flush();
    });
    expect(result.current).toBe(true);
  });
});

describe('parseHouseholdFeatures', () => {
  test('keeps known keys per household; rejects any other shape', () => {
    expect(parseHouseholdFeatures({ households: { [HOME]: ['recipe_import', 'x'] } })).toEqual({ [HOME]: ['recipe_import'] });
    expect(parseHouseholdFeatures({ households: {} })).toEqual({});
    expect(parseHouseholdFeatures(null)).toBeNull();
    expect(parseHouseholdFeatures(['recipe_import'])).toBeNull();
    expect(parseHouseholdFeatures({ households: null })).toBeNull();
    expect(parseHouseholdFeatures({ households: { [HOME]: [1] } })).toBeNull();
  });
});
