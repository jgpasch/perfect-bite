import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';
import { respondToRpc, resetSupabase, rpcCallsFor, setSupabaseConfigured } from '@/test/fake-supabase';

import { DEFAULT_FEATURES, FEATURES, getFeatures, hasFeature, onFeaturesChange, parseFeatures } from '../features';
import { clearFeatures, FEATURES_KEY, lostFeature, refreshFeatures, startFeatures } from '../load';

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

const flush = () => new Promise((resolve) => setImmediate(resolve));

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

async function start(userId: string, ...answers: unknown[]) {
  for (const data of answers) respondToRpc('my_features', { data });
  stop = startFeatures(userId);
  await flush();
}

describe('before the first load', () => {
  test('assumes the default plan, founding: every feature', () => {
    const founding = [
      'categorize',
      'recipe_import',
      'recipe_import_photo',
      'recipe_photo_ai',
      'recipe_tags',
      'step_ingredients',
    ];
    expect(DEFAULT_FEATURES).toEqual(founding);
    expect(getFeatures()).toEqual(founding);
    expect([...FEATURES].sort()).toEqual(founding);
    for (const feature of FEATURES) expect(hasFeature(feature)).toBe(true);
  });

  test('starting with no cache and a failing load keeps the default', async () => {
    respondToRpc('my_features', { data: null, error: { message: 'boom' } });
    stop = startFeatures('u1');
    await flush();
    expect(rpcCallsFor('my_features')).toHaveLength(1);
    expect(getFeatures()).toEqual(DEFAULT_FEATURES);
  });
});

describe('loading', () => {
  test('loads on sign-in, calling my_features with no household', async () => {
    await start('u1', ['categorize', 'recipe_import', 'recipe_import_photo']);
    expect(rpcCallsFor('my_features')).toEqual([{ fn: 'my_features', args: undefined }]);
    expect(getFeatures()).toEqual(['categorize', 'recipe_import', 'recipe_import_photo']);
    expect(hasFeature('recipe_import')).toBe(true);
  });

  test('a plan with no features has nothing', async () => {
    await start('u1', []);
    expect(getFeatures()).toEqual([]);
    expect(hasFeature('categorize')).toBe(false);
  });

  test('loads again on each foreground and reconnect', async () => {
    await start('u1', ['categorize']);
    respondToRpc('my_features', { data: [] });
    mockTriggers.onCatchUp!();
    await flush();
    expect(rpcCallsFor('my_features')).toHaveLength(2);
    expect(getFeatures()).toEqual([]);

    respondToRpc('my_features', { data: ['categorize', 'recipe_import'] });
    mockTriggers.onNetwork!(true);
    mockTriggers.onCatchUp!();
    await flush();
    expect(rpcCallsFor('my_features')).toHaveLength(3);
    expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
  });

  test('sorts the answer, drops duplicates and unknown keys', async () => {
    await start('u1', ['recipe_import', 'categorize', 'categorize', 'teleport']);
    expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
  });

  test('saves each answer in device settings for the user', async () => {
    await start('u1', ['categorize', 'recipe_import']);
    expect(getDeviceSetting(FEATURES_KEY, null)).toEqual({ userId: 'u1', features: ['categorize', 'recipe_import'] });
  });

  test('a malformed answer changes nothing', async () => {
    await start('u1', ['categorize', 'recipe_import']);
    respondToRpc('my_features', { data: 'founding' });
    await refreshFeatures();
    expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
    expect(warn).toHaveBeenCalled();
  });

  test('without Supabase configured nothing is asked', async () => {
    setSupabaseConfigured(false);
    await start('u1');
    expect(rpcCallsFor('my_features')).toEqual([]);
    expect(getFeatures()).toEqual(DEFAULT_FEATURES);
  });

  test('tells listeners only when the features change', async () => {
    const listener = jest.fn();
    const off = onFeaturesChange(listener);
    await start('u1', [...DEFAULT_FEATURES]);
    expect(listener).not.toHaveBeenCalled();
    respondToRpc('my_features', { data: [] });
    await refreshFeatures();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('offline', () => {
  test('an offline launch uses the cached answer', async () => {
    setDeviceSetting(FEATURES_KEY, { userId: 'u1', features: [] });
    stop = startFeatures('u1');
    mockTriggers.onNetwork!(false);
    // The load started at once fails (no network); the cached value stays.
    respondToRpc('my_features', { data: null, error: { message: 'Network request failed' } });
    await flush();
    expect(getFeatures()).toEqual([]);
  });

  test('while offline, foregrounds ask nothing and keep the cached value', async () => {
    await start('u1', ['categorize', 'recipe_import']);
    mockTriggers.onNetwork!(false);
    mockTriggers.onCatchUp!();
    await refreshFeatures();
    expect(rpcCallsFor('my_features')).toHaveLength(1);
    expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
  });

  test("another user's cached answer isn't used", async () => {
    setDeviceSetting(FEATURES_KEY, { userId: 'u2', features: ['categorize', 'recipe_import'] });
    // The load fails, so only the cache could have changed the default.
    await start('u1', undefined);
    expect(getFeatures()).toEqual(DEFAULT_FEATURES);
  });
});

describe('sign-out', () => {
  test('clears the store and the cache, back to the default', async () => {
    await start('u1', []);
    clearFeatures();
    expect(getFeatures()).toEqual(DEFAULT_FEATURES);
    expect(getDeviceSetting(FEATURES_KEY, null)).toBeNull();
  });

  test("a load that finishes after sign-out doesn't bring the features back", async () => {
    await start('u1', ['categorize']);
    respondToRpc('my_features', { data: ['categorize', 'recipe_import'] });
    const late = refreshFeatures();
    clearFeatures();
    await late;
    expect(getFeatures()).toEqual(DEFAULT_FEATURES);
    expect(getDeviceSetting(FEATURES_KEY, null)).toBeNull();
  });

  test('signed out, nothing is loaded', async () => {
    await refreshFeatures();
    expect(rpcCallsFor('my_features')).toEqual([]);
  });

  test('the cleanup stops the triggers', async () => {
    await start('u1', ['categorize']);
    stop!();
    stop = null;
    expect(mockTriggers.stopped).toBe(1);
  });
});

describe('lostFeature (a not_entitled answer)', () => {
  test('drops the feature at once, saves it and reloads', async () => {
    await start('u1', ['categorize', 'recipe_import']);
    respondToRpc('my_features', { data: ['recipe_import'] });
    const done = lostFeature('categorize');
    expect(hasFeature('categorize')).toBe(false);
    expect(getDeviceSetting(FEATURES_KEY, null)).toEqual({ userId: 'u1', features: ['recipe_import'] });
    await done;
    expect(rpcCallsFor('my_features')).toHaveLength(2);
  });

  test('the reload has the last word', async () => {
    await start('u1', ['categorize']);
    respondToRpc('my_features', { data: ['categorize'] });
    await lostFeature('categorize');
    expect(getFeatures()).toEqual(['categorize']);
  });
});

describe('parseFeatures', () => {
  test('keeps known keys; rejects anything but a list of strings', () => {
    expect(parseFeatures(['categorize', 'x'])).toEqual(['categorize']);
    expect(parseFeatures([])).toEqual([]);
    expect(parseFeatures(null)).toBeNull();
    expect(parseFeatures('categorize')).toBeNull();
    expect(parseFeatures(['categorize', 1])).toBeNull();
  });
});
