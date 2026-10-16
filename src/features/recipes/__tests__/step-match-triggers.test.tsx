// What starts a background step match (spec 4.5): opening the recipe or cook screen, the Steps
// sheet's Save and ingredient edits on the recipe screen (2 s after the last).

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Toast } from '@/components/toast';
import { db, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { DEFAULT_FEATURES, setFeatures } from '@/features/plans/features';
import type { MatchRecipeStepsRequestInput } from '@/shared/schemas/match-recipe-steps';
import { resetDb } from '@/test/db';
import { makeSession, resetSupabase, supabase } from '@/test/fake-supabase';

import CookScreen from '@/app/recipe/[id]/cook';
import RecipeScreen from '@/app/recipe/[id]/index';
import RecipeStepsSheet from '@/app/recipe/[id]/steps';

import { ensureStepMatch, resetStepMatching, STEP_MATCH_EDIT_DELAY_MS } from '../ensure-step-match';
import { RecipeIngredientRow } from '../recipe-ingredient-row';
import { addRecipeIngredient, createRecipe, recipeIngredientsQuery } from '../recipes';
import { stepMatch } from '../step-match';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
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
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement } = require('react');
  return { __esModule: true, default: ({ children }: { children?: unknown }) => createElement('Swipeable', null, children) };
});
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }),
  addNetworkStateListener: () => ({ remove: () => {} }),
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve(),
}));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({ categorizePending: () => Promise.resolve() }));
jest.mock('@/features/lists/add-bar', () => {
  const { createElement } = require('react');
  return { ItemAddBar: (props: object) => createElement('ItemAddBar', props) };
});
const mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const passThrough = () =>
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    };
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(passThrough(), {
    Button: host('ToolbarButton'),
    Menu: host('ToolbarMenu'),
    MenuAction: host('ToolbarMenuAction'),
  });
  return {
    Stack: { Screen: () => null, Toolbar },
    router: { push: () => {}, back: () => {} },
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Host: host('SwiftHost'),
    RNHostView: host('RNHostView'),
    Button: host('SwiftButton'),
    ContextMenu: Object.assign(host('SwiftContextMenu'), {
      Items: host('SwiftContextMenuItems'),
      Trigger: host('SwiftContextMenuTrigger'),
    }),
  };
});
jest.mock('expo-linking', () => ({ openURL: () => Promise.resolve(true) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: () => Promise.resolve(true) }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const STEPS = ['Grill the chicken thighs.', 'Squeeze over the limes.'];
const invoke = supabase.functions.invoke;

let tree: ReactTestRenderer | null = null;
let tacos: string;

type Body = { body: MatchRecipeStepsRequestInput };
const matchCalls = () => invoke.mock.calls.filter(([name]) => name === 'match-recipe-steps');
const sentSteps = (call: number) => (matchCalls()[call][1] as Body).body.steps;
const sentNames = (call: number) => (matchCalls()[call][1] as Body).body.ingredients.map((i) => i.name);
const recipeRow = () => db.select().from(recipes).where(eq(recipes.id, tacos)).get()!;
const matchState = () => stepMatch(recipeRow(), recipeIngredientsQuery(tacos).all()).state;
const setSteps = (steps: string[] | null) => db.update(recipes).set({ steps }).where(eq(recipes.id, tacos)).run();

beforeEach(() => {
  resetDb();
  resetSupabase();
  resetStepMatching();
  ensureStarterData('user-1');
  setFeatures([...DEFAULT_FEATURES, 'step_ingredients']);
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession('user-1') }, error: null });
  // Every step uses every ingredient.
  invoke.mockImplementation(async (_name: unknown, args: unknown) => {
    const { body } = args as Body;
    return {
      data: { steps: body.steps.map(() => body.ingredients.map((i) => ({ id: i.id, quantity: null }))), promptVersion: 'v1' },
      error: null,
    };
  });
  tacos = createRecipe('Tacos');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = tacos;
  addRecipeIngredient(tacos, '2 lb chicken thighs');
  addRecipeIngredient(tacos, '3 limes');
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setFeatures(DEFAULT_FEATURES);
  jest.useRealTimers();
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

/** Waits for the match a screen started (a second call joins the one in flight). */
const settle = () => act(() => ensureStepMatch(tacos));

describe('opening a screen', () => {
  test('the recipe screen matches a recipe that has steps but no match', async () => {
    setSteps(STEPS);
    expect(recipeRow().stepIngredients).toBeNull();
    render(<RecipeScreen />);
    await settle();
    expect(matchCalls()).toHaveLength(1);
    expect(sentSteps(0)).toEqual(STEPS);
    expect(matchState()).toBe('fresh');
  });

  test('the cook screen matches a recipe that has steps but no match', async () => {
    setSteps(STEPS);
    render(<CookScreen />);
    await settle();
    expect(matchCalls()).toHaveLength(1);
    expect(matchState()).toBe('fresh');
  });

  test('a recipe without steps is not sent', async () => {
    render(<RecipeScreen />);
    await settle();
    expect(matchCalls()).toHaveLength(0);
  });

  test('a fresh match is not sent again', async () => {
    setSteps(STEPS);
    await ensureStepMatch(tacos);
    render(<RecipeScreen />);
    await settle();
    act(() => tree?.unmount());
    render(<CookScreen />);
    await settle();
    expect(matchCalls()).toHaveLength(1);
  });

  test('without step_ingredients nothing is sent', async () => {
    setFeatures(DEFAULT_FEATURES);
    setSteps(STEPS);
    render(<CookScreen />);
    await settle();
    expect(matchCalls()).toHaveLength(0);
  });
});

describe("the Steps sheet's Save", () => {
  const field = (root: ReactTestRenderer) =>
    root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Steps');
  const save = (root: ReactTestRenderer) =>
    root.root.findAll((n) => String(n.type) === 'ToolbarButton').find((n) => n.props.children === 'Save')!;

  test('matches the saved steps', async () => {
    const root = render(<RecipeStepsSheet />);
    act(() => field(root).props.onChangeText('Grill the chicken.\nAdd the limes.'));
    act(() => save(root).props.onPress());
    await settle();
    expect(matchCalls()).toHaveLength(1);
    expect(sentSteps(0)).toEqual(['Grill the chicken.', 'Add the limes.']);
    expect(matchState()).toBe('fresh');
  });

  test('an edit to matched steps matches again', async () => {
    setSteps(STEPS);
    await ensureStepMatch(tacos);
    const root = render(<RecipeStepsSheet />);
    act(() => field(root).props.onChangeText(`${STEPS.join('\n')}\nServe.`));
    act(() => save(root).props.onPress());
    await settle();
    expect(matchCalls()).toHaveLength(2);
    expect(sentSteps(1)).toEqual([...STEPS, 'Serve.']);
  });

  test('saving no steps sends nothing', async () => {
    const root = render(<RecipeStepsSheet />);
    act(() => field(root).props.onChangeText('  \n'));
    act(() => save(root).props.onPress());
    await settle();
    expect(matchCalls()).toHaveLength(0);
  });
});

describe('ingredient edits on the recipe screen', () => {
  beforeEach(async () => {
    setSteps(STEPS);
    await ensureStepMatch(tacos);
    jest.useFakeTimers();
  });

  const addBar = (root: ReactTestRenderer) => root.root.find((n) => String(n.type) === 'ItemAddBar');

  test('an add matches 2 s after the last edit', async () => {
    const root = render(<RecipeScreen />);
    await act(() => jest.advanceTimersByTimeAsync(0));
    expect(matchCalls()).toHaveLength(1); // Opening found the match fresh.

    act(() => addBar(root).props.onAdd('tortillas'));
    await act(() => jest.advanceTimersByTimeAsync(1500));
    act(() => addBar(root).props.onAdd('1 onion'));
    await act(() => jest.advanceTimersByTimeAsync(STEP_MATCH_EDIT_DELAY_MS - 1));
    expect(matchCalls()).toHaveLength(1);
    expect(matchState()).toBe('stale');

    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(matchCalls()).toHaveLength(2);
    expect(sentNames(1)).toEqual(['chicken thighs', 'limes', 'tortillas', 'onion']);
    expect(matchState()).toBe('fresh');
  });

  test('a delete undone within 2 s waits for the undo, and then the match is fresh', async () => {
    const root = render(<RecipeScreen />);
    await act(() => jest.advanceTimersByTimeAsync(0));
    const limes = root.root.findAll((n) => n.type === RecipeIngredientRow)[1];
    act(() => limes.props.onDelete());
    await act(() => jest.advanceTimersByTimeAsync(1000));
    act(() => root.root.find((n) => n.type === Toast).props.actions[0].onPress());
    await act(() => jest.advanceTimersByTimeAsync(STEP_MATCH_EDIT_DELAY_MS - 1));
    expect(matchCalls()).toHaveLength(1);

    // Back to the ingredients it was matched with: fresh again, so nothing is sent.
    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(matchCalls()).toHaveLength(1);
    expect(matchState()).toBe('fresh');
  });

  test('a delete matches without the deleted ingredient', async () => {
    const root = render(<RecipeScreen />);
    await act(() => jest.advanceTimersByTimeAsync(0));
    act(() => root.root.findAll((n) => n.type === RecipeIngredientRow)[1].props.onDelete());
    await act(() => jest.advanceTimersByTimeAsync(STEP_MATCH_EDIT_DELAY_MS));
    expect(matchCalls()).toHaveLength(2);
    expect(sentNames(1)).toEqual(['chicken thighs']);
    expect(matchState()).toBe('fresh');
  });
});
