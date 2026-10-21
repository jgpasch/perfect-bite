// The wording of the Change plan dialog (spec 4.12): its choices, each plan's features and limits in
// one line, and the line shown once the move is saved, kept out of the component so they can be tested.
import { featureLabel } from "./features";
import type { AdminPlan, AdminPlanList } from "./types";
import { usageNoun } from "./users";

/** One choice in the dialog. `planId` null is the default plan (no `user_plans` row). */
export type PlanChoice = {
  /** The radio's value: the plan id, or "" for the default. */
  value: string;
  planId: string | null;
  /** "Default (Founding)", or the plan's name. */
  title: string;
  /** Its features and limits in one line. */
  summary: string;
  /** What the user is on now. */
  current: boolean;
};

/** "Categorize 250 names · Recipe import no limit", or "No features". */
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

/** The default choice's title: "Default (Founding)", or "Default" when no plan is the default. */
export function defaultChoiceTitle(plans: AdminPlanList): string {
  const fallback = plans.find((plan) => plan.is_default);
  return fallback ? `Default (${fallback.name})` : "Default";
}

/**
 * The dialog's choices: the default first, then every plan in the list's order (by id). `current`
 * is the user's `user_plans` plan id, or null when they're on the default.
 */
export function planChoices(plans: AdminPlanList, current: string | null): PlanChoice[] {
  const fallback = plans.find((plan) => plan.is_default);
  return [
    {
      value: "",
      planId: null,
      title: defaultChoiceTitle(plans),
      summary: fallback ? planSummary(fallback) : "No features",
      current: current === null,
    },
    ...plans.map((plan) => ({
      value: plan.id,
      planId: plan.id,
      title: plan.name,
      summary: planSummary(plan),
      current: current === plan.id,
    })),
  ];
}

/** "Moved ann@example.com to Free"; the default reads as its choice, "Default (Founding)". */
export function movedMessage(email: string | null, choice: Pick<PlanChoice, "title">): string {
  return `Moved ${email ?? "the user"} to ${choice.title}`;
}

/** A blank or whitespace note isn't one (the server says `note required`). */
export function isNoteValid(note: string): boolean {
  return note.trim() !== "";
}
