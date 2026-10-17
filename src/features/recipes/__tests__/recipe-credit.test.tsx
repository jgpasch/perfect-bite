// The recipe's source credit (spec 4.5): "From <host>" under the steps, in Cook mode and on the photo.

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Palette } from '@/constants/theme';
import { db, recipes } from '@/db';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData } from '@/features/lists/lists';
import { i18n } from '@/i18n';
import { resetDb } from '@/test/db';

import CookScreen from '@/app/recipe/[id]/cook';
import RecipeScreen from '@/app/recipe/[id]/index';

import { PhotoCreditChip, RecipeCredit } from '../recipe-credit';
import { RecipeMethodCard } from '../recipe-method-card';
import { createRecipe, getRecipe } from '../recipes';

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
const mockOpenURL = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('expo-linking', () => ({ openURL: (url: string) => mockOpenURL(url) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: () => Promise.resolve(true) }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const LINK = 'https://www.seriouseats.com/chipotle-chicken-tacos';
const PHOTO = 'https://www.seriouseats.com/tacos.jpg';
const STEPS = ['Blend the chipotles into a paste.', 'Grill the thighs.'];
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let tree: ReactTestRenderer | null = null;
let tacos: string;

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  tacos = createRecipe('Tacos');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = tacos;
  mockOpenURL.mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  void i18n.changeLanguage('en');
});

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

const setRecipe = (fields: Partial<typeof recipes.$inferInsert>) => db.update(recipes).set(fields).where(eq(recipes.id, tacos)).run();
/** The credits (host Views with the link role), by test ID: `recipe-credit` or `recipe-credit-photo`. */
const credits = (root: ReactTestRenderer, testID = 'recipe-credit') =>
  root.root.findAll((n) => String(n.type) === 'View' && n.props.testID === testID);
const textOf = (n: ReactTestInstance) =>
  n
    .findAll((c) => String(c.type) === 'Text')
    .map((c) => [c.props.children].flat().join(''))
    .join('');
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
/** The composite Pressable behind a host credit. */
const pressable = (root: ReactTestRenderer, testID = 'recipe-credit') =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.testID === testID && typeof n.props.onPress === 'function');
const methodTab = (root: ReactTestRenderer) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'tab' && /^Method/.test(n.props.accessibilityLabel ?? ''));
/** Every host Text's content, in render order. */
const hostTexts = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => String(n.type) === 'Text')
    .map((n) => [n.props.children].flat().join(''))
    .filter(Boolean);

describe('RecipeCredit', () => {
  test('a link reads "From <host>" without www., read by VoiceOver as "Recipe from <host>", a link', () => {
    const root = render(<RecipeCredit sourceUrl={LINK} />);
    const [credit] = credits(root);
    expect(textOf(credit)).toBe('From seriouseats.com');
    expect(credit.props.accessibilityRole).toBe('link');
    expect(credit.props.accessibilityLabel).toBe('Recipe from seriouseats.com');
    expect(credit.props.accessibilityHint).toBe('Opens the recipe in Safari');
  });

  test('pressing it opens the original link in Safari', () => {
    const root = render(<RecipeCredit sourceUrl={LINK} />);
    press(pressable(root));
    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(mockOpenURL).toHaveBeenCalledWith(LINK);
  });

  test('keeps a host that is not www. and its port; drops only a leading www.', () => {
    expect(textOf(credits(render(<RecipeCredit sourceUrl="http://cooking.nytimes.com/r/1" />))[0])).toBe('From cooking.nytimes.com');
    act(() => tree!.update(<SafeAreaProvider initialMetrics={METRICS}><RecipeCredit sourceUrl="https://WWW.example.com:8080/x" /></SafeAreaProvider>));
    expect(textOf(credits(tree!)[0])).toBe('From example.com:8080');
  });

  test.each([
    ['no link', null],
    ['an empty link', ''],
    ['plain text', 'Grandma’s card'],
    ['a mailto link', 'mailto:me@example.com'],
    ['a host without a dot', 'http://localhost/recipe'],
  ])('%s: nothing', (_, sourceUrl) => {
    const root = render(<RecipeCredit sourceUrl={sourceUrl} />);
    expect(credits(root)).toHaveLength(0);
    expect(hostTexts(root)).toEqual([]);
  });

  test('in Spanish: "De <host>", read as "Receta de <host>"', async () => {
    await act(async () => {
      await i18n.changeLanguage('es');
    });
    const root = render(<RecipeCredit sourceUrl={LINK} />);
    const [credit] = credits(root);
    expect(textOf(credit)).toBe('De seriouseats.com');
    expect(credit.props.accessibilityLabel).toBe('Receta de seriouseats.com');
  });

  test('at a card foot: footnote in inkSecondary under a hairline, at least 44 pt tall', () => {
    const root = render(<RecipeCredit sourceUrl={LINK} />);
    const [credit] = credits(root);
    expect(StyleSheet.flatten(credit.props.style)).toMatchObject({ minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth });
    const text = credit.find((n) => String(n.type) === 'Text');
    expect(StyleSheet.flatten(text.props.style).color).toBe(Palette.light.inkSecondary);
  });
});

