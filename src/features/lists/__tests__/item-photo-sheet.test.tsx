// The item sheet's photo (spec 4.4, item-requests board G), against the real in-memory database: the
// Add photo tile and its menu, the upload with its spinner, failure and Try again, Undo, Replace and
// Remove, VoiceOver's actions, the full-screen view, offline, and the photo after a reopen.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { Alert, StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import ItemEditSheet from '@/app/list/[id]/item/[itemId]';
import { Sizes } from '@/constants/theme';
import { db, listItems } from '@/db';
import { setFeatures } from '@/features/plans/features';
import { initI18n } from '@/i18n';
import { resetDb } from '@/test/db';
import { resetSupabase, storageUploads, supabase } from '@/test/fake-supabase';

import { viewerDragCloses, VIEWER_CLOSE_DISTANCE } from '../item-photo';
import { resetItemPhotos } from '../item-photos';
import { addItem, setItemChecked, setItemPhoto } from '../items';
import { ensureStarterData, getDefaultListId } from '../lists';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
jest.mock('@/components/icon-tile', () => ({ IconTile: () => null }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({
  ...jest.requireActual<object>('@/features/categories/categorization'),
  categorizePending: jest.fn(() => Promise.resolve()),
}));
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});
// SwiftUI views as host elements; modifiers as plain records.
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
    Menu: ({ label, children, ...props }: { label?: unknown; children?: unknown }) =>
      createElement('SwiftMenu', { ...props, title: typeof label === 'string' ? label : undefined }, typeof label === 'string' ? null : label, children),
    RNHostView: host('RNHostView'),
    Section: host('SwiftSection'),
    Text: host('SwiftText'),
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  accessibilityHint: (value: string) => ({ accessibilityHint: value }),
  disabled: (value: boolean) => ({ disabled: value }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return { __esModule: true, default: { View }, FadeIn: builder, FadeInDown: builder, FadeOut: builder, LinearTransition: builder, useReducedMotion: () => false };
});
jest.mock('react-native-safe-area-context', () => {
  const { createElement } = require('react');
  return { SafeAreaView: ({ children, ...props }: { children?: unknown }) => createElement('SafeAreaView', props, children) };
});
// The connection: online unless a test says otherwise; `mockNetwork.set` is the OS telling of a change.
const mockNetwork: { online: boolean; set: ((online: boolean) => void) | null } = { online: true, set: null };
jest.mock('expo-network', () => ({
  getNetworkStateAsync: () => Promise.resolve({ isConnected: mockNetwork.online, isInternetReachable: mockNetwork.online }),
  addNetworkStateListener: (fn: (s: object) => void) => {
    mockNetwork.set = (online) => fn({ isConnected: online, isInternetReachable: online });
    return { remove: () => (mockNetwork.set = null) };
  },
}));
const mockPicker = {
  library: jest.fn(async (_o: object): Promise<object> => ({ canceled: false, assets: [{ uri: 'file:///jar.heic' }] })),
  camera: jest.fn(async (_o: object): Promise<object> => ({ canceled: false, assets: [{ uri: 'file:///shot.jpg' }] })),
  permission: jest.fn(async () => ({ granted: true })),
};
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (o: object) => mockPicker.library(o),
  launchCameraAsync: (o: object) => mockPicker.camera(o),
  requestCameraPermissionsAsync: () => mockPicker.permission(),
}));
jest.mock('@/features/recipes/downscale-photo', () => ({
  UPLOAD_PHOTO: { longEdge: 1600, quality: 0.8 },
  downscalePhoto: async (uri: string) => ({ uri: `${uri}.small.jpg`, width: 1600, height: 1200 }),
}));
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(path: string) {
      this.uri = path;
    }
    async arrayBuffer() {
      return new ArrayBuffer(4);
    }
  }
  return { File, Paths: { cache: { uri: 'file:///cache' } } };
});
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const Toolbar = Object.assign(
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    },
    { Button: ({ children, ...props }: { children?: unknown }) => createElement('ToolbarButton', props, children) },
  );
  return { Stack: { Toolbar }, router: { push: jest.fn(), navigate: jest.fn(), back: () => mockBack() }, useLocalSearchParams: () => mockParams };
});
const mockParams: { id?: string; itemId?: string } = {};

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

let listId: string;
let tree: ReactTestRenderer | null = null;
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  ensureStarterData(USER);
  setFeatures(['categorize']);
  listId = getDefaultListId(USER)!;
  mockNetwork.online = true;
  mockPicker.library.mockClear();
  mockPicker.camera.mockClear();
  mockPicker.permission.mockReset().mockResolvedValue({ granted: true });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  resetItemPhotos();
  warn.mockRestore();
  jest.restoreAllMocks();
});

