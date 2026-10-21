import { describe, expect, it } from "vitest";

import { initialChoice, isNoteValid, movedMessage, planChoices, planSummary } from "./plan-change";
import type { AdminPlan, AdminPlanList } from "./types";

const free: AdminPlan = { id: "free", name: "Free", is_default: false, households: 2, features: [] };
const founding: AdminPlan = {
  id: "founding",
  name: "Founding",
  is_default: true,
  households: 7,
  features: [
    { feature: "recipe_import", monthly_limit: 50 },
    { feature: "recipe_photo_ai", monthly_limit: 1 },
  ],
};
const unlimited: AdminPlan = {
  id: "unlimited",
  name: "Unlimited",
  is_default: false,
  households: 1,
  features: [
    { feature: "recipe_import", monthly_limit: null },
    { feature: "recipe_photo_ai", monthly_limit: null },
  ],
};
const plans: AdminPlanList = [founding, free, unlimited];

describe("planSummary", () => {
  it("lists each feature with its limit and unit in the plan's order, singular for 1", () => {
    expect(planSummary(founding)).toBe("Recipe import 50 imports · AI photos 1 photo");
  });

  it("uses a thousands separator", () => {
    expect(planSummary({ features: [{ feature: "recipe_import", monthly_limit: 2500 }] })).toBe("Recipe import 2,500 imports");
  });

  it("says no limit for a null limit, and a 0 limit as a number", () => {
    expect(planSummary(unlimited)).toBe("Recipe import no limit · AI photos no limit");
    expect(planSummary({ features: [{ feature: "recipe_photo_ai", monthly_limit: 0 }] })).toBe("AI photos 0 photos");
  });

  it("says No features for an empty plan", () => {
    expect(planSummary(free)).toBe("No features");
  });

  it("shows an unknown feature by its key", () => {
    expect(planSummary({ features: [{ feature: "new_thing", monthly_limit: 3 }] })).toBe("new_thing 3 calls");
  });
});

describe("planChoices", () => {
  it("offers every plan in the list's order, and no default choice", () => {
    const choices = planChoices(plans, "free");
    expect(choices.map((c) => c.value)).toEqual(["founding", "free", "unlimited"]);
    expect(choices.map((c) => c.planId)).toEqual(["founding", "free", "unlimited"]);
    expect(choices.some((c) => c.value === "")).toBe(false);
  });

  it("marks the default plan in its title", () => {
    expect(planChoices(plans, null).map((c) => c.title)).toEqual(["Founding (default)", "Free", "Unlimited"]);
  });

  it("marks the household's current plan", () => {
    expect(planChoices(plans, "free").filter((c) => c.current).map((c) => c.value)).toEqual(["free"]);
    expect(planChoices(plans, "founding").filter((c) => c.current).map((c) => c.value)).toEqual(["founding"]);
  });

  it("marks nothing for a household with no plan, or one not in the list", () => {
    expect(planChoices(plans, null).some((c) => c.current)).toBe(false);
    expect(planChoices(plans, "gone").some((c) => c.current)).toBe(false);
  });

  it("summarises each plan", () => {
    expect(planChoices(plans, null)[1].summary).toBe("No features");
    expect(planChoices([], null)).toEqual([]);
  });
});

describe("initialChoice", () => {
  it("opens on the current plan", () => {
    expect(initialChoice(planChoices(plans, "unlimited"))).toBe("unlimited");
  });

  it("opens on the first plan when the household has none", () => {
    expect(initialChoice(planChoices(plans, null))).toBe("founding");
  });

  it("is null with no plans", () => {
    expect(initialChoice([])).toBeNull();
  });
});

describe("movedMessage", () => {
  it("names the household and the plan", () => {
    expect(movedMessage("The Lees", free)).toBe("Moved The Lees to Free");
  });
});

describe("isNoteValid", () => {
  it("needs something other than whitespace", () => {
    expect(isNoteValid("asked by email")).toBe(true);
    expect(isNoteValid("  x ")).toBe(true);
    expect(isNoteValid("")).toBe(false);
    expect(isNoteValid("   \n\t")).toBe(false);
  });
});
