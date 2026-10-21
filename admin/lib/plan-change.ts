// The wording of the Change plan dialog on a household's page (spec 4.12): its choices, each plan's
// features and limits in one line, and the line shown once the move is saved, kept out of the
// component so they can be tested. A household's plan can be changed but never cleared, so there's
// no "default" choice.
import { featureLabel } from "./features";
import type { AdminPlan, AdminPlanList } from "./types";
import { usageNoun } from "./users";

/** One choice in the dialog: a plan. */
export type PlanChoice = {
  /** The radio's value: the plan id. */
  value: string;
  planId: string;
  /** The plan's name, with "(default)" on the one new households start on. */
  title: string;
  /** Its features and limits in one line. */
  summary: string;
  /** What the household is on now. */
  current: boolean;
};

/** "Recipe import 50 imports · AI photos no limit", or "No features". */
export function planSummary(plan: Pick<AdminPlan, "features">): string {
  if (plan.features.length === 0) return "No features";
  return plan.features
    .map(({ feature, monthly_limit: limit }) =>
      limit === null
        ? `${featureLabel(feature)} no limit`
        : `${featureLabel(feature)} ${limit.toLocaleString("en-US")} ${usageNoun(feature, limit)}`,
    )
    .join(" · ");
}

/**
 * The dialog's choices: every plan in the list's order (by id). `current` is the household's plan
 * id, or null when it has none (then nothing is marked).
 */
export function planChoices(plans: AdminPlanList, current: string | null): PlanChoice[] {
  return plans.map((plan) => ({
    value: plan.id,
    planId: plan.id,
    title: plan.is_default ? `${plan.name} (default)` : plan.name,
    summary: planSummary(plan),
    current: current === plan.id,
  }));
}

/** The choice the dialog opens on: the current plan, else the first. Null with no plans. */
export function initialChoice(choices: readonly PlanChoice[]): string | null {
  return (choices.find((choice) => choice.current) ?? choices[0])?.value ?? null;
}

/** "Moved The Lees to Free". */
export function movedMessage(householdName: string, plan: Pick<AdminPlan, "name">): string {
  return `Moved ${householdName} to ${plan.name}`;
}

/** A blank or whitespace note isn't one (the server says `note required`). */
export function isNoteValid(note: string): boolean {
  return note.trim() !== "";
}
