// The wording of the Users pages (spec 4.12): the plan badge, a feature's usage this month, who
// changed a plan, and the list's search and paging, kept out of the components so they can be tested.
import { FEATURES, isFeature, type Feature } from "./features";
import { shortUtcDate } from "./format";
import type { AdminFeatureUsage, AdminPlanHistoryEntry } from "./types";

/** Users a page on /users. */
export const USERS_PAGE_SIZE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** `?page=` as a page number from 1; anything else is page 1. */
export function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

/** `?q=` trimmed; "" for none. */
export function parseQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").trim();
}

/** `?blocked=1`, the Blocked filter: only users whose AI photos are blocked. Anything else is off. */
export function parseBlocked(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1";
}

/**
 * The list's URL for a search, page and the Blocked filter: `/users`, `/users?q=ann`,
 * `/users?q=ann&page=2`, `/users?blocked=1`.
 */
export function usersHref(query: string, page: number, blocked: boolean = false): string {
  const params = new URLSearchParams();
  if (query.trim() !== "") params.set("q", query.trim());
  if (blocked) params.set("blocked", "1");
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search === "" ? "/users" : `/users?${search}`;
}

/** "51–100 of 123" for page 2 of 123 matches; "" when there are none. */
export function pageRange(page: number, total: number, pageSize: number = USERS_PAGE_SIZE): string {
  if (total <= 0) return "";
  const first = (page - 1) * pageSize + 1;
  if (first > total) return `0 of ${total}`;
  const last = Math.min(page * pageSize, total);
  return `${first}–${last} of ${total}`;
}

/** The avatar's letter: the name's, else the email's, else "?". */
export function avatarInitial(displayName: string | null, email: string | null): string {
  const source = displayName?.trim() || email?.trim() || "";
  const letter = Array.from(source)[0];
  return letter ? letter.toLocaleUpperCase("en") : "?";
}

/** A plan's name from `admin_list_plans`, or its id when that plan isn't in the list. */
export function planName(planId: string | null, names: ReadonlyMap<string, string>): string {
  if (planId === null) return "No plan";
  return names.get(planId) ?? planId;
}

/** The badge: "Plus", or "Plus · default" for a user who has no plan of their own. */
export function planBadge(name: string, assigned: boolean): string {
  return assigned ? name : `${name} · default`;
}

/** A plan in Plan history's from/to: null is the default plan, named when it's known. */
export function historyPlan(planId: string | null, names: ReadonlyMap<string, string>, defaultName: string | null): string {
  if (planId === null) return defaultName === null ? "Default" : `Default (${defaultName})`;
  return planName(planId, names);
}

/** Who changed it: the admin's email, "Dashboard" for `postgres`, else the raw id. */
export function whoWording(entry: Pick<AdminPlanHistoryEntry, "performed_by" | "performed_by_email">): string {
  if (entry.performed_by_email) return entry.performed_by_email;
  if (entry.performed_by === "postgres") return "Dashboard";
  return entry.performed_by;
}

const NOUNS: Record<Feature, [one: string, other: string]> = {
  categorize: ["name", "names"],
  recipe_import: ["import", "imports"],
  recipe_import_photo: ["photo import", "photo imports"],
  recipe_tags: ["suggestion", "suggestions"],
  step_ingredients: ["match", "matches"],
  recipe_photo_ai: ["photo", "photos"],
};

/** What a feature's usage counts, by how many: "1 import", "40 imports" ("calls" for an unknown feature). */
export function usageNoun(feature: string, count: number): string {
  const [one, other] = isFeature(feature) ? NOUNS[feature] : (["call", "calls"] as const);
  return count === 1 ? one : other;
}

export type UsageRow = {
  feature: string;
  label: string;
  /** "23 / 40 imports · resets Nov 1", "12 names · no limit" or "Not in plan". */
  text: string;
  inPlan: boolean;
  /** How full the bar is, 0 to 1; null with no bar (no limit, or not in plan). */
  fraction: number | null;
  /** At or past the limit. */
  atLimit: boolean;
};

/**
 * One row of the This month card. `doubled` is the first month: the limit `admin_user_detail`
 * sends is already twice the plan's, and the row says so.
 */
export function usageRow(usage: AdminFeatureUsage, doubled: boolean): UsageRow {
  const label = isFeature(usage.feature) ? FEATURES[usage.feature].label : usage.feature;
  const base = { feature: usage.feature, label };
  if (!usage.in_plan) return { ...base, text: "Not in plan", inPlan: false, fraction: null, atLimit: false };

  const used = usage.used.toLocaleString("en-US");
  if (usage.limit === null) {
    return {
      ...base,
      text: `${used} ${usageNoun(usage.feature, usage.used)} · no limit`,
      inPlan: true,
      fraction: null,
      atLimit: false,
    };
  }

  const limit = usage.limit.toLocaleString("en-US");
  const doubledNote = doubled ? " (2× first month)" : "";
  const resets = shortUtcDate(usage.resets_at);
  return {
    ...base,
    text: `${used} / ${limit} ${usageNoun(usage.feature, usage.limit)}${doubledNote} · resets ${resets}`,
    inPlan: true,
    fraction: usage.limit === 0 ? 1 : Math.min(usage.used / usage.limit, 1),
    atLimit: usage.used >= usage.limit,
  };
}
