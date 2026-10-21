// The wording of the Households pages (spec 4.12): the list's URL, member counts and roles, and
// the first month, kept out of the components so they can be tested. Search, paging, plan names,
// usage rows and who changed a plan are shared with the Users pages (./users).
import { mediumDate } from "./format";
import type { AdminHouseholdDetail, AdminHouseholdMember } from "./types";

/** Households a page on /households. */
export const HOUSEHOLDS_PAGE_SIZE = 50;

/** The list's URL for a search and page: `/households`, `/households?q=lee`, `/households?q=lee&page=2`. */
export function householdsHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query.trim() !== "") params.set("q", query.trim());
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search === "" ? "/households" : `/households?${search}`;
}

/** A household's page. */
export function householdHref(householdId: string): string {
  return `/households/${householdId}`;
}

/** "1 member", "3 members", "No members". */
export function membersCount(count: number): string {
  if (count === 0) return "No members";
  return `${count.toLocaleString("en-US")} ${count === 1 ? "member" : "members"}`;
}

/** "Owner" or "Member". */
export function roleLabel(role: AdminHouseholdMember["role"]): string {
  return role === "owner" ? "Owner" : "Member";
}

/** The header's first-month badge, "First month · 2× limits until Nov 3, 2026", or null after it. */
export function firstMonthBadge(firstMonth: AdminHouseholdDetail["first_month"]): string | null {
  if (!firstMonth.doubled || firstMonth.ends_at === null) return null;
  return `First month · 2× limits until ${mediumDate(firstMonth.ends_at)}`;
}

/** Under the plan's name: "Since Oct 2, 2026", or why there's none. */
export function planSinceLine(plan: AdminHouseholdDetail["plan"]): string {
  if (plan === null) return "No plan, so no features. Choose one.";
  return `Since ${mediumDate(plan.assigned_at)}`;
}
