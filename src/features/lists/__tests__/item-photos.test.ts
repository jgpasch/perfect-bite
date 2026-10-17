// An item's photo (spec 4.4): its path, how it loads, the upload (shrunk, a new object each time,
// photo_path set through the usual item update), the failure and Try again, Replace and Remove with
// Undo, and that a reopen keeps it.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, listItems } from '@/db';
import { resetDb } from '@/test/db';
import { resetSupabase, storageUploads, supabase } from '@/test/fake-supabase';
import { outboxMutations } from '@/test/outbox';

import {
  dismissItemPhotoChange,
  dismissItemPhotoUpload,
  ITEM_PHOTOS_BUCKET,
  itemPhotoPath,
  itemPhotoSource,
  removeItemPhoto,
  resetItemPhotos,
  retryItemPhotoUpload,
  undoItemPhotoChange,
  uploadItemPhoto,
  useItemPhotoChange,
  useItemPhotoUpload,
} from '../item-photos';
import { addItem, deleteItem, getItemPhoto, groupItems, listItemsQuery, setItemChecked, setItemPhoto } from '../items';
import { ensureStarterData, getDefaultListId } from '../lists';
import { pickPhoto } from '@/features/recipes/photo-upload';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('react', () => ({
  ...jest.requireActual<object>('react'),
  // The stores' hooks outside a component: read the snapshot directly.
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
const mockPicker = {
  library: jest.fn(async (_o: object): Promise<object> => ({ canceled: false, assets: [{ uri: 'file:///picked.heic' }] })),
  camera: jest.fn(async (_o: object): Promise<object> => ({ canceled: false, assets: [{ uri: 'file:///shot.jpg' }] })),
  permission: jest.fn(async () => ({ granted: true })),
};
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (o: object) => mockPicker.library(o),
  launchCameraAsync: (o: object) => mockPicker.camera(o),
  requestCameraPermissionsAsync: () => mockPicker.permission(),
}));
const mockDownscale = jest.fn(async (uri: string, _o: object) => ({ uri: `${uri}.small.jpg`, width: 1600, height: 1200 }));
jest.mock('@/features/recipes/downscale-photo', () => ({
  UPLOAD_PHOTO: { longEdge: 1600, quality: 0.8 },
  downscalePhoto: (uri: string, o: object) => mockDownscale(uri, o),
}));
const mockRead: string[] = [];
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    async arrayBuffer() {
      mockRead.push(this.uri);
      return new ArrayBuffer(4);
    }
  }
  return { File, Paths: { cache: { uri: 'file:///cache' } } };
});

const USER = 'user-1';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/.source;
let listId: string;
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  mockPicker.library.mockClear();
  mockPicker.camera.mockClear();
  mockPicker.permission.mockReset().mockResolvedValue({ granted: true });
  mockDownscale.mockClear();
  mockRead.length = 0;
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetItemPhotos();
  warn.mockRestore();
});

const newItem = (text = "za'atar") => addItem(listId, text, USER)!.itemId;
const photoOf = (itemId: string) => db.select().from(listItems).where(eq(listItems.id, itemId)).get()!.photoPath;

describe('itemPhotoPath', () => {
  test('<household_id>/<list_item_id>/<uuid>.jpg, a new uuid each time', () => {
    expect(itemPhotoPath('h1', 'i1', 'abc')).toBe('h1/i1/abc.jpg');
    const a = itemPhotoPath('h1', 'i1');
    expect(a).toMatch(new RegExp(`^h1/i1/${UUID}\\.jpg$`));
    expect(itemPhotoPath('h1', 'i1')).not.toBe(a);
  });
});

describe('itemPhotoSource', () => {
  test("the item-photos bucket's authenticated URL, keyed by path, with the session's token", () => {
    expect(ITEM_PHOTOS_BUCKET).toBe('item-photos');
    expect(itemPhotoSource('h1/i1/p.jpg', { accessToken: 'tok' })).toEqual({
      uri: 'https://project.supabase.test/storage/v1/object/authenticated/item-photos/h1/i1/p.jpg',
      cacheKey: 'h1/i1/p.jpg',
      headers: { Authorization: 'Bearer tok' },
    });
  });

  test('signed out: the same key and URL with no header, so only the disk cache answers', () => {
    expect(itemPhotoSource('h1/i1/p.jpg', null)).toEqual({
      uri: 'https://project.supabase.test/storage/v1/object/authenticated/item-photos/h1/i1/p.jpg',
      cacheKey: 'h1/i1/p.jpg',
    });
  });

  test('no photo: no source', () => {
    expect(itemPhotoSource(null, { accessToken: 'tok' })).toBeNull();
    expect(itemPhotoSource(undefined, null)).toBeNull();
    expect(itemPhotoSource('', null)).toBeNull();
  });
});

