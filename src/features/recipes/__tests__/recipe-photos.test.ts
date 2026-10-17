// The Choose a photo sheet's server call (spec 4.5, 6.9) and the photo change it leaves for the
// recipe screen's toast.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { NetworkState } from 'expo-network';

import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import { makeSession, resetSupabase, setSupabaseConfigured, supabase } from '@/test/fake-supabase';
import { outboxMutations } from '@/test/outbox';

import type { PhotoCredit } from '@/shared/photo-credit';

import {
  chooseRecipePhoto,
  dismissPhotoChange,
  loadPagePhotos,
  pagePhoto,
  photoAfterRemove,
  undoPhotoChange,
  usePhotoChange,
} from '../recipe-photos';
import { createRecipe, getRecipe } from '../recipes';

const mockNetwork: { state: NetworkState } = { state: { isConnected: true, isInternetReachable: true } };

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => mockNetwork.state,
  addNetworkStateListener: () => ({ remove: () => {} }),
}));
jest.mock('react', () => ({
  ...jest.requireActual<object>('react'),
  // usePhotoChange outside a component: read the store's snapshot directly.
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));

const URL = 'https://snacks.example.com/blueberry-bread/';
const A = 'https://snacks.example.com/img/a.jpg';
const B = 'https://snacks.example.com/img/b.jpg';
const invoke = supabase.functions.invoke;
let warn: ReturnType<typeof jest.spyOn>;

function respondWithError(status: number, body: unknown) {
  invoke.mockResolvedValue({
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status,
        json: () => (typeof body === 'string' ? Promise.reject(new SyntaxError(body)) : Promise.resolve(body)),
      },
    },
  });
}

beforeEach(() => {
  resetDb();
  resetSupabase();
  ensureStarterData('user-1');
  mockNetwork.state = { isConnected: true, isInternetReachable: true };
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession('user-1') }, error: null });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  dismissPhotoChange();
});

describe('loadPagePhotos', () => {
  test('posts the link to recipe-photos and returns its images', async () => {
    invoke.mockResolvedValue({ data: { images: [A, B] }, error: null });
    expect(await loadPagePhotos(URL)).toEqual({ ok: true, images: [A, B] });
    expect(invoke).toHaveBeenCalledWith('recipe-photos', { body: { url: URL } });
  });

  test('an empty list is ok with no images', async () => {
    invoke.mockResolvedValue({ data: { images: [] }, error: null });
    expect(await loadPagePhotos(URL)).toEqual({ ok: true, images: [] });
  });

  test('offline, signed out or not configured: offline, and no call', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'offline' });
    mockNetwork.state = { isConnected: true, isInternetReachable: true };

    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'offline' });

    setSupabaseConfigured(false);
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'offline' });
    setSupabaseConfigured(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a network failure on the call is offline', async () => {
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'offline' });
    invoke.mockRejectedValue(new Error('boom'));
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'offline' });
  });

  test('fetch_failed and invalid_url are none ("No photos found"), by code or by status', async () => {
    respondWithError(502, { error: 'fetch_failed', message: 'The page could not be fetched' });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'none' });
    respondWithError(400, { error: 'invalid_url', message: 'Not an http(s) URL' });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'none' });
    respondWithError(502, 'Bad Gateway');
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'none' });
  });

  test('the rate limit, the global cap and other errors are failed', async () => {
    respondWithError(429, { error: 'rate_limited', message: 'Too many requests' });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'failed' });
    respondWithError(503, { error: 'unavailable', message: 'Paused' });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'failed' });
    respondWithError(500, { error: 'internal_error', message: 'x' });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'failed' });
  });

  test('a response that does not fit the schema is failed', async () => {
    invoke.mockResolvedValue({ data: { images: ['http://insecure.example.com/a.jpg'] }, error: null });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'failed' });
    invoke.mockResolvedValue({ data: { images: Array.from({ length: 13 }, (_, i) => `https://e.com/${i}.jpg`) }, error: null });
    expect(await loadPagePhotos(URL)).toEqual({ ok: false, error: 'failed' });
  });
});

