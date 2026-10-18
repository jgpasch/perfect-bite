// Uploading a household's own recipe photo (spec 4.5): the object path, the upload, photo_path set
// through the usual recipe update, and the upload state the recipe screen shows.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import {
  resetSupabase,
  storageRemovals,
  storageRemoveMock,
  storageUploadMock,
  storageUploads,
  supabase,
} from '@/test/fake-supabase';
import { outboxMutations } from '@/test/outbox';
import type { PhotoCredit } from '@/shared/photo-credit';

import {
  dismissPhotoUpload,
  pickRecipePhoto,
  recipePhotoPath,
  resetPhotoUpload,
  retryPhotoUpload,
  stockPhotoCredit,
  uploadRecipePages,
  uploadRecipePhoto,
  uploadStockPhoto,
  usePhotoUpload,
} from '../photo-upload';
import { dismissPhotoChange, undoPhotoChange, usePhotoChange } from '../recipe-photos';
import { createRecipe, deleteRecipe, getRecipe } from '../recipes';

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
jest.mock('../downscale-photo', () => ({
  UPLOAD_PHOTO: { longEdge: 1600, quality: 0.8 },
  downscalePhoto: (uri: string, o: object) => mockDownscale(uri, o),
}));
// A stock photo's download: records where it went and what was deleted; `mockDownload` can fail it.
const mockDeleted: string[] = [];
const mockDownload = jest.fn(async (url: string, destination: { uri: string }) => {
  void url;
  return destination;
});
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    static downloadFileAsync(url: string, destination: File, _options?: object) {
      return mockDownload(url, destination);
    }
    async arrayBuffer() {
      return new ArrayBuffer(4);
    }
    delete() {
      mockDeleted.push(this.uri);
    }
  }
  return { File, Paths: { cache: { uri: 'file:///cache' } } };
});

const USER = 'user-1';
const PICK_OPTIONS = { mediaTypes: 'images', allowsEditing: true, aspect: [4, 3], quality: 1 };
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  ensureStarterData(USER);
  mockPicker.library.mockClear();
  mockPicker.camera.mockClear();
  mockPicker.permission.mockReset().mockResolvedValue({ granted: true });
  mockDownscale.mockClear();
  mockDownload.mockClear();
  mockDeleted.length = 0;
  warn =jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetPhotoUpload();
  dismissPhotoChange();
  warn.mockRestore();
});

describe('recipePhotoPath', () => {
  test('<household_id>/<recipe_id>/<uuid>.jpg, a new uuid each time', () => {
    expect(recipePhotoPath('h1', 'r1', 'abc')).toBe('h1/r1/abc.jpg');
    const a = recipePhotoPath('h1', 'r1');
    const b = recipePhotoPath('h1', 'r1');
    expect(a).toMatch(/^h1\/r1\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    expect(a).not.toBe(b);
  });
});

describe('pickRecipePhoto', () => {
  test('the library: a 4:3 crop allowed, then shrunk for upload', async () => {
    expect(await pickRecipePhoto('library')).toEqual({ ok: true, uri: 'file:///picked.heic.small.jpg' });
    expect(mockPicker.library).toHaveBeenCalledWith(PICK_OPTIONS);
    expect(mockPicker.permission).not.toHaveBeenCalled();
    expect(mockDownscale).toHaveBeenCalledWith('file:///picked.heic', { longEdge: 1600, quality: 0.8 });
  });

  test('the camera asks first', async () => {
    expect(await pickRecipePhoto('camera')).toEqual({ ok: true, uri: 'file:///shot.jpg.small.jpg' });
    expect(mockPicker.permission).toHaveBeenCalledTimes(1);
    expect(mockPicker.camera).toHaveBeenCalledWith(PICK_OPTIONS);
  });

  test('no camera access: denied, and the camera never opens', async () => {
    mockPicker.permission.mockResolvedValue({ granted: false });
    expect(await pickRecipePhoto('camera')).toEqual({ ok: false, reason: 'denied' });
    expect(mockPicker.camera).not.toHaveBeenCalled();
  });

  test('cancelled: nothing is shrunk', async () => {
    mockPicker.library.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickRecipePhoto('library')).toEqual({ ok: false, reason: 'cancelled' });
    expect(mockDownscale).not.toHaveBeenCalled();
  });
});

