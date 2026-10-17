// The Choose a photo sheet's stock photo search call (spec 4.5, 6.11): photo-search.ts.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { NetworkState } from 'expo-network';

import { makeSession, resetSupabase, setSupabaseConfigured, supabase } from '@/test/fake-supabase';

import { appendPhotos, photoSearchQuery, searchPhotos } from '../photo-search';

const mockNetwork: { state: NetworkState } = { state: { isConnected: true, isInternetReachable: true } };

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => mockNetwork.state,
  addNetworkStateListener: () => ({ remove: () => {} }),
}));

const invoke = supabase.functions.invoke;
let warn: ReturnType<typeof jest.spyOn>;

const stock = (id: number, author = 'Jane Doe') => ({
  id,
  thumb: `https://images.pexels.com/photos/${id}/medium.jpeg`,
  full: `https://images.pexels.com/photos/${id}/large2x.jpeg`,
  width: 1200,
  height: 900,
  author,
  authorUrl: 'https://www.pexels.com/@jane-doe',
  pageUrl: `https://www.pexels.com/photo/${id}/`,
  alt: null,
});

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
  resetSupabase();
  mockNetwork.state = { isConnected: true, isInternetReachable: true };
  supabase.auth.getSession.mockResolvedValue({ data: { session: makeSession('user-1') }, error: null });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  setSupabaseConfigured(true);
});

describe('searchPhotos', () => {
  test('posts the query and page to photo-search and returns its photos and hasMore', async () => {
    invoke.mockResolvedValue({ data: { photos: [stock(1), stock(2)], hasMore: true }, error: null });
    expect(await searchPhotos('blueberry bread', 2)).toEqual({ ok: true, photos: [stock(1), stock(2)], hasMore: true });
    expect(invoke).toHaveBeenCalledWith('photo-search', { body: { query: 'blueberry bread', page: 2 } });
  });

  test('page 1 by default; the query is trimmed and cut to 100 characters', async () => {
    invoke.mockResolvedValue({ data: { photos: [], hasMore: false }, error: null });
    expect(await searchPhotos(`  ${'a'.repeat(120)} `)).toEqual({ ok: true, photos: [], hasMore: false });
    expect(invoke).toHaveBeenCalledWith('photo-search', { body: { query: 'a'.repeat(100), page: 1 } });
  });

  test('page 10 never has more, whatever the answer says', async () => {
    invoke.mockResolvedValue({ data: { photos: [stock(1)], hasMore: true }, error: null });
    expect(await searchPhotos('bread', 10)).toEqual({ ok: true, photos: [stock(1)], hasMore: false });
  });

  test.each([
    ['an empty query', '   ', 1],
    ['page 0', 'bread', 0],
    ['page 11', 'bread', 11],
    ['a fractional page', 'bread', 1.5],
  ])('%s fails without a request', async (_name, query, page) => {
    expect(await searchPhotos(query, page)).toEqual({ ok: false, error: 'failed' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('offline, signed out or unconfigured: offline, without a request', async () => {
    mockNetwork.state = { isConnected: false, isInternetReachable: false };
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'offline' });

    mockNetwork.state = { isConnected: true, isInternetReachable: true };
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'offline' });

    setSupabaseConfigured(false);
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'offline' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a network failure or a throw is offline', async () => {
    invoke.mockResolvedValue({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } });
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'offline' });
    invoke.mockRejectedValue(new Error('boom'));
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'offline' });
  });

  test('rate_limited, by its code or a bare 429', async () => {
    respondWithError(429, { error: 'rate_limited', message: 'Too many searches' });
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'rate_limited' });
    respondWithError(429, '<html>');
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'rate_limited' });
  });

  test.each([
    [503, { error: 'unavailable', message: 'No key' }],
    [502, { error: 'search_failed', message: 'Pexels failed' }],
    [400, { error: 'invalid_request', message: 'Bad query' }],
    [500, 'Internal Server Error'],
  ])('%s is failed', async (status, body) => {
    respondWithError(status, body);
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'failed' });
  });

  test('an answer of the wrong shape is failed', async () => {
    invoke.mockResolvedValue({ data: { photos: [{ ...stock(1), thumb: 'http://insecure.example/a.jpg' }], hasMore: false }, error: null });
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'failed' });
    invoke.mockResolvedValue({ data: { images: [] }, error: null });
    expect(await searchPhotos('bread')).toEqual({ ok: false, error: 'failed' });
  });
});

describe('photoSearchQuery', () => {
  test('trims and cuts to 100, trimming again after the cut', () => {
    expect(photoSearchQuery('  Blueberry bread  ')).toBe('Blueberry bread');
    expect(photoSearchQuery(`${'a'.repeat(99)} b`)).toBe('a'.repeat(99));
    expect(photoSearchQuery('   ')).toBe('');
  });
});

describe('appendPhotos', () => {
  test('adds the next page after the shown photos, leaving out repeats', () => {
    expect(appendPhotos([stock(1), stock(2)], [stock(2), stock(3), stock(3), stock(4)]).map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(appendPhotos([], [stock(5)]).map((p) => p.id)).toEqual([5]);
    expect(appendPhotos([stock(1)], []).map((p) => p.id)).toEqual([1]);
  });
});
