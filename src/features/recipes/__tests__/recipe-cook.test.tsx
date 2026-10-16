// Cooking mode (board 19): the recipe screen's Cook button and the cook screen.

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { PrimaryButton, SurfaceButton } from '@/components/button';
import { AisleColors, Palette, Sizes, Typography } from '@/constants/theme';
import { db, recipes } from '@/db';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData } from '@/features/lists/lists';
import { today } from '@/features/meal-plan/week';
import { dayName } from '@/features/meal-plan/week-view';
import { setSlot } from '@/features/meal-plan/write';
import { setKeepScreenOn } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import CookScreen from '@/app/recipe/[id]/cook';
import RecipeScreen from '@/app/recipe/[id]/index';

import { addRecipeIngredient, createRecipe } from '../recipes';
import { cookProgressLabel, upNextIndex } from '../recipe-view';

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
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
// The keep-awake tags held right now; the screen stays on while there's any.
const mockAwake = new Set<string>();
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn((tag: string) => (mockAwake.add(tag), Promise.resolve())),
  deactivateKeepAwake: jest.fn((tag: string) => (mockAwake.delete(tag), Promise.resolve())),
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
const mockPush = jest.fn();
const mockBack = jest.fn();
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
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => mockBack() },
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

const STEPS = ['Blend the chipotles into a paste.', 'Toss the chicken in half the paste.', 'Grill the thighs.'];

let tree: ReactTestRenderer | null = null;
let tacos: string;

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  tacos = createRecipe('Tacos');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = tacos;
  mockPush.mockClear();
  mockBack.mockClear();
  mockAwake.clear();
  jest.mocked(activateKeepAwakeAsync).mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

function close() {
  act(() => tree?.unmount());
  tree = null;
}

const setSteps = (steps: string[] | null) => db.update(recipes).set({ steps }).where(eq(recipes.id, tacos)).run();
const setServings = (servings: number | null) => db.update(recipes).set({ servings }).where(eq(recipes.id, tacos)).run();
const addIngredients = (...lines: string[]) => lines.forEach((line) => addRecipeIngredient(tacos, line));

const hostTexts = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => String(n.type) === 'Text')
    .map((n) => [n.props.children].flat().join(''))
    .filter(Boolean);
/** The checkbox rows (steps and ingredients): the whole row is the Pressable. */
const checkboxes = (root: ReactTestRenderer) =>
  root.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function',
  );
/** A Pressable's style, unpressed. */
const rowStyle = (row: ReactTestInstance) =>
  StyleSheet.flatten(typeof row.props.style === 'function' ? row.props.style({ pressed: false }) : row.props.style);
const stepRows = (root: ReactTestRenderer) => checkboxes(root).filter((n) => /^Step \d+ of \d+, /.test(n.props.accessibilityLabel));
const ingredientRows = (root: ReactTestRenderer) => checkboxes(root).filter((n) => !/^Step \d+ of \d+, /.test(n.props.accessibilityLabel));
const checkbox = (root: ReactTestRenderer, label: string) => checkboxes(root).find((n) => n.props.accessibilityLabel === label)!;
const isChecked = (row: ReactTestInstance) => row.props.accessibilityState?.checked === true;
const tap = (row: ReactTestInstance) => act(() => row.props.onPress());
const textIn = (row: ReactTestInstance, text: string) =>
  row.find((n) => String(n.type) === 'Text' && [n.props.children].flat().join('') === text);
const textsIn = (row: ReactTestInstance) =>
  row.findAll((n) => String(n.type) === 'Text').map((n) => [n.props.children].flat().join(''));
/** The style of the nearest View around `node` that's sized: a step's number circle. */
const circleStyle = (node: ReactTestInstance) => {
  let n = node.parent;
  while (n && !(String(n.type) === 'View' && StyleSheet.flatten(n.props.style)?.width !== undefined)) n = n.parent;
  return StyleSheet.flatten(n!.props.style);
};
const progress = (root: ReactTestRenderer) => hostTexts(root).find((t) => /steps? done$/.test(t));
const upNextRows = (root: ReactTestRenderer) => stepRows(root).filter((row) => textsIn(row).includes('Up next'));
const byA11y = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');

