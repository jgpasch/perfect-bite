// Cooking mode (board 19): the recipe screen's Cook button and the cook screen.

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { activateKeepAwakeAsync } from 'expo-keep-awake';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Button, PrimaryButton, SurfaceButton } from '@/components/button';
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
import { setCookViewStyle } from '@/features/recipes/cook-style';
import { es } from '@/i18n/es';
import { stepIngredientsBasis, type RecipeStepEntry } from '@/shared';
import { resetDb } from '@/test/db';

import CookScreen from '@/app/recipe/[id]/cook';
import RecipeScreen from '@/app/recipe/[id]/index';

import {
  allTicked,
  cookPlan,
  toggleAllUses,
  tickUses,
  stepAmount,
  stepUseText,
  tickKey,
  usesByIngredient,
  withCookPick,
} from '../cook-match';
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
/** The timeline row a step's checkbox (its number) sits in: the nearest View around it that reports its layout. */
const stepBlock = (row: ReactTestInstance) => {
  let n = row.parent;
  while (n && !(String(n.type) === 'View' && typeof n.props.onLayout === 'function')) n = n.parent;
  return n!;
};
const stepBlocks = (root: ReactTestRenderer) => stepRows(root).map(stepBlock);
/** The View the step rows are laid out in: the nearest one around a row with a gap (past the row's own wrapper). */
const stepColumn = (block: ReactTestInstance) => {
  let n = block.parent;
  while (n && (n.props.onLayout === block.props.onLayout || StyleSheet.flatten(n.props.style)?.gap === undefined)) n = n.parent;
  return n!;
};
const cardStyle = (card: ReactTestInstance) => StyleSheet.flatten(card.props.style) ?? {};
/** The current step's row: the one labelled NOW. */
const currentBlocks = (root: ReactTestRenderer) => stepBlocks(root).filter((block) => textsIn(block).includes('NOW'));
const markDoneButtons = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === PrimaryButton && n.props.label === 'Mark step done');
/** A ticked step's folded line: the button that reopens it, labelled with its text. */
const foldLine = (block: ReactTestInstance) =>
  block.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')[0];
