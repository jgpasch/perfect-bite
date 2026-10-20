import { describe, expect, it } from "vitest";

import {
  ACTION_KEYS,
  actionHref,
  actionLabel,
  actionOptions,
  actionSummary,
  actionTarget,
  actionWho,
  activityHref,
} from "./activity";
import type { AdminPlan } from "./types";

function plan(overrides: Partial<AdminPlan> = {}): AdminPlan {
  return {
    id: "plus",
    name: "Plus",
    is_default: false,
    users: 3,
    features: [
      { feature: "categorize", monthly_limit: 250 },
      { feature: "recipe_import", monthly_limit: 40 },
    ],
    ...overrides,
  };
}

const summary = (action: string, details: unknown) =>
  actionSummary({ action, details: details as Record<string, unknown> });

describe("actionLabel", () => {
  it("labels every portal action", () => {
    expect(ACTION_KEYS.map(actionLabel)).toEqual([
      "Changed plan",
      "Changed a limit",
      "Changed a feature",
      "Created a plan",
      "Renamed a plan",
      "Changed the default plan",
      "Deleted a plan",
      "Deleted user",
      "Deleted own account",
      "Viewed an AI call",
    ]);
  });

  it("shows the raw name for an unknown action", () => {
    expect(actionLabel("grant_admin")).toBe("grant_admin");
    expect(actionLabel("")).toBe("");
    // Not fooled by Object.prototype.
    expect(actionLabel("toString")).toBe("toString");
  });
});

describe("actionOptions", () => {
  it("lists the known actions, adding an unknown current one last", () => {
    expect(actionOptions("").map((o) => o.value)).toEqual(ACTION_KEYS);
    expect(actionOptions("set_user_plan")).toHaveLength(ACTION_KEYS.length);
    expect(actionOptions("grant_admin").at(-1)).toEqual({ value: "grant_admin", label: "grant_admin" });
  });
});

describe("activityHref", () => {
  it("keeps the filter and page in the URL", () => {
    expect(activityHref("", 1)).toBe("/activity");
    expect(activityHref("set_user_plan", 1)).toBe("/activity?action=set_user_plan");
    expect(activityHref("set_user_plan", 3)).toBe("/activity?action=set_user_plan&page=3");
    expect(activityHref(" ", 2)).toBe("/activity?page=2");
    expect(activityHref("a&b", 1)).toBe("/activity?action=a%26b");
  });
});