describe('pickPhoto', () => {
  test('the library: a 4:3 crop allowed, returned full size (the upload shrinks it)', async () => {
    expect(await pickPhoto('library')).toEqual({ ok: true, uri: 'file:///picked.heic' });
    expect(mockPicker.library).toHaveBeenCalledWith({ mediaTypes: 'images', allowsEditing: true, aspect: [4, 3], quality: 1 });
    expect(mockDownscale).not.toHaveBeenCalled();
  });

  test('the camera asks first; no access is denied and the camera never opens', async () => {
    expect(await pickPhoto('camera')).toEqual({ ok: true, uri: 'file:///shot.jpg' });
    mockPicker.permission.mockResolvedValue({ granted: false });
    mockPicker.camera.mockClear();
    expect(await pickPhoto('camera')).toEqual({ ok: false, reason: 'denied' });
    expect(mockPicker.camera).not.toHaveBeenCalled();
  });

  test('cancelled', async () => {
    mockPicker.library.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickPhoto('library')).toEqual({ ok: false, reason: 'cancelled' });
  });
});

describe('uploadItemPhoto', () => {
  test('shrinks it, uploads a new jpeg object, then sets photo_path (synced) with a "Photo updated" change', async () => {
    const itemId = newItem();
    const household = getItemPhoto(itemId)!.householdId;
    const done = uploadItemPhoto(itemId, 'file:///picked.heic');
    expect(useItemPhotoUpload(itemId)).toMatchObject({ itemId, localUri: 'file:///picked.heic', status: 'uploading' });
    expect(useItemPhotoUpload('other')).toBeNull();
    // An upload in flight isn't dismissed.
    dismissItemPhotoUpload();
    expect(useItemPhotoUpload(itemId)?.status).toBe('uploading');

    expect(await done).toBe(true);
    expect(mockDownscale).toHaveBeenCalledWith('file:///picked.heic', { longEdge: 1600, quality: 0.8 });
    expect(mockRead).toEqual(['file:///picked.heic.small.jpg']);
    const [bucket, path, body, options] = storageUploads()[0];
    expect([bucket, options]).toEqual(['item-photos', { contentType: 'image/jpeg', upsert: false }]);
    expect(path).toMatch(new RegExp(`^${household}/${itemId}/${UUID}\\.jpg$`));
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(photoOf(itemId)).toBe(path);
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'list_items', id: itemId, fields: { photo_path: path } });
    expect(useItemPhotoChange(itemId)).toMatchObject({ itemId, previous: null, next: path });
    expect(useItemPhotoUpload(itemId)).toBeNull();
  });

  test('Replace: a new object at a new path, and Undo points back at the old one', async () => {
    const itemId = newItem();
    await uploadItemPhoto(itemId, 'file:///first.jpg');
    const first = photoOf(itemId)!;
    dismissItemPhotoChange();

    await uploadItemPhoto(itemId, 'file:///second.jpg');
    const second = photoOf(itemId)!;
    expect(storageUploads().map(([, p]) => p)).toEqual([first, second]);
    expect(second).not.toBe(first);
    const change = useItemPhotoChange(itemId)!;
    expect(change).toMatchObject({ previous: first, next: second });

    undoItemPhotoChange(change);
    expect(photoOf(itemId)).toBe(first);
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'list_items', id: itemId, fields: { photo_path: first } });
    expect(useItemPhotoChange(itemId)).toBeNull();
  });

  test('a failed upload changes nothing and leaves a failed upload; Try again uploads the same photo', async () => {
    const itemId = newItem();
    const before = outboxMutations().length;
    jest.mocked(supabase.storage.from).mockImplementationOnce(
      () => ({ upload: async () => ({ data: null, error: { message: 'Network', statusCode: '500' } }) }) as never,
    );
    expect(await uploadItemPhoto(itemId, 'file:///picked.heic')).toBe(false);
    expect(photoOf(itemId)).toBeNull();
    expect(outboxMutations()).toHaveLength(before);
    const failed = useItemPhotoUpload(itemId)!;
    expect(failed).toMatchObject({ itemId, localUri: 'file:///picked.heic', status: 'failed' });
    expect(useItemPhotoChange(itemId)).toBeNull();

    expect(await retryItemPhotoUpload(failed)).toBe(true);
    // The failed attempt went to the failing fake; the retry is the one stored.
    expect(storageUploads()).toHaveLength(1);
    expect(photoOf(itemId)).toBe(storageUploads()[0][1]);
    expect(mockDownscale.mock.calls.map(([uri]) => uri)).toEqual(['file:///picked.heic', 'file:///picked.heic']);
    expect(useItemPhotoUpload(itemId)).toBeNull();
  });

  test("a photo that can't be read or shrunk fails the same way", async () => {
    const itemId = newItem();
    mockDownscale.mockRejectedValueOnce(new Error('unreadable'));
    expect(await uploadItemPhoto(itemId, 'file:///broken.heic')).toBe(false);
    expect(storageUploads()).toHaveLength(0);
    expect(useItemPhotoUpload(itemId)).toMatchObject({ status: 'failed', localUri: 'file:///broken.heic' });
  });

  test("a failed upload's toast ends on its own key, or with no key", async () => {
    const itemId = newItem();
    jest.mocked(supabase.storage.from).mockImplementation(
      () => ({ upload: async () => ({ data: null, error: { message: 'Payload too large', statusCode: '413' } }) }) as never,
    );
    await uploadItemPhoto(itemId, 'file:///a.jpg');
    const failed = useItemPhotoUpload(itemId)!;
    dismissItemPhotoUpload(failed.key + 1);
    expect(useItemPhotoUpload(itemId)).toBe(failed);
    dismissItemPhotoUpload(failed.key);
    expect(useItemPhotoUpload(itemId)).toBeNull();
    await uploadItemPhoto(itemId, 'file:///a.jpg');
    dismissItemPhotoUpload();
    expect(useItemPhotoUpload(itemId)).toBeNull();
  });

  test('an item deleted before it starts: nothing uploaded', async () => {
    const itemId = newItem();
    deleteItem(itemId);
    expect(await uploadItemPhoto(itemId, 'file:///a.jpg')).toBe(false);
    expect(storageUploads()).toHaveLength(0);
  });

  test('an item deleted while it uploads: nothing written, no toast', async () => {
    const itemId = newItem();
    jest.mocked(supabase.storage.from).mockImplementationOnce(
      () =>
        ({
          upload: async () => {
            deleteItem(itemId);
            return { data: { path: 'x' }, error: null };
          },
        }) as never,
    );
    const before = outboxMutations().length;
    expect(await uploadItemPhoto(itemId, 'file:///a.jpg')).toBe(true);
    expect(photoOf(itemId)).toBeNull();
    // Only the delete was queued.
    expect(outboxMutations().slice(before).map((m) => m.fields)).toEqual([{ deleted_at: expect.any(String) }]);
    expect(useItemPhotoChange(itemId)).toBeNull();
  });
});