describe('PhotoCreditChip', () => {
  const CREDIT = {
    provider: 'Pixabay',
    author: 'Jane Doe',
    authorUrl: 'https://pixabay.com/users/jane',
    pageUrl: 'https://pixabay.com/photos/bread-123/',
  };

  test('"Photo: Jane Doe / Pixabay", read as "Photo by Jane Doe on Pixabay", a link to the photo\'s page (not the photographer\'s)', () => {
    const root = render(<PhotoCreditChip credit={CREDIT} />);
    const [chip] = credits(root, 'photo-credit');
    expect(textOf(chip)).toBe('Photo: Jane Doe / Pixabay');
    expect(chip.props.accessibilityRole).toBe('link');
    expect(chip.props.accessibilityLabel).toBe('Photo by Jane Doe on Pixabay');
    press(pressable(root, 'photo-credit'));
    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(mockOpenURL).toHaveBeenCalledWith(CREDIT.pageUrl);
  });

  test.each([
    ['no credit', null],
    ['an undefined credit', undefined],
  ])('%s: nothing', (_, credit) => {
    const root = render(<PhotoCreditChip credit={credit} />);
    expect(credits(root, 'photo-credit')).toHaveLength(0);
    expect(hostTexts(root)).toEqual([]);
  });

  test('in Spanish: "Foto: Jane Doe / Pixabay", read as "Foto de Jane Doe en Pixabay"', async () => {
    await act(async () => {
      await i18n.changeLanguage('es');
    });
    const root = render(<PhotoCreditChip credit={CREDIT} />);
    const [chip] = credits(root, 'photo-credit');
    expect(textOf(chip)).toBe('Foto: Jane Doe / Pixabay');
    expect(chip.props.accessibilityLabel).toBe('Foto de Jane Doe en Pixabay');
  });

  test('a long name stays on one line', () => {
    const root = render(<PhotoCreditChip credit={{ ...CREDIT, author: 'A'.repeat(200) }} />);
    const text = credits(root, 'photo-credit')[0].find((n) => String(n.type) === 'Text');
    expect(text.props.numberOfLines).toBe(1);
  });
});

describe('the Method card', () => {
  test('with steps and a link: the credit comes after the last step', () => {
    const root = render(<RecipeMethodCard steps={STEPS} hue={recipeHue(tacos)} sourceUrl={LINK} onEdit={() => {}} />);
    const texts = hostTexts(root);
    expect(texts.indexOf('From seriouseats.com')).toBeGreaterThan(texts.indexOf(STEPS[1]));
    expect(texts[texts.length - 1]).toBe('From seriouseats.com');
  });

  test('a link but no steps: no credit', () => {
    const root = render(<RecipeMethodCard steps={null} hue={recipeHue(tacos)} sourceUrl={LINK} onEdit={() => {}} />);
    expect(credits(root)).toHaveLength(0);
    expect(hostTexts(root)).toContain('No steps yet.');
  });

  test('steps but no link: no credit', () => {
    const root = render(<RecipeMethodCard steps={STEPS} hue={recipeHue(tacos)} onEdit={() => {}} />);
    expect(credits(root)).toHaveLength(0);
  });
});

