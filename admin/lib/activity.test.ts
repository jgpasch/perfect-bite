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
    id: "founding",
    name: "Founding",
    is_default: false,
    households: 3,
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
      "Changed a household's plan",
      "Changed a user's plan",
      "Changed a limit",
      "Changed a feature",
      "Created a plan",
      "Renamed a plan",
      "Changed the default plan",
      "Deleted a plan",
      "Set safety limit",
      "Deleted user",
      "Deleted own account",
      "Viewed an AI call",
      "Blocked AI photos",
      "Unblocked AI photos",
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
  it("set_household_plan: plan ids, a null from as no plan", () => {
    expect(summary("set_household_plan", { from: "founding", to: "unlimited" })).toBe("founding → unlimited");
    expect(summary("set_household_plan", { from: null, to: "free" })).toBe("no plan → free");
    expect(summary("set_household_plan", { from: "free", to: "free" })).toBe("free → free");
    expect(summary("set_household_plan", {})).toBe("no plan → ?");
  });

  it("set_user_plan (older rows): plan ids, null as the default", () => {
    expect(summary("set_user_plan", { from: "founding", to: "unlimited" })).toBe("founding → unlimited");
    expect(summary("set_user_plan", { from: null, to: "free" })).toBe("default → free");
    expect(summary("set_user_plan", { from: "free", to: null })).toBe("free → default");
    expect(summary("set_user_plan", { from: "founding", to: "founding" })).toBe("founding → founding");
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
    ).toBe("“Founding” · 1 feature");
  });

  it("rename_plan: old name → new name", () => {
    expect(summary("rename_plan", { before: plan(), after: plan({ name: "Founders" }), users: 3 })).toBe("“Founding” → “Founders”");
  });

  it("set_default_plan: the previous default → the new one", () => {
    expect(summary("set_default_plan", { before: plan(), after: plan({ is_default: true }), users: 9, previous_default: "free" })).toBe(
      "free → founding",
    );
    expect(summary("set_default_plan", { before: plan(), after: plan(), users: 9, previous_default: null })).toBe("none → founding");
  });

  it("delete_plan: the name and its households", () => {
    expect(summary("delete_plan", { before: plan({ name: "Old", households: 0 }), after: null, households: 0 })).toBe(
      "“Old” · 0 households",
    );
    expect(summary("delete_plan", { before: plan(), after: null, households: 1 })).toBe("“Founding” · 1 household");
  });

  it("delete_plan from before plans were per household: its users", () => {
    expect(summary("delete_plan", { before: plan(), after: null, users: 1 })).toBe("“Founding” · 1 user");
    expect(summary("delete_plan", { before: plan(), after: null, users: 4 })).toBe("“Founding” · 4 users");
    expect(summary("delete_plan", { before: plan(), after: null })).toBe("“Founding” · 0 households");
  });

  it("set_safety_limit: the key's label and the numbers that changed, none for null", () => {
    const row = (key: string, per_minute: number | null, per_day: number | null) => ({ key, per_minute, per_day });
    expect(summary("set_safety_limit", { before: row("categorize", 60, 500), after: row("categorize", 30, 1500) })).toBe(
      "Categorize · per minute 60 → 30 · per day 500 → 1,500",
    );
    expect(summary("set_safety_limit", { before: row("recipe_import", null, 100), after: row("recipe_import", null, 200) })).toBe(
      "Recipe imports · per day 100 → 200",
    );
    expect(summary("set_safety_limit", { before: row("recipe_photo_ai", 5, 40), after: row("recipe_photo_ai", null, null) })).toBe(
      "AI photos · per minute 5 → none · per day 40 → none",
    );
    expect(summary("set_safety_limit", { before: row("step_match", 30, 100), after: row("step_match", 30, 100) })).toBe(
      "Step matching · No change",
    );
  });

  it("set_safety_limit: an unknown key raw, and odd details", () => {
    expect(summary("set_safety_limit", { before: { key: "new_key", per_minute: 1, per_day: null }, after: { key: "new_key", per_minute: 2, per_day: null } })).toBe(
      "new_key · per minute 1 → 2",
    );
    expect(summary("set_safety_limit", {})).toBe("? · No change");
    expect(summary("set_safety_limit", { before: null, after: { key: "categorize", per_minute: 10 } })).toBe(
      "Categorize · per minute none → 10",
    );
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
    expect(summary("delete_plan", { before: null })).toBe("“?” · 0 households");
  });
});

