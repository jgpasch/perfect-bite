// The wording and rules of the Plans grid (spec 4.12): each cell's text, the "Affects" line, what a
// cell's popover saves, the column menu's defaults and why Delete is off, kept out of the components
// so they can be tested.
import type { AdminPlan, AdminPlanList, MonthlyLimit } from "./types";

/** "1 household", "12 households". */
export function householdsCount(households: number): string {
  return `${households.toLocaleString("en-US")} ${households === 1 ? "household" : "households"}`;
}

/** The plan's entry for a feature, or null when the plan doesn't have it. */
export function planFeature(plan: Pick<AdminPlan, "features">, feature: string): { monthly_limit: MonthlyLimit } | null {
  return plan.features.find((entry) => entry.feature === feature) ?? null;
}

/** A cell: "—" not in the plan, "No limit", or the limit ("1,000"). */
export function cellWording(plan: Pick<AdminPlan, "features">, feature: string): string {
  const entry = planFeature(plan, feature);
  if (entry === null) return "—";
  if (entry.monthly_limit === null) return "No limit";
  return entry.monthly_limit.toLocaleString("en-US");
}

/** What a change to a plan's cell does, under the popover. */
export function affectsLine(households: number): string {
  return `Affects ${householdsCount(households)}. AI requests use it right away; the app shows or hides the feature the next time it's opened.`;
}

/** The Make default dialog's line: only new households start on it. */
export function makeDefaultLine(planName: string): string {
  return `New households will start on ${planName}. Existing households keep their plan.`;
}

/**
 * The limit a feature gets when it's turned on: the default plan's for it, or null (no limit) when
 * there's no default plan or the default doesn't have the feature.
 */
export function defaultLimit(plans: AdminPlanList, feature: string): MonthlyLimit {
  const fallback = plans.find((plan) => plan.is_default);
  return fallback ? (planFeature(fallback, feature)?.monthly_limit ?? null) : null;
}

/** The Monthly limit field: "" for no number yet, else a whole number from 0. Null when it isn't one. */
export function parseLimit(text: string): number | null {
  const trimmed = text.trim().replaceAll(",", "");
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value <= 2_147_483_647 ? value : null;
}

/** A cell's state in its popover. */
export type CellState = { enabled: boolean; limit: MonthlyLimit };

/** What saving a cell calls, or null when nothing changed. */
export type CellSave =
  | { kind: "feature"; enabled: boolean; limit: MonthlyLimit }
  | { kind: "limit"; limit: MonthlyLimit };

export function cellSave(before: CellState, after: CellState): CellSave | null {
  if (before.enabled !== after.enabled) {
    return after.enabled ? { kind: "feature", enabled: true, limit: after.limit } : { kind: "feature", enabled: false, limit: null };
  }
  if (after.enabled && before.limit !== after.limit) return { kind: "limit", limit: after.limit };
  return null;
}

/** Why a plan can't be deleted, or null when it can. */
export function deleteBlockedReason(plan: Pick<AdminPlan, "is_default" | "households">): string | null {
  if (plan.is_default) return "The default plan can't be deleted. Make another plan the default first.";
  if (plan.households > 0) {
    return `${householdsCount(plan.households)} ${plan.households === 1 ? "is" : "are"} on this plan. Move them first.`;
  }
  return null;
}

const PLAN_ID = /^[a-z][a-z0-9_]{1,30}$/;

/** The server's rule for a new plan's id: a lowercase letter, then 1–30 of a–z, 0–9 and _. */
export function isPlanIdValid(id: string): boolean {
  return PLAN_ID.test(id);
}

/** Duplicate's prefilled id, `<id>_copy`, cut to fit the 31-character limit. */
export function copyId(id: string): string {
  return `${id.slice(0, 31 - "_copy".length)}_copy`;
}

/** Duplicate's prefilled name: "Founding copy". */
export function copyName(name: string): string {
  return `${name} copy`;
}

/** The server's message as a sentence: "plan in use" → "Plan in use." */
export function serverMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed === "") return "Something went wrong.";
  const sentence = trimmed[0].toLocaleUpperCase("en") + trimmed.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