describe('the Cook button on the recipe screen', () => {
  // Plan (spec 4.16) is a SurfaceButton too, always there.
  const isCook = (n: ReactTestInstance) => n.type === SurfaceButton && n.props.label === 'Cook';

  test('shows only when the recipe has steps', () => {
    let root = render(<RecipeScreen />);
    expect(root.root.findAll(isCook)).toHaveLength(0);
    close();

    setSteps([]);
    root = render(<RecipeScreen />);
    expect(root.root.findAll(isCook)).toHaveLength(0);
    close();

    setSteps(STEPS);
    root = render(<RecipeScreen />);
    const cook = root.root.find(isCook);
    expect(cook.props).toMatchObject({
      label: 'Cook',
      accessibilityLabel: 'Start cooking',
      icon: 'flame',
      iconTint: AisleColors.light[recipeHue(tacos)].strong,
      on: 'surface',
    });
  });

  test('a surface pill with ink text beside Add to a list, which takes the rest of the row', () => {
    setSteps(STEPS);
    const root = render(<RecipeScreen />);
    const host = root.root.find((n) => String(n.type) === 'View' && n.props.accessibilityLabel === 'Start cooking');
    expect(StyleSheet.flatten(host.props.style)).toMatchObject({ backgroundColor: Palette.light.surface, minHeight: Sizes.cta });
    expect(StyleSheet.flatten(textIn(host, 'Cook').props.style).color).toBe(Palette.light.ink);
    const glyph = host.find((n) => String(n.type) === 'Icon');
    expect(glyph.props).toMatchObject({ name: 'flame', tint: AisleColors.light[recipeHue(tacos)].strong });
    // Same row as Add to a list, which grows to take the rest; the row wraps when Plan doesn't fit too.
    const add = root.root.find((n) => n.type === PrimaryButton && n.props.label === 'Add to a list');
    const cook = root.root.find(isCook);
    expect(cook.parent!.findAll((n) => n.type === PrimaryButton).map((n) => n.props.label)).toEqual(['Add to a list']);
    expect(StyleSheet.flatten(cook.parent!.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    expect(StyleSheet.flatten(add.parent!.props.style)).toMatchObject({ flexGrow: 1 });
  });

  test('opens the cook screen with the stepper\'s servings, or just the id without servings', () => {
    setSteps(STEPS);
    let root = render(<RecipeScreen />);
    act(() => byA11y(root, 'Start cooking').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/cook', params: { id: tacos } });
    close();

    setServings(4);
    root = render(<RecipeScreen />);
    act(() => byA11y(root, 'Start cooking').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/cook', params: { id: tacos, servings: '4' } });
    act(() => byA11y(root, 'More').props.onPress());
    act(() => byA11y(root, 'More').props.onPress());
    act(() => byA11y(root, 'Start cooking').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/cook', params: { id: tacos, servings: '6' } });
  });
});

describe('Plan on the recipe screen (spec 4.16)', () => {
  test('a surface button after Add to a list and Cook, opening the plan modal for the recipe', () => {
    setSteps(STEPS);
    const root = render(<RecipeScreen />);
    const row = root.root.find((n) => n.type === SurfaceButton && n.props.label === 'Plan').parent!;
    expect(
      row.findAll((n) => n.type === PrimaryButton || n.type === SurfaceButton).map((n) => [n.props.label, n.props.icon]),
    ).toEqual([
      ['Add to a list', 'cart'],
      ['Cook', 'flame'],
      ['Plan', 'calendar'],
    ]);
    act(() => byA11y(root, 'Plan').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-recipe', params: { recipeId: tacos } });
  });

  test('without steps, Plan still shows; no badges until the recipe is planned', () => {
    const root = render(<RecipeScreen />);
    expect(byA11y(root, 'Plan')).toBeTruthy();
    expect(root.root.findAll((n) => n.props.testID === 'plan-badges')).toHaveLength(0);
  });

  test('the band shows a badge per upcoming entry, which opens the plan modal', () => {
    const householdId = db.select().from(recipes).where(eq(recipes.id, tacos)).get()!.householdId;
    const day = today();
    setSlot(householdId, day, 'dinner', { kind: 'recipe', recipeId: tacos });
    const root = render(<RecipeScreen />);
    const label = `Planned for ${dayName(day, 'short')} dinner`;
    act(() => byA11y(root, label).props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-recipe', params: { recipeId: tacos } });
  });
});

describe('the cook screen', () => {
  test('top bar: Done closes it; the name in headline over the progress line', () => {
    setSteps(STEPS);
    setServings(4);
    mockParams.servings = '6';
    const root = render(<CookScreen />);
    const name = root.root.find((n) => String(n.type) === 'Text' && n.props.children === 'Tacos');
    expect(name.props.accessibilityRole).toBe('header');
    expect(StyleSheet.flatten(name.props.style)).toMatchObject({ fontSize: Typography.headline.fontSize, fontWeight: '700' });
    const line = root.root.find((n) => String(n.type) === 'Text' && n.props.children === 'For 6 · 0 of 3 steps done');
    expect(StyleSheet.flatten(line.props.style)).toMatchObject({
      fontSize: Typography.footnote.fontSize,
      color: Palette.light.inkSecondary,
    });
    const done = byA11y(root, 'Done');
    expect(done.props.accessibilityRole).toBe('button');
    act(() => done.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('"N of M steps done" counts ticks, with "For N" only when the recipe has servings', () => {
    setSteps(STEPS);
    let root = render(<CookScreen />);
    expect(progress(root)).toBe('0 of 3 steps done');
    tap(stepRows(root)[0]);
    tap(stepRows(root)[2]);
    expect(progress(root)).toBe('2 of 3 steps done');
    tap(stepRows(root)[0]);
    expect(progress(root)).toBe('1 of 3 steps done');
    close();

    // With servings and no param, it's the recipe's own.
    setServings(4);
    root = render(<CookScreen />);
    expect(progress(root)).toBe('For 4 · 0 of 3 steps done');
  });

  test('every step is a checkbox row read as "Step N of M, …", numbered in a ringed 30 pt circle', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const rows = stepRows(root);
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
      'Step 1 of 3, Blend the chipotles into a paste.',
      'Step 2 of 3, Toss the chicken in half the paste.',
      'Step 3 of 3, Grill the thighs.',
    ]);
    expect(rows.map(isChecked)).toEqual([false, false, false]);
    const digit = textIn(rows[1], '2');
    expect(StyleSheet.flatten(digit.props.style).color).toBe(Palette.light.inkSecondary);
    expect(circleStyle(digit)).toMatchObject({
      width: 30,
      height: 30,
      borderColor: Palette.light.controlBorder,
      backgroundColor: Palette.light.surface,
    });
    const text = textIn(rows[1], STEPS[1]);
    expect(StyleSheet.flatten(text.props.style)).toMatchObject({
      fontFamily: Typography.cookStep.fontFamily,
      fontSize: 20,
      fontWeight: '500',
      lineHeight: 28,
      color: Palette.light.ink,
    });
    // The Method header: "3 steps" shown, read as one header.
    expect(hostTexts(root)).toEqual(expect.arrayContaining(['Method', '3 steps']));
    expect(root.root.findAll((n) => String(n.type) === 'Text' && n.props.accessibilityLabel === 'Method, 3 steps')).toHaveLength(1);
  });

  test('tapping a step ticks it (a primary circle with a check, dimmed text), and again unticks it', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    tap(stepRows(root)[1]);
    let row = stepRows(root)[1];
    expect(isChecked(row)).toBe(true);
    expect(textsIn(row)).not.toContain('2');
    const check = row.find((n) => String(n.type) === 'Icon');
    expect(check.props).toMatchObject({ name: 'checkmark', color: 'onPrimary' });
    expect(circleStyle(check)).toMatchObject({
      width: 30,
      backgroundColor: Palette.light.primary,
      borderColor: Palette.light.primary,
    });
    expect(StyleSheet.flatten(textIn(row, STEPS[1]).props.style).color).toBe(Palette.light.inkSecondary);
    // The others are untouched.
    expect(stepRows(root).map(isChecked)).toEqual([false, true, false]);

    tap(row);
    row = stepRows(root)[1];
    expect(isChecked(row)).toBe(false);
    expect(textsIn(row)).toContain('2');
    expect(row.findAll((n) => String(n.type) === 'Icon')).toHaveLength(0);
    expect(StyleSheet.flatten(textIn(row, STEPS[1]).props.style).color).toBe(Palette.light.ink);
  });

  test('"Up next" tints the first unticked step, moves as steps are ticked, and goes with all ticked', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const upNext = () => upNextRows(root).map((r) => r.props.accessibilityLabel);
    expect(upNext()).toEqual(['Step 1 of 3, Blend the chipotles into a paste.']);
    const tinted = upNextRows(root)[0];
    expect(rowStyle(tinted).backgroundColor).toBe(Palette.light.primarySoft);
    const caption = textIn(tinted, 'Up next');
    expect(StyleSheet.flatten(caption.props.style)).toMatchObject({
      fontSize: Typography.caption.fontSize,
      color: Palette.light.onPrimarySoft,
    });
    expect(rowStyle(stepRows(root)[1]).backgroundColor).toBeUndefined();

    tap(stepRows(root)[0]);
    expect(upNext()).toEqual(['Step 2 of 3, Toss the chicken in half the paste.']);
    // Ticking a later step out of order doesn't move it past an unticked one.
    tap(stepRows(root)[2]);
    expect(upNext()).toEqual(['Step 2 of 3, Toss the chicken in half the paste.']);
    tap(stepRows(root)[1]);
    expect(upNext()).toEqual([]);
    expect(stepRows(root).map((r) => rowStyle(r).backgroundColor)).toEqual([undefined, undefined, undefined]);
    // Unticking the first brings it back there.
    tap(stepRows(root)[0]);
    expect(upNext()).toEqual(['Step 1 of 3, Blend the chipotles into a paste.']);
  });

  test('ingredients tick and untick: filled check and the name struck through in inkSecondary', () => {
    setSteps(STEPS);
    addIngredients('2 lb chicken thighs', '1 onion');
    const root = render(<CookScreen />);
    expect(ingredientRows(root).map((r) => r.props.accessibilityLabel)).toEqual(['Chicken thighs, 2 lb', 'Onion, 1']);
    const nameStyle = () => StyleSheet.flatten(textIn(checkbox(root, 'Chicken thighs, 2 lb'), 'Chicken thighs').props.style);
    expect(nameStyle()).toMatchObject({ fontSize: 20, fontWeight: '500', lineHeight: 28, color: Palette.light.ink });
    expect(nameStyle().textDecorationLine).toBeUndefined();
    const amount = textIn(checkbox(root, 'Chicken thighs, 2 lb'), '2 lb');
    expect(StyleSheet.flatten(amount.props.style)).toMatchObject({ fontSize: Typography.amount.fontSize, color: Palette.light.inkSecondary });

    tap(checkbox(root, 'Chicken thighs, 2 lb'));
    expect(ingredientRows(root).map(isChecked)).toEqual([true, false]);
    expect(nameStyle()).toMatchObject({ color: Palette.light.inkSecondary, textDecorationLine: 'line-through' });
    const check = checkbox(root, 'Chicken thighs, 2 lb').find((n) => String(n.type) === 'Icon');
    expect(check.props).toMatchObject({ name: 'checkmark', color: 'onPrimary' });
    // Ingredients don't count as steps.
    expect(progress(root)).toBe('0 of 3 steps done');

    tap(checkbox(root, 'Chicken thighs, 2 lb'));
    expect(ingredientRows(root).map(isChecked)).toEqual([false, false]);
    expect(nameStyle().textDecorationLine).toBeUndefined();
  });

  test('amounts scale from the servings param; a bad param or no servings leaves them as written', () => {
    setSteps(STEPS);
    setServings(4);
    addIngredients('2 lb chicken thighs', '1 onion', 'salt');
    mockParams.servings = '6';
    let root = render(<CookScreen />);
    expect(ingredientRows(root).map((r) => r.props.accessibilityLabel)).toEqual(['Chicken thighs, 3 lb', 'Onion, 1½', 'Salt']);
    close();

    mockParams.servings = '2';
    root = render(<CookScreen />);
    expect(ingredientRows(root).map((r) => r.props.accessibilityLabel)).toEqual(['Chicken thighs, 1 lb', 'Onion, ½', 'Salt']);
    expect(progress(root)).toBe('For 2 · 0 of 3 steps done');
    close();

    mockParams.servings = 'lots';
    root = render(<CookScreen />);
    expect(ingredientRows(root).map((r) => r.props.accessibilityLabel)).toEqual(['Chicken thighs, 2 lb', 'Onion, 1', 'Salt']);
    expect(progress(root)).toBe('For 4 · 0 of 3 steps done');
    close();

    setServings(null);
    mockParams.servings = '6';
    root = render(<CookScreen />);
    expect(ingredientRows(root).map((r) => r.props.accessibilityLabel)).toEqual(['Chicken thighs, 2 lb', 'Onion, 1', 'Salt']);
    expect(progress(root)).toBe('0 of 3 steps done');
  });

  test('ticks are gone after closing and reopening, and nothing is saved', () => {
    setSteps(STEPS);
    addIngredients('1 onion');
    const before = db.select().from(recipes).where(eq(recipes.id, tacos)).get();
    let root = render(<CookScreen />);
    tap(stepRows(root)[0]);
    tap(checkbox(root, 'Onion, 1'));
    expect(progress(root)).toBe('1 of 3 steps done');
    close();

    root = render(<CookScreen />);
    expect(stepRows(root).map(isChecked)).toEqual([false, false, false]);
    expect(ingredientRows(root).map(isChecked)).toEqual([false]);
    expect(progress(root)).toBe('0 of 3 steps done');
    expect(db.select().from(recipes).where(eq(recipes.id, tacos)).get()).toEqual(before);
  });

  test('no ingredients: no Ingredients card, just the Method', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    expect(hostTexts(root)).not.toContain('Ingredients');
    expect(ingredientRows(root)).toHaveLength(0);
  });

  test('a missing recipe renders an empty screen', () => {
    mockParams.id = 'nope';
    const root = render(<CookScreen />);
    expect(hostTexts(root)).toEqual([]);
  });
});

describe('the cook screen keeps the screen on', () => {
  test('on while it is open, under its own tag, and off when it closes', () => {
    setSteps(STEPS);
    render(<CookScreen />);
    expect([...mockAwake]).toHaveLength(1);
    expect([...mockAwake][0]).toMatch(new RegExp(`^cook:${tacos}:`));
    close();
    expect(mockAwake.size).toBe(0);
  });

  test('honours Settings > Keep screen on being off', () => {
    setKeepScreenOn(false);
    setSteps(STEPS);
    render(<CookScreen />);
    expect(mockAwake.size).toBe(0);
    expect(activateKeepAwakeAsync).not.toHaveBeenCalled();
    act(() => setKeepScreenOn(true));
    expect(mockAwake.size).toBe(1);
  });
});

describe('cook helpers', () => {
  test('cookProgressLabel', () => {
    expect(cookProgressLabel(6, 2, 6)).toBe('For 6 · 2 of 6 steps done');
    expect(cookProgressLabel(null, 2, 6)).toBe('2 of 6 steps done');
    expect(cookProgressLabel(null, 0, 1)).toBe('0 of 1 step done');
    expect(cookProgressLabel(1, 1, 1)).toBe('For 1 · 1 of 1 step done');
  });

  test('upNextIndex', () => {
    expect(upNextIndex([false, false])).toBe(0);
    expect(upNextIndex([true, false, true])).toBe(1);
    expect(upNextIndex([true, true])).toBe(-1);
    expect(upNextIndex([])).toBe(-1);
  });
});