describe('uploadRecipePhoto', () => {
  test('uploads a new jpeg object, then sets photo_path (synced) with a "Photo updated" change', async () => {
    const id = createRecipe('Bread');
    const household = getRecipe(id)!.householdId;
    const done = uploadRecipePhoto(id, 'file:///small.jpg');
    expect(usePhotoUpload(id)).toMatchObject({ recipeId: id, localUri: 'file:///small.jpg', status: 'uploading' });
    expect(usePhotoUpload('other')).toBeNull();
    // An upload in flight isn't dismissed.
    dismissPhotoUpload();
    expect(usePhotoUpload(id)?.status).toBe('uploading');

    expect(await done).toBe(true);
    const [bucket, path, body, options] = storageUploads()[0];
    expect([bucket, options]).toEqual(['recipe-photos', { contentType: 'image/jpeg', upsert: false }]);
    expect(path).toMatch(new RegExp(`^${household}/${id}/[0-9a-f-]{36}\\.jpg$`));
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(getRecipe(id)!.photoPath).toBe(path);
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'recipes', id, fields: { photo_path: path } });
    expect(usePhotoChange(id)).toMatchObject({ previous: { imageUrl: null, photoPath: null }, removed: false });
    expect(usePhotoUpload(id)).toBeNull();
  });

  test('a failed upload changes nothing and leaves a failed upload to retry', async () => {
    const id = createRecipe('Bread');
    const before = outboxMutations().length;
    jest.mocked(supabase.storage.from).mockImplementation(
      () => ({ upload: async () => ({ data: null, error: { message: 'Payload too large', statusCode: '413' } }) }) as never,
    );
    expect(await uploadRecipePhoto(id, 'file:///small.jpg')).toBe(false);
    expect(getRecipe(id)!.photoPath).toBeNull();
    expect(outboxMutations()).toHaveLength(before);
    const failed = usePhotoUpload(id)!;
    expect(failed).toMatchObject({ status: 'failed', localUri: 'file:///small.jpg' });
    expect(usePhotoChange(id)).toBeNull();

    dismissPhotoUpload(failed.key + 1);
    expect(usePhotoUpload(id)).toBe(failed);
    dismissPhotoUpload(failed.key);
    expect(usePhotoUpload(id)).toBeNull();
  });

  test('a recipe deleted before it starts: nothing uploaded', async () => {
    const id = createRecipe('Bread');
    deleteRecipe(id);
    expect(await uploadRecipePhoto(id, 'file:///small.jpg')).toBe(false);
    expect(storageUploads()).toHaveLength(0);
  });
});

describe("uploadRecipePhoto with a stock photo's credit (spec 4.5)", () => {
  const CREDIT: PhotoCredit = {
    provider: 'Pixabay',
    author: 'Jane Doe',
    authorUrl: 'https://pixabay.com/users/jane',
    pageUrl: 'https://pixabay.com/photos/bread-123/',
  };

  test('sets the credit together with photo_path, in one mutation', async () => {
    const id = createRecipe('Bread');
    expect(await uploadRecipePhoto(id, 'file:///stock.jpg', CREDIT)).toBe(true);
    const [, path] = storageUploads()[0];
    expect(getRecipe(id)).toMatchObject({ photoPath: path, photoCredit: CREDIT });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: path, photo_credit: CREDIT });
    expect(usePhotoChange(id)).toMatchObject({
      previous: { imageUrl: null, photoPath: null, photoCredit: null },
      next: { photoPath: path, photoCredit: CREDIT },
    });
  });

  test('a library photo over a credited one clears the credit', async () => {
    const id = createRecipe('Bread');
    await uploadRecipePhoto(id, 'file:///stock.jpg', CREDIT);
    const [, stockPath] = storageUploads()[0];

    expect(await uploadRecipePhoto(id, 'file:///library.jpg')).toBe(true);
    const [, libraryPath] = storageUploads()[1];
    expect(getRecipe(id)).toMatchObject({ photoPath: libraryPath, photoCredit: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: libraryPath, photo_credit: null });
    expect(usePhotoChange(id)).toMatchObject({ previous: { photoPath: stockPath, photoCredit: CREDIT } });
  });

  test('Undo of a stock photo restores the old photo and its credit', async () => {
    const id = createRecipe('Bread');
    await uploadRecipePhoto(id, 'file:///first.jpg', CREDIT);
    const [, firstPath] = storageUploads()[0];
    const other = { ...CREDIT, author: 'Sam Lee' };
    await uploadRecipePhoto(id, 'file:///second.jpg', other);
    expect(getRecipe(id)!.photoCredit).toEqual(other);

    undoPhotoChange(usePhotoChange(id)!);
    expect(getRecipe(id)).toMatchObject({ photoPath: firstPath, photoCredit: CREDIT });
  });

  test('a failed upload keeps the credit, and Try again uploads with it', async () => {
    const id = createRecipe('Bread');
    jest.mocked(supabase.storage.from).mockImplementationOnce(
      () => ({ upload: async () => ({ data: null, error: { message: 'Network', statusCode: '500' } }) }) as never,
    );
    expect(await uploadRecipePhoto(id, 'file:///stock.jpg', CREDIT)).toBe(false);
    const failed = usePhotoUpload(id)!;
    expect(failed).toMatchObject({ status: 'failed', credit: CREDIT });
    expect(getRecipe(id)).toMatchObject({ photoPath: null, photoCredit: null });

    expect(await retryPhotoUpload(failed)).toBe(true);
    expect(getRecipe(id)!.photoCredit).toEqual(CREDIT);
  });

  test('a library upload carries no credit in its upload state', async () => {
    const id = createRecipe('Bread');
    void uploadRecipePhoto(id, 'file:///small.jpg');
    expect(usePhotoUpload(id)).toMatchObject({ credit: null });
  });
});

