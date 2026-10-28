import { describe, expect, it } from '@jest/globals';

import { MAX_JSON_LD_BLOCK_BYTES, MAX_JSON_LD_BLOCKS, MAX_PAGE_TEXT_BYTES } from '../schemas/recipe-import';
import { MAX_PHOTO_IMPORT_IMAGE_BYTES, MAX_PHOTO_IMPORT_IMAGES } from '../schemas/recipe-photo-import';
import { ShareEnvelopeSchema, shareAddsToList, shareKind } from '../schemas/share';
import photo from './fixtures/share-envelope.photo.json';
import recipeOnly from './fixtures/share-envelope.recipe-only.json';
import safari from './fixtures/share-envelope.safari.json';
import urlOnly from './fixtures/share-envelope.url-only.json';
import v2 from './fixtures/share-envelope.v2.json';

// Contract test: the fixtures are JSON as targets/_shared/ShareQueue.swift encodes it (escaped
// slashes, `listId: null` written explicitly, a nil `page` omitted). The URL-only fixture is as an
// older extension wrote it, without `householdId` and `addToList`; the v2 one is as the extension
// that uploads writes it, with `v` and `userId`; the photo one is a `v: 3` photo share, with
// `images` and no `url` or `page`. Update both sides together.
describe('ShareEnvelopeSchema', () => {
  describe('photo shares (v 3)', () => {
    const jpeg = (data: string) => ({ mediaType: 'image/jpeg', data });
    const page = jpeg('/9j/4AAQSkZJRg==');
    const parse = (overrides: object) => ShareEnvelopeSchema.safeParse({ ...photo, ...overrides });
    const issuePaths = (overrides: object) => parse(overrides).error?.issues.map((issue) => issue.path.join('.'));

    it('accepts the photo envelope as Swift writes it', () => {
      const envelope = ShareEnvelopeSchema.parse(photo);
      expect(envelope.v).toBe(3);
      expect(envelope.images).toEqual([jpeg('/9j/4AAQSkZJRg=='), jpeg('/9j/4AAQSkZJRgABAQ==')]);
      expect(envelope).not.toHaveProperty('url');
      expect(envelope).not.toHaveProperty('page');
      expect(envelope.listId).toBeNull();
      expect(envelope.householdId).toBe('019a4c0f-0000-7000-8000-0000000000b1');
      expect(shareAddsToList(envelope)).toBe(false);
      expect(shareKind(envelope)).toBe('photo');
    });

    it('says every link envelope is a link', () => {
      for (const fixture of [v2, safari, urlOnly, recipeOnly]) {
        expect(shareKind(ShareEnvelopeSchema.parse(fixture))).toBe('link');
      }
    });

    it(`takes 1 to ${MAX_PHOTO_IMPORT_IMAGES} pages, not 0 or ${MAX_PHOTO_IMPORT_IMAGES + 1}`, () => {
      expect(parse({ images: [page] }).success).toBe(true);
      expect(parse({ images: Array(MAX_PHOTO_IMPORT_IMAGES).fill(page) }).success).toBe(true);
      expect(issuePaths({ images: Array(MAX_PHOTO_IMPORT_IMAGES + 1).fill(page) })).toEqual(['images']);
      expect(issuePaths({ images: [] })).toEqual(['images']);
    });

    it('refuses url plus images, and neither', () => {
      expect(issuePaths({ url: 'https://example.com/r' })).toEqual(['url']);
      expect(issuePaths({ ...v2, images: [page], v: 3 })).toEqual(['url', 'page']);
      const { images: _images, ...neither } = photo;
      expect(ShareEnvelopeSchema.safeParse(neither).success).toBe(false);
      expect(ShareEnvelopeSchema.safeParse({ ...neither, v: 2 }).error?.issues[0]?.path).toEqual(['url']);
    });

    it('refuses a page with a photo share', () => {
      expect(issuePaths({ page: { title: 'Soup' } })).toEqual(['page']);
    });

    it('requires v 3 with images, and only with images', () => {
      expect(issuePaths({ v: 2 })).toEqual(['v']);
      const { v: _v, ...noVersion } = photo;
      expect(ShareEnvelopeSchema.safeParse(noVersion).error?.issues.map((issue) => issue.path)).toEqual([['v']]);
      expect(parse({ v: 4 }).success).toBe(false);
    });

    it('takes JPEG only', () => {
      expect(issuePaths({ images: [{ mediaType: 'image/png', data: page.data }] })).toEqual(['images.0.mediaType']);
      expect(issuePaths({ images: [page, { mediaType: 'image/webp', data: page.data }] })).toEqual(['images.1.mediaType']);
      expect(parse({ images: [{ mediaType: 'image/heic', data: page.data }] }).success).toBe(false);
    });

    it('refuses an image over 2 MB decoded, and data that is not base64', () => {
      // Base64 decodes 4 characters to 3 bytes.
      const atCap = 'A'.repeat(Math.floor(MAX_PHOTO_IMPORT_IMAGE_BYTES / 3) * 4);
      expect(parse({ images: [jpeg(atCap)] }).success).toBe(true);
      const overCap = 'A'.repeat(Math.ceil((MAX_PHOTO_IMPORT_IMAGE_BYTES + 1) / 3) * 4);
      expect(issuePaths({ images: [page, jpeg(overCap)] })).toEqual(['images.1.data']);
      expect(issuePaths({ images: [jpeg('data:image/jpeg;base64,/9j/')] })).toEqual(['images.0.data']);
    });

    it('keeps the other envelope rules', () => {
      expect(issuePaths({ listId: '019a4c10-0000-7000-8000-00000000c057' })).toEqual(['listId']);
      expect(parse({ listId: '019a4c10-0000-7000-8000-00000000c057', addToList: true }).success).toBe(true);
      expect(parse({ id: '6f1c2a5e-8b1d-4c3a-9e2f-0a1b2c3d4e5f' }).success).toBe(false);
      expect(parse({ userId: 'me' }).success).toBe(false);
    });
  });

  it('accepts a v2 envelope with the sharer and the version', () => {
    const envelope = ShareEnvelopeSchema.parse(v2);
    expect(envelope.v).toBe(2);
    expect(envelope.userId).toBe('7d3f9c2a-5b1e-4f6a-8c0d-2e9b4a7f1c36');
    expect(envelope.url).toBe('https://www.bonappetit.com/recipe/lemon-pasta');
    expect(envelope.page).toEqual({ title: 'Lemon Pasta', imageUrl: 'https://assets.bonappetit.com/photos/lemon-pasta.jpg' });
  });

  it('accepts a v2 envelope without userId (a snapshot from an older app has none)', () => {
    const { userId: _userId, ...noUser } = v2;
    const envelope = ShareEnvelopeSchema.parse(noUser);
    expect(envelope.v).toBe(2);
    expect(envelope).not.toHaveProperty('userId');
  });

  it('rejects another version or a userId that is not a UUID', () => {
    expect(ShareEnvelopeSchema.safeParse({ ...v2, v: 1 }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...v2, v: 3 }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...v2, v: '2' }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...v2, userId: 'me' }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...v2, userId: null }).success).toBe(false);
  });

  it('an older envelope has neither v nor userId', () => {
    for (const fixture of [safari, urlOnly, recipeOnly]) {
      const envelope = ShareEnvelopeSchema.parse(fixture);
      expect(envelope).not.toHaveProperty('v');
      expect(envelope).not.toHaveProperty('userId');
    }
  });

  it('accepts a Safari share with the captured page', () => {
    const envelope = ShareEnvelopeSchema.parse(safari);
    expect(envelope.url).toBe('https://www.halfbakedharvest.com/20-minute-thai-peanut-chicken-ramen/');
    expect(envelope.listId).toBe('019a4c10-0000-7000-8000-00000000c057');
    expect(envelope.page).toEqual({
      title: '20 Minute Thai Peanut Chicken Ramen',
      jsonLd: ['{"@type":"Recipe","name":"Thai Peanut Chicken Ramen"}'],
      text: 'Thai Peanut Chicken Ramen\nIngredients\n2 tablespoons peanut butter',
    });
  });

  it('accepts a URL-only share to the default list', () => {
    const envelope = ShareEnvelopeSchema.parse(urlOnly);
    expect(envelope.listId).toBeNull();
    expect(envelope).not.toHaveProperty('page');
  });

  it('a Safari share to a list carries its household and addToList: true', () => {
    const envelope = ShareEnvelopeSchema.parse(safari);
    expect(envelope.householdId).toBe('019a4c0f-0000-7000-8000-0000000000a1');
    expect(envelope.addToList).toBe(true);
    expect(shareAddsToList(envelope)).toBe(true);
  });

  it('accepts a recipe-only share: no list, a household, addToList: false', () => {
    const envelope = ShareEnvelopeSchema.parse(recipeOnly);
    expect(envelope.listId).toBeNull();
    expect(envelope.householdId).toBe('019a4c0f-0000-7000-8000-0000000000b1');
    expect(envelope.addToList).toBe(false);
    expect(shareAddsToList(envelope)).toBe(false);
    expect(envelope.page).toEqual({ title: 'Chicken Tikka Masala' });
  });

  it('an envelope from an older extension (no householdId or addToList) adds to a list', () => {
    const envelope = ShareEnvelopeSchema.parse(urlOnly);
    expect(envelope).not.toHaveProperty('householdId');
    expect(envelope).not.toHaveProperty('addToList');
    expect(shareAddsToList(envelope)).toBe(true);
  });

  it('rejects a recipe-only share with a list, and a household that is not a UUID', () => {
    const result = ShareEnvelopeSchema.safeParse({ ...recipeOnly, listId: '019a4c10-0000-7000-8000-00000000c057' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['listId']);
    expect(ShareEnvelopeSchema.safeParse({ ...recipeOnly, householdId: 'home' }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...recipeOnly, addToList: 'no' }).success).toBe(false);
  });

  it('allows a null household (an older sheet that knew none)', () => {
    expect(ShareEnvelopeSchema.parse({ ...urlOnly, householdId: null }).householdId).toBeNull();
    expect(ShareEnvelopeSchema.parse({ ...recipeOnly, householdId: null }).addToList).toBe(false);
  });

  it('accepts a page with only some parts', () => {
    expect(ShareEnvelopeSchema.parse({ ...urlOnly, page: {} }).page).toEqual({});
    expect(ShareEnvelopeSchema.parse({ ...urlOnly, page: { title: 'Soup' } }).page).toEqual({ title: 'Soup' });
  });

  it('requires listId to be present, even when null', () => {
    const { listId: _listId, ...noListId } = urlOnly;
    expect(ShareEnvelopeSchema.safeParse(noListId).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...urlOnly, listId: 'groceries' }).success).toBe(false);
  });

  it('requires a UUIDv7 id', () => {
    expect(ShareEnvelopeSchema.safeParse({ ...urlOnly, id: '6f1c2a5e-8b1d-4c3a-9e2f-0a1b2c3d4e5f' }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...urlOnly, id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects non-http(s) URLs, other sources and a bad date', () => {
    expect(ShareEnvelopeSchema.safeParse({ ...urlOnly, url: 'file:///etc/passwd' }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...urlOnly, url: 'not a link' }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...urlOnly, source: 'siri' }).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse({ ...urlOnly, createdAt: 'yesterday' }).success).toBe(false);
  });

  describe('page caps (same as the import request)', () => {
    const withPage = (page: object) => ShareEnvelopeSchema.safeParse({ ...urlOnly, page }).success;

    it(`allows ${MAX_JSON_LD_BLOCKS} JSON-LD blocks, not ${MAX_JSON_LD_BLOCKS + 1}`, () => {
      expect(withPage({ jsonLd: Array(MAX_JSON_LD_BLOCKS).fill('{}') })).toBe(true);
      expect(withPage({ jsonLd: Array(MAX_JSON_LD_BLOCKS + 1).fill('{}') })).toBe(false);
    });

    it('caps each JSON-LD block at 200 KB of UTF-8', () => {
      expect(withPage({ jsonLd: ['a'.repeat(MAX_JSON_LD_BLOCK_BYTES)] })).toBe(true);
      expect(withPage({ jsonLd: ['a'.repeat(MAX_JSON_LD_BLOCK_BYTES + 1)] })).toBe(false);
      // "é" is 2 bytes: half as many characters fill the cap.
      expect(withPage({ jsonLd: ['é'.repeat(MAX_JSON_LD_BLOCK_BYTES / 2)] })).toBe(true);
      expect(withPage({ jsonLd: ['é'.repeat(MAX_JSON_LD_BLOCK_BYTES / 2 + 1)] })).toBe(false);
    });

    it('caps the text at 50 KB of UTF-8', () => {
      expect(withPage({ text: 'a'.repeat(MAX_PAGE_TEXT_BYTES) })).toBe(true);
      expect(withPage({ text: 'a'.repeat(MAX_PAGE_TEXT_BYTES + 1) })).toBe(false);
      expect(withPage({ text: '😀'.repeat(MAX_PAGE_TEXT_BYTES / 4 + 1) })).toBe(false);
    });
  });
});
