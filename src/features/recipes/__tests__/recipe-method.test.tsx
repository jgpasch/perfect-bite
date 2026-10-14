// The recipe screen's Method card and the Steps sheet (boards 14–16).

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Pill } from '@/components/pill';
import { SegmentedControl } from '@/components/segmented-control';
import { AisleColors, Palette, Typography } from '@/constants/theme';
import { db, outbox, recipes } from '@/db';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import RecipeScreen from '@/app/recipe/[id]/index';
import RecipeStepsSheet from '@/app/recipe/[id]/steps';

import { RecipeMethodCard } from '../recipe-method-card';
import { methodTab } from '../recipe-view';
import { addRecipeIngredient, createRecipe, getRecipe, updateRecipeSteps } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
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

const setSteps = (steps: string[] | null) => db.update(recipes).set({ steps }).where(eq(recipes.id, tacos)).run();
const hostTexts = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => String(n.type) === 'Text')
    .map((n) => [n.props.children].flat().join(''))
    .filter(Boolean);
/** The steps' rows, by their VoiceOver label. */
const stepRows = (root: ReactTestRenderer) =>
  root.root.findAll((n) => String(n.type) === 'View' && n.props.accessible === true && /^Step \d+ of \d+, /.test(n.props.accessibilityLabel ?? ''));
const byA11y = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
/** The Ingredients | Method switch's tabs (host Views), by their VoiceOver label. */
const tabs = (root: ReactTestRenderer) =>
  root.root.findAll((n) => String(n.type) === 'View' && n.props.accessibilityRole === 'tab');
const tab = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'tab' && n.props.accessibilityLabel === label);
const toolbarButton = (root: ReactTestRenderer, title: string) =>
  root.root.findAll((n) => String(n.type) === 'ToolbarButton').find((n) => n.props.children === title)!;
const field = (root: ReactTestRenderer) =>
  root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Steps');
const recipeUpdates = () =>
  db
    .select()
    .from(outbox)
    .all()
    .map((r) => r.mutation)
    .filter((m) => m.table === 'recipes' && m.id === tacos && !('household_id' in m.fields));

