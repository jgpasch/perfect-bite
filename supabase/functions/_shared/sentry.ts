// Error reporting to Sentry (supabase.com/docs/guides/functions/examples/sentry-monitoring). Off
// unless SENTRY_DSN is set, so local serves and tests send nothing. No default integrations: one
// isolate serves many requests, so breadcrumbs and request data would mix users. A report carries
// the error, the function's name and where it ran, never headers, bodies or page content.
import * as Sentry from '@sentry/deno';

const dsn = Deno.env.get('SENTRY_DSN');
if (dsn) Sentry.init({ dsn, defaultIntegrations: false });

type EdgeRuntime = { waitUntil(promise: Promise<unknown>): void };

/**
 * Reports an error that's about to become a 500, or one that's caught but means data is lost or
 * something is quietly broken (a failed `ai_calls` insert, a missing secret), and sends it before
 * the isolate can stop. `tags` are added to the report's; pass `event` to tell caught ones apart.
 */
export function reportError(fn: string, err: unknown, tags: Record<string, string> = {}): void {
  if (!dsn) return;
  Sentry.captureException(err, {
    tags: { function: fn, region: Deno.env.get('SB_REGION'), execution_id: Deno.env.get('SB_EXECUTION_ID'), ...tags },
  });
  // Flush without holding up the response; outside the Edge Runtime (a CLI) it just runs.
  const flush = Sentry.flush(2000);
  (globalThis as { EdgeRuntime?: EdgeRuntime }).EdgeRuntime?.waitUntil(flush);
}

/**
 * supabase-js returns a failed insert's error as a plain object ({ message, code, details, hint }),
 * not an Error, which would log as `[object Object]`; this keeps all four in the message.
 */
export function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const { message, code, details, hint } = err as Record<string, unknown>;
    const parts = [code ? `${message} (${code})` : message, details, hint].filter((part) => part);
    return new Error(parts.join(' · '));
  }
  return new Error(String(err));
}
