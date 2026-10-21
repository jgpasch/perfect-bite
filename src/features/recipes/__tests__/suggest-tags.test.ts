import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import type { NetworkState } from 'expo-network';

import { db, outbox, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { getFeatures, hasFeature } from '@/features/plans/features';
import { clearFeatures, startFeatures } from '@/features/plans/load';
import { initI18n } from '@/i18n';
import type { AiRecipeTags } from '@/shared/recipe-tags';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';
import {
  makeSession,
  resetSupabase,
  respondToRpc,
  rpcCallsFor,
  setSupabaseConfigured,
  supabase,
} from '@/test/fake-supabase';

import { addRecipeIngredient, createRecipe, deleteRecipe, deleteRecipeIngredient, updateRecipe } from '../recipes';
import {
  buildSuggestTagsRequest,
  SUGGEST_TAGS_MESSAGES,
  suggestRecipeTags,
  suggestTagsFailureMessage,
  suggestTagsMessage,
  type SuggestTagsError,
} from '../suggest-tags';

const mockNetwork: { state: NetworkState | Error } = { state: { isConnected: true, isInternetReachable: true } };

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => {
    if (mockNetwork.state instanceof Error) throw mockNetwork.state;
    return mockNetwork.state;
  },
  addNetworkStateListener: () => ({ remove: () => {} }),
}));
jest.mock('@/features/categories/catch-up', () => ({
  ...jest.requireActual<object>('@/features/categories/catch-up'),
  startCatchUpTriggers: () => () => {},
}));

const USER = 'user-1';
const invoke = supabase.functions.invoke;

const TAGS: AiRecipeTags ={ meal: ['dinner'], cuisine: ['indian'], protein: ['chicken'], diet: [], method: [] };

let recipeId: string;
let warn: ReturnType<typeof jest.spyOn>;

function respond(data: unknown = { tags: TAGS, promptVersion: 'suggest-recipe-tags.v1' }) {
  invoke.mockResolvedValue({ data, error: null });
}

/** What `functions.invoke` gives for a non-2xx answer: a FunctionsHttpError with the Response. */
function respondWithError(status: number, body: unknown) {
  invoke.mockResolvedValue({
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status,
        json: () => (typeof body === 'string' ? Promise.reject(new SyntaxError(body)) : Promise.resolve(body)),
      },
    },
  });
}

const recipeRow = () => db.select().from(recipes).where(eq(recipes.id, recipeId)).get();

beforeEach(() => {
  resetDb();
  resetSupabase();
  seedCatalog();
  ensureStarterData(USER);
  mockNetwork.state = { isConnected: true, isInternetReachable: true };
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  respond();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  recipeId = createRecipe('Chicken tikka masala');
  updateRecipe(recipeId, { name: 'Chicken tikka masala', notes: 'Serves 4\nBest the next day', sourceUrl: '' });
  addRecipeIngredient(recipeId, '2 lb chicken thighs');
  addRecipeIngredient(recipeId, 'garam masala');
});

afterEach(() => {
  warn.mockRestore();
  setSupabaseConfigured(true);
});

describe('the request', () => {
  test('is the name, notes as stored and live ingredients in order', () => {
    addRecipeIngredient(recipeId, '4 cloves garlic');
    expect(buildSuggestTagsRequest(recipeId)).toEqual({
      name: 'Chicken tikka masala',
      notes: 'Serves 4\nBest the next day',
      ingredients: [
        { name: 'chicken thighs', quantity: 2, unit: 'lb', note: null },
        { name: 'garam masala', quantity: null, unit: null, note: null },
        { name: 'garlic', quantity: 4, unit: 'clove', note: null },
      ],
    });
  });

  test('leaves deleted ingredients out', () => {
    const { id } = addRecipeIngredient(recipeId, 'cream')!;
    deleteRecipeIngredient(id);
    expect(buildSuggestTagsRequest(recipeId)!.ingredients.map((i) => i.name)).toEqual(['chicken thighs', 'garam masala']);
  });

  test('null notes stay null', () => {
    const plain = createRecipe('Toast');
    addRecipeIngredient(plain, 'bread');
    expect(buildSuggestTagsRequest(plain)!.notes).toBeNull();
  });

  test('is null for a deleted or unknown recipe', () => {
    deleteRecipe(recipeId);
    expect(buildSuggestTagsRequest(recipeId)).toBeNull();
    expect(buildSuggestTagsRequest('nope')).toBeNull();
  });

  test('is sent to suggest-recipe-tags', async () => {
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: true, tags: TAGS });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('suggest-recipe-tags', {
      body: {
        name: 'Chicken tikka masala',
        notes: 'Serves 4\nBest the next day',
        ingredients: [
          { name: 'chicken thighs', quantity: 2, unit: 'lb', note: null },
          { name: 'garam masala', quantity: null, unit: null, note: null },
        ],
      },
    });
  });
});

