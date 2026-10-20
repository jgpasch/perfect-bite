// The index card recipe view (spec 4.5, board F): the Recipe view trial picks it, and it keeps the screen's
// behaviour: the source line and its servings stepper, the amount column, the folded method, the photo square,
// the notes, the ingredient rows' gestures and the dock.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS, Alert, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Pill } from '@/components/pill';
import { SegmentedControl } from '@/components/segmented-control';
import { Stepper } from '@/components/stepper';
import { AisleColors, Palette, Rounded, Sizes, Typography } from '@/constants/theme';
import { db, recipes } from '@/db';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData } from '@/features/lists/lists';
import { initI18n } from '@/i18n';
import type { RecipeStepEntry } from '@/shared';
import { resetDb } from '@/test/db';

import RecipeScreen from '@/app/recipe/[id]/index';

import { amountColumnWidth, RecipeIndexCard } from '../recipe-index-card';
import { RecipeIngredientRow } from '../recipe-ingredient-row';
import { RecipeMethodCard } from '../recipe-method-card';
import { RecipePhotoHeader } from '../recipe-photo';
import {
  addRecipeIngredient,
  createRecipe,
  getRecipe,
  recipeIngredientsQuery,
  updateRecipe,
  updateRecipeIngredient,
  updateRecipeServings,
} from '../recipes';
import { setRecipeViewStyle } from '../view-style';

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
  return {
    __esModule: true,
    default: ({ children, onSwipeableOpen }: Record<string, any>) => createElement('Swipeable', { onSwipeableOpen }, children),
  };
});
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({ categorizePending: () => Promise.resolve() }));
jest.mock('@/features/recipes/ensure-step-match', () => ({ useEnsureStepMatch: () => {}, ensureStepMatchSoon: () => {} }));
jest.mock('@/features/lists/add-bar', () => {
  const { createElement } = require('react');
  return { ItemAddBar: (props: object) => createElement('ItemAddBar', props) };
});
const mockParams: Record<string, string | undefined> = {};
const mockPush = jest.fn();
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
    Stack: { Screen: host('StackScreen'), Toolbar },
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => {} },
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});
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
const mockOpenURL = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('expo-linking', () => ({ openURL: (url: string) => mockOpenURL(url) }));
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
  mockOpenURL.mockClear();
  setRecipeViewStyle('indexCard');
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(): ReactTestRenderer {
  act(() => {
    tree = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <RecipeScreen />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

const setSteps = (steps: RecipeStepEntry[] | null) => db.update(recipes).set({ steps }).where(eq(recipes.id, tacos)).run();
const setLink = (sourceUrl: string) => updateRecipe(tacos, { name: 'Tacos', notes: '', sourceUrl });
const tint = () => AisleColors.light[recipeHue(tacos)];
/** A host Text's full string, nested Text included. */
const textOf = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
/** Every outermost host Text's string, in order. */
const texts = (root: ReactTestInstance) =>
  root
    .findAll((n) => String(n.type) === 'Text' && (n.parent === null || !hasTextAncestor(n)))
    .map(textOf)
    .filter(Boolean);
const hasTextAncestor = (n: ReactTestInstance): boolean => {
  for (let p = n.parent; p; p = p.parent) if (String(p.type) === 'Text') return true;
  return false;
};
const byTestId = (root: ReactTestRenderer, id: string) => root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
const pressables = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
/** Presses `n`, or for a host node, the pressable that renders it. */
const press = (n: ReactTestInstance) => {
  let target: ReactTestInstance | null = n;
  while (target && typeof target.props.onPress !== 'function') target = target.parent;
  act(() => target!.props.onPress());
};
const card = (root: ReactTestRenderer) => root.root.findByType(RecipeIndexCard);
const headerOptions = (root: ReactTestRenderer) => root.root.find((n) => String(n.type) === 'StackScreen').props.options;
/** The visible amounts, in row order (not the unseen ones that size the column). */
const shownAmounts = (root: ReactTestRenderer) => byTestId(root, 'ingredient-amount').map(textOf);
const layout = (node: ReactTestInstance, width: number) =>
  act(() => node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 22 } } }));

