import { describe, expect, it } from '@jest/globals';

import * as shared from '@/shared';
import {
  base64DecodedBytes,
  MAX_PHOTO_IMPORT_BODY_BYTES,
  MAX_PHOTO_IMPORT_IMAGE_BYTES,
  MAX_PHOTO_IMPORT_IMAGES,
  RECIPE_PHOTO_MEDIA_TYPES,
  RecipePhotoImportRequestSchema,
} from '../schemas/recipe-photo-import';

/** Standard base64 of `n` zero bytes, without building them. */
const zeros = (n: number) => 'A'.repeat(Math.floor(n / 3) * 4) + (n % 3 === 1 ? 'AA==' : n % 3 === 2 ? 'AAA=' : '');

const image = (data = zeros(3000), mediaType = 'image/jpeg') => ({ mediaType, data });

describe('base64DecodedBytes', () => {
  it('counts the decoded bytes, padding included', () => {
    expect(base64DecodedBytes('TWFu')).toBe(3); // "Man"
    expect(base64DecodedBytes('TWE=')).toBe(2);
    expect(base64DecodedBytes('TQ==')).toBe(1);
    expect(base64DecodedBytes('/+9z')).toBe(3);
    expect(base64DecodedBytes(zeros(2 * 1024 * 1024))).toBe(2 * 1024 * 1024);
    expect(base64DecodedBytes(zeros(10))).toBe(10);
  });

  it('is null for anything but standard, padded base64', () => {
    for (const bad of ['', 'TWE', 'TQ', 'TW=u', 'T===', 'TW E', 'TWFu\n', '-_9z', 'data:image/jpeg;base64,TWFu', 'TWFu!']) {
      expect(base64DecodedBytes(bad)).toBeNull();
    }
  });
});

describe('RecipePhotoImportRequestSchema', () => {
  const householdId = '019a4c0f-0000-7000-8000-0000000000a1';

  it('takes 1 to 3 images in order, each JPEG, PNG or WebP', () => {
    const images = [image(zeros(10), 'image/jpeg'), image(zeros(11), 'image/png'), image(zeros(12), 'image/webp')];
    expect(RecipePhotoImportRequestSchema.parse({ images, householdId })).toEqual({ images, householdId });
    expect(RecipePhotoImportRequestSchema.parse({ images: [images[1]], householdId }).images).toEqual([images[1]]);
  });

  it('requires the household the recipe is saved to (an old build sent none)', () => {
    const missing = RecipePhotoImportRequestSchema.safeParse({ images: [image()] });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['householdId']);
    expect(RecipePhotoImportRequestSchema.safeParse({ images: [image()], householdId: 'home' }).success).toBe(false);
  });

  it('refuses no images, or more than 3', () => {
    expect(RecipePhotoImportRequestSchema.safeParse({ images: [] }).success).toBe(false);
    expect(RecipePhotoImportRequestSchema.safeParse({ images: [image(), image(), image(), image()] }).success).toBe(false);
    expect(RecipePhotoImportRequestSchema.safeParse({}).success).toBe(false);
    expect(RecipePhotoImportRequestSchema.safeParse({ images: image() }).success).toBe(false);
  });

  it('refuses another media type, HEIC included', () => {
    for (const mediaType of ['image/heic', 'image/gif', 'application/pdf', 'jpeg', '']) {
      expect(RecipePhotoImportRequestSchema.safeParse({ images: [image(zeros(10), mediaType)] }).success).toBe(false);
    }
  });

  it('takes an image of exactly 2 MB decoded and refuses one byte more', () => {
    expect(RecipePhotoImportRequestSchema.safeParse({ images: [image(zeros(MAX_PHOTO_IMPORT_IMAGE_BYTES))], householdId }).success).toBe(true);
    const over = RecipePhotoImportRequestSchema.safeParse({ images: [image(zeros(MAX_PHOTO_IMPORT_IMAGE_BYTES + 1))], householdId });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]).toMatchObject({ path: ['images', 0, 'data'], message: 'Image over 2 MB' });
  });

  it('refuses data that isn’t base64, naming the image', () => {
    const bad = RecipePhotoImportRequestSchema.safeParse({ images: [image(), image('not base64!')], householdId });
    expect(bad.error?.issues[0]).toMatchObject({ path: ['images', 1, 'data'], message: 'Not base64' });
    expect(RecipePhotoImportRequestSchema.safeParse({ images: [image('')] }).success).toBe(false);
    expect(RecipePhotoImportRequestSchema.safeParse({ images: [{ mediaType: 'image/jpeg', data: 42 }] }).success).toBe(false);
  });

  it('has the spec’s caps, and is exported from @/shared', () => {
    expect([MAX_PHOTO_IMPORT_IMAGES, MAX_PHOTO_IMPORT_IMAGE_BYTES, MAX_PHOTO_IMPORT_BODY_BYTES]).toEqual([3, 2_097_152, 8_388_608]);
    expect(RECIPE_PHOTO_MEDIA_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(shared.RecipePhotoImportRequestSchema).toBe(RecipePhotoImportRequestSchema);
    expect(shared.base64DecodedBytes).toBe(base64DecodedBytes);
  });
});
