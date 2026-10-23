import { describe, expect, it } from '@jest/globals';

import { MAX_JSON_LD_BLOCK_BYTES, MAX_JSON_LD_BLOCKS, MAX_PAGE_TEXT_BYTES } from '../schemas/recipe-import';
import { ShareEnvelopeSchema, shareAddsToList } from '../schemas/share';
import recipeOnly from './fixtures/share-envelope.recipe-only.json';
import safari from './fixtures/share-envelope.safari.json';
import urlOnly from './fixtures/share-envelope.url-only.json';
import v2 from './fixtures/share-envelope.v2.json';

// Contract test: the fixtures are JSON as targets/_shared/ShareQueue.swift encodes it (escaped
// slashes, `listId: null` written explicitly, a nil `page` omitted). The URL-only fixture is as an
// older extension wrote it, without `householdId` and `addToList`; the v2 one is as the extension
// that uploads writes it, with `v` and `userId`. Update both sides together.
describe('ShareEnvelopeSchema', () => {
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
