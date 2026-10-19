import { describe, expect, it } from "vitest";

import { fullDate, mediumDate, relativeTime, shortUtcDate } from "./format";

const NOW = new Date("2026-10-18T12:00:00Z");

describe("relativeTime", () => {
  it("words the past in the largest whole unit", () => {
    expect(relativeTime("2026-10-18T11:59:30Z", NOW)).toBe("just now");
    expect(relativeTime("2026-10-18T11:55:00Z", NOW)).toBe("5 minutes ago");
    expect(relativeTime("2026-10-18T09:00:00Z", NOW)).toBe("3 hours ago");
    expect(relativeTime("2026-10-17T12:00:00Z", NOW)).toBe("yesterday");
    expect(relativeTime("2026-10-15T12:00:00Z", NOW)).toBe("3 days ago");
    expect(relativeTime("2026-10-04T12:00:00Z", NOW)).toBe("2 weeks ago");
    expect(relativeTime("2026-06-18T12:00:00Z", NOW)).toBe("4 months ago");
    expect(relativeTime("2024-10-18T12:00:00Z", NOW)).toBe("2 years ago");
  });

  it("words the future", () => {
    expect(relativeTime("2026-10-20T12:00:00Z", NOW)).toBe("in 2 days");
  });

  it("is empty for a bad date", () => {
    expect(relativeTime("nope", NOW)).toBe("");
  });
});

describe("dates", () => {
  it("reads the reset date in UTC", () => {
    expect(shortUtcDate("2026-11-01T00:00:00+00:00")).toBe("Nov 1");
    expect(shortUtcDate("2026-11-01T00:00:00+02:00")).toBe("Oct 31");
    expect(shortUtcDate("nope")).toBe("");
  });

  it("gives a full and a medium date, empty for a bad one", () => {
    expect(fullDate("2026-10-18T12:00:00Z")).toMatch(/^Oct 1[89], 2026, \d{1,2}:00\s[AP]M$/);
    expect(mediumDate("2026-10-18T12:00:00Z")).toMatch(/^Oct 1[89], 2026$/);
    expect(fullDate("nope")).toBe("");
    expect(mediumDate("nope")).toBe("");
  });
});
