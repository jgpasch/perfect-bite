import { describe, expect, it } from "vitest";

import {
  affectsLine,
  cellSave,
  cellWording,
  copyId,
  copyName,
  defaultLimit,
  deleteBlockedReason,
  householdsCount,
  isPlanIdValid,
  makeDefaultLine,
  parseLimit,
  serverMessage,
} from "./plans";
import type { AdminPlan } from "./types";

const free: AdminPlan = {
  id: "free",
  name: "Free",
  is_default: false,
  households: 1,
  features: [{ feature: "recipe_photo_ai", monthly_limit: 0 }],
};
const founding: AdminPlan = {
  id: "founding",
  name: "Founding",
  is_default: true,
  households: 7,
  features: [{ feature: "recipe_import", monthly_limit: 1500 }],
};
const unlimited: AdminPlan = {
  id: "unlimited",
  name: "Unlimited",
  is_default: true,
  households: 2,
  features: [
    { feature: "recipe_import", monthly_limit: 40 },
    { feature: "recipe_photo_ai", monthly_limit: null },
  ],
};

describe("cellWording", () => {
  it("is a dash for a feature not in the plan", () => {
    expect(cellWording({ ...free, features: [] }, "recipe_photo_ai")).toBe("—");
    expect(cellWording(free, "recipe_import")).toBe("—");
  });

  it("is the limit, with thousands separators", () => {
    expect(cellWording(unlimited, "recipe_import")).toBe("40");
    expect(cellWording(founding, "recipe_import")).toBe("1,500");
  });

  it("is 0 for a zero limit, not a dash", () => {
    expect(cellWording(free, "recipe_photo_ai")).toBe("0");
  });

  it("is No limit for a null limit", () => {
    expect(cellWording(unlimited, "recipe_photo_ai")).toBe("No limit");
  });
});

describe("affectsLine", () => {
  it("counts the plan's households", () => {
    expect(affectsLine(7)).toBe(
      "Affects 7 households. AI requests use it right away; the app shows or hides the feature the next time it's opened.",
    );
  });

  it("says 1 household, and 0 households", () => {
    expect(affectsLine(1)).toBe(
      "Affects 1 household. AI requests use it right away; the app shows or hides the feature the next time it's opened.",
    );
    expect(affectsLine(0)).toMatch(/^Affects 0 households\. /);
  });

  it("separates thousands", () => {
    expect(affectsLine(12345)).toMatch(/^Affects 12,345 households\. /);
  });
});

describe("householdsCount", () => {
  it("is singular for one", () => {
    expect(householdsCount(1)).toBe("1 household");
    expect(householdsCount(2)).toBe("2 households");
    expect(householdsCount(0)).toBe("0 households");
  });
});

describe("makeDefaultLine", () => {
  it("says only new households start on it", () => {
    expect(makeDefaultLine("Founding")).toBe("New households will start on Founding. Existing households keep their plan.");
  });
});

describe("defaultLimit", () => {
  it("is the default plan's limit for the feature", () => {
    expect(defaultLimit([free, { ...unlimited, is_default: false }, founding], "recipe_import")).toBe(1500);
  });

  it("is null when the default has the feature with no limit", () => {
    expect(defaultLimit([free, unlimited], "recipe_photo_ai")).toBeNull();
  });

  it("is null when the default doesn't have the feature", () => {
    expect(defaultLimit([free, founding], "recipe_photo_ai")).toBeNull();
  });

  it("is null with no default plan", () => {
    expect(defaultLimit([free], "recipe_photo_ai")).toBeNull();
  });
});

describe("parseLimit", () => {
  it("reads whole numbers, with commas and spaces", () => {
    expect(parseLimit("40")).toBe(40);
    expect(parseLimit(" 1,500 ")).toBe(1500);
    expect(parseLimit("0")).toBe(0);
  });

  it("refuses blanks, negatives, fractions and words", () => {
    expect(parseLimit("")).toBeNull();
    expect(parseLimit("-1")).toBeNull();
    expect(parseLimit("2.5")).toBeNull();
    expect(parseLimit("ten")).toBeNull();
  });

  it("refuses numbers past a Postgres integer", () => {
    expect(parseLimit("2147483647")).toBe(2147483647);
    expect(parseLimit("2147483648")).toBeNull();
  });
});