describe("actionTarget", () => {
  const empty = { target_user_id: null, target_user_email: null, target_plan_id: null, target_household_id: null };

  it("prefers the user's email, linking to their page", () => {
    expect(actionTarget({ ...empty, target_user_id: "u1", target_user_email: "ann@example.com", target_plan_id: "founding" })).toEqual({
      kind: "user",
      label: "ann@example.com",
      href: "/users/u1",
    });
  });

  it("then the household, linking to its page, even with a plan (set_household_plan)", () => {
    expect(actionTarget({ ...empty, target_plan_id: "founding", target_household_id: "h1" })).toEqual({
      kind: "household",
      label: "h1",
      href: "/households/h1",
    });
    expect(actionTarget({ ...empty, target_household_id: "h1" })).toEqual({ kind: "household", label: "h1", href: "/households/h1" });
  });

  it("then the plan id", () => {
    expect(actionTarget({ ...empty, target_plan_id: "founding" })).toEqual({ kind: "plan", label: "founding" });
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

  it("Automatic for a row nobody did by hand", () => {
    expect(actionWho({ action: "block_ai_photos", performed_by: null, performed_by_email: null })).toBe("Automatic");
    expect(actionWho({ action: "set_user_plan", performed_by: null, performed_by_email: null })).toBe("Automatic");
  });
});

describe("AI photo blocks", () => {
  // Noon UTC, so it's the 21st in any time zone the portal runs in.
  const blockedAt = "2026-10-21T12:00:00+00:00";

  it("are labelled and filterable", () => {
    expect(actionLabel("block_ai_photos")).toBe("Blocked AI photos");
    expect(actionLabel("unblock_ai_photos")).toBe("Unblocked AI photos");
    expect(actionOptions("").map((o) => o.value)).toEqual(expect.arrayContaining(["block_ai_photos", "unblock_ai_photos"]));
    expect(activityHref("unblock_ai_photos", 2)).toBe("/activity?action=unblock_ai_photos&page=2");
  });

  it("sums up a block by its refusals", () => {
    expect(summary("block_ai_photos", { refusals: 3, window_days: 30 })).toBe("3 refusals");
    expect(summary("block_ai_photos", { refusals: 1 })).toBe("1 refusal");
    expect(summary("block_ai_photos", { refusals: "3" })).toBe("");
    expect(summary("block_ai_photos", {})).toBe("");
    expect(summary("block_ai_photos", null)).toBe("");
  });

  it("sums up an unblock by the block it cleared", () => {
    expect(summary("unblock_ai_photos", { refusals: 3, blocked_at: blockedAt })).toBe("Blocked Oct 21, 2026 after 3 refusals");
    expect(summary("unblock_ai_photos", { refusals: 4 })).toBe("after 4 refusals");
    expect(summary("unblock_ai_photos", { blocked_at: blockedAt })).toBe("Blocked Oct 21, 2026");
    expect(summary("unblock_ai_photos", { blocked_at: "" })).toBe("");
    expect(summary("unblock_ai_photos", {})).toBe("");
  });

  it("link nowhere", () => {
    expect(actionHref({ action: "block_ai_photos", details: { refusals: 3 } })).toBeNull();
    expect(actionHref({ action: "unblock_ai_photos", details: { refusals: 3 } })).toBeNull();
  });
});