describe('uploadStockPhoto (spec 4.5)', () => {
  const PHOTO = {
    thumb: 'https://pixabay.com/get/123/medium.jpeg',
    full: 'https://pixabay.com/get/123/large2x.jpeg',
    author: 'Jane Doe',
    authorUrl: 'https://pixabay.com/users/jane',
    pageUrl: 'https://pixabay.com/photos/bread-123/',
    provider: 'Pixabay',
  };
  const CREDIT: PhotoCredit = {
    provider: 'Pixabay',
    author: 'Jane Doe',
    authorUrl: 'https://pixabay.com/users/jane',
    pageUrl: 'https://pixabay.com/photos/bread-123/',
  };
  const DOWNLOAD = /^file:\/\/\/cache\/stock-[0-9a-f-]{36}\.jpg$/;

  test("stockPhotoCredit: the provider's name, the photographer's name and page, and the photo's page", () => {
    expect(stockPhotoCredit({ ...PHOTO, author: 'Ana Ruiz' })).toEqual({ ...CREDIT, author: 'Ana Ruiz' });
  });

  test('downloads full to the cache, shrinks it for upload, uploads it and sets photo_path with the credit', async () => {
    const id = createRecipe('Bread');
    const done = uploadStockPhoto(id, PHOTO);
    // While it downloads, the screen shows the thumb the sheet already loaded.
    expect(usePhotoUpload(id)).toMatchObject({ localUri: PHOTO.thumb, credit: CREDIT, stock: PHOTO, status: 'uploading' });

    expect(await done).toBe(true);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    const [url, destination] = mockDownload.mock.calls[0];
    expect(url).toBe(PHOTO.full);
    expect(destination.uri).toMatch(DOWNLOAD);
    expect(mockDownscale).toHaveBeenCalledWith(destination.uri, { longEdge: 1600, quality: 0.8 });
    // The full-size download is deleted once it's shrunk.
    expect(mockDeleted).toEqual([destination.uri]);

    const [bucket, path] = storageUploads()[0];
    expect(bucket).toBe('recipe-photos');
    expect(path).toMatch(new RegExp(`^${getRecipe(id)!.householdId}/${id}/[0-9a-f-]{36}\\.jpg$`));
    expect(getRecipe(id)).toMatchObject({ photoPath: path, photoCredit: CREDIT });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: path, photo_credit: CREDIT });
    expect(usePhotoChange(id)).toMatchObject({ previous: { photoPath: null, photoCredit: null }, removed: false });
    expect(usePhotoUpload(id)).toBeNull();
  });

  test('each pick downloads to a new file', async () => {
    const id = createRecipe('Bread');
    await uploadStockPhoto(id, PHOTO);
    await uploadStockPhoto(id, PHOTO);
    const [first, second] = mockDownload.mock.calls.map(([, d]) => d.uri);
    expect(first).not.toBe(second);
  });

  test('a failed download uploads nothing, leaves the recipe as it was, and Try again downloads again', async () => {
    const id = createRecipe('Bread');
    const before = outboxMutations().length;
    mockDownload.mockRejectedValueOnce(new Error('UnableToDownload: 404'));
    expect(await uploadStockPhoto(id, PHOTO)).toBe(false);
    expect(mockDownscale).not.toHaveBeenCalled();
    expect(storageUploads()).toHaveLength(0);
    expect(getRecipe(id)).toMatchObject({ photoPath: null, photoCredit: null, imageUrl: null });
    expect(outboxMutations()).toHaveLength(before);
    expect(usePhotoChange(id)).toBeNull();
    const failed = usePhotoUpload(id)!;
    expect(failed).toMatchObject({ status: 'failed', localUri: PHOTO.thumb, credit: CREDIT, stock: PHOTO });

    expect(await retryPhotoUpload(failed)).toBe(true);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(getRecipe(id)!.photoCredit).toEqual(CREDIT);
    expect(usePhotoUpload(id)).toBeNull();
  });

  test('a photo that fails to shrink is still deleted, and nothing is uploaded', async () => {
    const id = createRecipe('Bread');
    mockDownscale.mockRejectedValueOnce(new Error('not an image'));
    expect(await uploadStockPhoto(id, PHOTO)).toBe(false);
    expect(mockDeleted).toHaveLength(1);
    expect(mockDeleted[0]).toMatch(DOWNLOAD);
    expect(storageUploads()).toHaveLength(0);
    expect(usePhotoUpload(id)?.status).toBe('failed');
  });

  test('a failed upload after the download: Try again starts over from the download', async () => {
    const id = createRecipe('Bread');
    jest.mocked(supabase.storage.from).mockImplementationOnce(
      () => ({ upload: async () => ({ data: null, error: { message: 'Network', statusCode: '500' } }) }) as never,
    );
    expect(await uploadStockPhoto(id, PHOTO)).toBe(false);
    expect(getRecipe(id)!.photoPath).toBeNull();
    expect(await retryPhotoUpload(usePhotoUpload(id)!)).toBe(true);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(storageUploads()).toHaveLength(1);
    expect(getRecipe(id)!.photoCredit).toEqual(CREDIT);
  });

  test('a library upload has no stock photo, so Try again re-sends the same file', async () => {
    const id = createRecipe('Bread');
    jest.mocked(supabase.storage.from).mockImplementationOnce(
      () => ({ upload: async () => ({ data: null, error: { message: 'Network', statusCode: '500' } }) }) as never,
    );
    await uploadRecipePhoto(id, 'file:///small.jpg');
    const failed = usePhotoUpload(id)!;
    expect(failed.stock).toBeNull();
    expect(await retryPhotoUpload(failed)).toBe(true);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(getRecipe(id)).toMatchObject({ photoCredit: null });
  });

  test('Undo of a stock pick over another credited photo restores the old photo and its credit', async () => {
    const id = createRecipe('Bread');
    const other = { ...PHOTO, author: 'Sam Lee', pageUrl: 'https://pixabay.com/photos/rolls-9/' };
    await uploadStockPhoto(id, other);
    const [, firstPath] = storageUploads()[0];
    await uploadStockPhoto(id, PHOTO);
    expect(getRecipe(id)!.photoCredit).toEqual(CREDIT);

    undoPhotoChange(usePhotoChange(id)!);
    expect(getRecipe(id)).toMatchObject({ photoPath: firstPath, photoCredit: stockPhotoCredit(other) });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: firstPath, photo_credit: stockPhotoCredit(other) });
  });

  test('a recipe deleted before it starts: nothing downloaded or uploaded', async () => {
    const id = createRecipe('Bread');
    deleteRecipe(id);
    expect(await uploadStockPhoto(id, PHOTO)).toBe(false);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(storageUploads()).toHaveLength(0);
  });
});

