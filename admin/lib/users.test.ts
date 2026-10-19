import { describe, expect, it } from "vitest";

import type { AdminFeatureUsage } from "./types";
import {
  avatarInitial,
  historyPlan,
  isUuid,
  pageRange,
  parsePage,
  parseQuery,
  planBadge,
  planName,
  usageNoun,
  usageRow,
  usersHref,
  whoWording,
} from "./users";

const RESETS = "2026-11-01T00:00:00+00:00";

function usage(over: Partial<AdminFeatureUsage> = {}): AdminFeatureUsage {
  return { feature: "recipe_import", in_plan: true, used: 23, limit: 40, resets_at: RESETS, ...over };
}

describe("usageRow", () => {
  it("words a limit with the reset date and a bar", () => {
    expect(usageRow(usage(), false)).toEqual({
      feature: "recipe_import",
      label: "Recipe import",
      text: "23 / 40 imports · resets Nov 1",
      inPlan: true,
      fraction: 23 / 40,
      atLimit: false,
    });
  });

  it("words no limit without a bar", () => {
    expect(usageRow(usage({ feature: "categorize", used: 12, limit: null }), false)).toEqual({
      feature: "categorize",
      label: "Categorize",
      text: "12 names · no limit",
      inPlan: true,
      fraction: null,
      atLimit: false,
    });
  });

  it("greys a feature that's not in the plan, whatever its usage", () => {
    expect(usageRow(usage({ in_plan: false, used: 5, limit: null }), true)).toEqual({
      feature: "recipe_import",
      label: "Recipe import",
      text: "Not in plan",
      inPlan: false,
      fraction: null,
      atLimit: false,
    });
  });

  it("says when the first month has doubled the limit", () => {
    expect(usageRow(usage({ used: 3, limit: 80 }), true).text).toBe("3 / 80 imports (2× first month) · resets Nov 1");
  });

  it("doesn't mention the first month without a limit", () => {
    expect(usageRow(usage({ used: 3, limit: null }), true).text).toBe("3 imports · no limit");
  });

  it("fills the bar and flags it at and past the limit", () => {
    const at = usageRow(usage({ used: 40, limit: 40 }), false);
    expect(at.fraction).toBe(1);
    expect(at.atLimit).toBe(true);
    const past = usageRow(usage({ used: 50, limit: 40 }), false);
    expect(past.fraction).toBe(1);
    expect(past.atLimit).toBe(true);
    expect(past.text).toBe("50 / 40 imports · resets Nov 1");
  });

  it("treats a zero limit as full", () => {
    const row = usageRow(usage({ used: 0, limit: 0 }), false);
    expect(row.fraction).toBe(1);
    expect(row.atLimit).toBe(true);
    expect(row.text).toBe("0 / 0 imports · resets Nov 1");
  });

  it("uses each feature's noun, singular for a limit of one", () => {
    expect(usageRow(usage({ feature: "recipe_photo_ai", used: 0, limit: 1 }), false).text).toBe(
      "0 / 1 photo · resets Nov 1",
    );
    expect(usageRow(usage({ feature: "step_ingredients", used: 1, limit: null }), false).text).toBe(
      "1 match · no limit",
    );
  });

  it("groups thousands", () => {
    expect(usageRow(usage({ feature: "categorize", used: 1234, limit: 2500 }), false).text).toBe(
      "1,234 / 2,500 names · resets Nov 1",
    );
  });

  it("reads the reset date in UTC", () => {
    expect(usageRow(usage({ resets_at: "2027-01-01T00:00:00Z" }), false).text).toBe("23 / 40 imports · resets Jan 1");
  });

  it("shows an unknown feature by its key, counting calls", () => {
    const row = usageRow(usage({ feature: "future_thing", used: 2, limit: 5 }), false);
    expect(row.label).toBe("future_thing");
    expect(row.text).toBe("2 / 5 calls · resets Nov 1");
  });
});

