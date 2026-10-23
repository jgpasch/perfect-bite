// Crash and error reporting (docs.sentry.io/platforms/react-native/guides/expo). Errors only, from
// release builds: no tracing or replays, and the user is their id alone, never their email or lists.
import * as Sentry from '@sentry/react-native';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

/** Starts reporting in release builds once EXPO_PUBLIC_SENTRY_DSN is set; a no-op otherwise. */
export function initSentry() {
  if (!dsn || __DEV__) return;
  Sentry.init({ dsn, sendDefaultPii: false });
}

/** Tags later reports with the signed-in user's id, or clears it when signed out. */
export function setSentryUser(userId: string | null) {
  Sentry.setUser(userId ? { id: userId } : null);
}

/**
 * Reports an error the global handler never sees: one a boundary caught, or one that's caught and
 * logged but means data is lost or something is quietly broken (a rejected sync change, a failed
 * wipe). Pass `area` and `event` to tell caught ones apart. A no-op until `initSentry` ran.
 */
export function reportError(error: unknown, tags: { area?: string; event?: string } & Record<string, string> = {}) {
  Sentry.captureException(asError(error), { tags });
}

/**
 * supabase-js and Zod hand back errors that aren't always Errors (a PostgREST error is a plain
 * { message, code, details, hint }), which Sentry would show as "Object captured as exception";
 * this keeps their message and code.
 */
export function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const { message, code, details, hint } = err as Record<string, unknown>;
    const parts = [code ? `${String(message)} (${String(code)})` : String(message), details, hint].filter((part) => part);
    return new Error(parts.join(' · '));
  }
  return new Error(String(err));
}

export const wrapRoot = Sentry.wrap;
