// Choosing a recipe's photo (spec 4.5): the recipe screen's Add photo tile and Change photo…, the
// Choose a photo sheet's sections by link, no link and offline, picking and removing a photo through
// the usual recipe update, and the "Photo updated" toast's Undo. The server call is faked here;
// recipe-photos.test.ts covers it.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Palette, Rounded, Sizes } from '@/constants/theme';
import { db, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { DEFAULT_FEATURES, setFeatures } from '@/features/plans/features';
import { resetDb } from '@/test/db';
import { outboxMutations } from '@/test/outbox';

import RecipeScreen from '@/app/recipe/[id]/index';
import RecipePhotoSheet from '@/app/recipe/[id]/photo';

import { emitAuthEvent, makeSession, resetSupabase, storageUploads, supabase } from '@/test/fake-supabase';

import type { PhotoSearchFailure, PhotoSearchOutcome } from '../photo-search';
import { resetPhotoUpload } from '../photo-upload';
import { resetPhotoSession } from '../recipe-photo-source';
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
const mockNetwork = { connected: true };
jest.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: mockNetwork.connected, isInternetReachable: mockNetwork.connected }),
}));
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
const mockOpenURL = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('expo-linking', () => ({ openURL: (url: string) => mockOpenURL(url) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: () => Promise.resolve(true) }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));
// Photo library and Take photo: the picker, the downscale and the file read are faked; the upload
// goes to the fake Storage.
const mockPicker = {
  library: jest.fn(async (_options: object): Promise<object> => ({ canceled: false, assets: [{ uri: 'file:///picked.heic' }] })),
  camera: jest.fn(async (_options: object): Promise<object> => ({ canceled: false, assets: [{ uri: 'file:///shot.jpg' }] })),
  permission: jest.fn(async () => ({ granted: true })),
};
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (o: object) => mockPicker.library(o),
  launchCameraAsync: (o: object) => mockPicker.camera(o),
  requestCameraPermissionsAsync: () => mockPicker.permission(),
}));
jest.mock('expo-image-manipulator', () => {
  const image = {
    width: 4032,
    height: 3024,
    saveAsync: async () => ({ uri: 'file:///cache/small.jpg', width: 1600, height: 1200 }),
  };
  const context = { resize: () => context, renderAsync: async () => image };
  return { ImageManipulator: { manipulate: () => context }, SaveFormat: { JPEG: 'jpeg' } };
});
jest.mock('expo-file-system', () => ({
  File: class {
    async arrayBuffer() {
      return new ArrayBuffer(8);
    }
  },
}));
// The server call; the rest of the module (the change store) stays real.
let resolvePhotos: (result: PagePhotosResult) => void = () => {};
const mockLoad = jest.fn((_url: string) => new Promise<PagePhotosResult>((resolve) => (resolvePhotos = resolve)));
jest.mock('@/features/recipes/recipe-photos', () => ({
  ...jest.requireActual<object>('@/features/recipes/recipe-photos'),
  loadPagePhotos: (url: string) => mockLoad(url),
}));
// The stock photo search's server call, answered by hand in order; photo-search.test.ts covers it.
let searchAnswers: ((outcome: PhotoSearchOutcome) => void)[] = [];
const mockSearch = jest.fn(
  (_query: string, _page?: number) => new Promise<PhotoSearchOutcome>((resolve) => searchAnswers.push(resolve)),
);
jest.mock('@/features/recipes/photo-search', () => ({
  ...jest.requireActual<object>('@/features/recipes/photo-search'),
  searchPhotos: (query: string, page?: number) => mockSearch(query, page),
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
  mockSearch.mockClear();
  searchAnswers = [];
  mockOpenURL.mockClear();
  setFeatures(DEFAULT_FEATURES);
  resetSupabase();
  resetPhotoSession();
  mockNetwork.connected = true;
  mockPicker.library.mockClear();
  mockPicker.camera.mockClear();
  mockPicker.permission.mockReset().mockResolvedValue({ granted: true });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  dismissPhotoChange();
  resetPhotoUpload();
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

/** The sheet, once it knows whether it's online. */
async function renderSheet(): Promise<ReactTestRenderer> {
  const root = render(<RecipePhotoSheet />);
  await act(async () => {});
  return root;
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
    const root = await renderSheet();
    expect(mockLoad).toHaveBeenCalledWith(LINK);
    expect(texts(root)).toEqual(['Choose a photo', 'From the page', 'Search photos', 'Photos provided by Pexels', 'Photo library', 'Take photo']);
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
    const root = await renderSheet();
    await answer({ ok: true, images: [A, B] });
    const [a, b] = tiles(root);
    expect([a.props.accessibilityState.selected, b.props.accessibilityState.selected]).toEqual([false, true]);
    const look = (t: ReactTestInstance) => Object.assign({}, ...[t.props.style({ pressed: false })].flat(Infinity as 1));
    expect(look(b)).toMatchObject({ borderColor: Palette.light.primary, borderWidth: Sizes.focusRing, aspectRatio: 4 / 3 });
    expect(look(a).borderColor).toBe('transparent');
  });

  test('without a link that opens: no From the page section and no request; Remove photo when there is one', async () => {
    setLink('grandma’s card');
    setPhoto(A);
    const root = await renderSheet();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(texts(root)).toEqual(['Choose a photo', 'Search photos', 'Photos provided by Pexels', 'Photo library', 'Take photo', 'Remove photo']);
    expect(removeButton(root)).toHaveLength(1);
  });

  test('offline: the section says to connect', async () => {
    setLink(LINK);
    const root = await renderSheet();
    await answer({ ok: false, error: 'offline' });
    expect(texts(root)).toEqual([
      'Choose a photo',
      'From the page',
      'Connect to see photos from the page',
      'Search photos',
      'Photos provided by Pexels',
      'Photo library',
      'Take photo',
    ]);
    expect(tiles(root)).toHaveLength(0);
  });

  test('a page that could not be fetched, or has no photos: "No photos found on the page"', async () => {
    setLink(LINK);
    let root = await renderSheet();
    await answer({ ok: false, error: 'none' });
    expect(texts(root)).toContain('No photos found on the page');
    act(() => root.unmount());

    root = await renderSheet();
    await answer({ ok: true, images: [] });
    expect(texts(root)).toContain('No photos found on the page');
  });

  test('any other failure says to try later', async () => {
    setLink(LINK);
    const root = await renderSheet();
    await answer({ ok: false, error: 'failed' });
    expect(texts(root)).toContain("Couldn't load the page's photos. Try again later.");
  });

  test('a page photo that fails to load leaves the grid, and the rest are renumbered', async () => {
    setLink(LINK);
    const root = await renderSheet();
    await answer({ ok: true, images: [A, B, C] });
    act(() => byType(root, 'ExpoImage')[1].props.onError({ error: '403' }));
    expect(tiles(root).map((t) => t.props.accessibilityLabel)).toEqual(['Photo 1 of 2 from the page', 'Photo 2 of 2 from the page']);
    expect(byType(root, 'ExpoImage').map((i) => i.props.source)).toEqual([A, C]);
  });

  test('picking a page photo writes image_url through the recipe update (synced) and closes the sheet', async () => {
    setLink(LINK);
    const root = await renderSheet();
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
    const root = await renderSheet();
    await answer({ ok: true, images: [A, B] });
    press(tiles(root)[0]);
    expect(outboxMutations()).toHaveLength(before);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('Remove photo clears image_url and closes the sheet', async () => {
    setPhoto(A);
    const root = await renderSheet();
    press(removeButton(root)[0]);
    expect(getRecipe(bread)!.imageUrl).toBeNull();
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'recipes', id: bread, fields: { image_url: null } });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('a missing recipe renders an empty sheet', async () => {
    mockParams.id = 'nope';
    const root = await renderSheet();
    expect(texts(root)).toEqual([]);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

describe('the toast after a change', () => {
  /** Picks `url` in the sheet (or removes the photo with null), then shows the recipe screen. */
  async function change(url: string | null): Promise<ReactTestRenderer> {
    const sheet = await renderSheet();
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

describe("the household's own photo (Photo library and Take photo)", () => {
  const OWN = () => `${getRecipe(bread)!.householdId}/${bread}/0190a000-0000-7000-8000-000000000001.jpg`;
  const setOwn = (path: string | null) => db.update(recipes).set({ photoPath: path }).where(eq(recipes.id, bread)).run();
  const row = (root: ReactTestRenderer, label: string) =>
    root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && n.props.accessibilityLabel?.startsWith(label));

  test('online: both rows are buttons that work', async () => {
    const root = await renderSheet();
    for (const label of ['Photo library', 'Take photo']) {
      const r = row(root, label);
      expect(r.props.accessibilityLabel).toBe(label);
      expect(r.props.disabled).toBe(false);
    }
  });

  test('offline: both rows are disabled with "Needs a connection", and a tap does nothing', async () => {
    mockNetwork.connected = false;
    const root = await renderSheet();
    for (const label of ['Photo library', 'Take photo']) {
      const r = row(root, label);
      expect(r.props.accessibilityLabel).toBe(`${label}, Needs a connection`);
      expect(r.props.disabled).toBe(true);
      expect(r.props.accessibilityState).toEqual({ disabled: true });
    }
    // The two rows, and the Search photos section.
    expect(texts(root).filter((s) => s === 'Needs a connection')).toHaveLength(3);
  });

  test('Photo library: picks with a 4:3 crop, uploads the small JPEG under <household>/<recipe>/<uuid>.jpg, sets photo_path, closes', async () => {
    setPhoto(A);
    const root = await renderSheet();
    await act(async () => row(root, 'Photo library').props.onPress());

    expect(mockPicker.library).toHaveBeenCalledWith({ mediaTypes: 'images', allowsEditing: true, aspect: [4, 3], quality: 1 });
    const [bucket, path, body, options] = storageUploads().at(-1)!;
    expect(bucket).toBe('recipe-photos');
    expect(path).toMatch(new RegExp(`^${getRecipe(bread)!.householdId}/${bread}/[0-9a-f-]{36}\\.jpg$`));
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(options).toEqual({ contentType: 'image/jpeg', upsert: false });
    expect(mockBack).toHaveBeenCalledTimes(1);
    // The site photo stays, for Remove; only photo_path is sent, with its (null) credit.
    expect(getRecipe(bread)).toMatchObject({ photoPath: path, imageUrl: A, photoCredit: null });
    expect(outboxMutations().at(-1)).toEqual(
      expect.objectContaining({ table: 'recipes', id: bread, fields: { photo_path: path, photo_credit: null } }),
    );
  });

  test('Take photo asks for the camera; denied shows an alert and uploads nothing', async () => {
    const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
    mockPicker.permission.mockResolvedValue({ granted: false });
    const root = await renderSheet();
    await act(async () => row(root, 'Take photo').props.onPress());
    expect(mockPicker.camera).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('Camera access is off', 'To take a photo, allow camera access for Perfect Bite in Settings.');
    expect(storageUploads()).toHaveLength(0);
    expect(mockBack).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test('cancelling the picker keeps the sheet open and changes nothing', async () => {
    mockPicker.library.mockResolvedValueOnce({ canceled: true, assets: null });
    const root = await renderSheet();
    await act(async () => row(root, 'Photo library').props.onPress());
    expect(storageUploads()).toHaveLength(0);
    expect(mockBack).not.toHaveBeenCalled();
    expect(getRecipe(bread)!.photoPath).toBeNull();
  });

  test('while it uploads, the recipe screen shows the photo from the device with a spinner, then the stored one', async () => {
    let finish: (r: { data: unknown; error: unknown }) => void = () => {};
    const pending = new Promise<{ data: unknown; error: unknown }>((resolve) => (finish = resolve));
    supabase.storage.from.mockImplementationOnce(() => ({ upload: () => pending }) as never);
    const sheet = await renderSheet();
    await act(async () => row(sheet, 'Take photo').props.onPress());
    act(() => sheet.unmount());

    const root = render(<RecipeScreen />);
    expect(byType(root, 'ExpoImage')[0].props.source).toBe('file:///cache/small.jpg');
    expect(root.root.findAll((n) => n.props.testID === 'photo-uploading' && String(n.type) === 'View')).toHaveLength(1);
    expect(byTestId(root, 'add-photo')).toHaveLength(0);

    await act(async () => finish({ data: {}, error: null }));
    expect(root.root.findAll((n) => n.props.testID === 'photo-uploading')).toHaveLength(0);
    const path = getRecipe(bread)!.photoPath!;
    expect(byType(root, 'ExpoImage')[0].props.source).toMatchObject({ cacheKey: path });
    expect(toasts(root).map((t) => t.props.message)).toEqual(['Photo updated']);
  });

  test("a failed upload leaves the recipe as it was and says \"Couldn't upload the photo\" with Try again, which retries", async () => {
    setPhoto(A);
    const upload = jest.fn(
      async (..._args: unknown[]): Promise<{ data: object | null; error: { message: string } | null }> => ({
        data: null,
        error: { message: 'Network request failed' },
      }),
    );
    supabase.storage.from.mockImplementation(() => ({ upload }) as never);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const sheet = await renderSheet();
    await act(async () => row(sheet, 'Photo library').props.onPress());
    act(() => sheet.unmount());

    expect(getRecipe(bread)).toMatchObject({ imageUrl: A, photoPath: null });
    const root = render(<RecipeScreen />);
    // The photo as it was, with no spinner.
    expect(byType(root, 'ExpoImage')[0].props.source).toBe(A);
    const [toast] = toasts(root);
    expect(toast.props.message).toBe("Couldn't upload the photo");
    expect(toast.props.actions.map((a: { label: string }) => a.label)).toEqual(['Try again']);

    upload.mockResolvedValueOnce({ data: {}, error: null });
    await act(async () => toast.props.actions[0].onPress());
    expect(upload).toHaveBeenCalledTimes(2);
    expect(getRecipe(bread)!.photoPath).toMatch(/\.jpg$/);
    expect(toasts(root).map((t) => t.props.message)).toEqual(['Photo updated']);
  });

  test('an own photo loads from Storage with the token and is cached by its path; no credit chip', async () => {
    setLink(LINK);
    setPhoto(A);
    setOwn(OWN());
    const root = render(<RecipeScreen />);
    act(() => emitAuthEvent('SIGNED_IN', { ...makeSession(USER), access_token: 'token-1' }));
    expect(byType(root, 'ExpoImage')[0].props.source).toEqual({
      uri: `https://project.supabase.test/storage/v1/object/authenticated/recipe-photos/${OWN()}`,
      cacheKey: OWN(),
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(root.root.findAll((n) => n.props.testID === 'recipe-credit-photo')).toHaveLength(0);
  });

  test('a site photo keeps its credit chip', () => {
    setLink(LINK);
    setPhoto(A);
    const root = render(<RecipeScreen />);
    expect(root.root.findAll((n) => n.props.testID === 'recipe-credit-photo').length).toBeGreaterThan(0);
  });

  test('with only an own photo: no Add photo tile, and Change photo… in the menu', () => {
    setOwn(OWN());
    const root = render(<RecipeScreen />);
    expect(byTestId(root, 'add-photo')).toHaveLength(0);
    expect(menuTitles(root)).toContain('Change photo…');
  });

  test('Remove photo with an own photo clears photo_path (and its credit) only, so the site photo shows again', async () => {
    setPhoto(A);
    setOwn(OWN());
    const sheet = await renderSheet();
    press(removeButton(sheet)[0]);
    expect(getRecipe(bread)).toMatchObject({ photoPath: null, imageUrl: A });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: null, photo_credit: null });
    act(() => sheet.unmount());

    const root = render(<RecipeScreen />);
    expect(byType(root, 'ExpoImage')[0].props.source).toBe(A);
    const [toast] = toasts(root);
    expect(toast.props.message).toBe('Photo removed');
    // Undo puts the own photo back.
    act(() => toast.props.actions[0].onPress());
    expect(getRecipe(bread)).toMatchObject({ photoPath: OWN(), imageUrl: A });
  });

  test('Remove photo with only a site photo clears image_url', async () => {
    setPhoto(A);
    const sheet = await renderSheet();
    press(removeButton(sheet)[0]);
    expect(getRecipe(bread)).toMatchObject({ photoPath: null, imageUrl: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ image_url: null });
  });

  test('picking a page photo sets image_url and clears photo_path; Undo restores both', async () => {
    setLink(LINK);
    setPhoto(A);
    setOwn(OWN());
    const sheet = await renderSheet();
    await answer({ ok: true, images: [A, B] });
    // With an own photo showing, no page photo is the current one.
    expect(tiles(sheet).map((t) => t.props.accessibilityState.selected)).toEqual([false, false]);
    press(tiles(sheet)[1]);
    expect(getRecipe(bread)).toMatchObject({ imageUrl: B, photoPath: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ image_url: B, photo_path: null, photo_credit: null });
    act(() => sheet.unmount());

    const root = render(<RecipeScreen />);
    act(() => toasts(root)[0].props.actions[0].onPress());
    expect(getRecipe(bread)).toMatchObject({ imageUrl: A, photoPath: OWN() });
    expect(outboxMutations().at(-1)!.fields).toEqual({ image_url: A, photo_path: OWN(), photo_credit: null });
  });

  test('picking a page photo over a stock photo clears its credit; Undo puts the credit back', async () => {
    const credit = {
      provider: 'pexels' as const,
      author: 'Jane Doe',
      authorUrl: 'https://www.pexels.com/@jane',
      pageUrl: 'https://www.pexels.com/photo/bread-123/',
    };
    setLink(LINK);
    setPhoto(A);
    setOwn(OWN());
    db.update(recipes).set({ photoCredit: credit }).where(eq(recipes.id, bread)).run();
    const sheet = await renderSheet();
    await answer({ ok: true, images: [A, B] });
    press(tiles(sheet)[1]);
    expect(getRecipe(bread)).toMatchObject({ imageUrl: B, photoPath: null, photoCredit: null });
    act(() => sheet.unmount());

    const root = render(<RecipeScreen />);
    act(() => toasts(root)[0].props.actions[0].onPress());
    expect(getRecipe(bread)).toMatchObject({ imageUrl: A, photoPath: OWN(), photoCredit: credit });
    expect(outboxMutations().at(-1)!.fields).toEqual({ image_url: A, photo_path: OWN(), photo_credit: credit });
  });

  test('picking the page photo it already shows, with an own photo, still switches to it', async () => {
    setLink(LINK);
    setPhoto(A);
    setOwn(OWN());
    const sheet = await renderSheet();
    await answer({ ok: true, images: [A] });
    press(tiles(sheet)[0]);
    expect(getRecipe(bread)).toMatchObject({ imageUrl: A, photoPath: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: null, photo_credit: null });
  });
});

describe('Search photos', () => {
  const stock = (id: number, author: string, alt: string | null = null) => ({
    id,
    thumb: `https://images.pexels.com/photos/${id}/medium.jpeg`,
    full: `https://images.pexels.com/photos/${id}/large2x.jpeg`,
    width: 1200,
    height: 900,
    author,
    authorUrl: `https://www.pexels.com/@${author.toLowerCase().replace(/ /g, '-')}`,
    pageUrl: `https://www.pexels.com/photo/${id}/`,
    alt,
  });
  const JANE = stock(1, 'Jane Doe');
  const ANA = stock(2, 'Ana Ruiz', 'Sliced bread on a board');
  const LEO = stock(3, 'Leo Park');
  const MIA = stock(4, 'Mia Chen');

  const field = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.testID === 'photo-search-field' && 'editable' in n.props)[0];
  const results = (root: ReactTestRenderer) =>
    root.root.findAll(
      (n) =>
        typeof n.type !== 'string' &&
        n.props.testID === 'search-photo' &&
        n.props.accessibilityRole === 'button' &&
        n.parent?.props.testID !== 'search-photo',
    );
  const labels = (root: ReactTestRenderer) => results(root).map((t) => t.props.accessibilityLabel);
  const loadMore = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'Load more' && typeof n.props.onPress === 'function');
  const searchPlaceholders = (root: ReactTestRenderer) =>
    root.root.findAll((n) => n.props.testID === 'search-placeholders' && String(n.type) === 'View');
  /** Answers the oldest search still waiting. */
  async function answerSearch(outcome: PhotoSearchOutcome) {
    const resolve = searchAnswers.shift();
    if (!resolve) throw new Error('no search is waiting');
    await act(async () => resolve(outcome));
  }
  const type = (root: ReactTestRenderer, text: string) => act(() => field(root).props.onChangeText(text));
  const submit = (root: ReactTestRenderer) => act(() => field(root).props.onSubmitEditing({ nativeEvent: { text: '' } }));
  const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity as 1));

  test('searches once on open with the recipe name, the field pre-filled; placeholder tiles until it answers', async () => {
    const root = await renderSheet();
    expect(mockSearch.mock.calls).toEqual([['Blueberry bread', 1]]);
    expect(field(root).props).toMatchObject({
      value: 'Blueberry bread',
      returnKeyType: 'search',
      accessibilityLabel: 'Search photos',
      editable: true,
    });
    const [placeholders] = searchPlaceholders(root);
    expect(placeholders.props.accessibilityLabel).toBe('Searching photos');
    const muted = placeholders.findAll((n) => String(n.type) === 'View' && flat(n.props.style).backgroundColor === Palette.light.surfaceMuted);
    expect(muted).toHaveLength(4);
    expect(results(root)).toHaveLength(0);

    await answerSearch({ ok: true, photos: [JANE, ANA, LEO], hasMore: false });
    expect(searchPlaceholders(root)).toHaveLength(0);
    expect(labels(root)).toEqual([
      'Photo by Jane Doe, 1 of 3',
      'Sliced bread on a board, photo by Ana Ruiz, 2 of 3',
      'Photo by Leo Park, 3 of 3',
    ]);
    expect(byType(root, 'ExpoImage').map((i) => [i.props.source, i.props.contentFit, i.props.cachePolicy])).toEqual([
      [JANE.thumb, 'cover', 'disk'],
      [ANA.thumb, 'cover', 'disk'],
      [LEO.thumb, 'cover', 'disk'],
    ]);
    expect(texts(root)).toEqual([
      'Choose a photo',
      'Search photos',
      'Jane Doe',
      'Ana Ruiz',
      'Leo Park',
      'Photos provided by Pexels',
      'Photo library',
      'Take photo',
    ]);
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  test('the section sits between From the page and Photo library', async () => {
    setLink(LINK);
    const root = await renderSheet();
    await answer({ ok: true, images: [A] });
    await answerSearch({ ok: true, photos: [JANE], hasMore: false });
    expect(texts(root)).toEqual([
      'Choose a photo',
      'From the page',
      'Search photos',
      'Jane Doe',
      'Photos provided by Pexels',
      'Photo library',
      'Take photo',
    ]);
  });

  test('a long recipe name is searched cut to 100 characters', async () => {
    updateRecipe(bread, { name: 'x'.repeat(130), notes: '', sourceUrl: '' });
    await renderSheet();
    expect(mockSearch.mock.calls).toEqual([['x'.repeat(100), 1]]);
  });

  test('tiles are 4:3 and rounded md, the name on a surface chip in caption inkSecondary', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [JANE], hasMore: false });
    const [tile] = results(root);
    expect(flat(tile.props.style({ pressed: false }))).toMatchObject({ aspectRatio: 4 / 3, borderRadius: Rounded.md, overflow: 'hidden' });
    const chip = root.root.find((n) => n.props.testID === 'search-photo-author' && String(n.type) === 'View');
    expect(flat(chip.props.style)).toMatchObject({ backgroundColor: Palette.light.surface, borderRadius: Rounded.full });
    const name = chip.find((n) => String(n.type) === 'Text');
    expect(flat(name.props.style)).toMatchObject({ color: Palette.light.inkSecondary, fontSize: 12 });
    expect(name.props.numberOfLines).toBe(1);
  });

  test("typing doesn't search; Return searches what's typed, and the old results go", async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [JANE], hasMore: false });
    type(root, 'b');
    type(root, 'banana');
    type(root, '  banana loaf ');
    expect(mockSearch).toHaveBeenCalledTimes(1);

    submit(root);
    expect(mockSearch.mock.calls[1]).toEqual(['banana loaf', 1]);
    expect(results(root)).toHaveLength(0);
    expect(searchPlaceholders(root)).toHaveLength(1);
    await answerSearch({ ok: true, photos: [LEO, MIA], hasMore: false });
    expect(labels(root)).toEqual(['Photo by Leo Park, 1 of 2', 'Photo by Mia Chen, 2 of 2']);
  });

  test('Return with an empty field searches nothing and keeps the results', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [JANE], hasMore: false });
    type(root, '   ');
    submit(root);
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(labels(root)).toEqual(['Photo by Jane Doe, 1 of 1']);
  });

  test('a late answer to an older search is dropped', async () => {
    const root = await renderSheet();
    type(root, 'scones');
    submit(root);
    // The search on open answers after the newer one started: it's ignored.
    await answerSearch({ ok: true, photos: [JANE], hasMore: false });
    expect(results(root)).toHaveLength(0);
    expect(searchPlaceholders(root)).toHaveLength(1);
    await answerSearch({ ok: true, photos: [MIA], hasMore: false });
    expect(labels(root)).toEqual(['Photo by Mia Chen, 1 of 1']);
  });

  test('Load more, while there are more pages, appends the next page of the same search', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [JANE, ANA], hasMore: true });
    expect(loadMore(root)).toHaveLength(1);
    // Editing the field doesn't change what Load more asks for.
    type(root, 'something else');

    press(loadMore(root)[0]);
    expect(mockSearch.mock.calls[1]).toEqual(['Blueberry bread', 2]);
    expect(loadMore(root)[0].props).toMatchObject({ loading: true, disabled: true });
    // A second tap while it loads asks for nothing more.
    press(loadMore(root)[0]);
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(labels(root)).toHaveLength(2);

    // A photo already shown isn't added twice.
    await answerSearch({ ok: true, photos: [ANA, LEO, MIA], hasMore: true });
    expect(labels(root)).toEqual([
      'Photo by Jane Doe, 1 of 4',
      'Sliced bread on a board, photo by Ana Ruiz, 2 of 4',
      'Photo by Leo Park, 3 of 4',
      'Photo by Mia Chen, 4 of 4',
    ]);
    expect(loadMore(root)[0].props).toMatchObject({ loading: false, disabled: false });

    press(loadMore(root)[0]);
    expect(mockSearch.mock.calls[2]).toEqual(['Blueberry bread', 3]);
    await answerSearch({ ok: true, photos: [stock(5, 'Kai Lo')], hasMore: false });
    expect(labels(root)).toHaveLength(5);
    expect(loadMore(root)).toHaveLength(0);
  });

  test('no Load more when the first page is the only one', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [JANE], hasMore: false });
    expect(loadMore(root)).toHaveLength(0);
  });

  test('a failed Load more keeps the photos, says why and can be tried again', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [JANE], hasMore: true });
    press(loadMore(root)[0]);
    await answerSearch({ ok: false, error: 'rate_limited' });
    expect(labels(root)).toEqual(['Photo by Jane Doe, 1 of 1']);
    expect(texts(root)).toContain("You've searched a lot today. Try again later.");
    press(loadMore(root)[0]);
    expect(mockSearch.mock.calls[2]).toEqual(['Blueberry bread', 2]);
    await answerSearch({ ok: true, photos: [LEO], hasMore: false });
    expect(labels(root)).toEqual(['Photo by Jane Doe, 1 of 2', 'Photo by Leo Park, 2 of 2']);
    expect(texts(root)).not.toContain("You've searched a lot today. Try again later.");
  });

  test('offline: the field is disabled and says "Needs a connection"', async () => {
    mockNetwork.connected = false;
    const root = await renderSheet();
    await answerSearch({ ok: false, error: 'offline' });
    expect(field(root).props).toMatchObject({ editable: false, accessibilityState: { disabled: true } });
    expect(texts(root).slice(0, 3)).toEqual(['Choose a photo', 'Search photos', 'Needs a connection']);
    expect(results(root)).toHaveLength(0);
    expect(searchPlaceholders(root)).toHaveLength(0);
  });

  test('a search that finds itself offline also disables the field', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: false, error: 'offline' });
    expect(field(root).props.editable).toBe(false);
    expect(texts(root).slice(0, 3)).toEqual(['Choose a photo', 'Search photos', 'Needs a connection']);
  });

  test('no results: "No photos for “X”. Try another word."', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [], hasMore: false });
    expect(texts(root)).toContain('No photos for “Blueberry bread”. Try another word.');
    type(root, '  zzzz ');
    submit(root);
    await answerSearch({ ok: true, photos: [], hasMore: false });
    expect(texts(root)).toContain('No photos for “zzzz”. Try another word.');
  });

  test.each<[PhotoSearchFailure, string]>([
    ['rate_limited', "You've searched a lot today. Try again later."],
    ['failed', "Couldn't search photos. Try again later."],
  ])('%s: %s', async (error, message) => {
    const root = await renderSheet();
    await answerSearch({ ok: false, error });
    expect(texts(root).slice(0, 4)).toEqual(['Choose a photo', 'Search photos', message, 'Photos provided by Pexels']);
    // The field still works, so another search can be tried.
    expect(field(root).props.editable).toBe(true);
  });

  test('a result that fails to load leaves the grid, and the rest are renumbered', async () => {
    const root = await renderSheet();
    await answerSearch({ ok: true, photos: [JANE, ANA, LEO], hasMore: false });
    act(() => byType(root, 'ExpoImage')[0].props.onError({ error: '404' }));
    expect(labels(root)).toEqual(['Sliced bread on a board, photo by Ana Ruiz, 1 of 2', 'Photo by Leo Park, 2 of 2']);
  });

  test('"Photos provided by Pexels" is a footnote link that opens pexels.com', async () => {
    const root = await renderSheet();
    const [link] = byTestId(root, 'pexels-link');
    expect(link.props).toMatchObject({
      accessibilityRole: 'link',
      accessibilityLabel: 'Photos provided by Pexels',
      accessibilityHint: 'Opens Pexels in Safari',
    });
    const text = link.find((n) => String(n.type) === 'Text');
    expect(flat(text.props.style)).toMatchObject({ color: Palette.light.inkSecondary, fontSize: 13 });
    press(link);
    expect(mockOpenURL).toHaveBeenCalledWith('https://www.pexels.com');
  });
});
