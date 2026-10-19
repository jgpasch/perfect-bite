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

/** Reports an error that a boundary caught, which the global handler never sees. */
export function reportError(error: unknown) {
  Sentry.captureException(error);
}

export const wrapRoot = Sentry.wrap;
