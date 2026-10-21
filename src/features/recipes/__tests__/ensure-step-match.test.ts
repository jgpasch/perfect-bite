import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import type { NetworkState } from 'expo-network';

import { db, households, recipes } from '@/db';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { DEFAULT_FEATURES, hasFeature, setFeatures } from '@/features/plans/features';
import { normalizeIngredientName, stepIngredientsBasis } from '@/shared';
import type { MatchRecipeStepsRequestInput } from '@/shared/schemas/match-recipe-steps';
import type { RecipeImportResponse } from '@/shared/schemas/recipe-import';
import { resetDb } from '@/test/db';
import { makeSession, resetSupabase, setSupabaseConfigured, supabase } from '@/test/fake-supabase';
import { seedCatalog } from '@/test/seed';

import {
  ensureStepMatch,
  ensureStepMatchSoon,
  resetStepMatching,
  STEP_MATCH_EDIT_DELAY_MS,
  STEP_MATCH_PAUSE_MS,
} from '../ensure-step-match';
import { importRecipe } from '../import';
import {
  addRecipeIngredient,
  createRecipe,
  deleteRecipe,
  deleteRecipeIngredient,
  recipeIngredientsQuery,
  updateRecipeSteps,
} from '../recipes';
import { stepMatch } from '../step-match';

const mockNetwork: { state: NetworkState } = { state: { isConnected: true, isInternetReachable: true } };

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => mockNetwork.state,
  addNetworkStateListener: () => ({ remove: () => {} }),
}));
jest.mock('@/features/categories/catch-up', () => ({
  ...jest.requireActual<object>('@/features/categories/catch-up'),
  startCatchUpTriggers: () => () => {},
}));

const USER = 'user-1';
const invoke = supabase.functions.invoke;
const STEPS = ['Grill the chicken thighs.', 'Squeeze over the limes.', 'Serve.'];

let recipeId: string;
let warn: ReturnType<typeof jest.spyOn>;

type Body = { body: MatchRecipeStepsRequestInput };
const matchCalls = () => invoke.mock.calls.filter(([name]) => name === 'match-recipe-steps');

/** The mock model: a step uses an ingredient when the ingredient's first word is in it. */
function modelAnswer({ body }: Body) {
  return {
    steps: body.steps.map((step) =>
      body.ingredients
        .filter((i) => step.toLowerCase().includes(i.name.split(' ')[0].toLowerCase()))
        .map((i) => ({ id: i.id, quantity: null })),
    ),
    promptVersion: 'match-recipe-steps.v1',
  };
}

function respond(answer: (args: Body) => unknown = modelAnswer) {
  invoke.mockImplementation(async (_name: unknown, args: unknown) => ({ data: answer(args as Body), error: null }));
}

/** What `functions.invoke` gives for a non-2xx answer: a FunctionsHttpError with the Response. */
function respondWithError(status: number, body?: unknown) {
  invoke.mockResolvedValue({
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status,
        json: () => (body === undefined ? Promise.reject(new SyntaxError('not json')) : Promise.resolve(body)),
      },
    },
  });
}

const saved = (id = recipeId) => db.select().from(recipes).where(eq(recipes.id, id)).get()!.stepIngredients;
const ingredientIds = (id = recipeId) =>
  recipeIngredientsQuery(id)
    .all()
    .map((i) => i.id);
const matchState = (id = recipeId) =>
  stepMatch(db.select().from(recipes).where(eq(recipes.id, id)).get()!, recipeIngredientsQuery(id).all()).state;

beforeEach(() => {
  resetDb();
  resetSupabase();
  resetStepMatching();
  seedCatalog();
  ensureStarterData(USER);
  setFeatures([...DEFAULT_FEATURES, 'step_ingredients']);
  mockNetwork.state = { isConnected: true, isInternetReachable: true };
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
  respond();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  recipeId = createRecipe('Chicken tacos');
  updateRecipeSteps(recipeId, STEPS);
  addRecipeIngredient(recipeId, '2 lb chicken thighs');
  addRecipeIngredient(recipeId, '3 limes');
});

