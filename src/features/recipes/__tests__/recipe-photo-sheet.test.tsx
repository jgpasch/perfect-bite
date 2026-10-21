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
import { initI18n } from '@/i18n';
import { resetDb } from '@/test/db';
import { outboxMutations } from '@/test/outbox';

import RecipeScreen from '@/app/recipe/[id]/index';
import RecipePhotoSheet from '@/app/recipe/[id]/photo';

import { emitAuthEvent, makeSession, resetSupabase, storageUploads, supabase } from '@/test/fake-supabase';

import { photoGenerationMessage, resetPhotoUpload } from '../photo-upload';
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
// A not_entitled answer drops the feature and reloads the plan; the reload isn't under test here.
const mockLostFeature = jest.fn((_feature: string) => Promise.resolve());
jest.mock('@/features/plans/load', () => ({
  ...jest.requireActual<object>('@/features/plans/load'),
  lostFeature: (feature: string) => mockLostFeature(feature),
}));
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
jest.mock('expo-file-system', () => {
  class File {
    uri = 'file:///cache/photo.jpg';
    async arrayBuffer() {
      return new ArrayBuffer(8);
    }
    delete() {}
  }
  return { File, Paths: { cache: { uri: 'file:///cache' } } };
});
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
  mockOpenURL.mockClear();
  // A plan without recipe_photo_ai; the Generate with AI tests add it.
  setFeatures(['categorize']);
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
    expect(texts(root)).toEqual(['Choose a photo', 'From the page', 'Photo library', 'Take photo']);
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
    expect(texts(root)).toEqual(['Choose a photo', 'Photo library', 'Take photo', 'Remove photo']);
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
    // `change` renders a new screen; this one would stay mounted and follow later tests' recipe.
    act(() => root.unmount());

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
    // The two rows.
    expect(texts(root).filter((s) => s === 'Needs a connection')).toHaveLength(2);
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
    // The site photo stays, for Remove; only photo_path is sent.
    expect(getRecipe(bread)).toMatchObject({ photoPath: path, imageUrl: A });
    expect(outboxMutations().at(-1)).toEqual(
      expect.objectContaining({ table: 'recipes', id: bread, fields: { photo_path: path } }),
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

  test('Remove photo with an own photo clears photo_path only, so the site photo shows again', async () => {
    setPhoto(A);
    setOwn(OWN());
    const sheet = await renderSheet();
    press(removeButton(sheet)[0]);
    expect(getRecipe(bread)).toMatchObject({ photoPath: null, imageUrl: A });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: null });
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
    expect(outboxMutations().at(-1)!.fields).toEqual({ image_url: B, photo_path: null });
    act(() => sheet.unmount());

    const root = render(<RecipeScreen />);
    act(() => toasts(root)[0].props.actions[0].onPress());
    expect(getRecipe(bread)).toMatchObject({ imageUrl: A, photoPath: OWN() });
    expect(outboxMutations().at(-1)!.fields).toEqual({ image_url: A, photo_path: OWN() });
  });

  test('picking the page photo it already shows, with an own photo, still switches to it', async () => {
    setLink(LINK);
    setPhoto(A);
    setOwn(OWN());
    const sheet = await renderSheet();
    await answer({ ok: true, images: [A] });
    press(tiles(sheet)[0]);
    expect(getRecipe(bread)).toMatchObject({ imageUrl: A, photoPath: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: null });
  });
});

