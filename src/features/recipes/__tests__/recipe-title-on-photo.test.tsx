// The title-on-photo recipe view (spec 4.5, board E): the Recipe view trial picks it. The name sits on the photo
// (or the tile colour), over a byline of the link's host, the tags and the notes; the switch, cards and dock are
// the standard view's.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Pill } from '@/components/pill';
import { PhotoScrim } from '@/constants/theme';
import { db, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import RecipeScreen from '@/app/recipe/[id]/index';

import { createRecipe, getRecipe } from '../recipes';
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
  return { __esModule: true, default: ({ children }: { children?: unknown }) => createElement('Swipeable', null, children) };
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

const LINK = 'https://www.nytimes.com/tikka-masala';
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let tree: ReactTestRenderer | null = null;
let tikka: string;

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  tikka = createRecipe('Weeknight chicken tikka masala');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = tikka;
  mockPush.mockClear();
  mockOpenURL.mockClear();
  setRecipeViewStyle('titleOnPhoto');
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setRecipeViewStyle('standard');
  jest.restoreAllMocks();
});

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

const setRecipe = (fields: Partial<typeof recipes.$inferInsert>) => db.update(recipes).set(fields).where(eq(recipes.id, tikka)).run();
const byTestID = (root: ReactTestRenderer, testID: string) =>
  root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === testID);
/** The composite with this accessibility label and an `onPress`. */
const button = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const texts = (n: ReactTestInstance) =>
  n
    .findAll((c) => String(c.type) === 'Text')
    .map((c) => [c.props.children].flat().join(''))
    .filter(Boolean);
const menuActions = (root: ReactTestRenderer) => root.root.findAll((n) => String(n.type) === 'ToolbarMenuAction');
const menuLabels = (root: ReactTestRenderer) => menuActions(root).map((n) => [n.props.children].flat().join(''));

describe('the trial', () => {
  test('swaps the photo header and band for the title photo and byline, and back, at once', () => {
    const root = render();
    expect(byTestID(root, 'recipe-title-photo')).toHaveLength(1);
    expect(byTestID(root, 'recipe-byline')).toHaveLength(1);
    // The band's link field is the standard view's.
    expect(root.root.findAll((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Link to the recipe')).toHaveLength(0);
    act(() => setRecipeViewStyle('standard'));
    expect(byTestID(root, 'recipe-title-photo')).toHaveLength(0);
    expect(byTestID(root, 'recipe-byline')).toHaveLength(0);
    expect(root.root.findAll((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Link to the recipe')).toHaveLength(1);
  });

  test('the native header is transparent over the photo, or the tile colour without one', () => {
    const root = render();
    const options = root.root.find((n) => String(n.type) === 'StackScreen').props.options;
    expect(options).toMatchObject({ headerTransparent: true, headerShadowVisible: false });
  });
});

describe('the title photo', () => {
  test('the name is a header in white on the photo scrim', () => {
    const root = render();
    const [header] = byTestID(root, 'recipe-title-photo');
    const title = header.find((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'header');
    expect([title.props.children].flat().join('')).toBe('Weeknight chicken tikka masala');
    const band = header.find((n) => String(n.type) === 'View' && n.props.style?.backgroundColor === PhotoScrim.fill);
    expect(band.findAll((n) => n === title)).toHaveLength(1);
    expect(title.props.style).toContainEqual({ color: PhotoScrim.text });
  });

  test('no photo: the tile colour is Add photo, opening Choose a photo', () => {
    const root = render();
    expect(byTestID(root, 'recipe-photo')).toHaveLength(0);
    act(() => button(root, 'Add photo').props.onPress());
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/photo', params: { id: tikka } });
  });

  test('a photo fills it, with no Add photo and no credit chip', () => {
    setRecipe({ imageUrl: 'https://www.nytimes.com/tikka.jpg', sourceUrl: LINK });
    const root = render();
    expect(root.root.findAll((n) => String(n.type) === 'ExpoImage')).toHaveLength(1);
    expect(byTestID(root, 'add-photo')).toHaveLength(0);
    expect(byTestID(root, 'recipe-credit-photo')).toHaveLength(0);
  });
});

describe('the byline', () => {
  test("the link's host opens Safari", () => {
    setRecipe({ sourceUrl: LINK });
    const root = render();
    const host = button(root, 'Recipe link, nytimes.com');
    expect(host.props.accessibilityRole).toBe('link');
    expect(texts(host)).toEqual(['nytimes.com']);
    act(() => host.props.onPress());
    expect(mockOpenURL).toHaveBeenCalledWith(LINK);
  });

  test('no link: just the tags', () => {
    const root = render();
    const [byline] = byTestID(root, 'recipe-byline');
    expect(byline.findAll((n) => n.props.accessibilityRole === 'link')).toHaveLength(0);
    expect(texts(byline)).toContain('Add tags');
  });

  test('notes on one line; a tap edits them, saved when editing ends', () => {
    setRecipe({ notes: 'Double the garlic. Thighs, not breasts: 25 min.' });
    const root = render();
    const notes = button(root, 'Notes: Double the garlic. Thighs, not breasts: 25 min.');
    const line = notes.find((n) => String(n.type) === 'Text');
    expect(line.props.numberOfLines).toBe(1);
    act(() => notes.props.onPress());
    const field = root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Notes');
    act(() => field.props.onChangeText('Use thighs.'));
    act(() => field.props.onEndEditing());
    expect(getRecipe(tikka)?.notes).toBe('Use thighs.');
  });

  test('no notes: + Add notes', () => {
    const root = render();
    act(() => button(root, 'Add notes').props.onPress());
    expect(root.root.findAll((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Notes')).toHaveLength(1);
  });
});

describe('the link and servings without their band fields', () => {
  test('the ⋯ menu adds the link, normalized', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render();
    const action = menuActions(root).find((n) => [n.props.children].flat().join('') === 'Add link')!;
    act(() => action.props.onPress());
    const [title, , save, , initial] = prompt.mock.calls[0] as unknown as [string, unknown, (text: string) => void, unknown, string];
    expect(title).toBe('Link to the recipe');
    expect(initial).toBe('');
    act(() => save('nytimes.com/tikka-masala'));
    expect(getRecipe(tikka)?.sourceUrl).toBe('https://nytimes.com/tikka-masala');
  });

  test('with a link the menu reads Edit link; the standard view has neither', () => {
    setRecipe({ sourceUrl: LINK });
    const root = render();
    expect(menuLabels(root)).toContain('Edit link');
    act(() => setRecipeViewStyle('standard'));
    expect(menuLabels(root)).not.toContain('Edit link');
    expect(menuLabels(root)).not.toContain('Add link');
  });

  test('no servings: Add servings in the Ingredients card header; with servings, the stepper', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render();
    const servingsPills = () => root.root.findAllByType(Pill).filter((p) => p.props.label === 'Add servings');
    const [pill] = servingsPills();
    expect(pill.props.dashed).toBe(true);
    act(() => pill.props.onPress());
    expect(prompt.mock.calls[0][0]).toBe('Servings');
    setRecipe({ servings: 4 });
    act(() => setRecipeViewStyle('standard'));
    act(() => setRecipeViewStyle('titleOnPhoto'));
    expect(servingsPills()).toHaveLength(0);
  });
});
