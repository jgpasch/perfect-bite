import { describe, expect, it } from "vitest";

import { defaultChoiceTitle, isNoteValid, movedMessage, planChoices, planSummary } from "./plan-change";
import type { AdminPlan, AdminPlanList } from "./types";

const free: AdminPlan = { id: "free", name: "Free", is_default: false, users: 2, features: [] };
const founding: AdminPlan = {
  id: "founding",
  name: "Founding",
  is_default: true,
  users: 7,
  features: [
    { feature: "categorize", monthly_limit: 250 },
    { feature: "recipe_import", monthly_limit: 40 },
    { feature: "recipe_import_photo", monthly_limit: 1 },
    { feature: "recipe_tags", monthly_limit: 50 },
    { feature: "step_ingredients", monthly_limit: 100 },
    { feature: "recipe_photo_ai", monthly_limit: 15 },
  ],
};
const unlimited: AdminPlan = {
  id: "unlimited",
  name: "Unlimited",
  is_default: false,
  users: 1,
  features: [
    { feature: "categorize", monthly_limit: null },
    { feature: "recipe_import", monthly_limit: null },
  ],
};
const plans: AdminPlanList = [founding, free, unlimited];

describe("planSummary", () => {
  it("lists each feature with its limit and unit in the plan's order", () => {
    expect(
      planSummary({
        features: [
          { feature: "categorize", monthly_limit: 250 },
          { feature: "step_ingredients", monthly_limit: 100 },
        ],
      }),
    ).toBe("Categorize 250 names · Step matching 100 matches");
  });

  it("uses the singular for a limit of 1 and a thousands separator", () => {
    expect(planSummary(founding)).toBe(
      "Categorize 250 names · Recipe import 40 imports · Photo import 1 photo import · " +
        "Tag suggestions 50 suggestions · Step matching 100 matches · AI photos 15 photos",
    );
    expect(planSummary({ features: [{ feature: "categorize", monthly_limit: 2500 }] })).toBe("Categorize 2,500 names");
  });

  it("says no limit for a null limit, and a 0 limit as a number", () => {
    expect(planSummary(unlimited)).toBe("Categorize no limit · Recipe import no limit");
    expect(planSummary({ features: [{ feature: "recipe_tags", monthly_limit: 0 }] })).toBe("Tag suggestions 0 suggestions");
  });

  it("says No features for an empty plan", () => {
    expect(planSummary(free)).toBe("No features");
  });

  it("shows an unknown feature by its key", () => {
    expect(planSummary({ features: [{ feature: "new_thing", monthly_limit: 3 }] })).toBe("new_thing 3 calls");
  });
});

describe("planChoices", () => {
  it("puts the default first, named after the default plan, then every plan in order", () => {
    const choices = planChoices(plans, null);
    expect(choices.map((c) => [c.value, c.planId, c.title])).toEqual([
      ["", null, "Default (Founding)"],
      ["founding", "founding", "Founding"],
      ["free", "free", "Free"],
      ["unlimited", "unlimited", "Unlimited"],
    ]);
    expect(choices[0].summary).toBe(planSummary(founding));
    expect(choices[2].summary).toBe("No features");
  });

  it("marks the default as current for an unassigned user", () => {
    expect(planChoices(plans, null).filter((c) => c.current).map((c) => c.value)).toEqual([""]);
  });

  it("marks their own plan, not the default, even when it's the default plan", () => {
    expect(planChoices(plans, "free").filter((c) => c.current).map((c) => c.value)).toEqual(["free"]);
    expect(planChoices(plans, "founding").filter((c) => c.current).map((c) => c.value)).toEqual(["founding"]);
  });

  it("marks nothing when their plan isn't in the list", () => {
    expect(planChoices(plans, "gone").some((c) => c.current)).toBe(false);
  });

  it("with no default plan, the default choice has no features", () => {
    const choices = planChoices([free, unlimited], null);
    expect(choices[0]).toEqual({ value: "", planId: null, title: "Default", summary: "No features", current: true });
    expect(planChoices([], null)).toHaveLength(1);
  });
});

describe("defaultChoiceTitle", () => {
  it("names the default plan", () => {
    expect(defaultChoiceTitle(plans)).toBe("Default (Founding)");
    expect(defaultChoiceTitle([free])).toBe("Default");
  });
});

describe("movedMessage", () => {
  it("names the email and the choice", () => {
    expect(movedMessage("ann@example.com", { title: "Free" })).toBe("Moved ann@example.com to Free");
    expect(movedMessage("ann@example.com", { title: "Default (Founding)" })).toBe(
      "Moved ann@example.com to Default (Founding)",
    );
  });

  it("falls back without an email", () => {
    expect(movedMessage(null, { title: "Free" })).toBe("Moved the user to Free");
  });
});

describe("isNoteValid", () => {
  it("needs something besides whitespace", () => {
    expect(isNoteValid("Asked by email")).toBe(true);
    expect(isNoteValid("")).toBe(false);
    expect(isNoteValid("  \n\t")).toBe(false);
  });
});
