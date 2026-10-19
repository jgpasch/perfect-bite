// Cooking mode (board 19): the recipe screen's Cook button and the cook screen.

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { PrimaryButton, SurfaceButton } from '@/components/button';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { AisleColors, Palette, Rounded, Sizes, Spacing, Typography } from '@/constants/theme';
import { db, recipes } from '@/db';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData } from '@/features/lists/lists';
import { today } from '@/features/meal-plan/week';
import { dayName } from '@/features/meal-plan/week-view';
import { setSlot } from '@/features/meal-plan/write';
import { setKeepScreenOn } from '@/features/settings/device-settings';
import { stepIngredientsBasis, type RecipeStepEntry } from '@/shared';
import { resetDb } from '@/test/db';

import CookScreen from '@/app/recipe/[id]/cook';
import RecipeScreen from '@/app/recipe/[id]/index';

import { allTicked, toggleAllUses, tickUses, stepAmount, stepUseText, tickKey, usesByIngredient } from '../cook-match';
import { addRecipeIngredient, createRecipe, recipeIngredientsQuery } from '../recipes';
import { stepMatch } from '../step-match';
import { cookProgressLabel, upNextIndex } from '../recipe-view';

const mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
let mockReduceMotion = false;
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
    useReducedMotion: () => mockReduceMotion,
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
  mockReduceMotion = false;
  mockWindow.fontScale = 1;
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

const setSteps = (steps: RecipeStepEntry[] | null) => db.update(recipes).set({ steps }).where(eq(recipes.id, tacos)).run();
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
/** The `Card` a step's checkbox row sits in. */
const stepCard = (row: ReactTestInstance) => {
  let n = row.parent;
  while (n && n.type !== Card) n = n.parent;
  return n!;
};
const stepCards = (root: ReactTestRenderer) => stepRows(root).map(stepCard);
/** The View the step cards are laid out in: the nearest one around a card with a gap. */
const stepColumn = (card: ReactTestInstance) => {
  let n = card.parent;
  while (n && StyleSheet.flatten(n.props.style)?.gap === undefined) n = n.parent;
  return n!;
};
const cardStyle = (card: ReactTestInstance) => StyleSheet.flatten(card.props.style) ?? {};
/** The step cards with the current step's 2 pt border. */
const currentCards = (root: ReactTestRenderer) => stepCards(root).filter((card) => cardStyle(card).borderWidth === 2);
const markDoneButtons = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === PrimaryButton && n.props.label === 'Mark step done');
/** An upcoming card's ingredient line: its footnote Text outside the checkbox row. */
const lineOf = (card: ReactTestInstance) =>
  card
    .findAll((n) => String(n.type) === 'Text' && StyleSheet.flatten(n.props.style)?.fontSize === Typography.footnote.fontSize)
    .map((n) => [n.props.children].flat().join(''));
