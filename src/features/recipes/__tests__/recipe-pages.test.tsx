// A photo import's original pages (spec 4.5): See original pages in the recipe's ⋯ menu, the Method card's
// "From your photos · View pages" credit, and the full-screen pages screen (paging, loading, Share page,
// Delete pages), rendered against the in-memory database.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert, Share, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { SegmentedControl } from '@/components/segmented-control';
import { db, outbox, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import RecipeScreen from '@/app/recipe/[id]/index';
import RecipePagesScreen from '@/app/recipe/[id]/pages';

import { dismissPagesDeleted, shareRecipePage } from '../recipe-pages';
import { recipePhotoSource, RECIPE_PAGES_BUCKET, resetPhotoSession } from '../recipe-photo-source';
import { createRecipe, getRecipe, updateRecipe, updateRecipeSourcePages, updateRecipeSteps } from '../recipes';

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
// The connection: online unless a test says otherwise.
const mockNetwork = { online: true };
jest.mock('expo-network', () => ({
  getNetworkStateAsync: () => Promise.resolve({ isConnected: mockNetwork.online, isInternetReachable: mockNetwork.online }),
  addNetworkStateListener: () => ({ remove: () => {} }),
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
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(({ children }: { children?: unknown }) => createElement(Fragment, null, children), {
    Button: host('ToolbarButton'),
    Menu: host('ToolbarMenu'),
    MenuAction: host('ToolbarMenuAction'),
  });
  return {
    Stack: { Screen: host('StackScreen'), Toolbar },
    router: { push: (...args: unknown[]) => mockPush(...args), navigate: jest.fn(), back: () => mockBack() },
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
const mockCachePath = jest.fn(async (_key: string): Promise<string | null> => null);
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return {
    Image: Object.assign((props: object) => createElement('ExpoImage', props), {
      getCachePathAsync: (key: string) => mockCachePath(key),
    }),
  };
});
const mockCopies: { from: string; to: string }[] = [];
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    async copy(to: { uri: string }) {
      mockCopies.push({ from: this.uri, to: to.uri });
    }
  }
  return { File, Paths: { cache: { uri: 'file:///cache' } } };
});
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Button: host('SwiftButton'),
    ContextMenu: Object.assign(host('SwiftContextMenu'), {
      Items: host('SwiftContextMenuItems'),
      Trigger: host('SwiftContextMenuTrigger'),
    }),
    Host: host('SwiftHost'),
    Menu: ({ label, children, ...props }: { label?: unknown; children?: unknown }) => createElement('SwiftMenu', props, label, children),
    RNHostView: host('RNHostView'),
    Section: host('SwiftSection'),
    Text: host('SwiftText'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  accessibilityHint: (value: string) => ({ accessibilityHint: value }),
  disabled: (value: boolean) => ({ disabled: value }),
}));
jest.mock('expo-linking', () => ({ openURL: () => Promise.resolve() }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const USER = 'user-1';
let tree: ReactTestRenderer | null = null;
let lemon: string;
let household: string;
let pages: string[];

beforeEach(() => {
  resetDb();
  resetPhotoSession();
  ensureStarterData(USER);
  lemon = createRecipe('Lemon bars');
  household = getRecipe(lemon)!.householdId;
  pages = [`${household}/${lemon}/aaaaaaaa-0000-4000-8000-000000000001.jpg`, `${household}/${lemon}/aaaaaaaa-0000-4000-8000-000000000002.jpg`];
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = lemon;
  mockPush.mockClear();
  mockBack.mockClear();
  mockCachePath.mockReset();
  mockCachePath.mockImplementation(async () => null);
  mockCopies.length = 0;
  mockNetwork.online = true;
  dismissPagesDeleted();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

/** Every host Text's full string (nested Text included), outermost only, in order. */
const texts = (root: ReactTestRenderer) => {
  const out: string[] = [];
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : node && typeof node === 'object' ? ((node as { children?: unknown[] }).children ?? []).map(flat).join('') : '';
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type: string; children?: unknown[] };
    if (n.type === 'Text') {
      const s = flat(n);
      if (s) out.push(s);
      return;
    }
    n.children?.forEach(walk);
  };
  walk(root.toJSON());
  return out;
};
const byType = (root: ReactTestRenderer, type: string) => root.root.findAll((n) => n.type === type);
const byTestId = (root: ReactTestRenderer, id: string) => root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
const byA11y = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const menuTitles = (root: ReactTestRenderer) => byType(root, 'ToolbarMenuAction').map((n) => n.props.children as string);
const menuAction = (root: ReactTestRenderer, title: string) => byType(root, 'ToolbarMenuAction').find((n) => n.props.children === title)!;
const swiftButton = (root: ReactTestRenderer, label: string) => byType(root, 'SwiftButton').find((n) => n.props.label === label)!;
const pageLabels = (root: ReactTestRenderer) =>
  root.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'image').map((n) => n.props.accessibilityLabel);
const swipeTo = (root: ReactTestRenderer, page: number) =>
  act(() => byTestId(root, 'recipe-pages-pager')[0].props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: page * 390, y: 0 } } }));
