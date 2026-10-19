// Error reporting to Sentry (supabase.com/docs/guides/functions/examples/sentry-monitoring). Off
// unless SENTRY_DSN is set, so local serves and tests send nothing. No default integrations: one
// isolate serves many requests, so breadcrumbs and request data would mix users. A report carries
// the error, the function's name and where it ran, never headers, bodies or page content.
import * as Sentry from '@sentry/deno';

const dsn = Deno.env.get('SENTRY_DSN');
if (dsn) Sentry.init({ dsn, defaultIntegrations: false });

type EdgeRuntime = { waitUntil(promise: Promise<unknown>): void };

/** Reports an error that's about to become a 500, and sends it before the isolate can stop. */
export function reportError(fn: string, err: unknown): void {
  if (!dsn) return;
  Sentry.captureException(err, {
    tags: { function: fn, region: Deno.env.get('SB_REGION'), execution_id: Deno.env.get('SB_EXECUTION_ID') },
  });
  // Flush without holding up the response; outside the Edge Runtime (a CLI) it just runs.
  const flush = Sentry.flush(2000);
  (globalThis as { EdgeRuntime?: EdgeRuntime }).EdgeRuntime?.waitUntil(flush);
}