describe('the recipe screen', () => {
  test('an imported recipe with steps: the Method tab shows the credit, and pressing it opens the link', () => {
    setRecipe({ steps: STEPS, sourceUrl: LINK });
    const root = render(<RecipeScreen />);
    // Ingredients first: the Method card (and so its credit) isn't showing yet.
    expect(credits(root)).toHaveLength(0);
    press(methodTab(root));
    const [credit] = credits(root);
    expect(textOf(credit)).toBe('From seriouseats.com');
    press(pressable(root));
    expect(mockOpenURL).toHaveBeenCalledWith(LINK);
  });

  test('a link with no steps: no credit', () => {
    setRecipe({ sourceUrl: LINK });
    const root = render(<RecipeScreen />);
    expect(credits(root)).toHaveLength(0);
  });

  test('a recipe typed by hand (steps, no link or photo): no credit anywhere', () => {
    setRecipe({ steps: STEPS });
    const root = render(<RecipeScreen />);
    press(methodTab(root));
    expect(credits(root)).toHaveLength(0);
    expect(credits(root, 'recipe-credit-photo')).toHaveLength(0);
    expect(hostTexts(root).some((t) => t.startsWith('From '))).toBe(false);
  });

  test('text kept in the link field that is not a link: no credit', () => {
    setRecipe({ steps: STEPS, sourceUrl: 'from the back of the can' });
    const root = render(<RecipeScreen />);
    press(methodTab(root));
    expect(credits(root)).toHaveLength(0);
  });

  test('editing the link changes the credit; removing it removes the credit', () => {
    setRecipe({ steps: STEPS, sourceUrl: LINK, imageUrl: PHOTO });
    const root = render(<RecipeScreen />);
    press(methodTab(root));
    expect(textOf(credits(root)[0])).toBe('From seriouseats.com');

    // Edit link: the pencil, then a new link typed in the field.
    press(root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Edit link' && n.props.accessibilityRole === 'button'));
    const field = () => root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Link to the recipe');
    act(() => field().props.onChangeText('bonappetit.com/recipe/tacos'));
    act(() => field().props.onEndEditing());
    expect(getRecipe(tacos)?.sourceUrl).toBe('https://bonappetit.com/recipe/tacos');
    // The live query re-renders the screen with the saved link.
    act(() => root.update(<SafeAreaProvider initialMetrics={METRICS}><RecipeScreen /></SafeAreaProvider>));
    expect(textOf(credits(root)[0])).toBe('From bonappetit.com');
    expect(textOf(credits(root, 'recipe-credit-photo')[0])).toBe('From bonappetit.com');
    press(pressable(root));
    expect(mockOpenURL).toHaveBeenLastCalledWith('https://bonappetit.com/recipe/tacos');

    // Remove link, from the link's long-press menu: the recipe is the user's own now.
    press(root.root.find((n) => String(n.type) === 'SwiftButton' && n.props.label === 'Remove link'));
    expect(getRecipe(tacos)?.sourceUrl).toBeNull();
    act(() => root.update(<SafeAreaProvider initialMetrics={METRICS}><RecipeScreen /></SafeAreaProvider>));
    expect(credits(root)).toHaveLength(0);
    expect(credits(root, 'recipe-credit-photo')).toHaveLength(0);
    // The steps stay.
    expect(hostTexts(root)).toEqual(expect.arrayContaining(STEPS));
  });

  test('the site photo carries the credit as a small inkSecondary caption on a surface chip, and it opens the link', () => {
    setRecipe({ sourceUrl: LINK, imageUrl: PHOTO });
    const root = render(<RecipeScreen />);
    const [credit] = credits(root, 'recipe-credit-photo');
    expect(textOf(credit)).toBe('From seriouseats.com');
    expect(credit.props.accessibilityLabel).toBe('Recipe from seriouseats.com');
    expect(StyleSheet.flatten(credit.props.style)).toMatchObject({ position: 'absolute', backgroundColor: Palette.light.surface });
    const text = credit.find((n) => String(n.type) === 'Text');
    expect(StyleSheet.flatten(text.props.style).color).toBe(Palette.light.inkSecondary);
    // Not hidden from VoiceOver with the decorative photo.
    let node: ReactTestInstance | null = credit.parent;
    while (node) {
      expect(node.props.accessibilityElementsHidden).not.toBe(true);
      node = node.parent;
    }
    press(pressable(root, 'recipe-credit-photo'));
    expect(mockOpenURL).toHaveBeenCalledWith(LINK);
  });

  test('a photo without a link: no credit on it', () => {
    setRecipe({ imageUrl: PHOTO });
    const root = render(<RecipeScreen />);
    expect(root.root.findAll((n) => n.props.testID === 'recipe-photo').length).toBeGreaterThan(0);
    expect(credits(root, 'recipe-credit-photo')).toHaveLength(0);
  });
});

describe('Cook mode', () => {
  test('the credit sits at the foot of the last step', () => {
    setRecipe({ steps: STEPS, sourceUrl: LINK });
    const root = render(<CookScreen />);
    const texts = hostTexts(root);
    expect(texts[texts.length - 1]).toBe('From seriouseats.com');
    expect(texts.indexOf('From seriouseats.com')).toBeGreaterThan(texts.indexOf(STEPS[1]));
    expect(credits(root)[0].props.accessibilityLabel).toBe('Recipe from seriouseats.com');
    press(pressable(root));
    expect(mockOpenURL).toHaveBeenCalledWith(LINK);
  });

  test('a recipe typed by hand: no credit', () => {
    setRecipe({ steps: STEPS });
    const root = render(<CookScreen />);
    expect(credits(root)).toHaveLength(0);
    expect(hostTexts(root)).toEqual(expect.arrayContaining(STEPS));
  });
});
