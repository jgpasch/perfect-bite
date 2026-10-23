// A local server standing in for Sentry in tests. Point SENTRY_DSN at `dsn` before sentry.ts is
// loaded (it reads the DSN once, on import), so import what's under test dynamically after.

export type SentryEvent = { exception: string; tags: Record<string, string> };

/** The error events posted to the fake Sentry, read from each envelope's event item. */
export function startFakeSentry() {
  const events: SentryEvent[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    for (const line of (await req.text()).split('\n')) {
      const item = JSON.parse(line || '{}');
      if (item.exception) {
        events.push({ exception: item.exception.values.at(-1).value, tags: item.tags });
        for (const w of waiters) if (events.length >= w.count) w.resolve();
      }
    }
    return new Response('{}');
  });
  return {
    events,
    server,
    dsn: `http://public@127.0.0.1:${server.addr.port}/1`,
    /** Resolves once `count` events have arrived; rejects after 5 s. */
    waitFor(count: number): Promise<void> {
      if (events.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        waiters.push({ count, resolve });
        setTimeout(() => reject(new Error(`${events.length} of ${count} reports reached Sentry`)), 5000);
      });
    },
  };
}