/** The recipe screen on its Method tab (with steps it opens on Ingredients). */
const renderMethod = () => {
  const root = render(<RecipeScreen />);
  act(() => root.root.find((n) => n.type === SegmentedControl).props.onChange('method'));
  return root;
};
/** Settles the network check's promise. */
const settle = () => act(async () => {});

describe('See original pages in the recipe menu', () => {
  test('a recipe with pages has the item after Rename and Servings, before Change photo and Delete', () => {
    updateRecipeSourcePages(lemon, pages);
    db.update(recipes).set({ servings: 4, imageUrl: 'https://example.com/bars.jpg' }).where(eq(recipes.id, lemon)).run();
    const root = render(<RecipeScreen />);
    expect(menuTitles(root)).toEqual(['Rename', 'Edit servings', 'See original pages', 'Change photo…', 'Delete recipe']);
    expect(menuAction(root, 'See original pages').props.icon).toBe('doc.text');
  });

  test('a recipe without pages has no such item', () => {
    const root = render(<RecipeScreen />);
    expect(menuTitles(root)).toEqual(['Rename', 'Delete recipe']);
  });

  test('the item opens the pages screen', () => {
    updateRecipeSourcePages(lemon, pages);
    const root = render(<RecipeScreen />);
    press(menuAction(root, 'See original pages'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/pages', params: { id: lemon } });
  });
});

describe("the Method card's photo credit", () => {
  test('pages and no link: "From your photos · View pages" opens the pages screen', () => {
    updateRecipeSteps(lemon, ['Bake the crust.', 'Pour on the filling.']);
    updateRecipeSourcePages(lemon, pages);
    const root = renderMethod();
    expect(texts(root)).toContain('From your photos · View pages');
    const credit = byA11y(root, 'From your photos, 2 pages');
    expect(credit.props.accessibilityRole).toBe('button');
    expect(credit.props.accessibilityHint).toBe('Opens the pages');
    press(credit);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/pages', params: { id: lemon } });
  });

  test('one page reads "1 page"', () => {
    updateRecipeSteps(lemon, ['Bake.']);
    updateRecipeSourcePages(lemon, pages.slice(0, 1));
    const root = renderMethod();
    expect(byA11y(root, 'From your photos, 1 page')).toBeTruthy();
  });

  test('a recipe with a link shows its source credit, not this one', () => {
    updateRecipeSteps(lemon, ['Bake.']);
    updateRecipeSourcePages(lemon, pages);
    updateRecipe(lemon, { name: 'Lemon bars', notes: '', sourceUrl: 'https://www.seriouseats.com/lemon-bars' });
    const root = renderMethod();
    expect(texts(root)).toContain('From seriouseats.com');
    expect(texts(root)).not.toContain('From your photos · View pages');
    expect(byTestId(root, 'pages-credit')).toHaveLength(0);
  });

  test('no pages: no credit', () => {
    updateRecipeSteps(lemon, ['Bake.']);
    const root = renderMethod();
    expect(byTestId(root, 'pages-credit')).toHaveLength(0);
    expect(texts(root)).toContain('Bake.');
  });
});

describe('the pages screen', () => {
  test('shows the name and "Page 1 of 2", each page from recipe-pages, and moves to page 2', async () => {
    updateRecipeSourcePages(lemon, pages);
    const root = render(<RecipePagesScreen />);
    await settle();
    expect(texts(root)).toEqual(['Lemon bars', 'Page 1 of 2']);
    expect(pageLabels(root)).toEqual(['Page 1 of 2', 'Page 2 of 2']);
    const images = byType(root, 'ExpoImage');
    expect(images.map((i) => i.props.source.cacheKey)).toEqual(pages);
    expect(images[0].props.source.uri).toContain(`/storage/v1/object/authenticated/recipe-pages/${pages[0]}`);
    expect(images[0].props.contentFit).toBe('contain');
    expect(byTestId(root, 'recipe-page').map((z) => z.props.maximumZoomScale)).toEqual([4, 4]);
    expect(byTestId(root, 'page-dot-current')).toHaveLength(1);
    expect(byTestId(root, 'page-dot')).toHaveLength(1);

    swipeTo(root, 1);
    expect(texts(root)).toEqual(['Lemon bars', 'Page 2 of 2']);
  });

  test('one page: no dots', async () => {
    updateRecipeSourcePages(lemon, pages.slice(0, 1));
    const root = render(<RecipePagesScreen />);
    await settle();
    expect(texts(root)).toEqual(['Lemon bars', 'Page 1 of 1']);
    expect(byTestId(root, 'page-dot-current')).toHaveLength(0);
    expect(byTestId(root, 'page-dot')).toHaveLength(0);
  });

  test('✕ (Done) closes the screen', async () => {
    updateRecipeSourcePages(lemon, pages);
    const root = render(<RecipePagesScreen />);
    await settle();
    press(byA11y(root, 'Done'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('a page that fails to load says so in its place, "Needs a connection" offline', async () => {
    updateRecipeSourcePages(lemon, pages);
    const root = render(<RecipePagesScreen />);
    await settle();
    // Not an auth failure, so no retry: it fails for good.
    act(() => byType(root, 'ExpoImage')[1].props.onError({ error: 'HTTP 404' }));
    expect(texts(root)).toEqual(['Lemon bars', 'Page 1 of 2', "Couldn't load this page"]);
    expect(byType(root, 'ExpoImage')).toHaveLength(1);
    act(() => tree?.unmount());

    mockNetwork.online = false;
    const offline = render(<RecipePagesScreen />);
    await settle();
    act(() => byType(offline, 'ExpoImage')[0].props.onError({ error: 'HTTP 500' }));
    expect(texts(offline)).toContain('Needs a connection');
    expect(texts(offline)).not.toContain("Couldn't load this page");
  });

  test('the ⋯ menu has Share page and a destructive Delete pages', async () => {
    updateRecipeSourcePages(lemon, pages);
    const root = render(<RecipePagesScreen />);
    await settle();
    expect(byType(root, 'SwiftMenu')[0].props.modifiers).toEqual([{ accessibilityLabel: 'More' }]);
    expect(byType(root, 'SwiftButton').map((b) => [b.props.label, b.props.systemImage, b.props.role])).toEqual([
      ['Share page', 'square.and.arrow.up', undefined],
      ['Delete pages', 'trash', 'destructive'],
    ]);
  });

  test('Delete pages asks; Cancel keeps them, Delete clears source_pages, closes, and the recipe says "Pages deleted"', async () => {
    updateRecipeSourcePages(lemon, pages);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<RecipePagesScreen />);
    await settle();
    press(swiftButton(root, 'Delete pages'));
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] as [string, string, AlertButton[]];
    expect(title).toBe('Delete the original pages?');
    expect(message).toBe('The recipe stays. Everyone in the household loses the pages.');
    expect(buttons.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Delete', 'destructive'],
    ]);
    expect(getRecipe(lemon)?.sourcePages).toEqual(pages);

    const before = db.select().from(outbox).all().length;
    act(() => buttons[1].onPress?.());
    expect(getRecipe(lemon)?.sourcePages).toBeNull();
    expect(mockBack).toHaveBeenCalledTimes(1);
    const pushed = db.select().from(outbox).all().slice(before);
    expect(pushed.map((m) => (m.mutation as { fields?: Record<string, unknown> }).fields?.source_pages)).toContain(null);
    act(() => tree?.unmount());

    const recipeScreen = render(<RecipeScreen />);
    expect(texts(recipeScreen)).toContain('Pages deleted');
    expect(menuTitles(recipeScreen)).not.toContain('See original pages');
  });

  test('Share page shares the current page from the image cache', async () => {
    updateRecipeSourcePages(lemon, pages);
    mockCachePath.mockImplementation(async (key) => `/caches/${key.split('/').pop()}`);
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const root = render(<RecipePagesScreen />);
    await settle();
    swipeTo(root, 1);
    await act(async () => swiftButton(root, 'Share page').props.onPress());
    expect(mockCachePath).toHaveBeenCalledWith(pages[1]);
    expect(mockCopies).toHaveLength(1);
    expect(mockCopies[0].from).toBe('file:///caches/aaaaaaaa-0000-4000-8000-000000000002.jpg');
    expect(mockCopies[0].to).toMatch(/^file:\/\/\/cache\/page-.+\.jpg$/);
    expect(share).toHaveBeenCalledWith({ url: mockCopies[0].to });
  });

  test("a page that isn't in the cache can't be shared, and says so", async () => {
    updateRecipeSourcePages(lemon, pages);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const root = render(<RecipePagesScreen />);
    await settle();
    await act(async () => swiftButton(root, 'Share page').props.onPress());
    expect(share).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith("Couldn't share this page");
  });
});

describe('loading pages', () => {
  test('recipePhotoSource takes the bucket: a page loads from recipe-pages with the auth header and its path as cache key', () => {
    expect(recipePhotoSource({ imageUrl: null, photoPath: pages[0] }, { accessToken: 'tok' }, RECIPE_PAGES_BUCKET)).toEqual({
      uri: expect.stringMatching(new RegExp(`/storage/v1/object/authenticated/recipe-pages/${pages[0]}$`)),
      cacheKey: pages[0],
      headers: { Authorization: 'Bearer tok' },
    });
    // The default is still the recipe's own photo bucket.
    expect((recipePhotoSource({ imageUrl: null, photoPath: pages[0] }, null) as { uri: string }).uri).toContain('/recipe-photos/');
  });

  test('shareRecipePage is false when the cache read throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCachePath.mockImplementation(async () => {
      throw new Error('boom');
    });
    await expect(shareRecipePage(pages[0])).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