async function open(itemId: string): Promise<ReactTestRenderer> {
  mockParams.id = listId;
  mockParams.itemId = itemId;
  await act(async () => {
    tree = create(<ItemEditSheet />);
  });
  return tree!;
}
/** Re-reads the live queries, as a write would trigger. */
const refresh = () => act(() => tree!.update(<ItemEditSheet />));
/** Lets pending promises (the picker, the upload) settle, then re-reads. */
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  refresh();
};

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const text = () =>
  tree!.root
    .findAll((n) => n.type === ('Text' as never))
    .map(textOf)
    .join('\n');
const hosts = (type: string) => tree!.root.findAll((n) => n.type === (type as never));
const byTestId = (id: string) => tree!.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
/** The Add photo tile's native menu, if it shows. */
const addMenu = () => hosts('SwiftMenu').find((m) => m.props.modifiers?.[0]?.accessibilityLabel === 'Add photo');
const swiftButton = (within: ReactTestInstance, label: string) =>
  within.findAll((n) => n.type === ('SwiftButton' as never) && n.props.label === label);
const tap = (button: ReactTestInstance) => act(() => button.props.onPress());
/** The photo as VoiceOver sees it (the Pressable, not its host view). */
const photo = () => tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.testID === 'item-photo' && 'onPress' in n.props)[0];
const photoImage = () => byTestId('item-photo-image')[0];
/** The photo's long-press menu, and its … menu. */
const contextItems = () => hosts('SwiftContextMenuItems')[0];
const moreMenu = () => hosts('SwiftMenu').find((m) => m.props.modifiers?.[0]?.accessibilityLabel === 'Photo options');
const toastAction = (label: string) =>
  tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props)[0];
const photoPath = (itemId: string) => db.select().from(listItems).where(eq(listItems.id, itemId)).get()!.photoPath;

async function addFromLibrary() {
  tap(swiftButton(addMenu()!, 'Choose from library')[0]);
  await settle();
}