/** The recipe screen's floating action dock: the pill. */
const dock = (root: ReactTestRenderer) => root.root.find((n) => String(n.type) === 'View' && n.props.testID === 'recipe-dock');
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
      layout: 'stacked',
    });
  });

  test('a compact surfaceMuted button in the dock, its glyph over a caption label in ink', () => {
    setSteps(STEPS);
    const root = render(<RecipeScreen />);
    const host = root.root.find((n) => String(n.type) === 'View' && n.props.accessibilityLabel === 'Start cooking');
    expect(StyleSheet.flatten(host.props.style)).toMatchObject({
      width: Sizes.stackedButton,
      minHeight: Sizes.minTapTarget,
      borderRadius: Rounded.full,
      backgroundColor: Palette.light.surfaceMuted,
    });
    expect(StyleSheet.flatten(host.props.style).flexDirection).toBeUndefined();
    const label = StyleSheet.flatten(textIn(host, 'Cook').props.style);
    expect(label).toMatchObject({ color: Palette.light.ink, fontSize: Typography.caption.fontSize });
    const glyph = host.find((n) => String(n.type) === 'Icon');
    expect(glyph.props).toMatchObject({ name: 'flame', tint: AisleColors.light[recipeHue(tacos)].strong });
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
  test('a stacked button in the dock after Add to a list and Cook, opening the plan modal for the recipe', () => {
    setSteps(STEPS);
    const root = render(<RecipeScreen />);
    const plan = root.root.find((n) => n.type === SurfaceButton && n.props.label === 'Plan');
    expect(plan.props).toMatchObject({ layout: 'stacked', iconTint: AisleColors.light[recipeHue(tacos)].strong });
    const row = dock(root);
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

describe('the action dock on the recipe screen (spec 4.5)', () => {
  const actions = (root: ReactTestRenderer) =>
    dock(root)
      .findAll((n) => n.type === PrimaryButton || n.type === SurfaceButton)
      .map((n) => n.props.label);
  const addToList = (root: ReactTestRenderer) => root.root.find((n) => n.type === PrimaryButton && n.props.label === 'Add to a list');
  const scrollPadding = (root: ReactTestRenderer) =>
    StyleSheet.flatten(root.root.findByType(ScrollView).props.contentContainerStyle).paddingBottom;
  /** The View the dock measures: its pill with the space around it. */
  const measured = (root: ReactTestRenderer) => {
    let n = dock(root).parent;
    while (n && !(String(n.type) === 'View' && typeof n.props.onLayout === 'function')) n = n.parent;
    return n!;
  };

  test('Add to a list, Cook and Plan with steps; no Cook without', () => {
    setSteps(STEPS);
    let root = render(<RecipeScreen />);
    expect(actions(root)).toEqual(['Add to a list', 'Cook', 'Plan']);
    close();
    setSteps(null);
    root = render(<RecipeScreen />);
    expect(actions(root)).toEqual(['Add to a list', 'Plan']);
  });

  test('the old row under the band is gone: no actions inside the scroll view', () => {
    setSteps(STEPS);
    addIngredients('2 cloves garlic');
    const root = render(<RecipeScreen />);
    const scroll = root.root.findByType(ScrollView);
    expect(scroll.findAll((n) => n.type === PrimaryButton || n.type === SurfaceButton)).toHaveLength(0);
    expect(scroll.findAll((n) => n.props.testID === 'recipe-dock')).toHaveLength(0);
    // The dock floats over the scroll view, pinned to the bottom.
    let overlay = dock(root).parent;
    while (overlay && StyleSheet.flatten(overlay.props.style)?.position !== 'absolute') overlay = overlay.parent;
    expect(StyleSheet.flatten(overlay!.props.style)).toMatchObject({ position: 'absolute', left: 0, right: 0, bottom: 0 });
    expect(overlay!.props.pointerEvents).toBe('box-none');
  });

  test('drawn like the tab bar: a surface pill with a hairline edge, 8 pt padding and gaps, soft shadow in light mode', () => {
    const root = render(<RecipeScreen />);
    expect(StyleSheet.flatten(dock(root).props.style)).toMatchObject({
      flexDirection: 'row',
      alignItems: 'stretch',
      padding: Spacing.sm,
      gap: Spacing.sm,
      borderRadius: Rounded.full,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: Palette.light.controlBorder,
      backgroundColor: Palette.light.surface,
      shadowOpacity: 0.08,
      shadowColor: Palette.light.ink,
    });
    // 16 pt from the sides and above the bottom (the safe area, at least 16 pt), on the screen's ground.
    expect(StyleSheet.flatten(measured(root).props.style)).toMatchObject({
      paddingHorizontal: Spacing.lg,
      paddingBottom: Spacing.lg,
      backgroundColor: Palette.light.background,
    });
    // Add to a list takes the room.
    expect(StyleSheet.flatten(addToList(root).parent!.props.style)).toMatchObject({ flex: 1 });
  });

  test('never clips with Large Dynamic Type: no fixed height, so it grows with a wrapped label', () => {
    setSteps(STEPS);
    const root = render(<RecipeScreen />);
    expect(StyleSheet.flatten(dock(root).props.style).height).toBeUndefined();
    expect(StyleSheet.flatten(measured(root).props.style).height).toBeUndefined();
    for (const label of ['Start cooking', 'Plan']) {
      const host = root.root.find((n) => String(n.type) === 'View' && n.props.accessibilityLabel === label);
      expect(StyleSheet.flatten(host.props.style).height).toBeUndefined();
    }
  });

  test('a short fade from transparent to the background above it, which takes no touches', () => {
    const root = render(<RecipeScreen />);
    const fade = root.root.find((n) => String(n.type) === 'View' && n.props.testID === 'recipe-dock-fade');
    expect(fade.props.pointerEvents).toBe('none');
    const style = StyleSheet.flatten(fade.props.style);
    expect(style.height).toBe(Spacing.xl);
    expect(style.experimental_backgroundImage).toBe(
      `linear-gradient(to bottom, ${Palette.light.background}00, ${Palette.light.background})`,
    );
  });

  test("the scroll view's content ends above the dock: its measured height plus a 16 pt gap", () => {
    const root = render(<RecipeScreen />);
    // Before it's measured: the CTA in its 8 pt padding over a 16 pt gap.
    expect(scrollPadding(root)).toBe(Sizes.cta + Spacing.sm * 2 + Spacing.lg + Spacing.lg);
    act(() => measured(root).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 120 } } }));
    expect(scrollPadding(root)).toBe(120 + Spacing.lg);
  });

  test('Add to a list is disabled with no ingredients, and opens the sheet at the stepper’s servings', () => {
    let root = render(<RecipeScreen />);
    expect(addToList(root).props.disabled).toBe(true);
    close();

    addIngredients('2 cloves garlic');
    setServings(4);
    root = render(<RecipeScreen />);
    expect(addToList(root).props.disabled).toBe(false);
    act(() => addToList(root).props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/add-to-list', params: { id: tacos } });
    act(() => byA11y(root, 'More').props.onPress());
    act(() => addToList(root).props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/add-to-list', params: { id: tacos, servings: '5' } });
  });

  test('a toast floats above the dock, not in the scroll view', () => {
    addIngredients('2 cloves garlic');
    const root = render(<RecipeScreen />);
    const row = root.root.find((n) => typeof n.props.onDelete === 'function' && n.props.ingredient !== undefined);
    act(() => row.props.onDelete());
    const message = root.root.find((n) => String(n.type) === 'Text' && [n.props.children].flat().join('') === 'Removed Garlic');
    expect(root.root.findByType(ScrollView).findAll((n) => n === message)).toHaveLength(0);
    // In the dock's overlay, before the fade and the pill.
    let overlay = measured(root).parent!;
    while (StyleSheet.flatten(overlay.props.style)?.position !== 'absolute') overlay = overlay.parent!;
    const order = overlay.findAll(
      (n) =>
        n === message || (String(n.type) === 'View' && (n.props.testID === 'recipe-dock-fade' || n.props.testID === 'recipe-dock')),
    );
    expect(order.map((n) => n.props.testID ?? 'toast')).toEqual(['toast', 'recipe-dock-fade', 'recipe-dock']);
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

  test('each step is its own card, 12 pt apart, its badge and text a checkbox read as "Step N of M, …"', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const rows = stepRows(root);
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
      'Step 1 of 3, Blend the chipotles into a paste.',
      'Step 2 of 3, Toss the chicken in half the paste.',
      'Step 3 of 3, Grill the thighs.',
    ]);
    expect(rows.map(isChecked)).toEqual([false, false, false]);
    const cards = stepCards(root);
    expect(new Set(cards).size).toBe(3);
    expect(cards.every((card) => stepColumn(card) === stepColumn(cards[0]))).toBe(true);
    expect(StyleSheet.flatten(stepColumn(cards[0]).props.style).gap).toBe(Spacing.md);
    // No Method card or header, and no "Up next" caption.
    expect(hostTexts(root)).not.toContain('Method');
    expect(hostTexts(root)).not.toContain('3 steps');
    expect(hostTexts(root)).not.toContain('Up next');
  });

  test('an upcoming step: an outlined controlBorder badge with its number, and the text in body', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const row = stepRows(root)[1];
    const digit = textIn(row, '2');
    expect(StyleSheet.flatten(digit.props.style).color).toBe(Palette.light.inkSecondary);
    expect(circleStyle(digit)).toMatchObject({
      width: 30,
      height: 30,
      borderWidth: Sizes.checkBorder,
      borderColor: Palette.light.controlBorder,
      backgroundColor: Palette.light.surface,
    });
    expect(StyleSheet.flatten(textIn(row, STEPS[1]).props.style)).toMatchObject({
      fontSize: Typography.body.fontSize,
      fontWeight: Typography.body.fontWeight,
      color: Palette.light.ink,
    });
    const card = stepCard(row);
    expect(cardStyle(card).borderWidth).toBeUndefined();
    expect(card.findAll((n) => n.type === PrimaryButton)).toHaveLength(0);
    // Without a match there's no ingredient line.
    expect(lineOf(card)).toEqual([]);
  });

  test('tapping a step marks it done (a primarySoft check, callout inkSecondary), and again unticks it', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    tap(stepRows(root)[1]);
    let row = stepRows(root)[1];
    expect(isChecked(row)).toBe(true);
    expect(textsIn(row)).not.toContain('2');
    const check = row.find((n) => String(n.type) === 'Icon');
    expect(check.props).toMatchObject({ name: 'checkmark', color: 'primary' });
    expect(circleStyle(check)).toMatchObject({ width: 30, backgroundColor: Palette.light.primarySoft });
    expect(StyleSheet.flatten(textIn(row, STEPS[1]).props.style)).toMatchObject({
      fontSize: Typography.callout.fontSize,
      color: Palette.light.inkSecondary,
    });
    expect(stepCard(row).findAll((n) => n.type === PrimaryButton)).toHaveLength(0);
    // The others are untouched.
    expect(stepRows(root).map(isChecked)).toEqual([false, true, false]);

    tap(row);
    row = stepRows(root)[1];
    expect(isChecked(row)).toBe(false);
    expect(textsIn(row)).toContain('2');
    expect(row.findAll((n) => String(n.type) === 'Icon')).toHaveLength(0);
    expect(StyleSheet.flatten(textIn(row, STEPS[1]).props.style)).toMatchObject({
      fontSize: Typography.body.fontSize,
      color: Palette.light.ink,
    });
  });

  test('the current step is the first unticked: a primary border, a filled badge, cookStep 600 and Mark step done', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const current = () =>
      stepRows(root)
        .filter((row) => currentCards(root).includes(stepCard(row)))
        .map((row) => row.props.accessibilityLabel);
    expect(current()).toEqual(['Step 1 of 3, Blend the chipotles into a paste.']);
    const card = currentCards(root)[0];
    expect(cardStyle(card)).toMatchObject({ borderWidth: Sizes.cookCurrentBorder, borderColor: Palette.light.primary });
    const row = stepRows(root)[0];
    const digit = textIn(row, '1');
    expect(StyleSheet.flatten(digit.props.style).color).toBe(Palette.light.onPrimary);
    expect(circleStyle(digit)).toMatchObject({ backgroundColor: Palette.light.primary, borderColor: Palette.light.primary });
    expect(StyleSheet.flatten(textIn(row, STEPS[0]).props.style)).toMatchObject({
      fontFamily: Typography.cookStep.fontFamily,
      fontSize: 20,
      fontWeight: '600',
      lineHeight: 28,
      color: Palette.light.ink,
    });
    // One full-width Mark step done, in the current card, read with the step's number.
    expect(markDoneButtons(root)).toHaveLength(1);
    expect(stepCard(markDoneButtons(root)[0])).toBe(card);
    expect(markDoneButtons(root)[0].props.accessibilityLabel).toBe('Mark step 1 done');
    expect(
      root.root.findAll((n) => String(n.type) === 'View' && n.props.accessibilityLabel === 'Mark step 1 done')[0].props
        .accessibilityRole,
    ).toBe('button');

    tap(stepRows(root)[0]);
    expect(current()).toEqual(['Step 2 of 3, Toss the chicken in half the paste.']);
    expect(markDoneButtons(root)[0].props.accessibilityLabel).toBe('Mark step 2 done');
    // Ticking a later step out of order doesn't move it past an unticked one.
    tap(stepRows(root)[2]);
    expect(current()).toEqual(['Step 2 of 3, Toss the chicken in half the paste.']);
    tap(stepRows(root)[1]);
    expect(current()).toEqual([]);
    expect(markDoneButtons(root)).toHaveLength(0);
    // Unticking the first brings it back there.
    tap(stepRows(root)[0]);
    expect(current()).toEqual(['Step 1 of 3, Blend the chipotles into a paste.']);
  });

  test('Mark step done ticks the current step and moves it on, updating the progress line', () => {
    setSteps(STEPS);
    setServings(4);
    const root = render(<CookScreen />);
    act(() => byA11y(root, 'Mark step 1 done').props.onPress());
    expect(stepRows(root).map(isChecked)).toEqual([true, false, false]);
    expect(progress(root)).toBe('For 4 · 1 of 3 steps done');
    act(() => byA11y(root, 'Mark step 2 done').props.onPress());
    act(() => byA11y(root, 'Mark step 3 done').props.onPress());
    expect(stepRows(root).map(isChecked)).toEqual([true, true, true]);
    expect(progress(root)).toBe('For 4 · 3 of 3 steps done');
    expect(markDoneButtons(root)).toHaveLength(0);
  });

  test('Mark step done scrolls the next current card into view once it lays out, at once under Reduce Motion', () => {
    setSteps(STEPS);
    const run = () => {
      const root = render(<CookScreen />);
      const scrollTo = jest.fn();
      root.root.findByType(ScrollView).instance.scrollTo = scrollTo;
      const layout = (node: ReactTestInstance, y: number) =>
        act(() => node.props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 358, height: 100 } } }));
      layout(stepColumn(stepCards(root)[0]), 200);
      // Laying out before any Mark step done doesn't scroll.
      layout(stepCards(root)[1], 90);
      expect(scrollTo).not.toHaveBeenCalled();

      act(() => byA11y(root, 'Mark step 1 done').props.onPress());
      // Another card laying out doesn't; the new current one does, once.
      layout(stepCards(root)[2], 300);
      expect(scrollTo).not.toHaveBeenCalled();
      layout(stepCards(root)[1], 70);
      layout(stepCards(root)[1], 70);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      const call = scrollTo.mock.calls[0][0];
      // Tapping a step (not the button) doesn't scroll, nor does the last Mark step done.
      tap(stepRows(root)[1]);
      layout(stepCards(root)[2], 120);
      act(() => byA11y(root, 'Mark step 3 done').props.onPress());
      layout(stepCards(root)[2], 120);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      close();
      return call;
    };
    expect(run()).toEqual({ y: 200 + 70 - Spacing.md, animated: true });
    mockReduceMotion = true;
    expect(run()).toEqual({ y: 200 + 70 - Spacing.md, animated: false });
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