describe('uploadRecipePages (spec 4.10)', () => {
  const URIS = ['file:///cache/p1.jpg', 'file:///cache/p2.jpg'];

  test('uploads each page in order to recipe-pages at a new path, and returns the paths', async () => {
    const paths = await uploadRecipePages('h1', 'r1', URIS);
    expect(paths).toHaveLength(2);
    expect(storageUploads().map(([bucket, path, , options]) => [bucket, path, options])).toEqual(
      paths!.map((p) => ['recipe-pages', p, { contentType: 'image/jpeg', upsert: false }]),
    );
    for (const p of paths!) expect(p).toMatch(/^h1\/r1\/[0-9a-f-]{36}\.jpg$/);
    expect(paths![0]).not.toBe(paths![1]);
    expect(storageRemovals()).toEqual([]);
  });

  test('a failure removes the pages that went up and resolves null', async () => {
    storageUploadMock
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'Network', statusCode: '500' } });
    expect(await uploadRecipePages('h1', 'r1', [...URIS, 'file:///cache/p3.jpg'])).toBeNull();
    const [[, first]] = storageUploads();
    expect(storageUploads()).toHaveLength(2);
    expect(storageRemovals()).toEqual([['recipe-pages', [first]]]);
    expect(warn).toHaveBeenCalledWith('[pages] upload failed', expect.anything());
  });

  test('a failed removal is only warned about: still null, never throws', async () => {
    storageUploadMock.mockResolvedValueOnce({ data: null, error: null }).mockRejectedValueOnce(new Error('offline'));
    storageRemoveMock.mockResolvedValueOnce({ data: null, error: { message: 'Network', statusCode: '500' } });
    expect(await uploadRecipePages('h1', 'r1', URIS)).toBeNull();
    expect(storageRemovals()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('[pages] removing the uploaded pages failed', expect.anything());
  });

  test('no pages: nothing uploaded, an empty list', async () => {
    expect(await uploadRecipePages('h1', 'r1', [])).toEqual([]);
    expect(storageUploads()).toEqual([]);
  });
});