describe('a suggestion', () => {
  test('never writes to the recipe', async () => {
    const before = recipeRow();
    const outboxBefore = db.select().from(outbox).all().length;
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: true, tags: TAGS });
    expect(recipeRow()).toEqual(before);
    expect(recipeRow()!.tags).toBeNull();
    expect(db.select().from(outbox).all()).toHaveLength(outboxBefore);
  });

  test('returns all-empty facets when nothing fit', async () => {
    const empty: AiRecipeTags = { meal: [], cuisine: [], protein: [], diet: [], method: [] };
    respond({ tags: empty, promptVersion: 'v1' });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: true, tags: empty });
  });

  test('drops saved from a response that has it', async () => {
    respond({ tags: { ...TAGS, saved: ['favorite'] }, promptVersion: 'v1' });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: true, tags: TAGS });
  });

  test('an unexpected response is failed', async () => {
    respond({ nope: true });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'failed' });
  });
});

describe('not calling the server', () => {
  test('a recipe with no ingredients is no-ingredients', async () => {
    const empty = createRecipe('Mystery');
    expect(await suggestRecipeTags(empty)).toEqual({ ok: false, error: 'no-ingredients' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('only deleted ingredients is no-ingredients', async () => {
    const r = createRecipe('Gone');
    deleteRecipeIngredient(addRecipeIngredient(r, 'eggs')!.id);
    expect(await suggestRecipeTags(r)).toEqual({ ok: false, error: 'no-ingredients' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('no-ingredients wins over offline', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    expect(await suggestRecipeTags(createRecipe('Mystery'))).toEqual({ ok: false, error: 'no-ingredients' });
  });

  test('offline per the OS', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('connected but the internet unreachable is offline', async () => {
    mockNetwork.state = { isConnected: true, isInternetReachable: false };
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('an unknown network state still calls', async () => {
    mockNetwork.state = new Error('no network module');
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: true, tags: TAGS });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('no session is offline', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('Supabase not configured is offline', async () => {
    setSupabaseConfigured(false);
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a deleted recipe is failed', async () => {
    deleteRecipe(recipeId);
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'failed' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  test.each([
    ['rate_limited', 429, 'rate-limited'],
    ['unavailable', 503, 'unavailable'],
    ['not_entitled', 403, 'not-entitled'],
    ['invalid_request', 400, 'failed'],
  ] as [string, number, SuggestTagsError][])('%s (%i) is %s', async (code, status, expected) => {
    respondWithError(status, { error: code, message: code });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: expected });
  });

  test.each([
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [403, 'not-entitled'],
    [500, 'failed'],
  ] as [number, SuggestTagsError][])('a bare %i with no JSON body is %s', async (status, expected) => {
    respondWithError(status, 'Oops');
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: expected });
  });

  test('the code wins over the status', async () => {
    respondWithError(403, { error: 'rate_limited', message: 'Slow down' });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'rate-limited' });
  });

  test('the monthly limit (limit_reached) is limit-reached with its resets_at, not rate-limited', async () => {
    respondWithError(429, { error: 'limit_reached', message: 'Used up', resets_at: '2026-11-01T00:00:00.000Z' });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'limit-reached', resetsAt: '2026-11-01T00:00:00.000Z' });
  });

  test("the user's daily safety limit (daily_limit) is daily-limit, not rate-limited", async () => {
    respondWithError(429, { error: 'daily_limit', message: 'Daily limit', resets_at: '2026-10-22T00:00:00.000Z' });
    const result = await suggestRecipeTags(recipeId);
    expect(result).toEqual({ ok: false, error: 'daily-limit' });
    if (result.ok) throw new Error('expected a failure');
    expect(suggestTagsFailureMessage(result)).toBe("You've reached today's limit. Try again tomorrow.");
  });

  test('limit_reached without resets_at falls back to the start of next month (UTC)', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-18T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      respondWithError(429, { error: 'limit_reached', message: 'Used up' });
      expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'limit-reached', resetsAt: '2026-11-01T00:00:00.000Z' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a 500 not_configured is failed', async () => {
    respondWithError(500, { error: 'not_configured', message: 'AI_MODEL_TAGS is not set' });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'failed' });
  });

  test('a network failure is offline', async () => {
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'offline' });
  });

  test('invoke throwing is offline', async () => {
    invoke.mockRejectedValue(new TypeError('Network request failed'));
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'offline' });
  });

  test('an error writes nothing to the recipe', async () => {
    const before = recipeRow();
    respondWithError(503, { error: 'unavailable', message: 'Paused' });
    await suggestRecipeTags(recipeId);
    expect(recipeRow()).toEqual(before);
  });
});

