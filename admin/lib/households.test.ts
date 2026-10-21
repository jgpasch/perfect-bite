import { describe, expect, it } from "vitest";

import { firstMonthBadge, householdHref, householdsHref, membersCount, planSinceLine, roleLabel } from "./households";

describe("householdsHref", () => {
  it("keeps the search and page in the URL", () => {
    expect(householdsHref("", 1)).toBe("/households");
    expect(householdsHref("  ", 3)).toBe("/households?page=3");
    expect(householdsHref(" lee ", 1)).toBe("/households?q=lee");
    expect(householdsHref("a&b", 2)).toBe("/households?q=a%26b&page=2");
  });
});

describe("householdHref", () => {
  it("is the household's page", () => {
    expect(householdHref("d1000000-0000-0000-0000-000000000001")).toBe("/households/d1000000-0000-0000-0000-000000000001");
  });
});

describe("membersCount", () => {
  it("counts members, singular for one", () => {
    expect(membersCount(1)).toBe("1 member");
    expect(membersCount(3)).toBe("3 members");
    expect(membersCount(1200)).toBe("1,200 members");
  });

  it("says No members for none", () => {
    expect(membersCount(0)).toBe("No members");
  });
});

describe("roleLabel", () => {
  it("capitalises the role", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("member")).toBe("Member");
  });
});

describe("firstMonthBadge", () => {
  it("says until when limits are doubled", () => {
    expect(firstMonthBadge({ doubled: true, ends_at: "2026-11-20T12:00:00Z" })).toBe("First month · 2× limits until Nov 20, 2026");
  });

  it("is null after the first month, or with no end", () => {
    expect(firstMonthBadge({ doubled: false, ends_at: "2026-09-01T12:00:00Z" })).toBeNull();
    expect(firstMonthBadge({ doubled: true, ends_at: null })).toBeNull();
  });
});

describe("planSinceLine", () => {
  it("says since when the household has had its plan", () => {
    expect(planSinceLine({ id: "founding", name: "Founding", assigned_at: "2026-10-02T12:00:00Z" })).toBe("Since Oct 2, 2026");
  });

  it("says a household with no plan has no features", () => {
    expect(planSinceLine(null)).toBe("No plan, so no features. Choose one.");
  });
});
