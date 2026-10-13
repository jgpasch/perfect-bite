import * as Linking from 'expo-linking';

/** A scheme at the start ("https:", "mailto:"), but not a host and port ("example.com:8080"). */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

/**
 * The parsed link when `text` is one that opens: an `http`/`https` URL whose host has a dot.
 * Null for anything else (plain text kept in the link field, spec 4.5).
 */
export function recipeLinkUrl(text: string | null | undefined): URL | null {
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.')) return null;
  return url;
}

/**
 * What the link field saves (spec 4.5): trimmed, with `https://` added when there's no scheme. If
 * that isn't a link that opens, the trimmed text is kept as typed. Empty clears the link.
 */
export function normalizeRecipeLink(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const withScheme = SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  return recipeLinkUrl(withScheme) ? withScheme : trimmed;
}

/**
 * How a link shows on the recipe screen: the host without `www.` (and its port, if any), then the
 * rest (path, query, fragment). A bare "/" path shows nothing. Null if it isn't a link that opens.
 */
export function recipeLinkParts(text: string | null | undefined): { host: string; path: string } | null {
  const url = recipeLinkUrl(text);
  if (!url) return null;
  const host = url.host.replace(/^www\./i, '');
  const rest = `${url.pathname}${url.search}${url.hash}`;
  return { host, path: rest === '/' ? '' : rest };
}

/**
 * Opens a recipe's link in Safari, not an in-app browser, so the user's sign-ins carry over.
 * Offline, Safari shows its own page. Resolves false if iOS couldn't open it.
 */
export function openRecipeLink(url: string): Promise<boolean> {
  return Linking.openURL(url).then(
    () => true,
    () => false,
  );
}