describe('messages', () => {
  test('one for each error', () => {
    expect(SUGGEST_TAGS_MESSAGES).toEqual({
      offline: "You're offline. Try again when you're connected.",
      'no-ingredients': "Add some ingredients first, so there's something to go on.",
      'not-entitled': "Tag suggestions aren't included in your plan.",
      'rate-limited': "That's a lot of suggestions. Try again in a minute.",
      'daily-limit': "You've reached today's limit. Try again tomorrow.",
      unavailable: "Couldn't suggest tags right now. Try again later.",
      failed: "Couldn't suggest tags right now. Try again later.",
    });
    expect(suggestTagsMessage('offline')).toBe("You're offline. Try again when you're connected.");
    expect(suggestTagsMessage('rate-limited')).toBe("That's a lot of suggestions. Try again in a minute.");
  });

  test('a failure: the monthly limit says when it resets', () => {
    expect(suggestTagsFailureMessage({ ok: false, error: 'limit-reached', resetsAt: '2026-11-01T00:00:00.000Z' })).toBe(
      "You've used this month's tag suggestions. They reset on Nov 1.",
    );
    expect(suggestTagsFailureMessage({ ok: false, error: 'rate-limited' })).toBe("That's a lot of suggestions. Try again in a minute.");
  });

  test('the monthly limit in Spanish', () => {
    initI18n('es');
    try {
      expect(suggestTagsFailureMessage({ ok: false, error: 'limit-reached', resetsAt: '2026-12-01T00:00:00.000Z' })).toBe(
        'Ya usaste las sugerencias de etiquetas de este mes. Se renuevan el 1 dic.',
      );
      expect(suggestTagsFailureMessage({ ok: false, error: 'daily-limit' })).toBe('Llegaste al límite de hoy. Inténtalo mañana.');
    } finally {
      initI18n('en');
    }
  });
});

describe('plans (spec 4.12)', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let stopFeatures: (() => void) | null = null;

  beforeEach(async () => {
    respondToRpc('my_features', { data: ['categorize', 'recipe_import', 'recipe_tags'] });
    stopFeatures = startFeatures(USER);
    await flush();
    expect(hasFeature('recipe_tags')).toBe(true);
  });

  afterEach(() => {
    stopFeatures?.();
    stopFeatures = null;
    clearFeatures();
  });

  test('not_entitled drops recipe_tags and reloads the plan', async () => {
    respondWithError(403, { error: 'not_entitled', message: 'No' });
    respondToRpc('my_features', { data: ['categorize'] });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'not-entitled' });
    await flush();
    expect(rpcCallsFor('my_features')).toHaveLength(2);
    expect(getFeatures()).toEqual(['categorize']);
  });

  test('not_entitled drops recipe_tags even when the reload fails, and keeps the rest', async () => {
    respondWithError(403, { error: 'not_entitled', message: 'No' });
    respondToRpc('my_features', { data: null, error: { message: 'boom' } });
    expect(await suggestRecipeTags(recipeId)).toEqual({ ok: false, error: 'not-entitled' });
    await flush();
    expect(rpcCallsFor('my_features')).toHaveLength(2);
    expect(getFeatures()).toEqual(['categorize', 'recipe_import']);
  });

  test('other errors keep recipe_tags', async () => {
    respondWithError(429, { error: 'rate_limited', message: 'Slow down' });
    await suggestRecipeTags(recipeId);
    await flush();
    expect(hasFeature('recipe_tags')).toBe(true);
    expect(rpcCallsFor('my_features')).toHaveLength(1);
  });
});
