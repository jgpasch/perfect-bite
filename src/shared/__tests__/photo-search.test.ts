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

const photo = {
  id: 1,
  thumb: 'https://images.pexels.com/photos/1/a.jpeg?h=350',
  full: 'https://images.pexels.com/photos/1/a.jpeg?dpr=2',
  width: 6000,
  height: 4000,
  author: 'Jane Doe',
  authorUrl: 'https://www.pexels.com/@jane-doe',
  pageUrl: 'https://www.pexels.com/photo/lemon-cake-1/',
  alt: 'Lemon cake',
};

describe('PhotoSearchRequestSchema', () => {
  it('trims the query and defaults the page to 1', () => {
    expect(PhotoSearchRequestSchema.parse({ query: '  lemon cake ' })).toEqual({ query: 'lemon cake', page: 1 });
  });

  it('takes 1 to 100 characters after trimming, and pages 1 to 10', () => {
    expect(MAX_PHOTO_SEARCH_QUERY).toBe(100);
    expect(MAX_PHOTO_SEARCH_PAGE).toBe(10);
    expect(PhotoSearchRequestSchema.parse({ query: ` ${'a'.repeat(100)} `, page: 10 })).toEqual({ query: 'a'.repeat(100), page: 10 });
    expect(PhotoSearchRequestSchema.parse({ query: 'a', page: 1 })).toEqual({ query: 'a', page: 1 });
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
  ])('refuses %s', (_, body) => {
    expect(PhotoSearchRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('PhotoSearchResponseSchema', () => {
  it('accepts a page of photos', () => {
    expect(PhotoSearchResponseSchema.parse({ photos: [photo, { ...photo, id: 2, alt: null }], hasMore: true })).toEqual({
      photos: [photo, { ...photo, id: 2, alt: null }],
      hasMore: true,
    });
    expect(PhotoSearchResponseSchema.parse({ photos: [], hasMore: false })).toEqual({ photos: [], hasMore: false });
  });

  it('holds at most 20 photos', () => {
    expect(PHOTO_SEARCH_PER_PAGE).toBe(20);
    const photos = Array.from({ length: 21 }, (_, i) => ({ ...photo, id: i }));
    expect(PhotoSearchResponseSchema.safeParse({ photos, hasMore: true }).success).toBe(false);
    expect(PhotoSearchResponseSchema.safeParse({ photos: photos.slice(0, 20), hasMore: true }).success).toBe(true);
  });

  it.each([
    ['an http thumb', { thumb: 'http://images.pexels.com/a.jpeg' }],
    ['an http full', { full: 'http://images.pexels.com/a.jpeg' }],
    ['an http authorUrl', { authorUrl: 'http://www.pexels.com/@jane' }],
    ['an http pageUrl', { pageUrl: 'http://www.pexels.com/photo/1/' }],
    ['a URL over 2048 characters', { full: `https://images.pexels.com/${'a'.repeat(2048)}` }],
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
