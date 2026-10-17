// Choosing a recipe's photo (spec 4.5): the recipe screen's Add photo tile and Change photo…, the
// Choose a photo sheet's sections by link, no link and offline, picking and removing a photo through
// the usual recipe update, and the "Photo updated" toast's Undo. The server call is faked here;
// recipe-photos.test.ts covers it.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Palette, Sizes } from '@/constants/theme';
import { db, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { DEFAULT_FEATURES, setFeatures } from '@/features/plans/features';
import { resetDb } from '@/test/db';
import { outboxMutations } from '@/test/outbox';

import RecipeScreen from '@/app/recipe/[id]/index';
import RecipePhotoSheet from '@/app/recipe/[id]/photo';

import { dismissPhotoChange, type PagePhotosResult } from '../recipe-photos';
import { createRecipe, getRecipe, updateRecipe } from '../recipes';

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
jest.mock('@/features/recipes/ensure-step-match', () => ({ useEnsureStepMatch: () => {}, ensureStepMatchSoon: () => {} }));
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
    Stack: { Screen: host('StackScreen'), Toolbar },
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => mockBack() },
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
jest.mock('expo-linking', () => ({ openURL: () => Promise.resolve(true) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: () => Promise.resolve(true) }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));
// The server call; the rest of the module (the change store) stays real.
let resolvePhotos: (result: PagePhotosResult) => void = () => {};
const mockLoad = jest.fn((_url: string) => new Promise<PagePhotosResult>((resolve) => (resolvePhotos = resolve)));
jest.mock('@/features/recipes/recipe-photos', () => ({
  ...jest.requireActual<object>('@/features/recipes/recipe-photos'),
  loadPagePhotos: (url: string) => mockLoad(url),
}));

const USER = 'user-1';
const LINK = 'https://snacks.example.com/blueberry-bread/';
const A = 'https://snacks.example.com/img/a.jpg';
const B = 'https://snacks.example.com/img/b.jpg';
const C = 'https://snacks.example.com/img/c.jpg';

let tree: ReactTestRenderer | null = null;
let bread: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  bread = createRecipe('Blueberry bread');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = bread;
  mockPush.mockClear();
  mockBack.mockClear();
  mockLoad.mockClear();
  setFeatures(DEFAULT_FEATURES);
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  dismissPhotoChange();
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

const setPhoto = (url: string | null) => db.update(recipes).set({ imageUrl: url }).where(eq(recipes.id, bread)).run();
const setLink = (link: string) => updateRecipe(bread, { name: 'Blueberry bread', notes: '', sourceUrl: link });

const texts = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => String(n.type) === 'Text')
    .map((n) => [n.props.children].flat(Infinity as 1).filter((c) => typeof c === 'string').join(''))
    .filter(Boolean);
const byType = (root: ReactTestRenderer, type: string) => root.root.findAll((n) => n.type === type);
const byTestId = (root: ReactTestRenderer, id: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.testID === id && typeof n.props.onPress === 'function');
const menuTitles = (root: ReactTestRenderer) => byType(root, 'ToolbarMenuAction').map((n) => n.props.children);
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const toasts = (root: ReactTestRenderer) => root.root.findAll((n) => typeof n.type !== 'string' && n.type.name === 'Toast');
const tiles = (root: ReactTestRenderer) => byTestId(root, 'page-photo');
const removeButton = (root: ReactTestRenderer) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'Remove photo' && typeof n.props.onPress === 'function');

async function answer(result: PagePhotosResult) {
  await act(async () => resolvePhotos(result));
}

describe('the recipe screen', () => {
  test('without a photo: a dashed Add photo tile in the band, read as "Add photo, button", that opens the sheet', () => {
    const root = render(<RecipeScreen />);
    const [tile] = byTestId(root, 'add-photo');
    expect(tile.props.accessibilityRole).toBe('button');
    expect(tile.props.accessibilityLabel).toBe('Add photo');
    const style = Object.assign({}, ...[tile.props.style({ pressed: false })].flat(Infinity as 1));
    expect(style).toMatchObject({ borderStyle: 'dashed', borderWidth: 2 });
    press(tile);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/photo', params: { id: bread } });
    // No photo, so no Change photo… in the menu.
    expect(menuTitles(root)).toEqual(['Rename', 'Delete recipe']);
  });

  test('with a photo: no Add photo tile, and Change photo… sits between Rename and Delete', () => {
    setPhoto(A);
    const root = render(<RecipeScreen />);
    expect(byTestId(root, 'add-photo')).toHaveLength(0);
    expect(menuTitles(root)).toEqual(['Rename', 'Change photo…', 'Delete recipe']);
    press(byType(root, 'ToolbarMenuAction').find((n) => n.props.children === 'Change photo…')!);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/photo', params: { id: bread } });
  });

  test('a photo that fails to load still counts as a photo: no Add photo tile, Change photo… in the menu', () => {
    setPhoto(A);
    const root = render(<RecipeScreen />);
    act(() => byType(root, 'ExpoImage')[0].props.onError({ error: '404' }));
    expect(byType(root, 'ExpoImage')).toHaveLength(0);
    expect(byTestId(root, 'add-photo')).toHaveLength(0);
    expect(menuTitles(root)).toContain('Change photo…');
  });
});