describe('the Recipe view setting', () => {
  test('Index card: the index card in place of the photo header, band, switch and cards, under a plain header', () => {
    setLink('https://www.example.com/tacos');
    setSteps(STEPS);
    addRecipeIngredient(tacos, '1 lb ground beef');
    db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
    const root = render();
    expect(root.root.findAllByType(RecipeIndexCard)).toHaveLength(1);
    expect(root.root.findAllByType(RecipePhotoHeader)).toHaveLength(0);
    expect(root.root.findAllByType(SegmentedControl)).toHaveLength(0);
    expect(byTestId(root, 'link')).toHaveLength(0);
    // Not transparent over the photo: the plain background, with no shadow.
    expect(headerOptions(root)).toEqual({
      headerTransparent: false,
      headerStyle: { backgroundColor: Palette.light.background },
      headerShadowVisible: false,
    });
  });

  test('Standard: the standard view, and switching on an open screen swaps the view both ways', () => {
    setSteps(STEPS);
    setRecipeViewStyle('standard');
    const root = render();
    expect(root.root.findAllByType(RecipeIndexCard)).toHaveLength(0);
    expect(root.root.findAllByType(SegmentedControl)).toHaveLength(1);
    expect(headerOptions(root)).toEqual({ headerTransparent: false, headerStyle: { backgroundColor: tint().soft } });

    act(() => setRecipeViewStyle('indexCard'));
    expect(root.root.findAllByType(RecipeIndexCard)).toHaveLength(1);
    expect(root.root.findAllByType(SegmentedControl)).toHaveLength(0);
    expect(headerOptions(root).headerStyle).toEqual({ backgroundColor: Palette.light.background });

    act(() => setRecipeViewStyle('standard'));
    expect(root.root.findAllByType(RecipeIndexCard)).toHaveLength(0);
    expect(root.root.findAllByType(SegmentedControl)).toHaveLength(1);
  });

  test('the servings chosen in one view carry to the other', () => {
    updateRecipeServings(tacos, 4);
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const root = render();
    press(byTestId(root, 'index-servings')[0]);
    act(() => root.root.findByType(Stepper).props.onChange(8));
    expect(shownAmounts(root)).toEqual(['4 lb']);
    act(() => setRecipeViewStyle('standard'));
    expect(root.root.findByType(RecipeIngredientRow).props.amount).toBe('4 lb');
  });
});