afterEach(() => {
  warn.mockRestore();
  setSupabaseConfigured(true);
  setFeatures(DEFAULT_FEATURES);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('a recipe that needs a match', () => {
  test('sends its steps and live ingredients, and saves the answer with its basis', async () => {
    const [chicken, limes] = ingredientIds();
    const { id: gone } = addRecipeIngredient(recipeId, 'cream')!;
    deleteRecipeIngredient(gone);

    await ensureStepMatch(recipeId);

    expect(matchCalls()).toEqual([
      [
        'match-recipe-steps',
        {
          body: {
            steps: STEPS,
            ingredients: [
              { id: chicken, name: 'chicken thighs', quantity: 2, unit: 'lb', note: null },
              { id: limes, name: 'limes', quantity: 3, unit: null, note: null },
            ],
            householdId: db.select().from(recipes).where(eq(recipes.id, recipeId)).get()!.householdId,
          },
        },
      ],
    ]);
    expect(saved()).toEqual({
      v: 1,
      basis: stepIngredientsBasis(STEPS, [chicken, limes]),
      steps: [[{ id: chicken, quantity: null }], [{ id: limes, quantity: null }], []],
    });
    expect(matchState()).toBe('fresh');
  });

  test("sends the recipe's own household, not the current one", async () => {
    const CABIN = '019a4c10-0000-7000-8000-00000000cab1';
    db.insert(households).values({ id: CABIN, name: 'Lake cabin' }).run();
    const cabinRecipe = createRecipe('Cabin tacos', CABIN);
    updateRecipeSteps(cabinRecipe, STEPS);
    addRecipeIngredient(cabinRecipe, '3 limes');
    await ensureStepMatch(cabinRecipe);
    expect(matchCalls().map(([, options]) => (options as { body: { householdId: string } }).body.householdId)).toEqual([CABIN]);
  });

  test('keeps the shares the function answers with', async () => {
    const [, limes] = ingredientIds();
    respond(() => ({ steps: [[], [{ id: limes, quantity: 1 }], []], promptVersion: 'v1' }));
    await ensureStepMatch(recipeId);
    expect(saved()!.steps).toEqual([[], [{ id: limes, quantity: 1 }], []]);
  });

  test('sends only the step strings of a sectioned recipe, so the answer lines up; a heading edit needs no new call', async () => {
    const [chicken, limes] = ingredientIds();
    updateRecipeSteps(recipeId, [{ section: 'Cook' }, STEPS[0], { section: 'Finish', choice: true }, STEPS[1], STEPS[2]]);

    await ensureStepMatch(recipeId);

    expect(matchCalls()).toHaveLength(1);
    expect((matchCalls()[0][1] as Body).body.steps).toEqual(STEPS);
    expect(saved()).toEqual({
      v: 1,
      basis: stepIngredientsBasis(STEPS, [chicken, limes]),
      steps: [[{ id: chicken, quantity: null }], [{ id: limes, quantity: null }], []],
    });
    expect(matchState()).toBe('fresh');

    updateRecipeSteps(recipeId, [{ section: 'Cook it' }, ...STEPS]);
    expect(matchState()).toBe('fresh');
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(1);
  });

  test('a recipe whose entries are all headings is never sent', async () => {
    db.update(recipes)
      .set({ steps: [{ section: 'Cook' }] })
      .where(eq(recipes.id, recipeId))
      .run();
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(0);
  });

  test('a stale match is matched again', async () => {
    await ensureStepMatch(recipeId);
    addRecipeIngredient(recipeId, 'tortillas');
    expect(matchState()).toBe('stale');

    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(2);
    expect(matchState()).toBe('fresh');
    expect(saved()!.basis).toBe(stepIngredientsBasis(STEPS, ingredientIds()));
  });
});

describe('skips', () => {
  test('when offline, with no call', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    await ensureStepMatch(recipeId);
    mockNetwork.state = { isConnected: true, isInternetReachable: false };
    await ensureStepMatch(recipeId);
    expect(invoke).not.toHaveBeenCalled();
    expect(saved()).toBeNull();
  });

  test('when signed out or unconfigured', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await ensureStepMatch(recipeId);
    supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null });
    setSupabaseConfigured(false);
    await ensureStepMatch(recipeId);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('when the plan has no step_ingredients', async () => {
    setFeatures(['categorize']);
    await ensureStepMatch(recipeId);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('when the recipe has no steps, or only blank ones', async () => {
    updateRecipeSteps(recipeId, null);
    await ensureStepMatch(recipeId);
    db.update(recipes).set({ steps: ['  ', ''] }).where(eq(recipes.id, recipeId)).run();
    await ensureStepMatch(recipeId);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('when the recipe has no live ingredients', async () => {
    for (const id of ingredientIds()) deleteRecipeIngredient(id);
    await ensureStepMatch(recipeId);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('when the recipe is deleted or unknown', async () => {
    deleteRecipe(recipeId);
    await ensureStepMatch(recipeId);
    await ensureStepMatch('nope');
    expect(invoke).not.toHaveBeenCalled();
  });

  test('when the match is fresh', async () => {
    await ensureStepMatch(recipeId);
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(1);
  });

  test('when a call for the recipe is in flight, joining it', async () => {
    const first = ensureStepMatch(recipeId);
    const second = ensureStepMatch(recipeId);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(matchCalls()).toHaveLength(1);
  });

  test('but not for a different recipe in flight', async () => {
    const other = createRecipe('Lime soda');
    updateRecipeSteps(other, ['Squeeze the limes.']);
    addRecipeIngredient(other, '2 limes');
    await Promise.all([ensureStepMatch(recipeId), ensureStepMatch(other)]);
    expect(matchCalls()).toHaveLength(2);
    expect(saved(other)!.steps).toHaveLength(1);
  });
});

describe('a change during the call', () => {
  test('a step edit drops the answer', async () => {
    respond((args) => {
      updateRecipeSteps(recipeId, [...STEPS, 'Eat.']);
      return modelAnswer(args);
    });
    await ensureStepMatch(recipeId);
    expect(saved()).toBeNull();
  });

  test('an added ingredient drops the answer', async () => {
    respond((args) => {
      addRecipeIngredient(recipeId, 'tortillas');
      return modelAnswer(args);
    });
    await ensureStepMatch(recipeId);
    expect(saved()).toBeNull();
  });

  test('a deleted ingredient drops the answer', async () => {
    respond((args) => {
      deleteRecipeIngredient(ingredientIds()[0]);
      return modelAnswer(args);
    });
    await ensureStepMatch(recipeId);
    expect(saved()).toBeNull();
  });

  test('a deleted recipe drops the answer', async () => {
    respond((args) => {
      deleteRecipe(recipeId);
      return modelAnswer(args);
    });
    await ensureStepMatch(recipeId);
    expect(saved()).toBeNull();
  });

  test('a rename keeps it (the basis is the steps and ingredients only)', async () => {
    respond((args) => {
      db.update(recipes).set({ name: 'Lime chicken' }).where(eq(recipes.id, recipeId)).run();
      return modelAnswer(args);
    });
    await ensureStepMatch(recipeId);
    expect(matchState()).toBe('fresh');
  });
});

describe('errors are silent', () => {
  test('a response with the wrong step count saves nothing and pauses nothing', async () => {
    respond(() => ({ steps: [[]], promptVersion: 'v1' }));
    await expect(ensureStepMatch(recipeId)).resolves.toBeUndefined();
    expect(saved()).toBeNull();
    respond();
    await ensureStepMatch(recipeId);
    expect(saved()).not.toBeNull();
  });

  test('a malformed response saves nothing', async () => {
    respond(() => ({ nope: true }));
    await ensureStepMatch(recipeId);
    expect(saved()).toBeNull();
  });

  test('a thrown invoke or a network failure resolves, and the next call goes', async () => {
    invoke.mockRejectedValue(new Error('boom'));
    await expect(ensureStepMatch(recipeId)).resolves.toBeUndefined();
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError', message: 'offline' } });
    await expect(ensureStepMatch(recipeId)).resolves.toBeUndefined();
    respond();
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(3);
    expect(saved()).not.toBeNull();
  });

  test('a 500 or invalid_request pauses nothing', async () => {
    respondWithError(500);
    await ensureStepMatch(recipeId);
    respondWithError(400, { error: 'invalid_request', message: 'bad' });
    await ensureStepMatch(recipeId);
    respond();
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(3);
    expect(saved()).not.toBeNull();
  });
});

describe('the pauses', () => {
  const pauseCases: [string, number, unknown][] = [
    ['unavailable', 503, { error: 'unavailable', message: 'x' }],
    ['rate_limited', 429, { error: 'rate_limited', message: 'x' }],
    ['a bare 503', 503, undefined],
    ['a bare 429', 429, undefined],
  ];

  test.each(pauseCases)('%s pauses all matching for an hour', async (_label, status, body) => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const other = createRecipe('Lime soda');
    updateRecipeSteps(other, ['Squeeze the limes.']);
    addRecipeIngredient(other, '2 limes');

    respondWithError(status, body);
    await ensureStepMatch(recipeId);
    respond();
    await ensureStepMatch(recipeId);
    await ensureStepMatch(other);
    now += STEP_MATCH_PAUSE_MS - 1;
    await ensureStepMatch(other);
    expect(matchCalls()).toHaveLength(1);

    now += 1;
    await ensureStepMatch(other);
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(3);
    expect(saved(other)).not.toBeNull();
    expect(saved()).not.toBeNull();
  });

  test.each([
    ['not_entitled', { error: 'not_entitled', message: 'x' }],
    ['a bare 403', undefined],
  ])('%s stops matching for the session', async (_label, body) => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    respondWithError(403, body);
    await ensureStepMatch(recipeId);
    expect(hasFeature('step_ingredients')).toBe(true); // No signed-in plan here, so the feature list is left alone.

    respond();
    now += 10 * STEP_MATCH_PAUSE_MS;
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(1);
    expect(saved()).toBeNull();

    resetStepMatching(); // A new session.
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(2);
  });

  test("the monthly limit (limit_reached) stops matching for the session, silently, and keeps the plan", async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const other = createRecipe('Lime soda');
    updateRecipeSteps(other, ['Squeeze the limes.']);
    addRecipeIngredient(other, '2 limes');

    respondWithError(429, { error: 'limit_reached', message: 'x', resets_at: '2026-11-01T00:00:00.000Z' });
    await ensureStepMatch(recipeId);
    expect(hasFeature('step_ingredients')).toBe(true);

    // Not a pause: an hour later, or any time this session, nothing more is sent.
    respond();
    now += 10 * STEP_MATCH_PAUSE_MS;
    await ensureStepMatch(recipeId);
    await ensureStepMatch(other);
    expect(matchCalls()).toHaveLength(1);
    expect(saved()).toBeNull();
    expect(saved(other)).toBeNull();

    resetStepMatching(); // A new session.
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(2);
    expect(saved()).not.toBeNull();
  });

  test("the user's daily limit (daily_limit) stops matching for the session, silently, where rate_limited only pauses", async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const other = createRecipe('Lime soda');
    updateRecipeSteps(other, ['Squeeze the limes.']);
    addRecipeIngredient(other, '2 limes');

    respondWithError(429, { error: 'daily_limit', message: 'x', resets_at: '2026-10-22T00:00:00.000Z' });
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(1);
    expect(hasFeature('step_ingredients')).toBe(true);

    // A second call makes no request, even past the hour a rate limit pauses for.
    respond();
    await ensureStepMatch(recipeId);
    await ensureStepMatch(other);
    now += STEP_MATCH_PAUSE_MS + 1;
    await ensureStepMatch(recipeId);
    await ensureStepMatch(other);
    expect(matchCalls()).toHaveLength(1);
    expect(saved()).toBeNull();
    expect(saved(other)).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    resetStepMatching(); // A new session.
    await ensureStepMatch(recipeId);
    expect(matchCalls()).toHaveLength(2);
    expect(saved()).not.toBeNull();

    // rate_limited, by contrast, only pauses: an hour later matching resumes.
    resetStepMatching();
    respondWithError(429, { error: 'rate_limited', message: 'x' });
    await ensureStepMatch(other);
    respond();
    await ensureStepMatch(other);
    expect(matchCalls()).toHaveLength(3);
    now += STEP_MATCH_PAUSE_MS;
    await ensureStepMatch(other);
    expect(matchCalls()).toHaveLength(4);
    expect(saved(other)).not.toBeNull();
  });
});

describe('ensureStepMatchSoon', () => {
  test('matches 2 s after the last call for the recipe', async () => {
    jest.useFakeTimers();
    ensureStepMatchSoon(recipeId);
    await jest.advanceTimersByTimeAsync(STEP_MATCH_EDIT_DELAY_MS - 500);
    ensureStepMatchSoon(recipeId);
    await jest.advanceTimersByTimeAsync(STEP_MATCH_EDIT_DELAY_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    expect(saved()).toBeNull();

    await jest.advanceTimersByTimeAsync(1);
    expect(matchCalls()).toHaveLength(1);
    expect(matchState()).toBe('fresh');
  });

  test('the wait is per recipe', async () => {
    jest.useFakeTimers();
    const other = createRecipe('Lime soda');
    updateRecipeSteps(other, ['Squeeze the limes.']);
    addRecipeIngredient(other, '2 limes');
    ensureStepMatchSoon(recipeId);
    await jest.advanceTimersByTimeAsync(1000);
    ensureStepMatchSoon(other);
    await jest.advanceTimersByTimeAsync(1000);
    expect(matchCalls()).toHaveLength(1);
    expect(matchState()).toBe('fresh');
    expect(saved(other)).toBeNull();

    await jest.advanceTimersByTimeAsync(1000);
    expect(matchCalls()).toHaveLength(2);
    expect(matchState(other)).toBe('fresh');
  });
});

describe('after an import saves', () => {
  const IMPORTED: RecipeImportResponse = {
    name: 'Lime chicken',
    sourceUrl: 'https://example.com/lime-chicken',
    servings: 4,
    ingredients: [
      {
        ingredientName: normalizeIngredientName('chicken thighs'),
        displayName: 'chicken thighs',
        quantity: 2,
        unit: 'lb',
        note: '',
        categoryId: null,
        status: 'pending',
      },
      {
        ingredientName: normalizeIngredientName('limes'),
        displayName: 'limes',
        quantity: 3,
        unit: null,
        note: '',
        categoryId: null,
        status: 'pending',
      },
    ],
    tags: { meal: [], cuisine: [], protein: [], diet: [], method: [] },
    totalMinutes: null,
    steps: ['Grill the chicken.', 'Squeeze the limes over.'],
    stepIngredients: null,
    imageUrl: null,
  };

  beforeEach(() => {
    invoke.mockImplementation(async (name: unknown, args: unknown) =>
      name === 'import-recipe'
        ? { data: IMPORTED, error: null }
        : { data: modelAnswer(args as Body), error: null },
    );
  });

  test('the new recipe is matched', async () => {
    const result = await importRecipe({ url: IMPORTED.sourceUrl!, listId: getDefaultListId(USER)! });
    if (!result.ok) throw new Error('import failed');
    await ensureStepMatch(result.recipeId); // Joins the call the import started.
    expect(matchCalls()).toHaveLength(1);
    const [chicken, limes] = ingredientIds(result.recipeId);
    expect(saved(result.recipeId)!.steps).toEqual([[{ id: chicken, quantity: null }], [{ id: limes, quantity: null }]]);
  });

  test('an import that comes back matched saves it fresh and makes no match-recipe-steps call', async () => {
    const matched = { ...IMPORTED, stepIngredients: [[{ index: 0, quantity: null }], [{ index: 1, quantity: 2 }]] };
    invoke.mockImplementation(async (name: unknown, args: unknown) =>
      name === 'import-recipe' ? { data: matched, error: null } : { data: modelAnswer(args as Body), error: null },
    );
    const result = await importRecipe({ url: IMPORTED.sourceUrl!, listId: getDefaultListId(USER)! });
    if (!result.ok) throw new Error('import failed');
    await ensureStepMatch(result.recipeId);
    expect(matchCalls()).toHaveLength(0);
    expect(matchState(result.recipeId)).toBe('fresh');
    const [chicken, limes] = ingredientIds(result.recipeId);
    expect(saved(result.recipeId)!.steps).toEqual([[{ id: chicken, quantity: null }], [{ id: limes, quantity: 2 }]]);
  });

  test('a failed import matches nothing', async () => {
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError', message: 'offline' } });
    const result = await importRecipe({ url: IMPORTED.sourceUrl!, listId: getDefaultListId(USER)! });
    expect(result.ok).toBe(false);
    expect(matchCalls()).toHaveLength(0);
  });
});