/** A step row's ingredient pills. */
const pillsIn = (block: ReactTestInstance) =>
  block.findAll(
    (n) =>
      typeof n.type !== 'string' &&
      n.props.accessibilityRole === 'checkbox' &&
      typeof n.props.onPress === 'function' &&
      / for step \d+$/.test(n.props.accessibilityLabel),
  );
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

  test('every step is open in its own surface card, 12 pt apart, its number a 44 pt checkbox read as "Step N of M, …"', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const rows = stepRows(root);
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
      'Step 1 of 3, Blend the chipotles into a paste.',
      'Step 2 of 3, Toss the chicken in half the paste.',
      'Step 3 of 3, Grill the thighs.',
    ]);
    expect(rows.map(isChecked)).toEqual([false, false, false]);
    expect(rowStyle(rows[0])).toMatchObject({ minWidth: Sizes.minTapTarget, minHeight: Sizes.minTapTarget });
    const blocks = stepBlocks(root);
    expect(new Set(blocks).size).toBe(3);
    expect(blocks.every((block) => stepColumn(block) === stepColumn(blocks[0]))).toBe(true);
    expect(StyleSheet.flatten(stepColumn(blocks[0]).props.style).gap).toBe(Spacing.md);
    // Each step is a surface card on the ground, and every step's whole text shows.
    expect(blocks.map((block) => cardStyle(block))).toEqual(
      blocks.map(() => expect.objectContaining({ backgroundColor: Palette.light.surface, borderRadius: Rounded.card })),
    );
    expect(StyleSheet.flatten(root.root.findByType(ScrollView).parent!.props.style).backgroundColor).toBe(Palette.light.background);
    expect(hostTexts(root)).toEqual(expect.arrayContaining(STEPS));
    // No timeline rail.
    expect(root.root.findAll((n) => String(n.type) === 'View' && StyleSheet.flatten(n.props.style)?.width === 2)).toHaveLength(0);
    // No Method card or header, and no "Up next" caption.
    expect(hostTexts(root)).not.toContain('Method');
    expect(hostTexts(root)).not.toContain('3 steps');
    expect(hostTexts(root)).not.toContain('Up next');
  });

  test('an upcoming step: an outlined controlBorder circle, STEP N, and the text in cookStepText, not a target', () => {
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
    const block = stepBlock(row);
    expect(cardStyle(block)).toMatchObject({ borderColor: 'transparent' });
    expect(StyleSheet.flatten(textIn(block, 'STEP 2').props.style)).toMatchObject({
      fontSize: Typography.caption.fontSize,
      color: Palette.light.inkSecondary,
    });
    const text = textIn(block, STEPS[1]);
    expect(StyleSheet.flatten(text.props.style)).toMatchObject({
      fontSize: 17,
      fontWeight: '400',
      lineHeight: 26,
      color: Palette.light.ink,
    });
    // VoiceOver reads it in the checkbox's label, so the text itself is hidden.
    let hidden: ReactTestInstance | null = text;
    while (hidden && hidden !== block && hidden.props.accessibilityElementsHidden !== true) hidden = hidden.parent;
    expect(hidden?.props.accessibilityElementsHidden).toBe(true);
    expect(textsIn(block)).not.toContain('NOW');
    expect(block.findAll((n) => n.type === PrimaryButton)).toHaveLength(0);
    // The number is the only target: tapping the text can't tick it.
    expect(block.findAll((n) => typeof n.type !== 'string' && typeof n.props.onPress === 'function')).toEqual([row]);
  });

  test('ticking a step folds it to one line (a filled primary check, callout inkSecondary); a tap reopens it', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    tap(stepRows(root)[1]);
    let row = stepRows(root)[1];
    expect(isChecked(row)).toBe(true);
    expect(textsIn(row)).not.toContain('2');
    const check = row.find((n) => String(n.type) === 'Icon');
    expect(check.props).toMatchObject({ name: 'checkmark', color: 'onPrimary' });
    expect(circleStyle(check)).toMatchObject({ width: 30, backgroundColor: Palette.light.primary });
    // Folded: the text on one line, a chevron, read as a collapsed button.
    let line = foldLine(stepBlock(row));
    expect(line.props).toMatchObject({ accessibilityLabel: STEPS[1], accessibilityState: { expanded: false } });
    const folded = textIn(line, STEPS[1]);
    expect(folded.props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(folded.props.style)).toMatchObject({
      fontSize: Typography.callout.fontSize,
      color: Palette.light.inkSecondary,
    });
    expect(line.find((n) => String(n.type) === 'Icon').props.name).toBe('chevron.down');
    expect(stepBlock(row).findAll((n) => n.type === PrimaryButton)).toHaveLength(0);
    // The others are untouched.
    expect(stepRows(root).map(isChecked)).toEqual([false, true, false]);

    // Tapping the line reopens it: the whole text in body, still ticked; again folds it.
    tap(line);
    line = foldLine(stepBlock(stepRows(root)[1]));
    expect(line.props.accessibilityState).toEqual({ expanded: true });
    expect(textIn(line, STEPS[1]).props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(textIn(line, STEPS[1]).props.style)).toMatchObject({
      fontSize: Typography.body.fontSize,
      color: Palette.light.inkSecondary,
    });
    expect(line.find((n) => String(n.type) === 'Icon').props.name).toBe('chevron.up');
    expect(isChecked(stepRows(root)[1])).toBe(true);
    tap(line);
    expect(foldLine(stepBlock(stepRows(root)[1])).props.accessibilityState).toEqual({ expanded: false });

    // The number unticks it, open again with no fold line.
    tap(stepRows(root)[1]);
    row = stepRows(root)[1];
    expect(isChecked(row)).toBe(false);
    expect(textsIn(row)).toContain('2');
    expect(row.findAll((n) => String(n.type) === 'Icon')).toHaveLength(0);
    expect(foldLine(stepBlock(row))).toBeUndefined();
    expect(StyleSheet.flatten(textIn(stepBlock(row), STEPS[1]).props.style)).toMatchObject({
      fontSize: Typography.body.fontSize,
      color: Palette.light.ink,
    });
  });

  test('a reopened step folds again once ticked anew', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    tap(stepRows(root)[0]);
    tap(foldLine(stepBlock(stepRows(root)[0])));
    // Unticked and ticked again, it rests folded.
    tap(stepRows(root)[0]);
    tap(stepRows(root)[0]);
    expect(foldLine(stepBlock(stepRows(root)[0])).props.accessibilityState).toEqual({ expanded: false });
  });

  test('the current step is the first unticked: a primary-bordered card, a filled circle, NOW, cookStepCurrent and Mark step done', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const current = () => currentBlocks(root).map((block) => stepRows(root).find((row) => stepBlock(row) === block)!.props.accessibilityLabel);
    expect(current()).toEqual(['Step 1 of 3, Blend the chipotles into a paste.']);
    const block = currentBlocks(root)[0];
    const row = stepRows(root)[0];
    const digit = textIn(row, '1');
    expect(StyleSheet.flatten(digit.props.style).color).toBe(Palette.light.onPrimary);
    expect(circleStyle(digit)).toMatchObject({ borderWidth: 0, backgroundColor: Palette.light.primary });
    const text = textIn(block, STEPS[0]);
    expect(StyleSheet.flatten(text.props.style)).toMatchObject({
      fontFamily: Typography.cookStepCurrent.fontFamily,
      fontSize: 20,
      fontWeight: '500',
      lineHeight: 30,
      color: Palette.light.ink,
    });
    // NOW (caption primary) over the text, in a surface card with the card radius and a primary border.
    const now = textIn(block, 'NOW');
    expect(StyleSheet.flatten(now.props.style)).toMatchObject({ fontSize: Typography.caption.fontSize, color: Palette.light.primary });
    expect(cardStyle(block)).toMatchObject({
      backgroundColor: Palette.light.surface,
      borderRadius: Rounded.card,
      borderWidth: Sizes.cookCurrentBorder,
      borderColor: Palette.light.primary,
    });
    // One full-width Mark step done, in the current step, read with the step's number.
    expect(markDoneButtons(root)).toHaveLength(1);
    expect(stepBlock(markDoneButtons(root)[0])).toBe(block);
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
    // The step it ticked folds to its line, which reopens it.
    expect(foldLine(stepBlocks(root)[0]).props.accessibilityState).toEqual({ expanded: false });
    tap(foldLine(stepBlocks(root)[0]));
    expect(foldLine(stepBlocks(root)[0]).props.accessibilityState).toEqual({ expanded: true });
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
      layout(stepColumn(stepBlocks(root)[0]), 200);
      // Laying out before any Mark step done doesn't scroll.
      layout(stepBlocks(root)[1], 90);
      expect(scrollTo).not.toHaveBeenCalled();

      act(() => byA11y(root, 'Mark step 1 done').props.onPress());
      // Another step laying out doesn't; the new current one does, once.
      layout(stepBlocks(root)[2], 300);
      expect(scrollTo).not.toHaveBeenCalled();
      layout(stepBlocks(root)[1], 70);
      layout(stepBlocks(root)[1], 70);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      const call = scrollTo.mock.calls[0][0];
      // Ticking a step by its number (not the button) doesn't scroll, nor does the last Mark step done.
      tap(stepRows(root)[1]);
      layout(stepBlocks(root)[2], 120);
      act(() => byA11y(root, 'Mark step 3 done').props.onPress());
      layout(stepBlocks(root)[2], 120);
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

describe('the cook screen on the sheet (Cook view)', () => {
  beforeEach(() => setCookViewStyle('sheet'));

  /** The screen's root View, under the safe area provider. */
  const page = (root: ReactTestRenderer) => root.root.findByType(ScrollView).parent!;

  test('the page is surface, the ✕ on background, and the steps lie between hairlines with no gap and no cards', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    expect(StyleSheet.flatten(page(root).props.style).backgroundColor).toBe(Palette.light.surface);
    expect(rowStyle(byA11y(root, 'Done')).backgroundColor).toBe(Palette.light.background);
    const blocks = stepBlocks(root);
    expect(StyleSheet.flatten(stepColumn(blocks[0]).props.style).gap).toBe(0);
    for (const block of blocks) {
      expect(cardStyle(block)).toMatchObject({ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Palette.light.border });
      expect(cardStyle(block).backgroundColor).toBeUndefined();
      expect(block.findAll((n) => n.type === Card)).toHaveLength(0);
    }
  });

  test('each number is a big numeral checkbox: primary for the current step, inkSecondary after; done, a filled check', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const numeral = (i: number) => textIn(stepRows(root)[i], String(i + 1));
    expect(StyleSheet.flatten(numeral(0).props.style)).toMatchObject({
      fontSize: Typography.title.fontSize,
      color: Palette.light.primary,
    });
    expect(StyleSheet.flatten(numeral(1).props.style).color).toBe(Palette.light.inkSecondary);
    expect(rowStyle(stepRows(root)[0])).toMatchObject({ minWidth: Sizes.minTapTarget + Spacing.sm, minHeight: Sizes.minTapTarget });
    tap(stepRows(root)[0]);
    expect(stepRows(root)[0].findAll((n) => String(n.type) === 'Text')).toHaveLength(0);
    expect(foldLine(stepBlock(stepRows(root)[0])).props.accessibilityState).toEqual({ expanded: false });
  });

  test('the current step has NOW over cookStepCurrent and Mark step done; an upcoming one just its text in cookStepText', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    const [current, upcoming] = stepBlocks(root);
    expect(textsIn(current)).toContain('NOW');
    expect(StyleSheet.flatten(textIn(current, STEPS[0]).props.style)).toMatchObject({ fontSize: 20, lineHeight: 30 });
    expect(current.findAll((n) => n.type === PrimaryButton)).toHaveLength(1);
    expect(textsIn(upcoming)).not.toContain('NOW');
    expect(textsIn(upcoming)).not.toContain('STEP 2');
    expect(StyleSheet.flatten(textIn(upcoming, STEPS[1]).props.style)).toMatchObject({ fontSize: 17, fontWeight: '400', lineHeight: 26 });
  });

  test('the Ingredients card lies flat across the page between hairlines', () => {
    setSteps(STEPS);
    addIngredients('2 limes');
    const root = render(<CookScreen />);
    const card = root.root.findAllByType(Card)[0];
    expect(cardStyle(card)).toMatchObject({
      marginHorizontal: 0,
      borderRadius: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: Palette.light.border,
    });
  });

  test('an open cook screen follows a change of Cook view at once', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    act(() => setCookViewStyle('cards'));
    expect(StyleSheet.flatten(page(root).props.style).backgroundColor).toBe(Palette.light.background);
    expect(cardStyle(stepBlocks(root)[0])).toMatchObject({ backgroundColor: Palette.light.surface, borderRadius: Rounded.card });
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

  test('section headings keep the steps, their numbers and the saved match, with the titles over them', () => {
    const plain = render(<CookScreen />);
    const before = stepRows(plain).map((r) => r.props.accessibilityLabel);
    close();

    setSteps([{ section: 'Marinate' }, MATCH_STEPS[0], MATCH_STEPS[1], { section: 'Grilling' }, MATCH_STEPS[2]]);
    // The basis was saved from the step strings alone: adding headings keeps the match fresh.
    const recipe = db.select().from(recipes).where(eq(recipes.id, tacos)).get()!;
    expect(stepMatch(recipe, recipeIngredientsQuery(tacos).all()).state).toBe('fresh');
    const root = render(<CookScreen />);
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual(before);
    // Each step still names the ingredients the match gave it.
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual([
      `Step 1 of 3, ${MATCH_STEPS[0]}, uses chicken thighs, garlic, limes`,
      `Step 2 of 3, ${MATCH_STEPS[1]}`,
      `Step 3 of 3, ${MATCH_STEPS[2]}, uses chicken thighs, limes`,
    ]);
    expect(progress(root)).toBe('0 of 3 steps done');
    const texts = hostTexts(root);
    expect(texts.indexOf('Marinate')).toBeLessThan(texts.indexOf(MATCH_STEPS[0]));
    expect(texts.indexOf('Grilling')).toBeGreaterThan(texts.indexOf(MATCH_STEPS[1]));
    expect(texts.indexOf('Grilling')).toBeLessThan(texts.indexOf(MATCH_STEPS[2]));
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

  test('every open step lists its ingredients with shares and "part"; a folded step lists none until reopened', () => {
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
      'Chicken thighs, 2 lb, part, for step 3',
      'Limes, 2 of 3 limes, for step 3',
    ]);
    const limes = checkbox(root, 'Limes, 1 of 3 limes, for step 1');
    expect(stepBlock(limes)).toBe(currentBlocks(root)[0]);
    expect(textsIn(limes)).toEqual(['1 of 3 limes']);
    expect(textsIn(checkbox(root, 'Chicken thighs, 2 lb, part, for step 1'))).toEqual(['2 lb chicken thighs, part']);
    // A 44 pt pill.
    expect(rowStyle(limes).minHeight).toBe(44);
    // The pills come before Mark step done.
    const texts = textsIn(currentBlocks(root)[0]);
    expect(texts.indexOf('Mark step done')).toBeGreaterThan(texts.indexOf('1 of 3 limes'));
    // Step 2 has none.
    expect(pillsIn(stepBlocks(root)[1])).toHaveLength(0);

    // Step 1 ticked folds and hides its pills; step 2 (no ingredients) is current.
    tap(stepRows(root)[0]);
    expect(stepIngredientLabels(root)).toEqual(['Chicken thighs, 2 lb, part, for step 3', 'Limes, 2 of 3 limes, for step 3']);
    expect(markDoneButtons(root)[0].props.accessibilityLabel).toBe('Mark step 2 done');
    // Reopened, they're back, ticked with the step.
    tap(foldLine(stepBlocks(root)[0]));
    expect(pillsIn(stepBlocks(root)[0]).map(isChecked)).toEqual([true, true, true]);
  });

  test('an upcoming step lists its ingredients as background pills in its card, under its text', () => {
    const root = render(<CookScreen />);
    const upcoming = pillsIn(stepBlocks(root)[2]);
    expect(upcoming.map((p) => textsIn(p))).toEqual([['2 lb chicken thighs, part'], ['2 of 3 limes']]);
    expect(rowStyle(upcoming[0])).toMatchObject({ backgroundColor: Palette.light.background, minHeight: Sizes.minTapTarget, borderWidth: 0 });
    const texts = textsIn(stepBlocks(root)[2]);
    expect(texts.indexOf('2 of 3 limes')).toBeGreaterThan(texts.indexOf(MATCH_STEPS[2]));
    // No footnote line any more.
    expect(hostTexts(root)).not.toContain('2 lb chicken thighs, part · 2 of 3 limes');
    // Ticking one ticks that use, without ticking the step.
    tap(upcoming[1]);
    expect(isChecked(checkbox(root, 'Limes, 2 of 3 limes, for step 3'))).toBe(true);
    expect(progress(root)).toBe('0 of 3 steps done');
  });

  test('on the sheet every step\'s pills are surface, outlined in controlBorder', () => {
    setCookViewStyle('sheet');
    const root = render(<CookScreen />);
    for (const pill of [...pillsIn(stepBlocks(root)[0]), ...pillsIn(stepBlocks(root)[2])]) {
      expect(rowStyle(pill)).toMatchObject({
        backgroundColor: Palette.light.surface,
        borderWidth: Sizes.cookPillBorder,
        borderColor: Palette.light.controlBorder,
      });
    }
  });

  test('split amounts scale with the servings, in every step\'s pills', () => {
    setServings(4);
    mockParams.servings = '8';
    const root = render(<CookScreen />);
    expect(stepIngredientLabels(root)).toEqual([
      'Chicken thighs, 4 lb, part, for step 1',
      'Garlic, 8 clove, for step 1',
      'Limes, 2 of 6 limes, for step 1',
      'Chicken thighs, 4 lb, part, for step 3',
      'Limes, 4 of 6 limes, for step 3',
    ]);
    expect(pillsIn(stepBlocks(root)[2]).map((p) => textsIn(p))).toEqual([['4 lb chicken thighs, part'], ['4 of 6 limes']]);
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
    /** The current step's pills. */
    const pills = (root: ReactTestRenderer) => pillsIn(currentBlocks(root)[0]);
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

    test('a background full-round pill at least 44 pt tall with a 22 pt check, wrapping under the text in the card', () => {
      const root = render(<CookScreen />);
      const [chicken] = pills(root);
      expect(rowStyle(chicken)).toMatchObject({
        minHeight: Sizes.minTapTarget,
        borderRadius: Rounded.full,
        backgroundColor: Palette.light.background,
        alignSelf: 'flex-start',
      });
      expect(chicken.findByType(CheckCircle).props).toMatchObject({ checked: false, size: Sizes.cookIngredientCheck });
      expect(StyleSheet.flatten(pillText(chicken).props.style).color).toBe(Palette.light.ink);
      // A wrapping row under the step's text.
      expect(StyleSheet.flatten(pillBox(chicken).props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm });
      // No more inset rows with a name and an amount.
      expect(currentBlocks(root)[0].findAll((n) => String(n.type) === 'Text' && n.props.children === 'Chicken thighs')).toHaveLength(0);
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

  test('with no match, no step has pills', () => {
    db.update(recipes).set({ stepIngredients: null }).where(eq(recipes.id, tacos)).run();
    const root = render(<CookScreen />);
    for (const block of stepBlocks(root)) {
      expect(block.findAll((n) => n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function')).toHaveLength(1);
    }
    expect(markDoneButtons(root)).toHaveLength(1);
  });

  test('the source credit sits on the ground under the last step', () => {
    db.update(recipes).set({ sourceUrl: 'https://www.seriouseats.com/tacos' }).where(eq(recipes.id, tacos)).run();
    const root = render(<CookScreen />);
    const credit = root.root.find((n) => n.props.testID === 'recipe-credit' && typeof n.props.onPress === 'function');
    const blocks = stepBlocks(root);
    // In the steps' column, in no step, after the last step's text.
    expect(stepColumn(blocks[0]).findAll((n) => n === credit)).toHaveLength(1);
    expect(blocks.some((block) => block.findAll((n) => n === credit).length > 0)).toBe(false);
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

// familystylefood.com/chicken-thigh-marinade, shortened: a marinate section, then four ways to cook it.
const MARINATE = ['Whisk the marinade.', 'Pour it over the chicken.', 'Marinate 30 minutes.'];
const GRILL = ['Preheat the grill.', 'Season the chicken.', 'Grill 5 minutes, then flip.', 'Cover and cook to 165°F.'];
const BAKE = ['Heat the oven to 425°F.', 'Bake 20 minutes.'];
const PAN = ['Heat a skillet.', 'Fry skin-side down.', 'Flip and finish.'];
const BROIL = ['Heat the broiler.', 'Broil 8 minutes a side.', 'Rest 5 minutes.'];
const CHICKEN: RecipeStepEntry[] = [
  { section: 'Marinate the chicken' },
  ...MARINATE,
  { section: 'Grill', choice: true },
  ...GRILL,
  { section: 'Bake', choice: true },
  ...BAKE,
  { section: 'Pan-fry', choice: true },
  ...PAN,
  { section: 'Broil', choice: true },
  ...BROIL,
];

describe('the cook screen with step sections (spec 4.5 "Step sections")', () => {
  const topLine = (root: ReactTestRenderer) => hostTexts(root).find((t) => / (done|hechos?)( · (pick a method|elige un método))?$/.test(t));
  const pickerCard = (root: ReactTestRenderer) =>
    root.root.find(
      (n) => n.type === Card && n.findAll((c) => String(c.type) === 'Text' && /^(How are you cooking it\?|¿Cómo lo vas a cocinar\?)$/.test(String(c.props.children))).length > 0,
    );
  const hasPicker = (root: ReactTestRenderer) => hostTexts(root).includes('How are you cooking it?');
  const changeMethod = (root: ReactTestRenderer) => root.root.find((n) => n.type === Button && n.props.label === 'Change method');
  const markThrough = (root: ReactTestRenderer, numbers: number[]) =>
    numbers.forEach((n) => act(() => byA11y(root, `Mark step ${n} done`).props.onPress()));

  test('a recipe without headings is unchanged: no titles, no picker, steps 1 to n', () => {
    setSteps(STEPS);
    const root = render(<CookScreen />);
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual(STEPS.map((s, i) => `Step ${i + 1} of 3, ${s}`));
    expect(hasPicker(root)).toBe(false);
    expect(root.root.findAll((n) => n.type === Button && n.props.label === 'Change method')).toHaveLength(0);
    expect(root.root.findAll((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'header').map((n) => n.props.children)).toEqual(['Tacos']);
    expect(currentBlocks(root)).toHaveLength(1);
    expect(topLine(root)).toBe('0 of 3 steps done');
  });

  test('the marinate steps come under their title, with the picker after them, upcoming until they are ticked', () => {
    setSteps(CHICKEN);
    setServings(4);
    const root = render(<CookScreen />);
    const title = root.root.find((n) => String(n.type) === 'Text' && n.props.children === 'Marinate the chicken');
    expect(title.props.accessibilityRole).toBe('header');
    expect(StyleSheet.flatten(title.props.style)).toMatchObject({ fontSize: Typography.sectionLabel.fontSize, color: Palette.light.inkSecondary });
    // Only the shared steps are cards; no option's steps show before a pick.
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual(MARINATE.map((s, i) => `Step ${i + 1} of 7, ${s}`));
    const texts = hostTexts(root);
    expect(texts.indexOf('How are you cooking it?')).toBeGreaterThan(texts.indexOf(MARINATE[2]));
    expect(texts).toContain('The recipe gives 4 ways. You can change this later.');
    // Upcoming: no current border while a step before it is unticked.
    expect(cardStyle(pickerCard(root)).borderWidth).toBeUndefined();
    expect(topLine(root)).toBe('For 4 · 0 steps done · pick a method');

    markThrough(root, [1, 2, 3]);
    expect(cardStyle(pickerCard(root))).toMatchObject({ borderWidth: Sizes.cookCurrentBorder, borderColor: Palette.light.primary });
    expect(currentBlocks(root)).toHaveLength(0);
    expect(markDoneButtons(root)).toHaveLength(0);
    expect(topLine(root)).toBe('For 4 · 3 steps done · pick a method');
    // With the picker current, the marinate steps stay open (board B).
    expect(stepRows(root).map(isChecked)).toEqual([true, true, true]);
  });

  test('one row per option with its step count, read as a button', () => {
    setSteps(CHICKEN);
    const root = render(<CookScreen />);
    const rows = pickerCard(root).findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && n.props.onPress);
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual(['Grill, 4 steps', 'Bake, 2 steps', 'Pan-fry, 3 steps', 'Broil, 3 steps']);
    expect(rowStyle(rows[0]).minHeight).toBe(56);
    expect(textsIn(rows[1])).toEqual(['Bake', '2 steps']);
    expect(pickerCard(root).find((n) => String(n.type) === 'Text' && n.props.children === 'How are you cooking it?').props.accessibilityRole).toBe('header');
  });

  test('picking Grill shows its steps numbered 4–7 under its title, and the count follows', () => {
    setSteps(CHICKEN);
    setServings(4);
    const root = render(<CookScreen />);
    markThrough(root, [1, 2, 3]);
    tap(byA11y(root, 'Grill, 4 steps'));
    expect(hasPicker(root)).toBe(false);
    expect(hostTexts(root)).toContain('Grill');
    expect(changeMethod(root)).toBeTruthy();
    expect(stepRows(root).map((r) => r.props.accessibilityLabel)).toEqual(GRILL.map((s, i) => `Step ${i + 4} of 7, ${s}`));
    for (const step of [...BAKE, ...PAN, ...BROIL]) expect(hostTexts(root)).not.toContain(step);
    expect(topLine(root)).toBe('For 4 · 3 of 7 steps done');
    expect(markDoneButtons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Mark step 4 done']);
    markThrough(root, [4]);
    expect(topLine(root)).toBe('For 4 · 4 of 7 steps done');
    expect(markDoneButtons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Mark step 5 done']);
  });

  test('Change method brings the card back, with Grill’s ticks kept', () => {
    setSteps(CHICKEN);
    const root = render(<CookScreen />);
    markThrough(root, [1, 2, 3]);
    tap(byA11y(root, 'Grill, 4 steps'));
    markThrough(root, [4, 5]);
    act(() => changeMethod(root).props.onPress());
    expect(hasPicker(root)).toBe(true);
    // The Grill ticks don't count while no method is picked.
    expect(topLine(root)).toBe('3 steps done · pick a method');
    // Bake is fresh; going back to Grill finds its ticks.
    tap(byA11y(root, 'Bake, 2 steps'));
    expect(topLine(root)).toBe('3 of 5 steps done');
    act(() => changeMethod(root).props.onPress());
    tap(byA11y(root, 'Grill, 4 steps'));
    expect(topLine(root)).toBe('5 of 7 steps done');
    expect(markDoneButtons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Mark step 6 done']);
  });

  test('the marinate section folds once ticked and past, and unfolds on a tap', () => {
    setSteps(CHICKEN);
    const root = render(<CookScreen />);
    markThrough(root, [1, 2, 3]);
    tap(byA11y(root, 'Grill, 4 steps'));
    const folded = byA11y(root, 'Marinate the chicken, 3 steps done');
    expect(folded.props.accessibilityRole).toBe('button');
    expect(folded.props.accessibilityState).toEqual({ expanded: false });
    expect(textsIn(folded)).toEqual(['Marinate the chicken', '3 done']);
    for (const step of MARINATE) expect(hostTexts(root)).not.toContain(step);
    expect(stepRows(root)).toHaveLength(4);

    tap(folded);
    expect(root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Marinate the chicken, 3 steps done')).toHaveLength(0);
    expect(stepRows(root).slice(0, 3).map(isChecked)).toEqual([true, true, true]);
    expect(hostTexts(root)).toContain('Marinate the chicken');
    // Unticking a marinate step makes it current again.
    tap(stepRows(root)[1]);
    expect(markDoneButtons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Mark step 2 done']);
  });

  test('Mark step done on the last step before a group scrolls the picker into view, at once under Reduce Motion', () => {
    setSteps(CHICKEN);
    const run = () => {
      const root = render(<CookScreen />);
      const scrollTo = jest.fn();
      root.root.findByType(ScrollView).instance.scrollTo = scrollTo;
      const layout = (node: ReactTestInstance, y: number) =>
        act(() => node.props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 358, height: 100 } } }));
      layout(stepColumn(stepBlocks(root)[0]), 100);
      markThrough(root, [1, 2]);
      layout(stepBlocks(root)[2], 150);
      scrollTo.mockClear();
      markThrough(root, [3]);
      layout(pickerCard(root), 260);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      const call = scrollTo.mock.calls[0][0];
      close();
      return call;
    };
    expect(run()).toEqual({ y: 100 + 260 - Spacing.md, animated: true });
    mockReduceMotion = true;
    expect(run()).toEqual({ y: 100 + 260 - Spacing.md, animated: false });
  });
});

describe('cookPlan', () => {
  const kinds = (entries: RecipeStepEntry[], picks: (number | null)[], ticked: boolean[], opened?: Set<number>) =>
    cookPlan(entries, picks, ticked, opened).blocks.map((b) =>
      b.kind === 'step' ? `${b.number}:${b.state}` : b.kind === 'picker' ? `picker${b.current ? '*' : ''}` : `${b.kind}:${b.title}`,
    );
  const none = (n: number) => Array.from({ length: n }, () => false);

  test('without headings: every step in turn, the first unticked current', () => {
    expect(kinds(['a', 'b', 'c'], [], [true, false, false])).toEqual(['1:done', '2:current', '3:upcoming']);
    expect(cookPlan(['a', 'b'], [], [true, true])).toMatchObject({ current: null, done: 2, total: 2, picking: false });
    expect(cookPlan([], [], []).blocks).toEqual([]);
    expect(cookPlan(null, [], []).current).toBeNull();
  });

  test('a choice group stands as its picker until picked, then as the pick', () => {
    expect(kinds(CHICKEN, [], none(15))).toEqual(['title:Marinate the chicken', '1:current', '2:upcoming', '3:upcoming', 'picker']);
    const ticked = [true, true, true, ...none(12)];
    expect(cookPlan(CHICKEN, [], ticked)).toMatchObject({ current: { kind: 'picker', group: 0 }, done: 3, total: 3, picking: true });
    // Bake (option 1): steps 7 and 8 of stepTexts, numbered 4 and 5.
    const baked = cookPlan(CHICKEN, [1], ticked);
    expect(baked.blocks.flatMap((b) => (b.kind === 'step' ? [[b.index, b.number]] : []))).toEqual([
      [7, 4],
      [8, 5],
    ]);
    expect(baked.blocks.find((b) => b.kind === 'title' && b.title === 'Bake')).toEqual({ kind: 'title', section: 2, title: 'Bake', group: 0 });
    expect(baked).toMatchObject({ current: { kind: 'step', index: 7 }, done: 3, total: 5, picking: false });
    expect(cookPlan(CHICKEN, [], ticked).blocks.at(-1)).toEqual({
      kind: 'picker',
      group: 0,
      current: true,
      options: [
        { title: 'Grill', count: 4 },
        { title: 'Bake', count: 2 },
        { title: 'Pan-fry', count: 3 },
        { title: 'Broil', count: 3 },
      ],
    });
  });

  test('ticks in an option not picked are kept but not counted', () => {
    const ticked = [true, true, true, true, true, ...none(10)];
    expect(cookPlan(CHICKEN, [null], ticked)).toMatchObject({ done: 3, picking: true });
    expect(cookPlan(CHICKEN, [0], ticked)).toMatchObject({ done: 5, total: 7 });
    expect(cookPlan(CHICKEN, [2], ticked)).toMatchObject({ done: 3, total: 6 });
  });

  test('a named section folds once all ticked and behind the current step, unless opened', () => {
    const ticked = [true, true, true, ...none(12)];
    expect(kinds(CHICKEN, [0], ticked)).toEqual(['fold:Marinate the chicken', 'title:Grill', '4:current', '5:upcoming', '6:upcoming', '7:upcoming']);
    expect(kinds(CHICKEN, [0], ticked, new Set([0]))[0]).toBe('title:Marinate the chicken');
    // Every step ticked: nothing is current, so nothing is behind it and nothing folds.
    const all = [true, true, true, true, true, true, true, ...none(8)];
    expect(kinds(CHICKEN, [0], all)).not.toContain('fold:Marinate the chicken');
    // The untitled first section never folds.
    expect(kinds(['a', { section: 'B' }, 'b'], [], [true, false])).toEqual(['1:done', 'title:B', '2:current']);
  });

  test('a later group is upcoming while an earlier step is unticked, and out-of-range picks read as none', () => {
    const entries: RecipeStepEntry[] = ['prep', { section: 'Oven', choice: true }, 'bake', { section: 'Grill', choice: true }, 'grill', { section: 'Serve' }, 'plate'];
    expect(kinds(entries, [], [false, false, false, false])).toEqual(['1:current', 'picker', 'title:Serve', '3:upcoming']);
    expect(kinds(entries, [5], [true, false, false, false])).toEqual(['1:done', 'picker*', 'title:Serve', '3:upcoming']);
    expect(kinds(entries, [1], [true, false, false, false])).toEqual(['1:done', 'title:Grill', '2:current', 'title:Serve', '3:upcoming']);
    // A lone choice section is an ordinary one.
    expect(kinds(['a', { section: 'Only', choice: true }, 'b'], [], [false, false])).toEqual(['1:current', 'title:Only', '2:upcoming']);
  });

  test('withCookPick sets and clears a group’s pick', () => {
    expect(withCookPick([], 1, 2)).toEqual([null, 2]);
    expect(withCookPick([0, 3], 1, null)).toEqual([0, null]);
    expect(withCookPick([1], 0, 0)).toEqual([0]);
  });

  test('cookProgressLabel while picking, in English and Spanish', () => {
    expect(cookProgressLabel(4, 3, 3, true)).toBe('For 4 · 3 steps done · pick a method');
    expect(cookProgressLabel(null, 1, 1, true)).toBe('1 step done · pick a method');
    expect(cookProgressLabel(null, 4, 7, false)).toBe('4 of 7 steps done');
    expect(es.recipes.cook.picking_other.replace('{{count}}', '3')).toBe('3 pasos hechos · elige un método');
    expect(es.recipes.cook.howCooking).toBe('¿Cómo lo vas a cocinar?');
    expect(es.recipes.cook.changeMethod).toBe('Cambiar método');
  });
});
