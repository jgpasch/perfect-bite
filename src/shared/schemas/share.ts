import { z } from 'zod';

import { HttpUrlSchema, RecipeImportPageSchema } from './recipe-import.ts';
import { MAX_PHOTO_IMPORT_IMAGES, RecipePhotoSchema } from './recipe-photo-import.ts';

// Spec 4.9, 4.10. targets/_shared/ShareQueue.swift keeps a matching Codable struct in sync by hand;
// src/shared/__tests__/fixtures/ holds JSON as Swift writes it (contract test).

/** A photo share's page: the extension writes JPEG only, each at most 2 MB decoded. */
const SharePhotoSchema = RecipePhotoSchema.extend({ mediaType: z.literal('image/jpeg') });

/**
 * One recipe shared from Safari (or any app), written to `share/pending/` by the share extension.
 * A link share has `url` (and maybe `page`); a photo share (`v: 3`) has `images` and neither.
 */
export const ShareEnvelopeSchema = z
  .object({
    /** 2 from the extension that uploads, 3 for a photo share; missing on envelopes written before. */
    v: z.union([z.literal(2), z.literal(3)]).optional(),
    /** Also the import id, so an envelope imported twice creates one recipe. */
    id: z.uuidv7(),
    /**
     * Who shared it (the list snapshot's user). Missing on older envelopes, which count as the
     * signed-in user's; `share-ingest` refuses one that isn't the authenticated user.
     */
    userId: z.uuid().optional(),
    /** A link share's URL. */
    url: HttpUrlSchema.optional(),
    /** A photo share's pages, in order. */
    images: z.array(SharePhotoSchema).min(1).max(MAX_PHOTO_IMPORT_IMAGES).optional(),
    /** The list picked in the sheet. Null: the default list, or no list when `addToList` is false. */
    listId: z.uuid().nullable(),
    /** The household picked in the sheet, where a recipe-only share is saved. */
    householdId: z.uuid().nullable().optional(),
    /**
     * False: save the recipe to `householdId` and add nothing to a list. Missing (an envelope queued
     * by an older extension): true.
     */
    addToList: z.boolean().optional(),
    /** What Safari captured; other apps only give the URL. Same caps as the import request. */
    page: RecipeImportPageSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
    appVersion: z.string(),
    source: z.literal('share'),
  })
  .superRefine((e, ctx) => {
    if (e.addToList === false && e.listId !== null) {
      ctx.addIssue({ code: 'custom', message: 'A recipe-only share has no list', path: ['listId'] });
    }
    if (e.images === undefined) {
      if (e.url === undefined) ctx.addIssue({ code: 'custom', message: 'A share has a url or images', path: ['url'] });
      if (e.v === 3) ctx.addIssue({ code: 'custom', message: 'A link share is not v 3', path: ['v'] });
      return;
    }
    if (e.url !== undefined) ctx.addIssue({ code: 'custom', message: 'A photo share has no url', path: ['url'] });
    if (e.page !== undefined) ctx.addIssue({ code: 'custom', message: 'A photo share has no page', path: ['page'] });
    if (e.v !== 3) ctx.addIssue({ code: 'custom', message: 'A photo share is v 3', path: ['v'] });
  });
export type ShareEnvelope = z.infer<typeof ShareEnvelopeSchema>;

export type ShareKind = 'link' | 'photo';

/** Which kind of share an envelope is: `photo` when it carries images, else `link`. */
export function shareKind(envelope: Pick<ShareEnvelope, 'images'>): ShareKind {
  return envelope.images === undefined ? 'link' : 'photo';
}

/** Whether a share puts the recipe's ingredients on a list (true unless the sheet said not to). */
export function shareAddsToList(envelope: Pick<ShareEnvelope, 'addToList'>): boolean {
  return envelope.addToList !== false;
}
