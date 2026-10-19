// Monthly limits (spec 4.12). An AI function answers 429 `limit_reached` once the user has used
// their plan's number this calendar month (UTC), with `resets_at`, the first instant of next month.
// The app never knows the number; it only says when the limit resets.
import { formatDate } from '@/i18n';

/**
 * When a monthly limit resets: the server's `resets_at`, else (an older server, or an unreadable
 * one) the first instant of the month after `now`, UTC, as ISO 8601.
 */
export function limitResetsAt(resetsAt?: string | null, now: number = Date.now()): string {
  if (resetsAt && !Number.isNaN(Date.parse(resetsAt))) return resetsAt;
  const today = new Date(now);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * The reset as a short date in the app's language, for "They reset on <date>.": "Nov 1", Spanish
 * "1 nov". Read in UTC, where the month turns, so it's the 1st wherever the user is.
 */
export function resetDate(resetsAt: string): string {
  return formatDate(new Date(resetsAt), { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