describe('Generate with AI', () => {
  const invoke = supabase.functions.invoke;
  const AI = () => `${getRecipe(bread)!.householdId}/${bread}/0190a000-0000-7000-8000-0000000000a1.jpg`;
  const generateRow = (root: ReactTestRenderer) =>
    root.root.findAll(
      (n) =>
        typeof n.type !== 'string' &&
        n.props.accessibilityRole === 'button' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Generate a photo with AI'),
    );
  const generating = (root: ReactTestRenderer) =>
    root.root.findAll((n) => n.props.testID === 'photo-generating' && String(n.type) === 'View');
  const signedIn = () =>
    supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession(USER) }, error: null } as never);
  /** Answers the next call with `status` and `body`, as a FunctionsHttpError. */
  const failWith = (status: number, body: unknown) =>
    invoke.mockResolvedValueOnce({
      data: null,
      error: {
        name: 'FunctionsHttpError',
        message: 'Edge Function returned a non-2xx status code',
        context: { status, json: () => Promise.resolve(body) },
      },
    });
  /** Holds the next call open until `finish` is called with its answer. */
  function holdNext() {
    let finish: (answer: { data: unknown; error: unknown }) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    return (answer: { data: unknown; error: unknown }) => act(async () => finish(answer));
  }
  /** With the recipe screen open, opens the sheet over it and taps Generate with AI; the sheet closes. */
  async function generate(): Promise<ReactTestRenderer> {
    const screen = render(<RecipeScreen />);
    let sheet: ReactTestRenderer | null = null;
    act(() => {
      sheet = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <RecipePhotoSheet />
        </SafeAreaProvider>,
      );
    });
    await act(async () => {});
    await act(async () => generateRow(sheet!)[0].props.onPress());
    act(() => sheet!.unmount());
    return screen;
  }

  beforeEach(() => {
    setFeatures([...DEFAULT_FEATURES, 'recipe_photo_ai']);
    signedIn();
    mockLostFeature.mockClear();
  });

  test('in the Add photo sheet with the feature: a sparkles row, read as "Generate a photo with AI", with its note under it', async () => {
    const root = await renderSheet();
    expect(texts(root)).toEqual([
      'Choose a photo',
      'Generate with AI',
      'Makes one photo from the recipe. One per recipe.',
      'Photo library',
      'Take photo',
    ]);
    const [row] = generateRow(root);
    expect(row.props.accessibilityLabel).toBe('Generate a photo with AI');
    expect(row.props.disabled).toBe(false);
    expect(root.root.findAll((n) => n.props.name === 'sparkles' && n.props.hue === 'plum')).toHaveLength(1);
    const note = root.root.find((n) => String(n.type) === 'Text' && n.props.children === 'Makes one photo from the recipe. One per recipe.');
    const flat = Object.assign({}, ...[note.props.style].flat(Infinity as 1));
    expect(flat).toMatchObject({ color: Palette.light.inkSecondary, fontSize: 13 });
  });

  test('not without the feature', async () => {
    setFeatures(['categorize']);
    const root = await renderSheet();
    expect(generateRow(root)).toHaveLength(0);
    expect(texts(root)).not.toContain('Generate with AI');
  });

  test('not in Change photo… (the recipe has a photo, its own or the site\'s)', async () => {
    setPhoto(A);
    let root = await renderSheet();
    expect(generateRow(root)).toHaveLength(0);
    act(() => root.unmount());

    setPhoto(null);
    db.update(recipes).set({ photoPath: AI() }).where(eq(recipes.id, bread)).run();
    root = await renderSheet();
    expect(generateRow(root)).toHaveLength(0);
  });

  test('offline: the row is disabled with "Needs a connection"', async () => {
    mockNetwork.connected = false;
    const root = await renderSheet();
    const [row] = generateRow(root);
    expect(row.props.accessibilityLabel).toBe('Generate a photo with AI, Needs a connection');
    expect(row.props.disabled).toBe(true);
    expect(row.props.accessibilityState).toEqual({ disabled: true });
    expect(texts(root).filter((s) => s === 'Needs a connection')).toHaveLength(3);
  });

  test('tapping it closes the sheet and asks the server with only the recipe id; the screen shows the placeholder, then the photo with Undo', async () => {
    const finish = holdNext();
    const root = await generate();
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('generate-recipe-photo', { body: { recipeId: bread } });

    const [placeholder] = generating(root);
    expect(placeholder.props).toMatchObject({ accessibilityRole: 'progressbar', accessibilityLabel: 'Generating photo…' });
    const style = Object.assign({}, ...[placeholder.props.style].flat(Infinity as 1));
    expect(style).toMatchObject({ backgroundColor: Palette.light.surfaceMuted, borderRadius: Rounded.md, aspectRatio: 16 / 9 });
    expect(texts(root)).toContain('Generating photo…');
    expect(byTestId(root, 'add-photo')).toHaveLength(0);
    expect(toasts(root)).toHaveLength(0);

    await finish({ data: { path: AI() }, error: null });
    expect(generating(root)).toHaveLength(0);
    expect(getRecipe(bread)).toMatchObject({ photoPath: AI(), imageUrl: null });
    expect(outboxMutations().at(-1)).toEqual(
      expect.objectContaining({ table: 'recipes', id: bread, fields: { photo_path: AI() } }),
    );
    const [toast] = toasts(root);
    expect(toast.props.message).toBe('Photo updated');
    expect(toast.props.actions.map((a: { label: string }) => a.label)).toEqual(['Undo']);

    // Undo clears it again; the recipe has still had its one AI photo, so nothing is asked again.
    act(() => toast.props.actions[0].onPress());
    expect(getRecipe(bread)).toMatchObject({ photoPath: null });
    expect(invoke).toHaveBeenCalledTimes(1);
    act(() => root.update(<SafeAreaProvider initialMetrics={METRICS}><RecipeScreen /></SafeAreaProvider>));
    expect(byTestId(root, 'add-photo')).toHaveLength(1);
  });

  test('leaving the recipe screen doesn\'t stop it: the photo is still set', async () => {
    const finish = holdNext();
    const root = await generate();
    act(() => root.unmount());
    tree = null;
    await finish({ data: { path: AI() }, error: null });
    expect(getRecipe(bread)!.photoPath).toBe(AI());
  });

  test.each<[string, number, unknown, string]>([
    ['not_food', 422, { error: 'not_food', message: 'x' }, "Couldn't make a photo for this recipe"],
    ['already_generated', 409, { error: 'already_generated', message: 'x' }, 'This recipe already had its AI photo'],
    [
      'daily_limit',
      429,
      { error: 'daily_limit', message: 'x', resets_at: '2026-10-22T00:00:00.000Z' },
      "You've reached today's limit. Try again tomorrow.",
    ],
    [
      'limit_reached',
      429,
      { error: 'limit_reached', message: 'x', resets_at: '2026-11-01T00:00:00.000Z' },
      "You've used this month's AI photos. They reset on Nov 1.",
    ],
  ])('%s (%i): its toast has no Try again, and the recipe is as it was', async (_code, status, body, message) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    failWith(status, body);
    const root = await generate();
    await act(async () => {});
    expect(generating(root)).toHaveLength(0);
    const [toast] = toasts(root);
    expect(toast.props.message).toBe(message);
    expect(toast.props.actions).toEqual([]);
    expect(getRecipe(bread)).toMatchObject({ photoPath: null });
    // The Add photo tile is back.
    expect(byTestId(root, 'add-photo')).toHaveLength(1);
  });

  test('the monthly limit never asks to try again in a minute, and keeps the plan', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    failWith(429, { error: 'limit_reached', message: 'x', resets_at: '2026-12-01T00:00:00.000Z' });
    const root = await generate();
    await act(async () => {});
    const [toast] = toasts(root);
    expect(toast.props.message).toBe("You've used this month's AI photos. They reset on Dec 1.");
    expect(toast.props.message).not.toMatch(/minute/);
    expect(mockLostFeature.mock.calls).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('blocked (403 ai_photos_blocked): "AI photos are turned off for your account." with no Try again, and the feature is dropped', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The real lostFeature drops the feature from the store; the plan reload isn't under test here.
    mockLostFeature.mockImplementationOnce(() => {
      setFeatures(DEFAULT_FEATURES.filter((f) => f !== 'recipe_photo_ai'));
      return Promise.resolve();
    });
    failWith(403, { error: 'ai_photos_blocked', message: 'AI photos are turned off for your account' });
    const root = await generate();
    await act(async () => {});
    expect(generating(root)).toHaveLength(0);
    const [toast] = toasts(root);
    expect(toast.props.message).toBe('AI photos are turned off for your account.');
    expect(toast.props.actions).toEqual([]);
    expect(getRecipe(bread)).toMatchObject({ photoPath: null });
    expect(mockLostFeature.mock.calls).toEqual([['recipe_photo_ai']]);
    expect(invoke).toHaveBeenCalledTimes(1);

    // The Generate with AI row is gone until the features reload.
    const sheet = await renderSheet();
    expect(generateRow(sheet)).toHaveLength(0);
    expect(texts(sheet)).toEqual(['Choose a photo', 'Photo library', 'Take photo']);
  });

  test('a bare 403 with no code is still read as not_entitled, not as blocked', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    failWith(403, 'oops');
    const root = await generate();
    await act(async () => {});
    const [toast] = toasts(root);
    expect(toast.props.message).toBe("Couldn't make a photo. Try again later.");
    expect(toast.props.actions.map((a: { label: string }) => a.label)).toEqual(['Try again']);
    expect(mockLostFeature.mock.calls).toEqual([['recipe_photo_ai']]);
  });

  test('photoGenerationMessage: each failure, the monthly limit in English and Spanish', () => {
    expect(photoGenerationMessage({ error: 'not_food' })).toBe("Couldn't make a photo for this recipe");
    expect(photoGenerationMessage({ error: 'already_generated' })).toBe('This recipe already had its AI photo');
    expect(photoGenerationMessage({ error: 'failed' })).toBe("Couldn't make a photo. Try again later.");
    expect(photoGenerationMessage({ error: 'ai_photos_blocked' })).toBe('AI photos are turned off for your account.');
    expect(photoGenerationMessage({ error: 'daily_limit' })).toBe("You've reached today's limit. Try again tomorrow.");
    expect(photoGenerationMessage({ error: 'limit_reached', resetsAt: '2027-01-01T00:00:00.000Z' })).toBe(
      "You've used this month's AI photos. They reset on Jan 1.",
    );
    initI18n('es');
    try {
      expect(photoGenerationMessage({ error: 'limit_reached', resetsAt: '2026-11-01T00:00:00.000Z' })).toBe(
        'Ya usaste las fotos con IA de este mes. Se renuevan el 1 nov.',
      );
      expect(photoGenerationMessage({ error: 'ai_photos_blocked' })).toBe('Las fotos con IA están desactivadas para tu cuenta.');
      expect(photoGenerationMessage({ error: 'daily_limit' })).toBe('Llegaste al límite de hoy. Inténtalo mañana.');
    } finally {
      initI18n('en');
    }
  });

  test.each<[string, () => void]>([
    ['a model failure (502)', () => failWith(502, { error: 'generation_failed', message: 'x' })],
    ['a kill switch (503)', () => failWith(503, { error: 'unavailable', message: 'x' })],
    ['a plan without the feature (403)', () => failWith(403, { error: 'not_entitled', message: 'x' })],
    ['an error with no JSON body', () => failWith(500, 'oops')],
    ['no connection', () => invoke.mockResolvedValueOnce({ data: null, error: { name: 'FunctionsFetchError', message: 'x' } })],
    ['an answer that isn\'t a photo path', () => invoke.mockResolvedValueOnce({ data: { path: '../../etc/passwd' }, error: null })],
    ['a thrown error', () => invoke.mockRejectedValueOnce(new Error('boom'))],
  ])('anything else, like %s: "Couldn\'t make a photo. Try again later." with Try again, which asks again', async (name, fail) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fail();
    const root = await generate();
    await act(async () => {});
    const [toast] = toasts(root);
    expect(toast.props.message).toBe("Couldn't make a photo. Try again later.");
    expect(toast.props.actions.map((a: { label: string }) => a.label)).toEqual(['Try again']);
    expect(getRecipe(bread)!.photoPath).toBeNull();

    // Only a plan without the feature drops it (spec 4.12).
    expect(mockLostFeature.mock.calls).toEqual(name.includes('403') ? [['recipe_photo_ai']] : []);

    invoke.mockResolvedValueOnce({ data: { path: AI() }, error: null });
    await act(async () => toast.props.actions[0].onPress());
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(getRecipe(bread)!.photoPath).toBe(AI());
    expect(toasts(root).map((t) => t.props.message)).toEqual(['Photo updated']);
  });

  test('signed out: fails without asking the server', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null } as never);
    const root = await generate();
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
    expect(toasts(root).map((t) => t.props.message)).toEqual(["Couldn't make a photo. Try again later."]);
  });

  test('a failure that comes back while the recipe screen is closed is dropped', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const finish = holdNext();
    let root = await generate();
    act(() => root.unmount());
    tree = null;
    await finish({ data: null, error: { name: 'FunctionsHttpError', message: 'x', context: { status: 422, json: async () => ({ error: 'not_food', message: 'x' }) } } });
    root = render(<RecipeScreen />);
    expect(toasts(root)).toHaveLength(0);
    expect(generating(root)).toHaveLength(0);
    expect(byTestId(root, 'add-photo')).toHaveLength(1);
  });

  test('the failure toast is dismissed when it times out', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    failWith(422, { error: 'not_food', message: 'x' });
    const root = await generate();
    await act(async () => {});
    act(() => toasts(root)[0].props.onDismiss());
    expect(toasts(root)).toHaveLength(0);
  });

  test('a second tap while one is running asks nothing more', async () => {
    const finish = holdNext();
    await generate();
    act(() => tree?.unmount());
    tree = null;
    // The sheet can't be opened from the screen while it runs, but the runner guards anyway.
    const sheet = await renderSheet();
    await act(async () => generateRow(sheet)[0].props.onPress());
    expect(invoke).toHaveBeenCalledTimes(1);
    await finish({ data: { path: AI() }, error: null });
  });
});
