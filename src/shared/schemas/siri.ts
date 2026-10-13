import { z } from 'zod';

// Spec 4.9. targets/_shared/SiriQueue.swift keeps matching Codable structs in sync by hand;
// src/shared/__tests__/fixtures/ holds JSON as Swift writes it (contract test).

/** One "Hey Siri, add to The Perfect Bite" add, written to the App Group queue by the intent. */
export const SiriEnvelopeSchema = z.object({
  id: z.uuid(),
  source: z.literal('siri'),
  /** What the user said, as dictated. Parsed by the same code as typed adds (spec 4.2). */
  text: z.string().min(1),
  /** The list the user named. Absent: the user's default list. */
  listId: z.uuid().optional(),
  createdAt: z.iso.datetime({ offset: true }),
  locale: z.string().optional(),
  appVersion: z.string(),
});
export type SiriEnvelope = z.infer<typeof SiriEnvelopeSchema>;

/**
 * `lists.json`: the lists Siri and the share extension can offer, written by the app whenever lists
 * change and whenever a list screen opens.
 */
export const ListSnapshotSchema = z.object({
  defaultListId: z.uuid().optional(),
  /** The list screen last opened on this device (spec 4.1), if it's offered; the share sheet's default. */
  lastOpenedListId: z.uuid().nullable(),
  lists: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      householdId: z.uuid(),
      householdName: z.string(),
    }),
  ),
  /**
   * Every household the user belongs to, in order, including any with no live lists, so the share
   * sheet can save a recipe to one (spec 4.10). Siri ignores it.
   */
  households: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type ListSnapshot = z.infer<typeof ListSnapshotSchema>;
