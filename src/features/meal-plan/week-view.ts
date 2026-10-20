// What the week screen shows (spec 4.16): day and slot labels, the folded earlier days, past days and
// which household's plan. Pure, apart from reading the app's language.
import { currentLanguage, i18n, type Language } from '@/i18n';
import { tagLabel } from '@/i18n/vocabulary';

import type { PlanEntry } from './queries';
import { type Day, type Meal, weekDays, weekStart } from './week';

/** Midnight UTC on `day`, to format with `timeZone: 'UTC'`. */
const utc = (day: Day) => new Date(`${day}T00:00:00Z`);

/** The weekday's name: "Thursday" (`long`) or "Thu" (`short`), in the app's language. */
export function dayName(day: Day, width: 'long' | 'short', language: Language = currentLanguage()): string {
  return new Intl.DateTimeFormat(language, { weekday: width, timeZone: 'UTC' }).format(utc(day));
}

/** The day of the month: "15". */
export function dayOfMonth(day: Day): string {
  return String(Number(day.slice(8, 10)));
}

/** The week label for VoiceOver: "Week of October 11". */
export function weekAccessibilityLabel(start: Day, language: Language = currentLanguage()): string {
  const date = new Intl.DateTimeFormat(language, { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(utc(weekStart(start)));
  return i18n.t('mealPlan.weekOf', { date });
}

/** The meal's name, as the Meal tag's value: "Dinner". */
export function mealLabel(meal: Meal): string {
  return tagLabel('meal', meal) ?? meal;
}

/** The meal's name inside a sentence: "dinner" ("Thursday dinner", "+ Add lunch"). */
function mealWord(meal: Meal, language: Language = currentLanguage()): string {
  return mealLabel(meal).toLocaleLowerCase(language);
}

/** What a filled slot shows: the recipe's name, Leftovers, Eating out, or the note as typed. */
export function entryText(entry: Pick<PlanEntry, 'kind' | 'recipeName' | 'note'>): string {
  switch (entry.kind) {
    case 'recipe':
      return entry.recipeName ?? '';
    case 'leftovers':
      return i18n.t('mealPlan.leftovers');
    case 'eating-out':
      return i18n.t('mealPlan.eatingOut');
    default:
      return entry.note ?? '';
  }
}

/** A slot for VoiceOver: "Thursday dinner, Chicken tacos", "Thursday lunch, empty". */
export function slotAccessibilityLabel(day: Day, meal: Meal, entry: Pick<PlanEntry, 'kind' | 'recipeName' | 'note'> | null): string {
  return i18n.t('mealPlan.slotLabel', {
    day: dayName(day, 'long'),
    meal: mealWord(meal),
    entry: entry ? entryText(entry) : i18n.t('mealPlan.empty'),
  });
}

/** A slot by name: "Thursday dinner" (the Clear toast). */
export function slotName(day: Day, meal: Meal): string {
  return i18n.t('mealPlan.slotName', { day: dayName(day, 'long'), meal: mealWord(meal) });
}

/** The slot sheet's day line: "Thursday 15". */
export function sheetDayLabel(day: Day): string {
  return i18n.t('mealPlan.sheetDay', { day: dayName(day, 'long'), date: dayOfMonth(day) });
}

/** A day's label in the week screen's grid, for VoiceOver: "Friday 16, expanded" or "Friday 16, collapsed". */
export function dayToggleLabel(day: Day, open: boolean): string {
  return i18n.t(open ? 'mealPlan.dayExpanded' : 'mealPlan.dayCollapsed', { day: sheetDayLabel(day) });
}

/** An empty slot's line in the agenda from today on: "+ Add lunch". */
export function addSlotLabel(meal: Meal): string {
  return i18n.t('mealPlan.add', { meal: mealWord(meal) });
}

/** Before today: quieter, and an empty slot has no + or "Add". */
export function isPastDay(day: Day, today: Day): boolean {
  return day < today;
}

/**
 * The agenda's folded days: in the week that holds `today`, the days before it (none on Sunday); in other
 * weeks, none.
 */
export function earlierDays(start: Day, today: Day): Day[] {
  const days = weekDays(start);
  return days.includes(today) ? days.filter((day) => day < today) : [];
}

/** The folded row: "Earlier this week · Sun – Wed", or "· Sun" on Monday. */
export function earlierLabel(days: readonly Day[]): string {
  const first = dayName(days[0], 'short');
  const range = days.length > 1 ? `${first} – ${dayName(days[days.length - 1], 'short')}` : first;
  return i18n.t('mealPlan.earlier', { days: range });
}

/**
 * Whose plan the week shows (spec 4.16): the household picked on this device, else the current list's,
 * else the first. Null without households.
 */
export function resolvePlanHousehold(
  households: readonly { id: string }[],
  picked: string | null,
  currentListHousehold: string | null,
): string | null {
  const known = (id: string | null) => id !== null && households.some((h) => h.id === id);
  if (known(picked)) return picked;
  if (known(currentListHousehold)) return currentListHousehold;
  return households[0]?.id ?? null;
}
