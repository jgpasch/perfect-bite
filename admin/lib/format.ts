// Dates as the portal shows them: relative ("3 days ago") with the full date on hover, and the
// short UTC date limits reset on ("Nov 1").

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/** "just now", "5 minutes ago", "yesterday", "3 months ago" (or "in 2 days" for a future date). */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = (new Date(iso).getTime() - now.getTime()) / 1000;
  if (Number.isNaN(seconds)) return "";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}

const full = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** "Oct 18, 2026, 2:05 PM", in the portal's time zone: the hover text for a relative date. */
export function fullDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : full.format(date);
}

const medium = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** "Nov 12, 2026", in the portal's time zone. */
export function mediumDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : medium.format(date);
}

const shortUtc = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Nov 1": a month and day read in UTC, as limits reset (always the 1st). */
export function shortUtcDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : shortUtc.format(date);
}
