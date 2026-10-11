import { z } from 'zod';

import { HttpUrlSchema, RecipeImportPageSchema } from './recipe-import.ts';

// Spec 4.9, 4.10. targets/_shared/ShareQueue.swift keeps a matching Codable struct in sync by hand;
// src/shared/__tests__/fixtures/ holds JSON as Swift writes it (contract test).

/** One recipe shared from Safari (or any app), written to `share/pending/` by the share extension. */
export const ShareEnvelopeSchema = z.object({
  /** Also the import id, so an envelope imported twice creates one recipe. */
  id: z.uuidv7(),
  url: HttpUrlSchema,
  /** The list picked in the sheet. Null: the default list. */
  listId: z.uuid().nullable(),
  /** What Safari captured; other apps only give the URL. Same caps as the import request. */
  page: RecipeImportPageSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  appVersion: z.string(),
  source: z.literal('share'),
});
export type ShareEnvelope = z.infer<typeof ShareEnvelopeSchema>;