describe('the Method card', () => {
  test('lists the steps numbered, each read as "Step N of M, …", with the count and Edit', () => {
    setSteps(STEPS);
    const root = render(<RecipeScreen />);
    press(tab(root, 'Method, 3 steps'));
    const rows = stepRows(root);
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
      'Step 1 of 3, Blend the chipotles into a paste.',
      'Step 2 of 3, Toss the chicken in half the paste.',
      'Step 3 of 3, Grill the thighs.',
    ]);
    const texts = hostTexts(root);
    expect(texts).toEqual(expect.arrayContaining(['Method', '1', '2', '3', ...STEPS]));
    expect(texts).not.toContain('No steps yet.');
    // The header reads its count; Edit opens the Steps sheet.
    expect(root.root.findAll((n) => String(n.type) === 'Text' && n.props.accessibilityLabel === 'Method, 3 steps')).toHaveLength(1);
    expect(root.root.findAll((n) => n.type === Pill && n.props.label === 'Add steps')).toHaveLength(0);
    press(byA11y(root, 'Edit steps'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/steps', params: { id: tacos } });
  });

  test('step text is body, selectable, with roomy line spacing; numbers are the hue strong on soft', () => {
    const hue = recipeHue(tacos);
    const root = render(<RecipeMethodCard steps={STEPS} hue={hue} onEdit={() => {}} />);
    const text = root.root.find((n) => String(n.type) === 'Text' && n.props.children === STEPS[1]);
    expect(text.props.selectable).toBe(true);
    const style = StyleSheet.flatten(text.props.style);
    expect(style).toMatchObject({ fontSize: Typography.body.fontSize, fontWeight: Typography.body.fontWeight, lineHeight: 25 });
    const digit = root.root.find((n) => String(n.type) === 'Text' && n.props.children === 2);
    expect(StyleSheet.flatten(digit.props.style).color).toBe(AisleColors.light[hue].strong);
    let circle = digit.parent!;
    while (String(circle.type) !== 'View') circle = circle.parent!;
    expect(StyleSheet.flatten(circle.props.style)).toMatchObject({
      width: 26,
      height: 26,
      backgroundColor: AisleColors.light[hue].soft,
    });
  });

  test('no steps: "No steps yet." and an Add steps pill that opens the sheet, with no count or Edit', () => {
    const root = render(<RecipeScreen />);
    expect(stepRows(root)).toHaveLength(0);
    const empty = root.root.find((n) => String(n.type) === 'Text' && n.props.children === 'No steps yet.');
    expect(StyleSheet.flatten(empty.props.style)).toMatchObject({ fontSize: Typography.callout.fontSize, color: Palette.light.inkSecondary });
    expect(root.root.findAll((n) => String(n.type) === 'Text' && n.props.accessibilityLabel === 'Method')).toHaveLength(1);
    expect(root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Edit steps')).toHaveLength(0);
    const pill = root.root.find((n) => n.type === Pill && n.props.label === 'Add steps');
    expect(pill.props).toMatchObject({ soft: true, icon: 'plus' });
    press(byA11y(root, 'Add steps'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/steps', params: { id: tacos } });
  });

  test('an empty list of steps is the empty state too', () => {
    const root = render(<RecipeMethodCard steps={[]} hue="green" onEdit={() => {}} />);
    expect(hostTexts(root)).toEqual(['Method', 'No steps yet.', 'Add steps']);
  });
});

describe('the Ingredients | Method tabs', () => {
  const ingredientsHeader = (root: ReactTestRenderer) =>
    root.root.findAll((n) => String(n.type) === 'Text' && /^Ingredients(, |$)/.test(n.props.accessibilityLabel ?? ''));
  const methodHeader = (root: ReactTestRenderer) =>
    root.root.findAll((n) => String(n.type) === 'Text' && /^Method(, |$)/.test(n.props.accessibilityLabel ?? ''));
  const scrollView = (root: ReactTestRenderer) =>
    root.root.find((n) => typeof n.type !== 'string' && typeof n.props.onScroll === 'function');
  const switchWrapper = (root: ReactTestRenderer) =>
    // The innermost View with onLayout around the tablist (the keyboard-avoiding view has one too).
    root.root
      .findAll(
        (n) =>
          String(n.type) === 'View' &&
          typeof n.props.onLayout === 'function' &&
          n.findAll((c) => String(c.type) === 'View' && c.props.accessibilityRole === 'tablist').length === 1,
      )
      .at(-1)!;

  test('no steps: no switch; the Ingredients card, then the Method card with Add steps, as before', () => {
    for (const steps of [null, []]) {
      setSteps(steps);
      addRecipeIngredient(tacos, '2 lb chicken thighs');
      const root = render(<RecipeScreen />);
      expect(root.root.findAll((n) => n.type === SegmentedControl)).toHaveLength(0);
      expect(tabs(root)).toHaveLength(0);
      const texts = hostTexts(root);
      expect(texts.indexOf('Ingredients')).toBeGreaterThan(-1);
      expect(texts.indexOf('Method')).toBeGreaterThan(texts.indexOf('Ingredients'));
      expect(texts).toEqual(expect.arrayContaining(['Chicken thighs', 'No steps yet.', 'Add steps']));
      press(byA11y(root, 'Add steps'));
      expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/steps', params: { id: tacos } });
      act(() => tree?.unmount());
      tree = null;
      resetDb();
      ensureStarterData('user-1');
      tacos = createRecipe('Tacos');
      mockParams.id = tacos;
    }
  });

  test('with steps: "Ingredients" and "Method · 3" as tabs, opening on Ingredients with only its card', () => {
    setSteps(STEPS);
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const root = render(<RecipeScreen />);
    expect(root.root.findAll((n) => String(n.type) === 'View' && n.props.accessibilityRole === 'tablist')).toHaveLength(1);
    expect(tabs(root).map((t) => [t.props.accessibilityLabel, t.props.accessibilityState])).toEqual([
      ['Ingredients', { selected: true }],
      ['Method, 3 steps', { selected: false }],
    ]);
    const texts = hostTexts(root);
    expect(texts).toEqual(expect.arrayContaining(['Ingredients', 'Method · 3', 'Chicken thighs']));
    expect(ingredientsHeader(root)).toHaveLength(1);
    expect(methodHeader(root)).toHaveLength(0);
    expect(stepRows(root)).toHaveLength(0);
    // The switch sits under the Add to a list / Cook row.
    expect(texts.indexOf('Cook')).toBeLessThan(texts.indexOf('Method · 3'));
  });

  test('Method shows only the Method card; Ingredients brings its card back', () => {
    setSteps(STEPS);
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const root = render(<RecipeScreen />);
    press(tab(root, 'Method, 3 steps'));
    expect(tabs(root).map((t) => t.props.accessibilityState)).toEqual([{ selected: false }, { selected: true }]);
    expect(stepRows(root)).toHaveLength(3);
    expect(methodHeader(root)).toHaveLength(1);
    expect(ingredientsHeader(root)).toHaveLength(0);
    expect(hostTexts(root)).not.toContain('Chicken thighs');
    press(tab(root, 'Ingredients'));
    expect(stepRows(root)).toHaveLength(0);
    expect(ingredientsHeader(root)).toHaveLength(1);
    expect(hostTexts(root)).toContain('Chicken thighs');
  });

  test('the servings stepper keeps its choice across a switch', () => {
    setSteps(STEPS);
    db.update(recipes).set({ servings: 4 }).where(eq(recipes.id, tacos)).run();
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const root = render(<RecipeScreen />);
    press(byA11y(root, 'More'));
    press(byA11y(root, 'More'));
    expect(hostTexts(root)).toEqual(expect.arrayContaining(['For 6', '3 lb']));
    press(tab(root, 'Method, 3 steps'));
    expect(hostTexts(root)).not.toContain('For 6');
    press(tab(root, 'Ingredients'));
    expect(hostTexts(root)).toEqual(expect.arrayContaining(['For 6', '3 lb', 'Reset']));
    // Cook still gets the chosen servings from either tab.
    press(tab(root, 'Method, 3 steps'));
    press(byA11y(root, 'Start cooking'));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/cook', params: { id: tacos, servings: '6' } });
  });

  test('opens on Ingredients every time; the tab isn\'t kept', () => {
    setSteps(STEPS);
    let root = render(<RecipeScreen />);
    press(tab(root, 'Method, 3 steps'));
    act(() => tree?.unmount());
    root = render(<RecipeScreen />);
    expect(tabs(root).map((t) => t.props.accessibilityState)).toEqual([{ selected: true }, { selected: false }]);
    expect(stepRows(root)).toHaveLength(0);
  });

  test('the tab reads the step count, one step singular', () => {
    setSteps(['Grill it.']);
    const root = render(<RecipeScreen />);
    expect(hostTexts(root)).toContain('Method · 1');
    expect(tabs(root)[1].props.accessibilityLabel).toBe('Method, 1 step');
  });

  test('switching scrolls the switch back to the top only when it has scrolled off', () => {
    setSteps(STEPS);
    const root = render(<RecipeScreen />);
    const scrollTo = jest.fn();
    scrollView(root).instance.scrollTo = scrollTo;
    act(() => switchWrapper(root).props.onLayout({ nativeEvent: { layout: { x: 0, y: 320, width: 390, height: 40 } } }));
    act(() => scrollView(root).props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 100 } } }));
    press(tab(root, 'Method, 3 steps'));
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => scrollView(root).props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 900 } } }));
    press(tab(root, 'Ingredients'));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 320, animated: true });
  });
});

