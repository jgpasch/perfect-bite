// The wording and rules of the Safety limits card (spec 4.12 Safety limits): each key's label and
// units, how a number shows, the edit form's parsing and what saving sends, kept out of the
// component so they can be tested. The keys are `private.safety_limit_keys()`'s, in its order
// (20261130120000_ai_safety_limits.sql); a root Jest test checks they match.
import { parseLimit } from "./plans";
import type { AdminSafetyLimit } from "./types";

export type SafetyLimitInfo = {
  label: string;
  /** What `per_day` counts, as "<n> <dayUnit>". `per_minute` is always requests a minute. */
  dayUnit: string;
  /** A line under the label, when the key needs one. */
  hint?: string;
};

export const SAFETY_LIMITS = {
  categorize: { label: "Categorize", dayUnit: "names a day", hint: "Names sent to the AI" },
  step_match: { label: "Step matching", dayUnit: "matches a day" },
  recipe_tags: { label: "Tag suggestions", dayUnit: "suggestions a day" },
  recipe_import_link: { label: "Link import", dayUnit: "imports a day" },
  recipe_import_photo: { label: "Photo import", dayUnit: "imports a day" },
  recipe_import: { label: "Recipe imports", dayUnit: "imports a day", hint: "Link and photo together" },
  recipe_photo_ai: { label: "AI photos", dayUnit: "photos a day" },
} as const satisfies Record<string, SafetyLimitInfo>;

export type SafetyLimitKey = keyof typeof SAFETY_LIMITS;

/** The keys in the server's order. */
export const SAFETY_LIMIT_KEYS = Object.keys(SAFETY_LIMITS) as SafetyLimitKey[];

/** Every key's per-minute unit. */
export const MINUTE_UNIT = "requests a minute";

export function isSafetyLimitKey(key: string): key is SafetyLimitKey {
  return Object.hasOwn(SAFETY_LIMITS, key);
}

/** The key's label, or the raw key for one this portal doesn't know yet. */
export function safetyLimitLabel(key: string): string {
  return isSafetyLimitKey(key) ? SAFETY_LIMITS[key].label : key;
}

/** The line under the key's label, or null. */
export function safetyLimitHint(key: string): string | null {
  if (!isSafetyLimitKey(key)) return null;
  const info: SafetyLimitInfo = SAFETY_LIMITS[key];
  return info.hint ?? null;
}

/** The key's per-day unit; "requests a day" for one this portal doesn't know. */
export function dayUnit(key: string): string {
  return isSafetyLimitKey(key) ? SAFETY_LIMITS[key].dayUnit : "requests a day";
}

/** A number as the card shows it: "1,500", or "" (blank) for none. */
export function limitNumber(limit: number | null): string {
  return limit === null ? "" : limit.toLocaleString("en-US");
}

/** A number in the activity log: "1,500", or "none". */
export function limitOrNone(limit: number | null | undefined): string {
  return typeof limit === "number" ? limit.toLocaleString("en-US") : "none";
}

/** A form field: blank is no limit (null), else a whole number from 0. */
export type ParsedLimit = { ok: true; value: number | null } | { ok: false };

export function parseSafetyLimit(text: string): ParsedLimit {
  if (text.trim() === "") return { ok: true, value: null };
  const value = parseLimit(text);
  return value === null ? { ok: false } : { ok: true, value };
}

/** A field's starting text: the number without separators, or blank for none. */
export function fieldText(limit: number | null): string {
  return limit === null ? "" : String(limit);
}

/**
 * What saving the form sends, or null when a field isn't a number or nothing changed (the server
 * would write an audit row anyway).
 */
export function safetyLimitSave(
  before: Pick<AdminSafetyLimit, "per_minute" | "per_day">,
  minuteText: string,
  dayText: string,
): { per_minute: number | null; per_day: number | null } | null {
  const minute = parseSafetyLimit(minuteText);
  const day = parseSafetyLimit(dayText);
  if (!minute.ok || !day.ok) return null;
  if (minute.value === before.per_minute && day.value === before.per_day) return null;
  return { per_minute: minute.value, per_day: day.value };
}