describe('the Choose a photo sheet', () => {
  test('with a link: the title, From the page, placeholder tiles while loading, then the page photos', async () => {
    setLink(LINK);
    const root = render(<RecipePhotoSheet />);
    expect(mockLoad).toHaveBeenCalledWith(LINK);
    expect(texts(root)).toEqual(['Choose a photo', 'From the page']);
    const placeholders = root.root.find((n) => n.props.testID === 'photo-placeholders' && String(n.type) === 'View');
    expect(placeholders.props.accessibilityLabel).toBe('Loading photos from the page');
    expect(tiles(root)).toHaveLength(0);

    await answer({ ok: true, images: [A, B, C] });
    expect(root.root.findAll((n) => n.props.testID === 'photo-placeholders')).toHaveLength(0);
    expect(tiles(root).map((t) => t.props.accessibilityLabel)).toEqual([
      'Photo 1 of 3 from the page',
      'Photo 2 of 3 from the page',
      'Photo 3 of 3 from the page',
    ]);
    expect(byType(root, 'ExpoImage').map((i) => i.props.source)).toEqual([A, B, C]);
    // No photo yet: none selected, and no Remove photo.
    expect(tiles(root).map((t) => t.props.accessibilityState.selected)).toEqual([false, false, false]);
    expect(removeButton(root)).toHaveLength(0);
  });

  test('the current photo is selected, outlined in primary; the others are not', async () => {
    setLink(LINK);
    setPhoto(B);
    const root = render(<RecipePhotoSheet />);
    await answer({ ok: true, images: [A, B] });
    const [a, b] = tiles(root);
    expect([a.props.accessibilityState.selected, b.props.accessibilityState.selected]).toEqual([false, true]);
    const look = (t: ReactTestInstance) => Object.assign({}, ...[t.props.style({ pressed: false })].flat(Infinity as 1));
    expect(look(b)).toMatchObject({ borderColor: Palette.light.primary, borderWidth: Sizes.focusRing, aspectRatio: 4 / 3 });
    expect(look(a).borderColor).toBe('transparent');
  });

  test('without a link that opens: no From the page section and no request; Remove photo when there is one', () => {
    setLink('grandma’s card');
    setPhoto(A);
    const root = render(<RecipePhotoSheet />);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(texts(root)).toEqual(['Choose a photo', 'Remove photo']);
    expect(removeButton(root)).toHaveLength(1);
  });

  test('offline: the section says to connect', async () => {
    setLink(LINK);
    const root = render(<RecipePhotoSheet />);
    await answer({ ok: false, error: 'offline' });
    expect(texts(root)).toEqual(['Choose a photo', 'From the page', 'Connect to see photos from the page']);
    expect(tiles(root)).toHaveLength(0);
  });

  test('a page that could not be fetched, or has no photos: "No photos found on the page"', async () => {
    setLink(LINK);
    let root = render(<RecipePhotoSheet />);
    await answer({ ok: false, error: 'none' });
    expect(texts(root)).toContain('No photos found on the page');
    act(() => root.unmount());

    root = render(<RecipePhotoSheet />);
    await answer({ ok: true, images: [] });
    expect(texts(root)).toContain('No photos found on the page');
  });

  test('any other failure says to try later', async () => {
    setLink(LINK);
    const root = render(<RecipePhotoSheet />);
    await answer({ ok: false, error: 'failed' });
    expect(texts(root)).toContain("Couldn't load the page's photos. Try again later.");
  });

  test('a page photo that fails to load leaves the grid, and the rest are renumbered', async () => {
    setLink(LINK);
    const root = render(<RecipePhotoSheet />);
    await answer({ ok: true, images: [A, B, C] });
    act(() => byType(root, 'ExpoImage')[1].props.onError({ error: '403' }));
    expect(tiles(root).map((t) => t.props.accessibilityLabel)).toEqual(['Photo 1 of 2 from the page', 'Photo 2 of 2 from the page']);
    expect(byType(root, 'ExpoImage').map((i) => i.props.source)).toEqual([A, C]);
  });

  test('picking a page photo writes image_url through the recipe update (synced) and closes the sheet', async () => {
    setLink(LINK);
    const root = render(<RecipePhotoSheet />);
    await answer({ ok: true, images: [A, B] });
    press(tiles(root)[1]);
    expect(getRecipe(bread)!.imageUrl).toBe(B);
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'recipes', id: bread, fields: { image_url: B } });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('picking the photo it already has writes nothing', async () => {
    setLink(LINK);
    setPhoto(A);
    const before = outboxMutations().length;
    const root = render(<RecipePhotoSheet />);
    await answer({ ok: true, images: [A, B] });
    press(tiles(root)[0]);
    expect(outboxMutations()).toHaveLength(before);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('Remove photo clears image_url and closes the sheet', () => {
    setPhoto(A);
    const root = render(<RecipePhotoSheet />);
    press(removeButton(root)[0]);
    expect(getRecipe(bread)!.imageUrl).toBeNull();
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'recipes', id: bread, fields: { image_url: null } });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('a missing recipe renders an empty sheet', () => {
    mockParams.id = 'nope';
    const root = render(<RecipePhotoSheet />);
    expect(texts(root)).toEqual([]);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

describe('the toast after a change', () => {
  /** Picks `url` in the sheet (or removes the photo with null), then shows the recipe screen. */
  async function change(url: string | null): Promise<ReactTestRenderer> {
    const sheet = render(<RecipePhotoSheet />);
    if (url === null) {
      press(removeButton(sheet)[0]);
    } else {
      await answer({ ok: true, images: [A, B] });
      press(tiles(sheet).find((t) => byTypeIn(t, 'ExpoImage')[0].props.source === url)!);
    }
    act(() => sheet.unmount());
    return render(<RecipeScreen />);
  }
  const byTypeIn = (n: ReactTestInstance, type: string) => n.findAll((c) => c.type === type);

  test('"Photo updated" with Undo, which puts the previous photo back and ends the toast', async () => {
    setLink(LINK);
    setPhoto(A);
    const root = await change(B);
    const [toast] = toasts(root);
    expect(toast.props.message).toBe('Photo updated');
    expect(toast.props.actions.map((a: { label: string }) => a.label)).toEqual(['Undo']);
    expect(byType(root, 'ExpoImage')[0].props.source).toBe(B);

    act(() => toast.props.actions[0].onPress());
    expect(getRecipe(bread)!.imageUrl).toBe(A);
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'recipes', id: bread, fields: { image_url: A } });
    expect(toasts(root)).toHaveLength(0);
  });

  test('Undo after adding the first photo clears it again, and the Add photo tile comes back', async () => {
    setLink(LINK);
    const root = await change(A);
    expect(byTestId(root, 'add-photo')).toHaveLength(0);
    act(() => toasts(root)[0].props.actions[0].onPress());
    expect(getRecipe(bread)!.imageUrl).toBeNull();
    act(() => root.update(<SafeAreaProvider initialMetrics={METRICS}><RecipeScreen /></SafeAreaProvider>));
    expect(byTestId(root, 'add-photo')).toHaveLength(1);
  });

  test('"Photo removed" with Undo after Remove photo', async () => {
    setPhoto(A);
    const root = await change(null);
    const [toast] = toasts(root);
    expect(toast.props.message).toBe('Photo removed');
    act(() => toast.props.actions[0].onPress());
    expect(getRecipe(bread)!.imageUrl).toBe(A);
  });

  test('the toast times out, and is only on its own recipe', async () => {
    setLink(LINK);
    const root = await change(A);
    act(() => toasts(root)[0].props.onDismiss());
    expect(toasts(root)).toHaveLength(0);

    await change(B);
    act(() => tree?.unmount());
    mockParams.id = createRecipe('Scones');
    const other = render(<RecipeScreen />);
    expect(toasts(other)).toHaveLength(0);
  });

  test('closing the recipe screen ends the toast', async () => {
    setLink(LINK);
    const root = await change(A);
    expect(toasts(root)).toHaveLength(1);
    act(() => root.unmount());
    tree = null;
    const again = render(<RecipeScreen />);
    expect(toasts(again)).toHaveLength(0);
  });
});
