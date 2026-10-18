// Which photo a recipe shows and how expo-image loads it (spec 4.5): an own photo from Storage with
// the session's token and a path cache key, else the site's URL; and an own photo the server turns
// away gets one retry with a refreshed session before falling back to the icon tile.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { IconTile } from '@/components/icon-tile';
import { emitAuthEvent, makeSession, resetSupabase, supabase } from '@/test/fake-supabase';

import { RecipePhotoCover, RecipePhotoTile } from '../recipe-photo';
import {
  isAuthFailure,
  photoObjectUrl,
  recipePhotoSource,
  resetPhotoSession,
} from '../recipe-photo-source';

jest.mock('@/global.css', () => ({}));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});

const SITE = 'https://example.com/tacos.jpg';
const PATH = 'household-1/r1/0190a000-0000-7000-8000-000000000001.jpg';
const STORAGE = `https://project.supabase.test/storage/v1/object/authenticated/recipe-photos/${PATH}`;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetSupabase();
  resetPhotoSession();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('recipePhotoSource', () => {
  const session = { accessToken: 'token-1' };

  test('an own photo: the authenticated Storage URL, the token as a header, and the path as the cache key', () => {
    expect(recipePhotoSource({ imageUrl: SITE, photoPath: PATH }, session)).toEqual({
      uri: STORAGE,
      headers: { Authorization: 'Bearer token-1' },
      cacheKey: PATH,
    });
  });

  test('the cache key is the path, so a new token still finds the cached copy', () => {
    const a = recipePhotoSource({ imageUrl: null, photoPath: PATH }, { accessToken: 'old' }) as { cacheKey: string };
    const b = recipePhotoSource({ imageUrl: null, photoPath: PATH }, { accessToken: 'new' }) as { cacheKey: string };
    expect([a.cacheKey, b.cacheKey]).toEqual([PATH, PATH]);
  });

  test('an own photo without a session: no header, same cache key (only the disk cache can answer)', () => {
    expect(recipePhotoSource({ imageUrl: null, photoPath: PATH }, null)).toEqual({ uri: STORAGE, cacheKey: PATH });
  });

  test('without an own photo: the site photo as today, or none', () => {
    expect(recipePhotoSource({ imageUrl: SITE, photoPath: null }, session)).toBe(SITE);
    expect(recipePhotoSource({ imageUrl: null, photoPath: null }, session)).toBeNull();
  });

  test('photoObjectUrl', () => {
    expect(photoObjectUrl('h/r/p.jpg')).toBe('https://project.supabase.test/storage/v1/object/authenticated/recipe-photos/h/r/p.jpg');
  });
});

describe('isAuthFailure', () => {
  test.each([
    ['HTTP 401 Unauthorized', true],
    ['Response code 403', true],
    ['status 400', true],
    ['Failed to load image', true],
    [undefined, true],
    ['HTTP 404 Not Found', false],
    ['HTTP 500', false],
    // An NSURLError code isn't an HTTP status.
    ['The Internet connection appears to be offline. (-1009)', true],
  ])('%s → %s', (message, expected) => {
    expect(isAuthFailure(message)).toBe(expected);
  });
});

describe('loading an own photo', () => {
  function render(element: React.ReactElement): ReactTestRenderer {
    act(() => {
      tree = create(element);
    });
    return tree!;
  }
  const images = (root: ReactTestRenderer) => root.root.findAll((n) => String(n.type) === 'ExpoImage');
  const tiles = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === IconTile);
  const signIn = (token: string) => act(() => emitAuthEvent('SIGNED_IN', { ...makeSession('u1'), access_token: token }));

  test('follows the session: the header carries the current token, refreshes included', () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={null} photoPath={PATH} />);
    signIn('token-1');
    expect(images(root)[0].props.source.headers).toEqual({ Authorization: 'Bearer token-1' });
    act(() => emitAuthEvent('TOKEN_REFRESHED', { ...makeSession('u1'), access_token: 'token-2' }));
    expect(images(root)[0].props.source.headers).toEqual({ Authorization: 'Bearer token-2' });
  });

  test('the stored session is used before any auth event', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: { ...makeSession('u1'), access_token: 'stored' } }, error: null });
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={null} photoPath={PATH} />);
    await act(async () => {});
    expect(images(root)[0].props.source.headers).toEqual({ Authorization: 'Bearer stored' });
  });

  test('turned away (401): refreshes the session and retries once with the new token', async () => {
    supabase.auth.refreshSession.mockResolvedValue({ data: { session: { ...makeSession('u1'), access_token: 'fresh' } }, error: null });
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={null} photoPath={PATH} />);
    signIn('stale');
    await act(async () => images(root)[0].props.onError({ error: 'HTTP 401' }));
    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(images(root)).toHaveLength(1);
    expect(images(root)[0].props.source.headers).toEqual({ Authorization: 'Bearer fresh' });

    // A second failure falls back to the icon tile for good, with no second refresh.
    await act(async () => images(root)[0].props.onError({ error: 'HTTP 403' }));
    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(images(root)).toHaveLength(0);
    expect(tiles(root)).toHaveLength(1);
  });

  test("a refresh that fails (offline, signed out) falls back at once", async () => {
    supabase.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: 'offline' } });
    const root = render(<RecipePhotoCover recipeId="r1" imageUrl={null} photoPath={PATH} />);
    signIn('stale');
    await act(async () => images(root)[0].props.onError({ error: 'HTTP 401' }));
    expect(images(root)).toHaveLength(0);
  });

  test("a photo that isn't there (404) falls back without a refresh", async () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={null} photoPath={PATH} />);
    signIn('token-1');
    await act(async () => images(root)[0].props.onError({ error: 'HTTP 404' }));
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
    expect(images(root)).toHaveLength(0);
  });

  test('a site photo never refreshes the session', async () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={SITE} />);
    await act(async () => images(root)[0].props.onError({ error: 'HTTP 403' }));
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
    expect(images(root)).toHaveLength(0);
  });

  test('a new photo after a failure gets its own try', async () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={SITE} photoPath={PATH} />);
    await act(async () => images(root)[0].props.onError({ error: 'HTTP 404' }));
    expect(images(root)).toHaveLength(0);
    // The own photo removed: the site photo shows.
    act(() => tree!.update(<RecipePhotoTile recipeId="r1" imageUrl={SITE} photoPath={null} />));
    expect(images(root).map((i) => i.props.source)).toEqual([SITE]);
  });
});
