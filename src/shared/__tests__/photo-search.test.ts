import { describe, expect, it } from '@jest/globals';

import * as shared from '@/shared';
import {
  MAX_PHOTO_SEARCH_PAGE,
  MAX_PHOTO_SEARCH_QUERY,
  PHOTO_SEARCH_ERROR_CODES,
  PHOTO_SEARCH_PER_PAGE,
  photoSearchKey,
  PhotoSearchRequestSchema,
  PhotoSearchResponseSchema,
  PhotoSearchResultSchema,
} from '../schemas/photo-search';

const PIXABAY = { name: 'Pixabay', url: 'https://pixabay.com' };

const photo = {
  id: '1',
  thumb: 'https://pixabay.com/get/1/a.jpeg?h=350',
  full: 'https://pixabay.com/get/1/a.jpeg?dpr=2',
  width: 6000,
  height: 4000,
  author: 'Jane Doe',
  authorUrl: 'https://pixabay.com/users/jane-doe',
  pageUrl: 'https://pixabay.com/photos/lemon-cake-1/',
  alt: 'Lemon cake',
};

describe('PhotoSearchRequestSchema', () => {
  it('trims the query and defaults the page to 1', () => {
    expect(PhotoSearchRequestSchema.parse({ query: '  lemon cake ' })).toEqual({ query: 'lemon cake', page: 1, lang: 'en' });
  });

  it('takes 1 to 100 characters after trimming, and pages 1 to 10', () => {
    expect(MAX_PHOTO_SEARCH_QUERY).toBe(100);
    expect(MAX_PHOTO_SEARCH_PAGE).toBe(10);
    expect(PhotoSearchRequestSchema.parse({ query: ` ${'a'.repeat(100)} `, page: 10 })).toEqual({ query: 'a'.repeat(100), page: 10, lang: 'en' });
    expect(PhotoSearchRequestSchema.parse({ query: 'a', page: 1 })).toEqual({ query: 'a', page: 1, lang: 'en' });
  });

  it('takes a two-letter language', () => {
    expect(PhotoSearchRequestSchema.parse({ query: 'pollo', lang: 'es' })).toEqual({ query: 'pollo', page: 1, lang: 'es' });
  });

  it.each([
    ['no query', {}],
    ['an empty query', { query: '' }],
    ['a blank query', { query: ' \n ' }],
    ['a 101-character query', { query: 'a'.repeat(101) }],
    ['a number query', { query: 7 }],
    ['page 0', { query: 'cake', page: 0 }],
    ['page 11', { query: 'cake', page: 11 }],
    ['a fractional page', { query: 'cake', page: 2.5 }],
    ['a string page', { query: 'cake', page: '2' }],
    ['an upper-case language', { query: 'cake', lang: 'ES' }],
    ['a three-letter language', { query: 'cake', lang: 'spa' }],
  ])('refuses %s', (_, body) => {
    expect(PhotoSearchRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('PhotoSearchResponseSchema', () => {
  it('accepts a page of photos', () => {
    expect(PhotoSearchResponseSchema.parse({ provider: PIXABAY, photos: [photo, { ...photo, id: '2', alt: null }], hasMore: true })).toEqual({
      provider: PIXABAY,
      photos: [photo, { ...photo, id: '2', alt: null }],
      hasMore: true,
    });
    expect(PhotoSearchResponseSchema.parse({ provider: PIXABAY, photos: [], hasMore: false })).toEqual({ provider: PIXABAY, photos: [], hasMore: false });
  });

  it('holds at most 20 photos', () => {
    expect(PHOTO_SEARCH_PER_PAGE).toBe(20);
    const photos = Array.from({ length: 21 }, (_, i) => ({ ...photo, id: String(i) }));
    expect(PhotoSearchResponseSchema.safeParse({ provider: PIXABAY, photos, hasMore: true }).success).toBe(false);
    expect(PhotoSearchResponseSchema.safeParse({ provider: PIXABAY, photos: photos.slice(0, 20), hasMore: true }).success).toBe(true);
  });

  it.each([
    ['an http thumb', { thumb: 'http://pixabay.com/get/a.jpeg' }],
    ['an http full', { full: 'http://pixabay.com/get/a.jpeg' }],
    ['an http authorUrl', { authorUrl: 'http://pixabay.com/users/jane' }],
    ['an http pageUrl', { pageUrl: 'http://pixabay.com/photos/1/' }],
    ['a URL over 2048 characters', { full: `https://pixabay.com/get/${'a'.repeat(2048)}` }],
    ['an empty author', { author: '' }],
    ['an author over 200 characters', { author: 'a'.repeat(201) }],
    ['a zero width', { width: 0 }],
    ['a missing alt', { alt: undefined }],
  ])('refuses a photo with %s', (_, change) => {
    expect(PhotoSearchResultSchema.safeParse({ ...photo, ...change }).success).toBe(false);
  });

  it('has the four error codes', () => {
    expect(PHOTO_SEARCH_ERROR_CODES).toEqual(['invalid_request', 'rate_limited', 'unavailable', 'search_failed']);
  });
});

describe('photoSearchKey', () => {
  it('lowercases, collapses whitespace and trims', () => {
    expect(photoSearchKey('  Lemon \t CAKE\n slice ')).toBe('lemon cake slice');
    expect(photoSearchKey('Crème Brûlée')).toBe('crème brûlée');
    expect(photoSearchKey('cake')).toBe('cake');
  });

  it('is exported from the shared index', () => {
    expect(shared.photoSearchKey).toBe(photoSearchKey);
    expect(shared.PhotoSearchRequestSchema).toBe(PhotoSearchRequestSchema);
  });
});