describe('removeItemPhoto', () => {
  test('clears photo_path (synced) with "Photo removed"; Undo puts it back', async () => {
    const itemId = newItem();
    await uploadItemPhoto(itemId, 'file:///a.jpg');
    const path = photoOf(itemId)!;
    dismissItemPhotoChange();

    expect(removeItemPhoto(itemId)).toBe(true);
    expect(photoOf(itemId)).toBeNull();
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'list_items', id: itemId, fields: { photo_path: null } });
    const change = useItemPhotoChange(itemId)!;
    expect(change).toMatchObject({ previous: path, next: null });

    undoItemPhotoChange(change);
    expect(photoOf(itemId)).toBe(path);
    expect(useItemPhotoChange(itemId)).toBeNull();
  });

  test('an item with no photo, or a deleted one: nothing to remove, nothing written', () => {
    const itemId = newItem();
    const before = outboxMutations().length;
    expect(removeItemPhoto(itemId)).toBe(false);
    expect(removeItemPhoto('gone')).toBe(false);
    expect(outboxMutations()).toHaveLength(before);
    expect(useItemPhotoChange(itemId)).toBeNull();
  });

  test("a toast ends on its own key; another key leaves it", () => {
    const itemId = newItem();
    setItemPhoto(itemId, 'h/i/p.jpg');
    removeItemPhoto(itemId);
    const change = useItemPhotoChange(itemId)!;
    dismissItemPhotoChange(change.key + 1);
    expect(useItemPhotoChange(itemId)).toBe(change);
    dismissItemPhotoChange(change.key);
    expect(useItemPhotoChange(itemId)).toBeNull();
  });
});

describe('setItemPhoto', () => {
  test('writes only a change, and refuses a deleted item', () => {
    const itemId = newItem();
    const before = outboxMutations().length;
    expect(setItemPhoto(itemId, null)).toBe(true);
    expect(outboxMutations()).toHaveLength(before);
    expect(setItemPhoto(itemId, 'h/i/p.jpg')).toBe(true);
    expect(outboxMutations()).toHaveLength(before + 1);
    deleteItem(itemId);
    expect(setItemPhoto(itemId, 'h/i/q.jpg')).toBe(false);
    expect(photoOf(itemId)).toBe('h/i/p.jpg');
  });
});

describe('the photo on the list (spec 4.4, 4.6)', () => {
  test("the list's items carry their photo", () => {
    const withPhoto = newItem();
    const without = newItem('sumac');
    setItemPhoto(withPhoto, 'h/i/p.jpg');
    const { unchecked } = groupItems(listItemsQuery(listId).all());
    expect(unchecked.map((i) => [i.displayName, i.photoPath])).toEqual([
      ["za'atar", 'h/i/p.jpg'],
      ['sumac', null],
    ]);
    expect(without).not.toBe(withPhoto);
  });

  test('a checked item reopened by a new add keeps its photo: the same product', () => {
    const itemId = newItem();
    setItemPhoto(itemId, 'h/i/p.jpg');
    setItemChecked(itemId, true, USER);
    const again = addItem(listId, "2 za'atar", USER)!;
    expect(again).toMatchObject({ itemId, kind: 'reopen' });
    expect(photoOf(itemId)).toBe('h/i/p.jpg');
    expect(groupItems(listItemsQuery(listId).all()).unchecked[0]).toMatchObject({ id: itemId, photoPath: 'h/i/p.jpg' });
  });
});