describe("cellSave", () => {
  it("is nothing when nothing changed", () => {
    expect(cellSave({ enabled: true, limit: 40 }, { enabled: true, limit: 40 })).toBeNull();
    expect(cellSave({ enabled: false, limit: null }, { enabled: false, limit: null })).toBeNull();
  });

  it("turns a feature on with its limit", () => {
    expect(cellSave({ enabled: false, limit: null }, { enabled: true, limit: 40 })).toEqual({
      kind: "feature",
      enabled: true,
      limit: 40,
    });
    expect(cellSave({ enabled: false, limit: null }, { enabled: true, limit: null })).toEqual({
      kind: "feature",
      enabled: true,
      limit: null,
    });
  });

  it("turns a feature off, ignoring the limit", () => {
    expect(cellSave({ enabled: true, limit: 40 }, { enabled: false, limit: 60 })).toEqual({
      kind: "feature",
      enabled: false,
      limit: null,
    });
  });

  it("changes only the limit of a feature the plan keeps", () => {
    expect(cellSave({ enabled: true, limit: 40 }, { enabled: true, limit: 60 })).toEqual({ kind: "limit", limit: 60 });
    expect(cellSave({ enabled: true, limit: 40 }, { enabled: true, limit: null })).toEqual({ kind: "limit", limit: null });
    expect(cellSave({ enabled: true, limit: null }, { enabled: true, limit: 0 })).toEqual({ kind: "limit", limit: 0 });
  });
});

describe("deleteBlockedReason", () => {
  it("refuses the default plan, even with no households", () => {
    expect(deleteBlockedReason({ is_default: true, households: 0 })).toBe(
      "The default plan can't be deleted. Make another plan the default first.",
    );
  });

  it("refuses a plan with households", () => {
    expect(deleteBlockedReason({ is_default: false, households: 1 })).toBe("1 household is on this plan. Move them first.");
    expect(deleteBlockedReason({ is_default: false, households: 3 })).toBe("3 households are on this plan. Move them first.");
  });

  it("allows an unused plan that isn't the default", () => {
    expect(deleteBlockedReason({ is_default: false, households: 0 })).toBeNull();
  });
});

describe("plan ids", () => {
  it("follows the server's rule", () => {
    expect(isPlanIdValid("founding_copy")).toBe(true);
    expect(isPlanIdValid("p2")).toBe(true);
    expect(isPlanIdValid("p")).toBe(false);
    expect(isPlanIdValid("2founding")).toBe(false);
    expect(isPlanIdValid("Founding")).toBe(false);
    expect(isPlanIdValid("founding-copy")).toBe(false);
    expect(isPlanIdValid("a".repeat(31))).toBe(true);
    expect(isPlanIdValid("a".repeat(32))).toBe(false);
  });

  it("prefills Duplicate with <id>_copy and <name> copy", () => {
    expect(copyId("founding")).toBe("founding_copy");
    expect(copyName("Founding")).toBe("Founding copy");
  });

  it("cuts a long id so the copy still fits", () => {
    const copy = copyId("a".repeat(31));
    expect(copy).toBe(`${"a".repeat(26)}_copy`);
    expect(isPlanIdValid(copy)).toBe(true);
  });
});

describe("serverMessage", () => {
  it("makes the server's message a sentence", () => {
    expect(serverMessage("plan required")).toBe("Plan required.");
    expect(serverMessage("plan in use")).toBe("Plan in use.");
  });

  it("keeps a message that already ends a sentence", () => {
    expect(serverMessage("Already done.")).toBe("Already done.");
  });

  it("has a fallback for an empty message", () => {
    expect(serverMessage("  ")).toBe("Something went wrong.");
  });
});
