// Monthly limits (spec 4.12, 6.1). The limit functions in Postgres answer 'monthly_limit' once a
// user has used their plan's number this calendar month (UTC); the functions don't know the
// number, only when it resets.

/** When a monthly limit resets: the first instant of the next calendar month, UTC, as ISO 8601. */
export function monthlyResetsAt(now: number = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/** 429 `limit_reached`, with `resets_at` for the app's "They reset on <date>." */
export function limitReachedResponse(message: string, now?: number): Response {
  return Response.json({ error: 'limit_reached', message, resets_at: monthlyResetsAt(now) }, { status: 429 });
}