describe("usageNoun", () => {
  it("has a singular and a plural for every feature", () => {
    expect([1, 2].map((n) => usageNoun("categorize", n))).toEqual(["name", "names"]);
    expect([1, 2].map((n) => usageNoun("recipe_import", n))).toEqual(["import", "imports"]);
    expect([1, 2].map((n) => usageNoun("recipe_import_photo", n))).toEqual(["photo import", "photo imports"]);
    expect([1, 2].map((n) => usageNoun("recipe_tags", n))).toEqual(["suggestion", "suggestions"]);
    expect([1, 2].map((n) => usageNoun("step_ingredients", n))).toEqual(["match", "matches"]);
    expect([1, 2].map((n) => usageNoun("recipe_photo_ai", n))).toEqual(["photo", "photos"]);
    expect(usageNoun("categorize", 0)).toBe("names");
  });
});

describe("whoWording", () => {
  it("is the admin's email when there is one", () => {
    expect(whoWording({ performed_by: "de300000-0000-4000-8000-000000000001", performed_by_email: "a@example.com" })).toBe(
      "a@example.com",
    );
  });

  it("is Dashboard for postgres", () => {
    expect(whoWording({ performed_by: "postgres", performed_by_email: null })).toBe("Dashboard");
  });

  it("is the raw id for a deleted admin or another role", () => {
    expect(whoWording({ performed_by: "de300000-0000-4000-8000-000000000009", performed_by_email: null })).toBe(
      "de300000-0000-4000-8000-000000000009",
    );
    expect(whoWording({ performed_by: "authenticator", performed_by_email: null })).toBe("authenticator");
  });

  it("ignores a blank email", () => {
    expect(whoWording({ performed_by: "postgres", performed_by_email: "" })).toBe("Dashboard");
  });
});

describe("plan names", () => {
  const names = new Map([
    ["plus", "Plus"],
    ["basic", "Basic"],
  ]);

  it("names a plan from the list, else by its id", () => {
    expect(planName("plus", names)).toBe("Plus");
    expect(planName("gone", names)).toBe("gone");
    expect(planName(null, names)).toBe("No plan");
  });

  it("marks the default on the badge only when unassigned", () => {
    expect(planBadge("Plus", true)).toBe("Plus");
    expect(planBadge("Plus", false)).toBe("Plus · default");
  });

  it("names the default in plan history", () => {
    expect(historyPlan(null, names, "Plus")).toBe("Default (Plus)");
    expect(historyPlan(null, names, null)).toBe("Default");
    expect(historyPlan("basic", names, "Plus")).toBe("Basic");
  });
});

describe("avatarInitial", () => {
  it("takes the name's first letter, else the email's", () => {
    expect(avatarInitial("ann lee", "z@example.com")).toBe("A");
    expect(avatarInitial(null, "zoe@example.com")).toBe("Z");
    expect(avatarInitial("  ", "zoe@example.com")).toBe("Z");
    expect(avatarInitial(null, null)).toBe("?");
  });

  it("keeps a letter outside the BMP whole", () => {
    expect(avatarInitial("𝒜lex", null)).toBe("𝒜");
    expect(avatarInitial("élise", null)).toBe("É");
  });
});

describe("search and paging", () => {
  it("parses ?page=, falling back to 1", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage(["2", "5"])).toBe(2);
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-2")).toBe(1);
    expect(parsePage("2.5")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("99999999999999999999")).toBe(1);
  });

  it("trims ?q=", () => {
    expect(parseQuery("  ann ")).toBe("ann");
    expect(parseQuery(["bob", "x"])).toBe("bob");
    expect(parseQuery(undefined)).toBe("");
  });

  it("builds the list's URL", () => {
    expect(usersHref("", 1)).toBe("/users");
    expect(usersHref("  ", 3)).toBe("/users?page=3");
    expect(usersHref(" ann ", 1)).toBe("/users?q=ann");
    expect(usersHref("a&b", 2)).toBe("/users?q=a%26b&page=2");
  });

  it("words the page's range", () => {
    expect(pageRange(1, 123)).toBe("1–50 of 123");
    expect(pageRange(3, 123)).toBe("101–123 of 123");
    expect(pageRange(1, 7)).toBe("1–7 of 7");
    expect(pageRange(1, 0)).toBe("");
    expect(pageRange(4, 123)).toBe("0 of 123");
  });

  it("recognizes a pasted user id", () => {
    expect(isUuid("de300000-0000-4000-8000-000000000001")).toBe(true);
    expect(isUuid("DE300000-0000-4000-8000-00000000000A")).toBe(true);
    expect(isUuid("de300000-0000-4000-8000-00000000001")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(" de300000-0000-4000-8000-000000000001")).toBe(false);
  });
});
