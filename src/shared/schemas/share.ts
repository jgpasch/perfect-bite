import { z } from 'zod';

import { HttpUrlSchema, RecipeImportPageSchema } from './recipe-import.ts';

// Spec 4.9, 4.10. targets/_shared/ShareQueue.swift keeps a matching Codable struct in sync by hand;
// src/shared/__tests__/fixtures/ holds JSON as Swift writes it (contract test).

/** One recipe shared from Safari (or any app), written to `share/pending/` by the share extension. */
export const ShareEnvelopeSchema = z
  .object({
    /** 2 from the extension that uploads; missing on envelopes written before it. */
    v: z.literal(2).optional(),
    /** Also the import id, so an envelope imported twice creates one recipe. */
    id: z.uuidv7(),
    /**
     * Who shared it (the list snapshot's user). Missing on older envelopes, which count as the
     * signed-in user's; `share-ingest` refuses one that isn't the authenticated user.
     */
    userId: z.uuid().optional(),
    url: HttpUrlSchema,
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
  .refine((e) => e.addToList !== false || e.listId === null, {
    message: 'A recipe-only share has no list',
    path: ['listId'],
  });
export type ShareEnvelope = z.infer<typeof ShareEnvelopeSchema>;

/** Whether a share puts the recipe's ingredients on a list (true unless the sheet said not to). */
export function shareAddsToList(envelope: Pick<ShareEnvelope, 'addToList'>): boolean {
  return envelope.addToList !== false;
}
