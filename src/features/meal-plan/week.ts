// Week math for the meal plan (spec 4.16). Pure: days are calendar dates as `YYYY-MM-DD` text, the
// way `meal_plan_entries.plan_date` stores them, so no time zone or DST change can move one. Only
// `today` reads the device's clock and zone. A week runs Sunday to Saturday.
import { currentLanguage, type Language } from '@/i18n';

/** A calendar day, `YYYY-MM-DD`. */
export type Day = string;

export const MEALS = ['breakfast', 'lunch', 'dinner'] as const;
export type Meal = (typeof MEALS)[number];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The day of a `Date` read in UTC (the form `dayToDate` makes). */
function utcDay(date: Date): Day {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Midnight UTC on `day`, for arithmetic and formatting in UTC. */
function dayToDate(day: Day): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`Not a day: ${day}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (utcDay(date) !== day) throw new Error(`Not a day: ${day}`);
  return date;
}

/** The device's local calendar day at `now`. */
export function today(now: Date = new Date()): Day {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `day` moved by `count` days (negative goes back). */
export function addDays(day: Day, count: number): Day {
  const date = dayToDate(day);
  date.setUTCDate(date.getUTCDate() + count);
  return utcDay(date);
}

/** The Sunday that starts `day`'s week. */
export function weekStart(day: Day): Day {
  return addDays(day, -dayToDate(day).getUTCDay());
}

/** The week's seven days, Sunday to Saturday. */
export function weekDays(start: Day): Day[] {
  const sunday = weekStart(start);
  return Array.from({ length: 7 }, (_, i) => addDays(sunday, i));
}

export function previousWeek(start: Day): Day {
  return addDays(weekStart(start), -7);
}

export function nextWeek(start: Day): Day {
  return addDays(weekStart(start), 7);
}

/**
 * The week toolbar's label in the app's language: "Oct 11 – 17", "Oct 28 – Nov 3", "Dec 27 – Jan 2";
 * Spanish "11 – 17 oct", "28 oct – 3 nov".
 */
export function weekLabel(start: Day, language: Language = currentLanguage()): string {
  const sunday = dayToDate(weekStart(start));
  const saturday = dayToDate(addDays(weekStart(start), 6));
  const format = new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (sunday.getUTCMonth() !== saturday.getUTCMonth() || typeof format.formatToParts !== 'function') {
    return `${format.format(sunday)} – ${format.format(saturday)}`;
  }
  // One month: the month once, where the language puts it, around the range of days.
  return format
    .formatToParts(sunday)
    .map((part) => (part.type === 'day' ? `${part.value} – ${saturday.getUTCDate()}` : part.value))
    .join('');
}
