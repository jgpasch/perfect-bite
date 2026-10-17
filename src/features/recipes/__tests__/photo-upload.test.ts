// Uploading a household's own recipe photo (spec 4.5): the object path, the upload, photo_path set
// through the usual recipe update, and the upload state the recipe screen shows.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import { resetSupabase, storageUploads, supabase } from '@/test/fake-supabase';
import { outboxMutations } from '@/test/outbox';
import type { PhotoCredit } from '@/shared/photo-credit';

import {
  dismissPhotoUpload,
  pickRecipePhoto,
  recipePhotoPath,
  resetPhotoUpload,
  retryPhotoUpload,
  uploadRecipePhoto,
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
jest.mock('expo-file-system', () => ({
  File: class {
    async arrayBuffer() {
      return new ArrayBuffer(4);
    }
  },
}));

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
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
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
    provider: 'pexels',
    author: 'Jane Doe',
    authorUrl: 'https://www.pexels.com/@jane',
    pageUrl: 'https://www.pexels.com/photo/bread-123/',
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
