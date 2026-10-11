import { describe, expect, it } from '@jest/globals';

import { MAX_JSON_LD_BLOCK_BYTES, MAX_JSON_LD_BLOCKS, MAX_PAGE_TEXT_BYTES } from '../schemas/recipe-import';
import { ShareEnvelopeSchema } from '../schemas/share';
import safari from './fixtures/share-envelope.safari.json';
import urlOnly from './fixtures/share-envelope.url-only.json';

// Contract test: the fixtures are JSON as targets/_shared/ShareQueue.swift encodes it (escaped
// slashes, `listId: null` written explicitly, a nil `page` omitted). Update both sides together.
describe('ShareEnvelopeSchema', () => {
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