describe("the item sheet's photo", () => {
  test('with no photo: a dashed 64 pt Add photo tile, under the title and above the Amount card', async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    await open(itemId);
    const tile = byTestId('item-add-photo')[0];
    expect(StyleSheet.flatten(tile.props.style)).toMatchObject({
      minHeight: Sizes.itemPhotoTile,
      borderStyle: 'dashed',
      borderWidth: Sizes.checkBorder,
    });
    expect(Sizes.itemPhotoTile).toBe(64);
    expect(tile.findAll((n) => n.type === ('Icon' as never))[0].props.name).toBe('photo.badge.plus');
    expect(addMenu()!.props.modifiers).toEqual([
      { accessibilityLabel: 'Add photo' },
      { accessibilityHint: 'Take a photo or choose one from your library' },
    ]);
    expect(photo()).toBeUndefined();
    // Under the title, above the Amount card.
    const lines = text();
    expect(lines.indexOf('Add photo')).toBeLessThan(lines.indexOf('Amount'));
  });

  test("the tile's menu has Take photo and Choose from library", async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    await open(itemId);
    const buttons = addMenu()!.findAll((n) => n.type === ('SwiftButton' as never));
    expect(buttons.map((b) => [b.props.label, b.props.systemImage])).toEqual([
      ['Take photo', 'camera'],
      ['Choose from library', 'photo.on.rectangle'],
    ]);
  });

  test('Choose from library: the photo from the device with a spinner, then the uploaded one and "Photo updated"', async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    let finish!: () => void;
    jest.mocked(supabase.storage.from).mockImplementationOnce(
      () =>
        ({
          upload: (...args: unknown[]) =>
            new Promise((resolve) => {
              storageUploadsSeen.push(args);
              finish = () => resolve({ data: { path: args[0] }, error: null });
            }),
        }) as never,
    );
    const storageUploadsSeen: unknown[][] = [];
    await open(itemId);

    await addFromLibrary();
    expect(mockPicker.library).toHaveBeenCalledWith({ mediaTypes: 'images', allowsEditing: true, aspect: [4, 3], quality: 1 });
    // Uploading: the picked photo, a spinner, and no menu.
    expect(photoImage().props.source).toBe('file:///jar.heic');
    expect(byTestId('item-photo-uploading')[0].props.accessibilityLabel).toBe('Uploading photo');
    expect(moreMenu()).toBeUndefined();
    expect(addMenu()).toBeUndefined();

    finish();
    await settle();
    const path = String(storageUploadsSeen[0][0]);
    expect(path).toMatch(new RegExp(`/${itemId}/[0-9a-f-]{36}\\.jpg$`));
    expect(photoPath(itemId)).toBe(path);
    expect(byTestId('item-photo-uploading')).toHaveLength(0);
    expect(photoImage().props.source).toMatchObject({
      uri: `https://project.supabase.test/storage/v1/object/authenticated/item-photos/${path}`,
      cacheKey: path,
    });
    expect(photoImage().props.cachePolicy).toBe('disk');
    expect(text()).toContain('Photo updated');
  });

  test('Undo on "Photo updated" takes the photo off again', async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    await open(itemId);
    await addFromLibrary();
    expect(photoPath(itemId)).not.toBeNull();
    act(() => toastAction('Undo').props.onPress());
    refresh();
    expect(photoPath(itemId)).toBeNull();
    expect(addMenu()).toBeDefined();
    expect(text()).not.toContain('Photo updated');
  });

  test('Take photo uses the camera; with no camera access, an alert and nothing uploaded', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { itemId } = addItem(listId, "za'atar", USER)!;
    await open(itemId);
    mockPicker.permission.mockResolvedValue({ granted: false });
    tap(swiftButton(addMenu()!, 'Take photo')[0]);
    await settle();
    expect(alert).toHaveBeenCalledWith(
      'Camera access is off',
      'To take a photo, allow camera access for Perfect Bite in Settings.',
    );
    expect(mockPicker.camera).not.toHaveBeenCalled();
    expect(storageUploads()).toHaveLength(0);

    mockPicker.permission.mockResolvedValue({ granted: true });
    tap(swiftButton(addMenu()!, 'Take photo')[0]);
    await settle();
    expect(mockPicker.camera).toHaveBeenCalledTimes(1);
    expect(storageUploads()).toHaveLength(1);
    expect(photoPath(itemId)).toBe(storageUploads()[0][1]);
  });

  test('cancelling the picker changes nothing', async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    await open(itemId);
    mockPicker.library.mockResolvedValueOnce({ canceled: true, assets: null });
    await addFromLibrary();
    expect(storageUploads()).toHaveLength(0);
    expect(addMenu()).toBeDefined();
    expect(text()).not.toMatch(/Photo updated|Couldn't upload/);
  });

  test('a failed upload leaves the item as it was, with "Couldn\'t upload the photo" and Try again', async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    jest.mocked(supabase.storage.from).mockImplementationOnce(
      () => ({ upload: async () => ({ data: null, error: { message: 'Network', statusCode: '500' } }) }) as never,
    );
    await open(itemId);
    await addFromLibrary();
    expect(photoPath(itemId)).toBeNull();
    expect(text()).toContain("Couldn't upload the photo");
    // The tile is back, as before.
    expect(addMenu()).toBeDefined();
    expect(photo()).toBeUndefined();

    act(() => toastAction('Try again').props.onPress());
    await settle();
    expect(photoPath(itemId)).toBe(storageUploads()[0][1]);
    expect(text()).not.toContain("Couldn't upload the photo");
    expect(text()).toContain('Photo updated');
  });

  describe('with a photo', () => {
    const PATH = (itemId: string) => `h1/${itemId}/0190a000-0000-7000-8000-000000000001.jpg`;
    let itemId: string;
    beforeEach(async () => {
      itemId = addItem(listId, "za'atar", USER)!.itemId;
      setItemPhoto(itemId, PATH(itemId));
      await open(itemId);
    });

    test('full width at 4:3 in a card, and VoiceOver reads "Photo of za\'atar" with its actions', () => {
      const frames = tree!.root.findAll(
        (n) => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.aspectRatio === 4 / 3,
      );
      expect(frames).toHaveLength(1);
      expect(StyleSheet.flatten(frames[0].props.style)).toMatchObject({ width: '100%', aspectRatio: 4 / 3, borderRadius: 12 });
      // The photo, its long-press menu and the … button are inside it.
      expect(frames[0].findAll((n) => n.props.testID === 'item-photo-image')).not.toHaveLength(0);
      expect(photoImage().props.contentFit).toBe('cover');
      expect(photo().props.accessibilityLabel).toBe("Photo of za'atar");
      expect(photo().props.accessibilityHint).toBe('Opens it full screen');
      expect(photo().props.accessibilityActions).toEqual([
        { name: 'camera', label: 'Take photo' },
        { name: 'library', label: 'Choose from library' },
        { name: 'remove', label: 'Remove photo' },
      ]);
      expect(addMenu()).toBeUndefined();
    });

    test('its long-press menu and … menu: Replace photo (Take photo, Choose from library) and Remove photo', () => {
      for (const menu of [contextItems(), moreMenu()!]) {
        const replace = menu.findAll((n) => n.type === ('SwiftMenu' as never) && n.props.title === 'Replace photo')[0];
        expect(replace.findAll((n) => n.type === ('SwiftButton' as never)).map((b) => b.props.label)).toEqual([
          'Take photo',
          'Choose from library',
        ]);
        const remove = swiftButton(menu, 'Remove photo')[0];
        expect(remove.props.role).toBe('destructive');
      }
    });

    test('Replace photo from the library: a new path, "Photo updated", and Undo brings the old one back', async () => {
      const replace = contextItems().findAll((n) => n.type === ('SwiftMenu' as never) && n.props.title === 'Replace photo')[0];
      tap(swiftButton(replace, 'Choose from library')[0]);
      await settle();
      const next = storageUploads()[0][1];
      expect(next).not.toBe(PATH(itemId));
      expect(photoPath(itemId)).toBe(next);
      expect(text()).toContain('Photo updated');
      act(() => toastAction('Undo').props.onPress());
      refresh();
      expect(photoPath(itemId)).toBe(PATH(itemId));
    });

    test('Remove photo: the tile again, "Photo removed", and Undo puts it back', () => {
      tap(swiftButton(moreMenu()!, 'Remove photo')[0]);
      refresh();
      expect(photoPath(itemId)).toBeNull();
      expect(photo()).toBeUndefined();
      expect(addMenu()).toBeDefined();
      expect(text()).toContain('Photo removed');
      act(() => toastAction('Undo').props.onPress());
      refresh();
      expect(photoPath(itemId)).toBe(PATH(itemId));
      expect(photo()).toBeDefined();
    });

    test("VoiceOver's Remove photo action removes it", () => {
      act(() => photo().props.onAccessibilityAction({ nativeEvent: { actionName: 'remove' } }));
      refresh();
      expect(photoPath(itemId)).toBeNull();
      expect(text()).toContain('Photo removed');
    });

    test("VoiceOver's Choose from library action replaces it", async () => {
      act(() => photo().props.onAccessibilityAction({ nativeEvent: { actionName: 'library' } }));
      await settle();
      expect(mockPicker.library).toHaveBeenCalledTimes(1);
      expect(photoPath(itemId)).toBe(storageUploads()[0][1]);
    });

    test('a tap opens it full screen; the close button and a pull down close it', () => {
      expect(byTestId('item-photo-viewer')).toHaveLength(0);
      act(() => photo().props.onPress());
      const viewer = byTestId('item-photo-viewer')[0];
      expect(viewer.props.accessibilityViewIsModal).toBe(true);
      const zoom = tree!.root.find((n) => n.props.testID === 'item-photo-zoom' && typeof n.type !== 'string');
      expect(zoom.props).toMatchObject({ minimumZoomScale: 1, maximumZoomScale: 4 });
      const image = tree!.root.findAll(
        (n) => typeof n.type === 'string' && n.props.accessibilityRole === 'image' && n.props.accessibilityLabel === "Photo of za'atar",
      );
      expect(image).toHaveLength(1);
      expect(image[0].props.accessibilityHint).toBe('Pinch to zoom, swipe down to close');
      act(() => toastAction('Close').props.onPress());
      expect(byTestId('item-photo-viewer')).toHaveLength(0);

      act(() => photo().props.onPress());
      const pull = tree!.root.find((n) => n.props.testID === 'item-photo-zoom' && typeof n.type !== 'string');
      // A short pull stays; a long one closes.
      act(() => pull.props.onScrollEndDrag({ nativeEvent: { zoomScale: 1, contentOffset: { x: 0, y: -20 } } }));
      expect(byTestId('item-photo-viewer')).toHaveLength(1);
      act(() => pull.props.onScrollEndDrag({ nativeEvent: { zoomScale: 1, contentOffset: { x: 0, y: -120 } } }));
      expect(byTestId('item-photo-viewer')).toHaveLength(0);
    });

    test('turned away (401): one retry with a refreshed token, then the placeholder if it fails again', async () => {
      jest.mocked(supabase.auth.refreshSession).mockResolvedValue({
        data: { session: { access_token: 'fresh' } },
        error: null,
      } as never);
      await act(async () => photoImage().props.onError({ error: 'HTTP 401' }));
      expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
      expect(photoImage().props.source).toMatchObject({
        cacheKey: PATH(itemId),
        headers: { Authorization: 'Bearer fresh' },
      });
      act(() => photoImage().props.onError({ error: 'HTTP 401' }));
      expect(photoImage()).toBeUndefined();
      expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
    });

    test("a photo that won't load: a placeholder glyph, no full-screen view, and the menu still there", () => {
      act(() => photoImage().props.onError({ error: 'HTTP 404' }));
      expect(photoImage()).toBeUndefined();
      expect(photo().props.disabled).toBe(true);
      expect(photo().findAll((n) => n.type === ('Icon' as never))[0].props.name).toBe('photo');
      expect(swiftButton(moreMenu()!, 'Remove photo')).toHaveLength(1);
    });
  });

  test('offline: the tile is disabled with "Needs a connection", and comes back online', async () => {
    mockNetwork.online = false;
    const { itemId } = addItem(listId, "za'atar", USER)!;
    await open(itemId);
    expect(addMenu()).toBeUndefined();
    const tile = tree!.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === 'Add photo')[0];
    expect(tile.props.accessibilityState).toEqual({ disabled: true });
    expect(tile.props.accessibilityHint).toBe('Needs a connection');
    expect(text()).toContain('Needs a connection');

    act(() => mockNetwork.set!(true));
    expect(addMenu()).toBeDefined();
    expect(text()).not.toContain('Needs a connection');
  });

  test('offline with a photo: Replace is disabled with "Needs a connection"; Remove still works', async () => {
    mockNetwork.online = false;
    const { itemId } = addItem(listId, "za'atar", USER)!;
    setItemPhoto(itemId, `h1/${itemId}/0190a000-0000-7000-8000-000000000001.jpg`);
    await open(itemId);
    const replace = contextItems()
      .findAll((n) => n.type === ('SwiftButton' as never))
      .find((b) => textOf(b).startsWith('Replace photo'))!;
    expect(replace.props.modifiers).toEqual([{ disabled: true }]);
    expect(textOf(replace)).toBe('Replace photoNeeds a connection');
    expect(contextItems().findAll((n) => n.type === ('SwiftMenu' as never))).toHaveLength(0);
    expect(photo().props.accessibilityActions).toEqual([{ name: 'remove', label: 'Remove photo' }]);
    tap(swiftButton(contextItems(), 'Remove photo')[0]);
    refresh();
    expect(photoPath(itemId)).toBeNull();
  });

  test('a checked item reopened by a new add still shows its photo', async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    const path = `h1/${itemId}/0190a000-0000-7000-8000-000000000001.jpg`;
    setItemPhoto(itemId, path);
    setItemChecked(itemId, true, USER);
    expect(addItem(listId, "za'atar", USER)).toMatchObject({ itemId, kind: 'reopen' });
    await open(itemId);
    expect(photoImage().props.source).toMatchObject({ cacheKey: path });
  });

  test("a photo another member added shows once it's pulled", async () => {
    const { itemId } = addItem(listId, "za'atar", USER)!;
    await open(itemId);
    expect(photo()).toBeUndefined();
    setItemPhoto(itemId, `h1/${itemId}/0190a000-0000-7000-8000-000000000009.jpg`);
    refresh();
    expect(photo().props.accessibilityLabel).toBe("Photo of za'atar");
  });

  test('in Spanish', async () => {
    initI18n('es');
    try {
      const { itemId } = addItem(listId, "za'atar", USER)!;
      await open(itemId);
      expect(hosts('SwiftMenu').find((m) => m.props.modifiers?.[0]?.accessibilityLabel === 'Agregar foto')).toBeDefined();
      setItemPhoto(itemId, `h1/${itemId}/0190a000-0000-7000-8000-000000000001.jpg`);
      refresh();
      expect(photo().props.accessibilityLabel).toBe("Foto de za'atar");
      expect(swiftButton(contextItems(), 'Quitar foto')).toHaveLength(1);
    } finally {
      initI18n('en');
    }
  });
});

describe('viewerDragCloses', () => {
  test('a pull down past the distance closes, unzoomed only', () => {
    expect(VIEWER_CLOSE_DISTANCE).toBe(80);
    expect(viewerDragCloses({ zoomScale: 1, offsetY: -80 })).toBe(true);
    expect(viewerDragCloses({ zoomScale: 1, offsetY: -79 })).toBe(false);
    expect(viewerDragCloses({ zoomScale: 1, offsetY: 120 })).toBe(false);
    expect(viewerDragCloses({ zoomScale: 2, offsetY: -200 })).toBe(false);
  });
});