describe('methodTab', () => {
  test('shows "Method · N" and reads the steps', () => {
    expect(methodTab(6)).toEqual({ label: 'Method · 6', accessibilityLabel: 'Method, 6 steps' });
    expect(methodTab(1)).toEqual({ label: 'Method · 1', accessibilityLabel: 'Method, 1 step' });
  });
});

describe('the Steps sheet', () => {
  test('shows the title, label, the steps one per line and the footnote', () => {
    setSteps(STEPS);
    const root = render(<RecipeStepsSheet />);
    expect(hostTexts(root)).toEqual([
      'Steps',
      'One step per line',
      'Empty lines are dropped. Clear everything to remove the steps.',
    ]);
    expect(field(root).props.value).toBe(STEPS.join('\n'));
    expect(field(root).props.multiline).toBe(true);
    expect(toolbarButton(root, 'Save').props.variant).toBe('done');
  });

  test('Save splits on line breaks, trims, drops empty lines and syncs the steps', () => {
    const root = render(<RecipeStepsSheet />);
    expect(field(root).props.value).toBe('');
    act(() => field(root).props.onChangeText('  Chop the onion.\n\n\nFry it.  \n   \nServe.\n'));
    press(toolbarButton(root, 'Save'));
    expect(getRecipe(tacos)!.steps).toEqual(['Chop the onion.', 'Fry it.', 'Serve.']);
    expect(recipeUpdates().at(-1)!.fields).toMatchObject({ steps: ['Chop the onion.', 'Fry it.', 'Serve.'] });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('clearing everything (or leaving only blank lines) saves null', () => {
    setSteps(STEPS);
    const root = render(<RecipeStepsSheet />);
    act(() => field(root).props.onChangeText(' \n\n  '));
    press(toolbarButton(root, 'Save'));
    expect(getRecipe(tacos)!.steps).toBeNull();
    expect(recipeUpdates().at(-1)!.fields).toMatchObject({ steps: null });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('Cancel goes back and writes nothing', () => {
    setSteps(STEPS);
    const root = render(<RecipeStepsSheet />);
    act(() => field(root).props.onChangeText('Something else'));
    press(toolbarButton(root, 'Cancel'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(getRecipe(tacos)!.steps).toEqual(STEPS);
    expect(recipeUpdates()).toEqual([]);
  });

  test('edits an imported recipe the same way, leaving its other fields alone', () => {
    db.update(recipes)
      .set({ steps: STEPS, sourceUrl: 'https://example.com/tacos', servings: 4, imageUrl: 'https://example.com/t.jpg' })
      .where(eq(recipes.id, tacos))
      .run();
    const root = render(<RecipeStepsSheet />);
    act(() => field(root).props.onChangeText(`${STEPS[0]}\n${STEPS[2]}\nTop with lime.`));
    press(toolbarButton(root, 'Save'));
    expect(getRecipe(tacos)).toMatchObject({
      steps: [STEPS[0], STEPS[2], 'Top with lime.'],
      sourceUrl: 'https://example.com/tacos',
      servings: 4,
      imageUrl: 'https://example.com/t.jpg',
    });
  });

  test('a missing recipe renders an empty sheet', () => {
    mockParams.id = 'nope';
    const root = render(<RecipeStepsSheet />);
    expect(hostTexts(root)).toEqual([]);
    expect(root.root.findAll((n) => String(n.type) === 'ToolbarButton')).toHaveLength(0);
  });
});

describe('updateRecipeSteps', () => {
  test('an empty array is stored as null', () => {
    setSteps(STEPS);
    updateRecipeSteps(tacos, []);
    expect(getRecipe(tacos)!.steps).toBeNull();
  });
});