describe('chooseRecipePhoto and Undo', () => {
  const NONE = { imageUrl: null, photoPath: null, photoCredit: null };
  const site = (imageUrl: string) => ({ imageUrl, photoPath: null, photoCredit: null });

  test('sets image_url, leaves a change for that recipe, and Undo restores the previous photo', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, NONE, site(A));
    expect(getRecipe(id)!.imageUrl).toBe(A);
    // Only the field that changed is sent.
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'recipes', id, fields: { image_url: A } });
    expect(outboxMutations().at(-1)!.fields).not.toHaveProperty('photo_path');
    const change = usePhotoChange(id)!;
    expect(change).toMatchObject({ recipeId: id, previous: NONE, next: site(A), removed: false });
    expect(usePhotoChange('other')).toBeNull();

    undoPhotoChange(change);
    expect(getRecipe(id)!.imageUrl).toBeNull();
    expect(outboxMutations().at(-1)).toMatchObject({ table: 'recipes', id, fields: { image_url: null } });
    expect(usePhotoChange(id)).toBeNull();
  });

  test('removing is a change marked removed; picking the same photo is no change', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, NONE, site(A));
    const before = outboxMutations().length;
    chooseRecipePhoto(id, site(A), site(A));
    expect(outboxMutations()).toHaveLength(before);

    chooseRecipePhoto(id, site(A), NONE);
    expect(getRecipe(id)!.imageUrl).toBeNull();
    expect(usePhotoChange(id)).toMatchObject({ previous: site(A), removed: true });
  });

  test('a later change replaces the toast; dismissing an older one leaves it', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, NONE, site(A));
    const first = usePhotoChange(id)!;
    chooseRecipePhoto(id, site(A), site(B));
    const second = usePhotoChange(id)!;
    expect(second.key).not.toBe(first.key);
    dismissPhotoChange(first.key);
    expect(usePhotoChange(id)).toBe(second);
    dismissPhotoChange(second.key);
    expect(usePhotoChange(id)).toBeNull();
  });
});

describe("a stock photo's credit (spec 4.5)", () => {
  const CREDIT: PhotoCredit = {
    provider: 'Pixabay',
    author: 'Jane Doe',
    authorUrl: 'https://pixabay.com/users/jane',
    pageUrl: 'https://pixabay.com/photos/bread-123/',
  };
  const OTHER: PhotoCredit = { ...CREDIT, author: 'Sam Lee', pageUrl: 'https://pixabay.com/photos/bread-456/' };
  const PATH = 'h/r/0190a000-0000-7000-8000-000000000001.jpg';
  const PATH2 = 'h/r/0190a000-0000-7000-8000-000000000002.jpg';
  const stock = { imageUrl: A, photoPath: PATH, photoCredit: CREDIT };
  const NONE_PHOTO = { imageUrl: null, photoPath: null, photoCredit: null };

  test('pagePhoto has no own photo and no credit', () => {
    expect(pagePhoto(B)).toEqual({ imageUrl: B, photoPath: null, photoCredit: null });
  });

  test('photoAfterRemove drops an own photo with its credit, keeping the site photo', () => {
    expect(photoAfterRemove(stock)).toEqual({ imageUrl: A, photoPath: null, photoCredit: null });
    expect(photoAfterRemove({ imageUrl: A, photoPath: null, photoCredit: null })).toEqual({
      imageUrl: null,
      photoPath: null,
      photoCredit: null,
    });
  });

  test('picking a page photo over a credited one clears the credit with the path', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, { imageUrl: A, photoPath: null, photoCredit: null }, stock);
    expect(getRecipe(id)).toMatchObject({ photoPath: PATH, photoCredit: CREDIT });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: PATH, photo_credit: CREDIT });

    chooseRecipePhoto(id, stock, pagePhoto(B));
    expect(getRecipe(id)).toMatchObject({ imageUrl: B, photoPath: null, photoCredit: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ image_url: B, photo_path: null, photo_credit: null });
    expect(usePhotoChange(id)).toMatchObject({ removed: false });
  });

  test('Remove clears the credit and is marked removed; Undo puts the photo and credit back', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, NONE_PHOTO, stock);

    chooseRecipePhoto(id, stock, photoAfterRemove(stock));
    expect(getRecipe(id)).toMatchObject({ imageUrl: A, photoPath: null, photoCredit: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: null, photo_credit: null });
    const change = usePhotoChange(id)!;
    expect(change.removed).toBe(true);

    undoPhotoChange(change);
    expect(getRecipe(id)).toMatchObject({ imageUrl: A, photoPath: PATH, photoCredit: CREDIT });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: PATH, photo_credit: CREDIT });
  });

  test('a new path always carries its credit, even an unchanged null one', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, NONE_PHOTO, { imageUrl: null, photoPath: PATH, photoCredit: null });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_path: PATH, photo_credit: null });
  });

  test('a different credit on the same path is a change; the same credit (a copy) is none', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, NONE_PHOTO, stock);
    const before = outboxMutations().length;
    chooseRecipePhoto(id, stock, { ...stock, photoCredit: { ...CREDIT } });
    expect(outboxMutations()).toHaveLength(before);

    chooseRecipePhoto(id, stock, { ...stock, photoCredit: OTHER });
    expect(outboxMutations().at(-1)!.fields).toEqual({ photo_credit: OTHER });
    expect(getRecipe(id)!.photoCredit).toEqual(OTHER);
  });

  test('replacing a credited photo with a different stock photo undoes back to the first credit', () => {
    const id = createRecipe('Bread');
    chooseRecipePhoto(id, NONE_PHOTO, stock);
    const second = { imageUrl: A, photoPath: PATH2, photoCredit: OTHER };
    chooseRecipePhoto(id, stock, second);
    expect(getRecipe(id)).toMatchObject({ photoPath: PATH2, photoCredit: OTHER });

    undoPhotoChange(usePhotoChange(id)!);
    expect(getRecipe(id)).toMatchObject({ photoPath: PATH, photoCredit: CREDIT });
  });
});