describe('the top row', () => {
  test('the name as a header in screenTitle, with the 64 pt square at its top right', () => {
    const root = render();
    const [name] = root.root.findAll((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'header');
    expect(textOf(name)).toBe('Tacos');
    expect(StyleSheet.flatten(name.props.style)).toMatchObject({ fontSize: Typography.screenTitle.fontSize });
    const square = byTestId(root, 'index-photo')[0];
    expect(StyleSheet.flatten(square.props.style)).toMatchObject({
      width: Sizes.recipeIndexPhoto,
      height: Sizes.recipeIndexPhoto,
      borderRadius: Rounded.md,
      backgroundColor: tint().soft,
    });
    expect(Sizes.recipeIndexPhoto).toBe(64);
  });

  test('no photo: the tile colour alone, read as "Add photo", and a tap opens the Choose a photo sheet', () => {
    const root = render();
    expect(root.root.findAll((n) => String(n.type) === 'ExpoImage')).toHaveLength(0);
    const [square] = pressables(root, 'Add photo');
    expect(square).toBeDefined();
    expect(square.props.accessibilityRole).toBe('button');
    press(square);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/photo', params: { id: tacos } });
  });

  test("a site photo fills the square over the tile colour, read as \"Change photo\"; if it fails, the colour alone", () => {
    db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
    const root = render();
    const [image] = root.root.findAll((n) => String(n.type) === 'ExpoImage');
    expect(image.props.source).toBe('https://example.com/tacos.jpg');
    expect(image.props.contentFit).toBe('cover');
    expect(pressables(root, 'Add photo')).toHaveLength(0);
    press(pressables(root, 'Change photo')[0]);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/photo', params: { id: tacos } });

    act(() => image.props.onError({ error: 'HTTP 404' }));
    expect(root.root.findAll((n) => String(n.type) === 'ExpoImage')).toHaveLength(0);
    expect(StyleSheet.flatten(byTestId(root, 'index-photo')[0].props.style).backgroundColor).toBe(tint().soft);
    // Still the recipe's photo, so still Change photo.
    expect(pressables(root, 'Change photo')).toHaveLength(1);
  });

  test('no spinner in the square unless a photo is being generated', () => {
    const root = render();
    expect(byTestId(root, 'photo-generating')).toHaveLength(0);
    expect(card(root).props.generating).toBe(false);
  });

  test('while Generate with AI runs, a small spinner in the square, read as "Generating photo…"', () => {
    const root = render();
    const props = card(root).props as React.ComponentProps<typeof RecipeIndexCard>;
    act(() =>
      tree!.update(
        <SafeAreaProvider initialMetrics={METRICS}>
          <RecipeIndexCard {...props} generating />
        </SafeAreaProvider>,
      ),
    );
    const [spinner] = byTestId(root, 'photo-generating');
    expect(spinner.props.accessibilityLabel).toBe('Generating photo…');
    expect(spinner.props.color).toBe(tint().strong);
    // Inside the square.
    expect(byTestId(root, 'index-photo')[0].findAll((n) => n.props.testID === 'photo-generating').length).toBeGreaterThan(0);
  });
});

describe('the source line', () => {
  test('with a link and servings: the host without www. in the strong tint, " · ", and "For 4" underlined', () => {
    setLink('https://www.example.com/recipes/tacos?x=1');
    updateRecipeServings(tacos, 4);
    const root = render();
    const line = byTestId(root, 'index-source-line')[0];
    expect(texts(line)).toEqual(['example.com', '·', 'For 4']);
    const host = line.find((n) => String(n.type) === 'Text' && textOf(n) === 'example.com');
    expect(StyleSheet.flatten(host.props.style)).toMatchObject({ color: tint().strong, fontSize: Typography.headline.fontSize });
    const dot = line.find((n) => String(n.type) === 'Text' && textOf(n) === '·');
    expect(StyleSheet.flatten(dot.props.style).color).toBe(Palette.light.inkSecondary);
    const servings = line.find((n) => String(n.type) === 'Text' && textOf(n) === 'For 4');
    expect(StyleSheet.flatten(servings.props.style)).toMatchObject({ color: Palette.light.ink, fontSize: Typography.headline.fontSize });
    expect(StyleSheet.flatten(byTestId(root, 'servings-underline')[0].props.style)).toEqual({
      borderBottomWidth: 2,
      borderBottomColor: tint().soft,
    });

    const [link] = pressables(root, 'Recipe link, example.com');
    expect(link.props.accessibilityRole).toBe('link');
    press(link);
    expect(mockOpenURL).toHaveBeenCalledWith('https://www.example.com/recipes/tacos?x=1');
  });

  test('servings only: just "For 4"', () => {
    updateRecipeServings(tacos, 4);
    const root = render();
    expect(texts(byTestId(root, 'index-source-line')[0])).toEqual(['For 4']);
    expect(root.root.findAll((n) => n.props.accessibilityRole === 'link')).toHaveLength(0);
  });

  test('text that is not a link counts as no link', () => {
    setLink('grandma’s card');
    updateRecipeServings(tacos, 2);
    const root = render();
    expect(texts(byTestId(root, 'index-source-line')[0])).toEqual(['For 2']);
  });

  test('a link and no servings: the host and a dashed Add servings pill that opens the servings prompt', () => {
    setLink('https://example.com/tacos');
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render();
    expect(texts(byTestId(root, 'index-source-line')[0])).toEqual(['example.com', '·', 'Add servings']);
    const pill = root.root.findAllByType(Pill).find((p) => p.props.label === 'Add servings')!;
    expect(pill.props.dashed).toBe(true);
    act(() => pill.props.onPress());
    expect(prompt).toHaveBeenCalledWith('Servings', expect.any(String), expect.any(Function), 'plain-text', '', 'number-pad');
  });

  test('neither: no line', () => {
    const root = render();
    expect(byTestId(root, 'index-source-line')).toHaveLength(0);
    expect(root.root.findAllByType(Pill).filter((p) => p.props.label === 'Add servings')).toHaveLength(0);
  });

  test('tapping "For 4" shows the stepper, which scales the amounts; Reset shows off the recipe\'s servings', () => {
    updateRecipeServings(tacos, 4);
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    addRecipeIngredient(tacos, '1 cup heavy cream');
    addRecipeIngredient(tacos, 'cilantro');
    const root = render();
    expect(root.root.findAllByType(Stepper)).toHaveLength(0);
    const servings = byTestId(root, 'index-servings')[0];
    expect(servings.props.accessibilityLabel).toBe('Servings');
    expect(servings.props.accessibilityValue).toEqual({ text: 'For 4' });
    press(servings);

    const stepper = root.root.findByType(Stepper);
    expect(stepper.props).toMatchObject({ value: 4, min: 1, max: 100, label: 'For 4', accessibilityLabel: 'Servings' });
    expect(byTestId(root, 'index-servings')).toHaveLength(0);
    expect(pressables(root, 'Reset')).toHaveLength(0);
    expect(shownAmounts(root)).toEqual(['2 lb', '1 cup', '']);

    act(() => stepper.props.onChange(8));
    expect(root.root.findByType(Stepper).props.label).toBe('For 8');
    expect(shownAmounts(root)).toEqual(['4 lb', '2 cup', '']);
    act(() => root.root.findByType(Stepper).props.onChange(2));
    expect(shownAmounts(root)).toEqual(['1 lb', '½ cup', '']);

    const reset = root.root.find((n) => typeof n.type !== 'string' && n.props.label === 'Reset' && typeof n.props.onPress === 'function');
    act(() => reset.props.onPress());
    expect(root.root.findByType(Stepper).props.value).toBe(4);
    expect(shownAmounts(root)).toEqual(['2 lb', '1 cup', '']);
    // The stepper stays once shown.
    expect(byTestId(root, 'index-servings')).toHaveLength(0);
  });
});

describe('the notes', () => {
  test('in full, in quotes, in lead italic in the strong tint; a tap edits them and saves on end', () => {
    const long = 'Double the garlic. Thighs, not breasts. Marinate overnight if you can, it really is better that way.';
    updateRecipe(tacos, { name: 'Tacos', notes: long, sourceUrl: 'https://example.com/t' });
    const root = render();
    const text = root.root.find((n) => String(n.type) === 'Text' && textOf(n) === `“${long}”`);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(text.props.style)).toMatchObject({
      fontSize: Typography.lead.fontSize,
      fontWeight: '400',
      fontStyle: 'italic',
      color: tint().strong,
    });

    press(pressables(root, `Notes: ${long}`)[0]);
    const field = root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Notes');
    expect(field.props.value).toBe(long);
    act(() => field.props.onChangeText('Less salt'));
    act(() => field.props.onEndEditing());
    // The link is kept.
    expect(getRecipe(tacos)).toMatchObject({ notes: 'Less salt', sourceUrl: 'https://example.com/t' });
    expect(root.root.findAll((n) => String(n.type) === 'Text' && textOf(n) === '“Less salt”')).toHaveLength(1);
  });

  test('no notes: "+ Add notes", which opens the field; tags are not shown', () => {
    db.update(recipes)
      .set({ tags: { cuisine: ['Mexican'], meal: [], diet: [], method: [], time: [], custom: [] } as never })
      .where(eq(recipes.id, tacos))
      .run();
    const root = render();
    expect(texts(root.root)).not.toContain('Mexican');
    press(pressables(root, 'Add notes')[0]);
    expect(root.root.findAll((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Notes')).toHaveLength(1);
  });

  test('a hairline under the header, 16 pt above and below', () => {
    const root = render();
    expect(StyleSheet.flatten(byTestId(root, 'index-separator')[0].props.style)).toEqual({
      height: StyleSheet.hairlineWidth,
      backgroundColor: Palette.light.border,
      marginHorizontal: 20,
      marginVertical: 16,
    });
  });
});

describe('the ingredients', () => {
  test('one row each: the amount, then the name and its note, no aisle dots; then Add ingredient', () => {
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    addRecipeIngredient(tacos, '3 tbsp butter');
    updateRecipeIngredient(recipeIngredientsQuery(tacos).all()[1].id, '3 tbsp butter', 'softened');
    const root = render();
    const rows = root.root.findAllByType(RecipeIngredientRow);
    expect(rows.map((r) => r.props.layout)).toEqual(['indexCard', 'indexCard']);
    expect(shownAmounts(root)).toEqual(['2 lb', '3 tbsp']);
    const [butter] = rows[1].findAll((n) => String(n.type) === 'Text' && textOf(n).startsWith('Butter'));
    expect(textOf(butter)).toBe('Butter softened');
    const [note] = butter.findAll((n) => String(n.type) === 'Text' && n !== butter && textOf(n) === ' softened');
    expect(StyleSheet.flatten(note.props.style).color).toBe(Palette.light.inkSecondary);
    expect(StyleSheet.flatten(butter.props.style)).toMatchObject({ color: Palette.light.ink, fontSize: Typography.body.fontSize });
    const row = rows[0].find((n) => typeof n.type !== 'string' && typeof n.props.onLongPress === 'function');
    const style = StyleSheet.flatten(row.props.style({ pressed: false }));
    expect(style).toMatchObject({ minHeight: Sizes.minTapTarget, backgroundColor: Palette.light.background, gap: 12 });
    expect(style.borderTopWidth).toBeUndefined();
    expect(byTestId(root, 'add-ingredient-row')).toHaveLength(1);
  });

  test('the amounts right-align in a column as wide as the widest, at most 40% of the width', () => {
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    addRecipeIngredient(tacos, '3 tbsp butter');
    addRecipeIngredient(tacos, '2 lb pork');
    const root = render();
    const amounts = () => byTestId(root, 'ingredient-amount');
    for (const a of amounts()) expect(StyleSheet.flatten(a.props.style)).toMatchObject({ textAlign: 'right', color: Palette.light.inkSecondary });
    // Each amount is measured once, unseen.
    const measures = byTestId(root, 'amount-measure');
    expect(measures.map(textOf)).toEqual(['2 lb', '3 tbsp']);
    expect(StyleSheet.flatten(amounts()[0].props.style).width).toBeUndefined();

    layout(byTestId(root, 'ingredient-rows')[0], 390);
    layout(measures[0], 30);
    layout(measures[1], 64);
    expect(amounts().map((a) => StyleSheet.flatten(a.props.style).width)).toEqual([64, 64, 64]);

    // A very wide amount is capped at 40% of the rows' width less the 20 pt margins: (390 − 40) × 0.4 = 140.
    layout(measures[1], 200);
    expect(amounts().map((a) => StyleSheet.flatten(a.props.style).width)).toEqual([140, 140, 140]);
  });

  test('amountColumnWidth: the widest, capped at 40%; none before the width is known', () => {
    expect(amountColumnWidth([30, 64, 12], 350)).toBe(64);
    expect(amountColumnWidth([30, 200], 350)).toBe(140);
    expect(amountColumnWidth([], 350)).toBe(0);
    expect(amountColumnWidth([30], 0)).toBeUndefined();
    expect(amountColumnWidth([30], -10)).toBeUndefined();
  });

  test('tap edits, long-press offers the lists, swipe deletes with Undo', () => {
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const root = render();
    const row = root.root.findByType(RecipeIngredientRow).find((n) => typeof n.type !== 'string' && typeof n.props.onLongPress === 'function');
    expect(row.props.accessibilityLabel).toBe('2 lb Chicken thighs');
    expect(row.props.accessibilityActions.map((a: { label: string }) => a.label)).toEqual(['Add to a list', 'Delete']);

    act(() => row.props.onPress());
    expect(prompt).toHaveBeenCalledWith('Edit ingredient', undefined, expect.any(Function), 'plain-text', '2 lb chicken thighs');

    act(() => row.props.onLongPress());
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.calls[0][0].title).toBe('Chicken thighs');

    act(() => root.root.find((n) => String(n.type) === 'Swipeable').props.onSwipeableOpen());
    expect(root.root.findAllByType(RecipeIngredientRow)).toHaveLength(0);
    expect(texts(root.root)).toContain('Removed Chicken thighs');
    expect(texts(root.root)).toContain('No ingredients yet. Add them below.');
  });

  test('Add ingredient opens the add bar, and the dock hides while adding', () => {
    const root = render();
    expect(root.root.findAll((n) => String(n.type) === 'ItemAddBar')).toHaveLength(0);
    press(pressables(root, 'Add an ingredient')[0]);
    expect(root.root.findAll((n) => String(n.type) === 'ItemAddBar')).toHaveLength(1);
  });
});

describe('the method', () => {
  test('folded behind "Method, 3 steps" and a chevron; a tap shows the card and "Hide method", read with its state', () => {
    setSteps(STEPS);
    const root = render();
    expect(root.root.findAllByType(RecipeMethodCard)).toHaveLength(0);
    const line = () => byTestId(root, 'method-line')[0];
    expect(line().props.accessibilityRole).toBe('button');
    expect(line().props.accessibilityLabel).toBe('Method, 3 steps');
    expect(line().props.accessibilityState).toEqual({ expanded: false });
    expect(texts(line())).toEqual(['Method, 3 steps']);
    const label = line().find((n) => String(n.type) === 'Text');
    expect(StyleSheet.flatten(label.props.style)).toMatchObject({ color: tint().strong, fontSize: Typography.headline.fontSize });
    expect(line().find((n) => String(n.type) === 'Icon').props).toMatchObject({ name: 'chevron.right', tint: tint().strong });

    press(line());
    expect(root.root.findAllByType(RecipeMethodCard)).toHaveLength(1);
    expect(texts(line())).toEqual(['Hide method']);
    expect(line().props.accessibilityState).toEqual({ expanded: true });
    expect(line().find((n) => String(n.type) === 'Icon').props.name).toBe('chevron.down');
    expect(texts(root.root)).toContain(STEPS[0]);

    press(line());
    expect(root.root.findAllByType(RecipeMethodCard)).toHaveLength(0);
  });

  test("the count is the method's path: headings aren't steps, and a choice counts its picked option", () => {
    setSteps([{ heading: 'Sauce' }, 'Blend.', 'Simmer.', { heading: 'Grill' }, 'Grill.'] as RecipeStepEntry[]);
    const root = render();
    expect(byTestId(root, 'method-line')[0].props.accessibilityLabel).toBe('Method, 3 steps');
  });

  test('one step: "Method, 1 step"', () => {
    setSteps(['Just eat it.']);
    const root = render();
    expect(texts(byTestId(root, 'method-line')[0])).toEqual(['Method, 1 step']);
  });

  test('no steps: the Method card with Add steps, and no method line', () => {
    const root = render();
    expect(byTestId(root, 'method-line')).toHaveLength(0);
    expect(root.root.findAllByType(RecipeMethodCard)).toHaveLength(1);
    expect(texts(root.root)).toContain('No steps yet.');
    const add = root.root.findAllByType(Pill).find((p) => p.props.label === 'Add steps')!;
    act(() => add.props.onPress());
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/steps', params: { id: tacos } });
  });
});

describe('the dock', () => {
  test('Add to a list, Cook and Plan, as in the standard view', () => {
    setSteps(STEPS);
    updateRecipeServings(tacos, 4);
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const root = render();
    const byLabel = (label: string) =>
      root.root.find((n) => typeof n.type !== 'string' && n.props.label === label && typeof n.props.onPress === 'function');
    act(() => byLabel('Add to a list').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/add-to-list', params: { id: tacos } });
    act(() => byLabel('Cook').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/cook', params: { id: tacos, servings: '4' } });
    act(() => byLabel('Plan').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/plan-recipe', params: { recipeId: tacos } });
  });

  test("Cook and Add to a list take the stepper's servings", () => {
    setSteps(STEPS);
    updateRecipeServings(tacos, 4);
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    const root = render();
    press(byTestId(root, 'index-servings')[0]);
    act(() => root.root.findByType(Stepper).props.onChange(6));
    const byLabel = (label: string) =>
      root.root.find((n) => typeof n.type !== 'string' && n.props.label === label && typeof n.props.onPress === 'function');
    act(() => byLabel('Add to a list').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/add-to-list', params: { id: tacos, servings: '6' } });
    act(() => byLabel('Cook').props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/recipe/[id]/cook', params: { id: tacos, servings: '6' } });
  });
});

describe('in Spanish', () => {
  test('the notes in « », "Ocultar preparación" and "Cambiar foto"', () => {
    initI18n('es');
    try {
      setSteps(STEPS);
      updateRecipe(tacos, { name: 'Tacos', notes: 'Más ajo', sourceUrl: '' });
      db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
      const root = render();
      expect(texts(root.root)).toContain('«Más ajo»');
      expect(pressables(root, 'Cambiar foto')).toHaveLength(1);
      expect(texts(byTestId(root, 'method-line')[0])).toEqual(['Preparación, 3 pasos']);
      press(byTestId(root, 'method-line')[0]);
      expect(texts(byTestId(root, 'method-line')[0])).toEqual(['Ocultar preparación']);
    } finally {
      initI18n('en');
    }
  });
});
