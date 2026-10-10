// Outbox helpers for tests that check what a write enqueues. Use with `@/test/db`.
import { asc } from 'drizzle-orm';

import { db, outbox } from '@/db';
import type { Mutation } from '@/sync/mutation';

/** Every outbox entry, oldest first. */
export function outboxRows() {
  return db.select().from(outbox).orderBy(asc(outbox.id)).all();
}

/** Every queued mutation, oldest first. */
export function outboxMutations(): Mutation[] {
  return outboxRows().map((r) => r.mutation);
}

/** The queued mutations without their HLCs, for exact comparisons. */
export function outboxPatches(): Omit<Mutation, 'hlc'>[] {
  return outboxMutations().map(({ hlc: _hlc, ...rest }) => rest);
}

/** Empties the outbox, so a test can look at just the next write. */
export function clearOutbox(): void {
  db.delete(outbox).run();
}
