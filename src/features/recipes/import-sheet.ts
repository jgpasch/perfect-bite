// What the "Add recipe from link…" sheet shows (spec 4.10). Pure, so it can be tested without rendering.

import { addedRecipeToListToast } from './recipe-view';
import type { ImportRecipeError } from './import';

/** Characters that end a sentence around a link rather than belong to it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"’”]+$/;

/**
 * The link in what the user pasted or typed: the first `http(s)` URL (apps share a URL inside text,
 * spec 4.10), without the punctuation that ends the sentence around it. A bare `example.com/path`
 * typed on its own gets `https://`. Null when there's no link.
 */
export function urlFromText(text: string): string | null {
  const found = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (found) return trimUrl(found[0]);
  const bare = text.trim();
  // One word with a dotted host, e.g. "smittenkitchen.com/2008/09/moms-apple-cake".
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(bare)) return trimUrl(`https://${bare}`);
  return null;
}

/** Drops trailing sentence punctuation, and closing brackets that weren't opened inside the URL. */
function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const next = out.replace(TRAILING_PUNCTUATION, '');
    const close = next.at(-1);
    const open = close === ')' ? '(' : close === ']' ? '[' : null;
    const unbalanced = open !== null && count(next, open) < count(next, close!);
    const trimmed = unbalanced ? next.slice(0, -1) : next;
    if (trimmed === out) return out;
    out = trimmed;
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Spec 4.10's inline failure copy; the sheet stays open. */
export function importErrorMessage(error: ImportRecipeError): string {
  switch (error.error) {
    case 'not_a_recipe':
      return "That page doesn't look like a recipe";
    case 'rate_limited':
      return 'Try again in a minute';
    case 'offline':
      return "You're offline";
    case 'failed':
      if (error.reason === 'fetch_failed') return "Couldn't reach that site";
      if (error.reason === 'invalid_url') return "That doesn't look like a link";
      return "Couldn't import that recipe. Try again.";
  }
}

/** The list screen's toast after an import: "Added Chicken tikka masala · 12 items", the name in bold. */
export function importedToast(recipeName: string, count: number): { message: string; emphasis: string } {
  return addedRecipeToListToast(recipeName, count);
}