describe('the cook screen with a step match (spec 4.5)', () => {
  const MATCH_STEPS = ['Toss the chicken with the garlic and lime juice.', 'Rest it.', 'Grill, then squeeze over the limes.'];

  /** Saves a match: per step, [ingredient name, share] pairs. `stale` saves a basis that doesn't match. */
  function setMatch(steps: [string, number | null][][], { stale = false } = {}) {
    const rows = recipeIngredientsQuery(tacos).all();
    const id = (name: string) => rows.find((r) => r.displayName === name)!.id;
    const basis = stale ? 'old' : stepIngredientsBasis(MATCH_STEPS, rows.map((r) => r.id));
    const stepIngredients = { v: 1 as const, basis, steps: steps.map((uses) => uses.map(([name, quantity]) => ({ id: id(name), quantity }))) };
    db.update(recipes).set({ stepIngredients }).where(eq(recipes.id, tacos)).run();
  }

  beforeEach(() => {
    setSteps(MATCH_STEPS);
    addIngredients('2 lb chicken thighs', '4 cloves garlic', '3 limes', '2 tbsp oil');
    setMatch([
      [
        ['chicken thighs', null],
        ['garlic', null],
        ['limes', 1],
      ],
      [],
      [
        ['chicken thighs', null],
        ['limes', 2],
      ],
    ]);
  });

  const fold = (root: ReactTestRenderer) => byA11y(root, fold.label(root));
  fold.label = (root: ReactTestRenderer) =>
    root.root.find((n) => typeof n.type !== 'string' && /^All ingredients, /.test(n.props.accessibilityLabel ?? '') && n.props.onPress)
      .props.accessibilityLabel as string;
  const stepIngredientLabels = (root: ReactTestRenderer) =>
    ingredientRows(root)
      .map((r) => r.props.accessibilityLabel as string)
      .filter((l) => / for step \d+$/.test(l));

  test('section headings (not shown yet) leave the steps, their numbers and the saved match as they were', () => {
    const plain = render(<CookScreen />);
    const before = { rows: stepRows(plain).map((r) => r.props.accessibilityLabel), texts: hostTexts(plain) };
    close();

    setSteps([{ section: 'Marinate' }, MATCH_STEPS[0], MATCH_STEPS[1], { section: 'Grilling', choice: true }, MATCH_STEPS[2], { section: 'Baking', choice: true }]);
    // The basis was saved from the step strings alone: adding headings keeps the match fresh.
    const recipe = db.select().from(recipes).where(eq(recipes.id, tacos)).get()!;
    expect(stepMatch(recipe, recipeIngredientsQuery(tacos).all()).state).toBe('fresh');
    const root = render(<CookScreen />);
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual(before.rows);
    // Each step still names the ingredients the match gave it.
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual([
      `Step 1 of 3, ${MATCH_STEPS[0]}, uses chicken thighs, garlic, limes`,
      `Step 2 of 3, ${MATCH_STEPS[1]}`,
      `Step 3 of 3, ${MATCH_STEPS[2]}, uses chicken thighs, limes`,
    ]);
    expect(hostTexts(root)).toEqual(before.texts);
    expect(progress(root)).toBe('0 of 3 steps done');
    for (const title of ['Marinate', 'Grilling', 'Baking']) expect(hostTexts(root)).not.toContain(title);
  });

  test('All ingredients is folded to one row with a count, and unfolds to the checklist for the visit', () => {
    const root = render(<CookScreen />);
    expect(hostTexts(root)).toEqual(expect.arrayContaining(['All ingredients', '4 · 0 ticked']));
    expect(hostTexts(root)).not.toContain('Ingredients');
    expect(fold.label(root)).toBe('All ingredients, 4, 0 ticked');
    expect(fold(root).props.accessibilityState).toEqual({ expanded: false });
    expect(ingredientRows(root).map((r) => r.props.accessibilityLabel)).not.toContain('Chicken thighs, 2 lb');

    tap(fold(root));
    expect(fold(root).props.accessibilityState).toEqual({ expanded: true });
    expect(checkbox(root, 'Chicken thighs, 2 lb')).toBeDefined();
    expect(checkbox(root, 'Limes, 3')).toBeDefined();
    tap(fold(root));
    expect(ingredientRows(root).map((r) => r.props.accessibilityLabel)).not.toContain('Chicken thighs, 2 lb');
  });

  test('the current step lists its ingredients with shares and "part"; done and upcoming steps list none', () => {
    const root = render(<CookScreen />);
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual([
      `Step 1 of 3, ${MATCH_STEPS[0]}, uses chicken thighs, garlic, limes`,
      `Step 2 of 3, ${MATCH_STEPS[1]}`,
      `Step 3 of 3, ${MATCH_STEPS[2]}, uses chicken thighs, limes`,
    ]);
    expect(stepIngredientLabels(root)).toEqual([
      'Chicken thighs, 2 lb, part, for step 1',
      'Garlic, 4 clove, for step 1',
      'Limes, 1 of 3 limes, for step 1',
    ]);
    const limes = checkbox(root, 'Limes, 1 of 3 limes, for step 1');
    expect(stepCard(limes)).toBe(currentCards(root)[0]);
    expect(textsIn(limes)).toEqual(['1 of 3 limes']);
    expect(textsIn(checkbox(root, 'Chicken thighs, 2 lb, part, for step 1'))).toEqual(['2 lb chicken thighs, part']);
    // A 44 pt pill.
    expect(rowStyle(limes).minHeight).toBe(44);
    // The pills come before Mark step done.
    const texts = textsIn(currentCards(root)[0]);
    expect(texts.indexOf('Mark step done')).toBeGreaterThan(texts.indexOf('1 of 3 limes'));

    // Step 1 done hides its rows; step 2 (no ingredients) is current with none; then step 3's.
    tap(stepRows(root)[0]);
    expect(stepIngredientLabels(root)).toEqual([]);
    expect(markDoneButtons(root)[0].props.accessibilityLabel).toBe('Mark step 2 done');
    tap(stepRows(root)[1]);
    expect(stepIngredientLabels(root)).toEqual(['Chicken thighs, 2 lb, part, for step 3', 'Limes, 2 of 3 limes, for step 3']);
  });

  test('an upcoming step names its ingredients on one footnote line, hidden from VoiceOver', () => {
    const root = render(<CookScreen />);
    const cards = stepCards(root);
    expect(lineOf(cards[2])).toEqual(['2 lb chicken thighs, part · 2 of 3 limes']);
    // No ingredients, no line; the current card shows rows, not a line.
    expect(lineOf(cards[1])).toEqual([]);
    expect(lineOf(cards[0])).toEqual([]);
    const line = cards[2].find((n) => String(n.type) === 'Text' && n.props.children === '2 lb chicken thighs, part · 2 of 3 limes');
    expect(StyleSheet.flatten(line.props.style)).toMatchObject({
      fontSize: Typography.footnote.fontSize,
      color: Palette.light.inkSecondary,
    });
    expect(line.props.accessibilityElementsHidden).toBe(true);
    // Lined up with the step's text: past the badge and the gap.
    expect(StyleSheet.flatten(line.props.style).marginLeft).toBe(Spacing.lg + Sizes.cookStepCheck + Spacing.md);
    // A done step shows no line either.
    tap(stepRows(root)[2]);
    expect(lineOf(stepCards(root)[2])).toEqual([]);
  });

  test('split amounts scale with the servings, in the rows and the upcoming line', () => {
    setServings(4);
    mockParams.servings = '8';
    const root = render(<CookScreen />);
    expect(stepIngredientLabels(root)).toEqual([
      'Chicken thighs, 4 lb, part, for step 1',
      'Garlic, 8 clove, for step 1',
      'Limes, 2 of 6 limes, for step 1',
    ]);
    expect(lineOf(stepCards(root)[2])).toEqual(['4 lb chicken thighs, part · 4 of 6 limes']);
    tap(stepRows(root)[0]);
    tap(stepRows(root)[1]);
    expect(stepIngredientLabels(root)).toEqual(['Chicken thighs, 4 lb, part, for step 3', 'Limes, 4 of 6 limes, for step 3']);
  });

  test('Mark step done ticks the step\'s ingredients too', () => {
    const root = render(<CookScreen />);
    act(() => byA11y(root, 'Mark step 1 done').props.onPress());
    tap(fold(root));
    expect(isChecked(checkbox(root, 'Garlic, 4 clove'))).toBe(true);
    expect(fold.label(root)).toBe('All ingredients, 4, 1 ticked');
    expect(progress(root)).toBe('1 of 3 steps done');
  });

  describe('the current step\'s ingredient pills', () => {
    /** The current card's pills: its checkboxes other than the step's own row. */
    const pills = (root: ReactTestRenderer) =>
      currentCards(root)[0].findAll(
        (n) =>
          typeof n.type !== 'string' &&
          n.props.accessibilityRole === 'checkbox' &&
          typeof n.props.onPress === 'function' &&
          / for step \d+$/.test(n.props.accessibilityLabel),
      );
    /** The View the pills sit in. */
    const pillBox = (pill: ReactTestInstance) => pill.parent!.parent!;
    const pillText = (pill: ReactTestInstance) =>
      pill.find((n) => String(n.type) === 'Text' && StyleSheet.flatten(n.props.style)?.fontSize === Typography.callout.fontSize);

    test('pill text is amount first: plain, share and part uses, scaled', () => {
      addIngredients('2 tbsp butter');
      setMatch([[['chicken thighs', null], ['garlic', null], ['limes', 1], ['butter', null]], [], [['chicken thighs', null], ['limes', 2]]]);
      let root = render(<CookScreen />);
      expect(pills(root).map((p) => textsIn(p))).toEqual([
        ['2 lb chicken thighs, part'],
        ['4 clove garlic'],
        ['1 of 3 limes'],
        ['2 tbsp butter'],
      ]);
      // VoiceOver labels are as before, each pill a checkbox with its state.
      expect(pills(root).map((p) => p.props.accessibilityLabel)).toEqual([
        'Chicken thighs, 2 lb, part, for step 1',
        'Garlic, 4 clove, for step 1',
        'Limes, 1 of 3 limes, for step 1',
        'Butter, 2 tbsp, for step 1',
      ]);
      expect(pills(root).map((p) => p.props.accessibilityState)).toEqual([
        { checked: false },
        { checked: false },
        { checked: false },
        { checked: false },
      ]);
      close();

      setServings(4);
      mockParams.servings = '8';
      root = render(<CookScreen />);
      expect(pills(root).map((p) => textsIn(p))).toEqual([
        ['4 lb chicken thighs, part'],
        ['8 clove garlic'],
        ['2 of 6 limes'],
        // Scaled amounts take the friendlier unit, as everywhere in cook mode.
        ['¼ cup butter'],
      ]);
    });

    test('a surfaceMuted full-round pill at least 44 pt tall with a 22 pt check, wrapping under the text', () => {
      const root = render(<CookScreen />);
      const [chicken] = pills(root);
      expect(rowStyle(chicken)).toMatchObject({
        minHeight: Sizes.minTapTarget,
        borderRadius: Rounded.full,
        backgroundColor: Palette.light.surfaceMuted,
        alignSelf: 'flex-start',
      });
      expect(chicken.findByType(CheckCircle).props).toMatchObject({ checked: false, size: Sizes.cookIngredientCheck });
      expect(StyleSheet.flatten(pillText(chicken).props.style).color).toBe(Palette.light.ink);
      // A wrapping row, indented to line up with the step's text.
      expect(StyleSheet.flatten(pillBox(chicken).props.style)).toMatchObject({
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginLeft: Spacing.lg + Sizes.cookStepCheck + Spacing.md,
      });
      // No more inset rows with a name and an amount.
      expect(currentCards(root)[0].findAll((n) => String(n.type) === 'Text' && n.props.children === 'Chicken thighs')).toHaveLength(0);
    });

    test('tapping a pill ticks and unticks that use; All ingredients follows', () => {
      const root = render(<CookScreen />);
      const garlic = () => checkbox(root, 'Garlic, 4 clove, for step 1');
      tap(garlic());
      expect(isChecked(garlic())).toBe(true);
      expect(garlic().findByType(CheckCircle).props.checked).toBe(true);
      expect(StyleSheet.flatten(pillText(garlic()).props.style).color).toBe(Palette.light.inkSecondary);
      expect(fold.label(root)).toBe('All ingredients, 4, 1 ticked');
      expect(hostTexts(root)).toContain('4 · 1 ticked');

      // Limes have a use in step 3 too, so ticking this one leaves the row unticked.
      tap(checkbox(root, 'Limes, 1 of 3 limes, for step 1'));
      expect(fold.label(root)).toBe('All ingredients, 4, 1 ticked');
      // The step doesn't tick with its pills.
      tap(checkbox(root, 'Chicken thighs, 2 lb, part, for step 1'));
      expect(progress(root)).toBe('0 of 3 steps done');

      tap(garlic());
      expect(isChecked(garlic())).toBe(false);
      expect(StyleSheet.flatten(pillText(garlic()).props.style).color).toBe(Palette.light.ink);
      expect(fold.label(root)).toBe('All ingredients, 4, 0 ticked');
    });

    test('ticking from All ingredients ticks the pill', () => {
      const root = render(<CookScreen />);
      tap(fold(root));
      tap(checkbox(root, 'Limes, 3'));
      expect(isChecked(checkbox(root, 'Limes, 1 of 3 limes, for step 1'))).toBe(true);
    });

    test('at the largest text sizes the pills go one per line', () => {
      mockWindow.fontScale = 2.35;
      const root = render(<CookScreen />);
      const all = pills(root);
      expect(all).toHaveLength(3);
      expect(StyleSheet.flatten(pillBox(all[0]).props.style)).toMatchObject({ flexDirection: 'column' });
      expect(StyleSheet.flatten(pillBox(all[0]).props.style).flexWrap).toBeUndefined();
      for (const pill of all) expect(rowStyle(pill).alignSelf).toBe('stretch');
    });

    test('just under the largest sizes they still wrap', () => {
      mockWindow.fontScale = 1.95;
      const root = render(<CookScreen />);
      expect(StyleSheet.flatten(pillBox(pills(root)[0]).props.style)).toMatchObject({ flexWrap: 'wrap' });
      expect(rowStyle(pills(root)[0]).alignSelf).toBe('flex-start');
    });
  });

  test('with no match, upcoming cards have no line and the current card no ingredients', () => {
    db.update(recipes).set({ stepIngredients: null }).where(eq(recipes.id, tacos)).run();
    const root = render(<CookScreen />);
    expect(stepCards(root).map(lineOf)).toEqual([[], [], []]);
    const current = currentCards(root)[0];
    expect(current.findAll((n) => n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function')).toHaveLength(1);
    expect(markDoneButtons(root)).toHaveLength(1);
  });

  test('the source credit sits on the ground under the last card, lined up with its text', () => {
    db.update(recipes).set({ sourceUrl: 'https://www.seriouseats.com/tacos' }).where(eq(recipes.id, tacos)).run();
    const root = render(<CookScreen />);
    const credit = root.root.find((n) => n.props.testID === 'recipe-credit' && typeof n.props.onPress === 'function');
    const cards = stepCards(root);
    // In the steps' column, in no card, after the last step's text.
    expect(stepColumn(cards[0]).findAll((n) => n === credit)).toHaveLength(1);
    expect(cards.some((card) => card.findAll((n) => n === credit).length > 0)).toBe(false);
    const texts = hostTexts(root);
    expect(texts.indexOf('From seriouseats.com')).toBeGreaterThan(texts.indexOf(MATCH_STEPS[2]));
    expect(texts.indexOf('From seriouseats.com')).toBeLessThan(texts.indexOf('Also needed'));
    expect(rowStyle(credit)).toMatchObject({ marginHorizontal: Spacing.lg, paddingHorizontal: Spacing.lg });
    expect(rowStyle(credit).borderTopWidth).toBeUndefined();
  });

  test('Also needed lists the ingredients in no step, after the steps', () => {
    const root = render(<CookScreen />);
    const texts = hostTexts(root);
    expect(texts).toEqual(expect.arrayContaining(['Also needed', 'Not in a step']));
    expect(texts.indexOf('Also needed')).toBeGreaterThan(texts.indexOf(MATCH_STEPS[2]));
    expect(checkbox(root, 'Oil, 2 tbsp')).toBeDefined();
  });

  test('ticking a step ticks its ingredients; unticking it leaves them; All ingredients follows its uses', () => {
    const root = render(<CookScreen />);
    tap(fold(root));
    tap(stepRows(root)[0]);
    // Garlic's only use is ticked; chicken and limes still have one to go.
    expect(isChecked(checkbox(root, 'Garlic, 4 clove'))).toBe(true);
    expect(isChecked(checkbox(root, 'Limes, 3'))).toBe(false);
    expect(fold.label(root)).toBe('All ingredients, 4, 1 ticked');

    // Unticked, step 1 is current again, its rows still ticked.
    tap(stepRows(root)[0]);
    expect(isChecked(stepRows(root)[0])).toBe(false);
    expect(isChecked(checkbox(root, 'Garlic, 4 clove, for step 1'))).toBe(true);
    expect(isChecked(checkbox(root, 'Limes, 1 of 3 limes, for step 1'))).toBe(true);

    // Ticking an All ingredients row ticks every use; again unticks them all.
    tap(checkbox(root, 'Limes, 3'));
    expect(isChecked(checkbox(root, 'Limes, 3'))).toBe(true);
    tap(checkbox(root, 'Limes, 3'));
    expect(isChecked(checkbox(root, 'Limes, 3'))).toBe(false);
    expect(isChecked(checkbox(root, 'Limes, 1 of 3 limes, for step 1'))).toBe(false);
    tap(checkbox(root, 'Limes, 3'));
    // With step 3 current, its limes are ticked from All ingredients; its chicken isn't.
    tap(stepRows(root)[1]);
    tap(stepRows(root)[0]);
    expect(isChecked(checkbox(root, 'Limes, 2 of 3 limes, for step 3'))).toBe(true);
    expect(isChecked(checkbox(root, 'Chicken thighs, 2 lb, part, for step 3'))).toBe(false);

    // Also needed's tick is oil's only use.
    tap(checkbox(root, 'Oil, 2 tbsp'));
    expect(fold.label(root)).toBe('All ingredients, 4, 3 ticked');
    // Steps count as before; ingredients don't.
    expect(progress(root)).toBe('2 of 3 steps done');
  });

  test('a stale match is still shown', () => {
    setMatch([[['garlic', null]], [], []], { stale: true });
    const root = render(<CookScreen />);
    expect(stepIngredientLabels(root)).toEqual(['Garlic, 4 clove, for step 1']);
    expect(hostTexts(root)).toContain('All ingredients');
  });

  test('with no match, the screen is today\'s', () => {
    db.update(recipes).set({ stepIngredients: null }).where(eq(recipes.id, tacos)).run();
    const root = render(<CookScreen />);
    expect(hostTexts(root)).toContain('Ingredients');
    expect(hostTexts(root)).not.toContain('All ingredients');
    expect(hostTexts(root)).not.toContain('Also needed');
    expect(stepIngredientLabels(root)).toEqual([]);
    expect(stepRows(root)[0].props.accessibilityLabel).toBe(`Step 1 of 3, ${MATCH_STEPS[0]}`);
  });

  test('cook-match helpers', () => {
    const recipe = db.select().from(recipes).where(eq(recipes.id, tacos)).get()!;
    const match = stepMatch(recipe, recipeIngredientsQuery(tacos).all());
    const uses = usesByIngredient(match);
    const limes = match.steps[0][2].ingredient;
    expect(uses.get(limes.id)).toEqual([tickKey(0, limes.id), tickKey(2, limes.id)]);
    const oil = match.unplaced[0];
    expect(uses.get(oil.id)).toEqual([tickKey('also', oil.id)]);
    let ticked = tickUses(new Set(), [tickKey(0, limes.id)]);
    expect(allTicked(ticked, uses.get(limes.id)!)).toBe(false);
    ticked = toggleAllUses(ticked, uses.get(limes.id)!);
    expect(allTicked(ticked, uses.get(limes.id)!)).toBe(true);
    expect(allTicked(toggleAllUses(ticked, uses.get(limes.id)!), uses.get(limes.id)!)).toBe(false);
    expect(allTicked(ticked, [])).toBe(false);

    const salt = { displayName: 'salt', quantity: null, unit: null };
    expect(stepAmount(salt, null, true, null, null)).toEqual({ text: '', spoken: '' });
    const flour = { displayName: 'flour', quantity: 2, unit: 'cup' as const };
    expect(stepAmount(flour, 0.5, true, null, null)).toEqual({ text: '½ cup of 2', spoken: '½ cup of 2 cup flour' });
    expect(stepAmount(flour, null, false, 4, 2)).toEqual({ text: '4 cup', spoken: '4 cup' });
  });

  test('stepUseText: amount first, shares "of", splits "part", bare names, scaled', () => {
    const butter = { displayName: 'butter', quantity: 2, unit: 'tbsp' as const };
    expect(stepUseText(butter, null, false, null, null)).toBe('2 tbsp butter');
    expect(stepUseText(butter, null, true, null, null)).toBe('2 tbsp butter, part');
    expect(stepUseText({ displayName: 'limes', quantity: 3, unit: null }, 1, true, null, null)).toBe('1 of 3 limes');
    expect(stepUseText({ displayName: 'spaghetti', quantity: null, unit: null }, null, true, null, null)).toBe('spaghetti');
    // A share on an ingredient with no quantity reads as the bare name.
    expect(stepUseText({ displayName: 'salt', quantity: null, unit: null }, 1, false, null, null)).toBe('salt');
    // Scaled to the servings, kitchen-rounded.
    expect(stepUseText({ displayName: 'lemon', quantity: 1, unit: null }, null, false, 6, 4)).toBe('1½ lemon');
    expect(stepUseText({ displayName: 'limes', quantity: 3, unit: null }, 1, true, 8, 4)).toBe('2 of 6 limes');
    expect(stepUseText(butter, null, false, 1, 4)).toBe('1½ tsp butter');
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