describe("actionSummary", () => {
  it("set_user_plan: plan ids, null as the default", () => {
    expect(summary("set_user_plan", { from: "plus", to: "unlimited" })).toBe("plus → unlimited");
    expect(summary("set_user_plan", { from: null, to: "base" })).toBe("default → base");
    expect(summary("set_user_plan", { from: "base", to: null })).toBe("base → default");
    expect(summary("set_user_plan", { from: "plus", to: "plus" })).toBe("plus → plus");
  });

  it("set_plan_limit: the feature's limit before and after", () => {
    const before = plan();
    const after = plan({ features: [{ feature: "categorize", monthly_limit: 250 }, { feature: "recipe_import", monthly_limit: 60 }] });
    expect(summary("set_plan_limit", { before, after, users: 3 })).toBe("recipe_import limit 40 → 60");
  });

  it("set_plan_limit: no limit and thousands", () => {
    const before = plan({ features: [{ feature: "categorize", monthly_limit: null }] });
    const after = plan({ features: [{ feature: "categorize", monthly_limit: 2500 }] });
    expect(summary("set_plan_limit", { before, after, users: 3 })).toBe("categorize limit no limit → 2,500");
    expect(summary("set_plan_limit", { before: after, after: before, users: 3 })).toBe("categorize limit 2,500 → no limit");
  });

  it("set_plan_limit: no change", () => {
    expect(summary("set_plan_limit", { before: plan(), after: plan(), users: 3 })).toBe("No change");
  });

  it("set_plan_feature: added with its limit, or removed", () => {
    const without = plan({ features: [{ feature: "categorize", monthly_limit: 250 }] });
    expect(summary("set_plan_feature", { before: without, after: plan(), users: 3 })).toBe("recipe_import added, limit 40");
    expect(summary("set_plan_feature", { before: plan(), after: without, users: 3 })).toBe("recipe_import removed");
    const withNone = plan({ features: [{ feature: "categorize", monthly_limit: 250 }, { feature: "recipe_tags", monthly_limit: null }] });
    expect(summary("set_plan_feature", { before: without, after: withNone, users: 3 })).toBe("recipe_tags added, limit no limit");
  });

  it("create_plan: the name and how many features", () => {
    expect(summary("create_plan", { before: null, after: plan({ name: "Pro" }), users: 0 })).toBe("“Pro” · 2 features");
    expect(summary("create_plan", { before: null, after: plan({ name: "Pro", features: [] }), users: 0 })).toBe("“Pro” · no features");
    expect(
      summary("create_plan", { before: null, after: plan({ features: [{ feature: "categorize", monthly_limit: 1 }] }), users: 0 }),
    ).toBe("“Plus” · 1 feature");
  });

  it("rename_plan: old name → new name", () => {
    expect(summary("rename_plan", { before: plan(), after: plan({ name: "Plus+" }), users: 3 })).toBe("“Plus” → “Plus+”");
  });

  it("set_default_plan: the previous default → the new one", () => {
    expect(summary("set_default_plan", { before: plan(), after: plan({ is_default: true }), users: 9, previous_default: "base" })).toBe(
      "base → plus",
    );
    expect(summary("set_default_plan", { before: plan(), after: plan(), users: 9, previous_default: null })).toBe("none → plus");
  });

  it("delete_plan: the name and its users", () => {
    expect(summary("delete_plan", { before: plan({ name: "Old", users: 0 }), after: null, users: 0 })).toBe("“Old” · 0 users");
    expect(summary("delete_plan", { before: plan(), after: null, users: 1 })).toBe("“Plus” · 1 user");
  });

  it("delete_user: the email and what happened to their households", () => {
    expect(
      summary("delete_user", {
        email: "ann@example.com",
        display_name: "Ann",
        households: [
          { id: "h1", name: "Home", outcome: "promoted", promoted_user_id: "u2" },
          { id: "h2", name: "Personal", outcome: "deleted" },
          { id: "h3", name: "Cabin", outcome: "deleted" },
        ],
      }),
    ).toBe("ann@example.com · 3 households: 1 promoted, 2 deleted");
    expect(summary("delete_user", { email: null, households: [] })).toBe("No households");
  });

  it("delete_account: households only (no email is kept)", () => {
    expect(summary("delete_account", { households: [{ id: "h1", outcome: "left" }] })).toBe("1 household: 1 left");
    expect(summary("delete_account", {})).toBe("No households");
  });

  it("an unknown action: compact JSON, cut to 80 characters, empty for none", () => {
    expect(summary("grant_admin", { user: "ann" })).toBe('{"user":"ann"}');
    expect(summary("grant_admin", {})).toBe("");
    const long = summary("grant_admin", { text: "x".repeat(200) });
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("survives malformed details", () => {
    expect(summary("set_user_plan", null)).toBe("default → default");
    expect(summary("set_plan_limit", { before: "x", after: [1] })).toBe("No change");
    expect(summary("rename_plan", {})).toBe("“?” → “?”");
    expect(summary("delete_plan", { before: null })).toBe("“?” · 0 users");
  });
});

describe("actionTarget", () => {
  const empty = { target_user_id: null, target_user_email: null, target_plan_id: null, target_household_id: null };

  it("prefers the user's email, linking to their page", () => {
    expect(actionTarget({ ...empty, target_user_id: "u1", target_user_email: "ann@example.com", target_plan_id: "plus" })).toEqual({
      kind: "user",
      label: "ann@example.com",
      href: "/users/u1",
    });
  });

  it("then the plan id, then the household id", () => {
    expect(actionTarget({ ...empty, target_plan_id: "plus", target_household_id: "h1" })).toEqual({ kind: "plan", label: "plus" });
    expect(actionTarget({ ...empty, target_household_id: "h1" })).toEqual({ kind: "household", label: "h1" });
  });

  it("a deleted user with no plan: their id, unlinked", () => {
    expect(actionTarget({ ...empty, target_user_id: "u1" })).toEqual({ kind: "user_id", label: "u1" });
  });

  it("nothing at all", () => {
    expect(actionTarget(empty)).toEqual({ kind: "none", label: "—" });
  });
});

describe("view_ai_call", () => {
  const id = "0b9d6f4e-2c1a-4e8b-9f3d-5a7c1e2b3d4f";

  it("is labelled and filterable", () => {
    expect(actionLabel("view_ai_call")).toBe("Viewed an AI call");
    expect(actionOptions("").map((o) => o.value)).toContain("view_ai_call");
    expect(activityHref("view_ai_call", 1)).toBe("/activity?action=view_ai_call");
  });

  it("sums up the call's task and flag", () => {
    expect(summary("view_ai_call", { ai_call_id: id, task: "recipePhotoDescription", flag: "not_food" })).toBe(
      "AI photo: description · Not food",
    );
    expect(summary("view_ai_call", { ai_call_id: id, task: "extractRecipe", flag: null })).toBe("Recipe import");
    expect(summary("view_ai_call", { ai_call_id: id, task: "someNewTask" })).toBe("someNewTask");
    expect(summary("view_ai_call", {})).toBe("AI call");
  });

  it("links to the call", () => {
    expect(actionHref({ action: "view_ai_call", details: { ai_call_id: id } })).toBe(`/ai-calls/${id}`);
  });

  it("links nowhere without a call id, or for other actions", () => {
    expect(actionHref({ action: "view_ai_call", details: {} })).toBeNull();
    expect(actionHref({ action: "view_ai_call", details: { ai_call_id: "" } })).toBeNull();
    expect(actionHref({ action: "view_ai_call", details: { ai_call_id: 42 } })).toBeNull();
    expect(actionHref({ action: "view_ai_call", details: null as unknown as Record<string, unknown> })).toBeNull();
    expect(actionHref({ action: "set_user_plan", details: { ai_call_id: id } })).toBeNull();
  });
});

describe("actionWho", () => {
  it("the admin's email, Dashboard for postgres, The user for the app's deletion, else raw", () => {
    expect(actionWho({ action: "set_user_plan", performed_by: "u1", performed_by_email: "me@example.com" })).toBe("me@example.com");
    expect(actionWho({ action: "delete_user", performed_by: "postgres", performed_by_email: null })).toBe("Dashboard");
    expect(actionWho({ action: "delete_account", performed_by: "authenticator", performed_by_email: null })).toBe("The user");
    expect(actionWho({ action: "set_plan_limit", performed_by: "gone-id", performed_by_email: null })).toBe("gone-id");
  });
});
