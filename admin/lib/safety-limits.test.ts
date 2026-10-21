import { describe, expect, it } from "vitest";

import {
  MINUTE_UNIT,
  SAFETY_LIMIT_KEYS,
  dayUnit,
  fieldText,
  limitNumber,
  limitOrNone,
  parseSafetyLimit,
  safetyLimitHint,
  safetyLimitLabel,
  safetyLimitSave,
} from "./safety-limits";

describe("SAFETY_LIMIT_KEYS", () => {
  it("is the server's keys in its order", () => {
    expect(SAFETY_LIMIT_KEYS).toEqual([
      "categorize",
      "step_match",
      "recipe_tags",
      "recipe_import_link",
      "recipe_import_photo",
      "recipe_import",
      "recipe_photo_ai",
    ]);
  });
});

describe("labels and units", () => {
  it("labels every key, and an unknown one raw", () => {
    expect(SAFETY_LIMIT_KEYS.map(safetyLimitLabel)).toEqual([
      "Categorize",
      "Step matching",
      "Tag suggestions",
      "Link import",
      "Photo import",
      "Recipe imports",
      "AI photos",
    ]);
    expect(safetyLimitLabel("new_key")).toBe("new_key");
    expect(safetyLimitLabel("toString")).toBe("toString");
  });

  it("counts a minute in requests and a day in each key's unit", () => {
    expect(MINUTE_UNIT).toBe("requests a minute");
    expect(SAFETY_LIMIT_KEYS.map(dayUnit)).toEqual([
      "names a day",
      "matches a day",
      "suggestions a day",
      "imports a day",
      "imports a day",
      "imports a day",
      "photos a day",
    ]);
    expect(dayUnit("new_key")).toBe("requests a day");
  });

  it("explains categorize's and the shared import limit", () => {
    expect(safetyLimitHint("recipe_import")).toBe("Link and photo together");
    expect(safetyLimitHint("categorize")).toBe("Names sent to the AI");
    expect(safetyLimitHint("step_match")).toBeNull();
    expect(safetyLimitHint("new_key")).toBeNull();
  });
});

describe("limitNumber and limitOrNone", () => {
  it("shows a number with separators, blank or none for null", () => {
    expect(limitNumber(1500)).toBe("1,500");
    expect(limitNumber(0)).toBe("0");
    expect(limitNumber(null)).toBe("");
    expect(limitOrNone(1500)).toBe("1,500");
    expect(limitOrNone(0)).toBe("0");
    expect(limitOrNone(null)).toBe("none");
    expect(limitOrNone(undefined)).toBe("none");
  });
});

describe("parseSafetyLimit", () => {
  it("reads blank as no limit", () => {
    expect(parseSafetyLimit("")).toEqual({ ok: true, value: null });
    expect(parseSafetyLimit("   ")).toEqual({ ok: true, value: null });
  });

  it("reads a whole number from 0, separators allowed", () => {
    expect(parseSafetyLimit("0")).toEqual({ ok: true, value: 0 });
    expect(parseSafetyLimit(" 60 ")).toEqual({ ok: true, value: 60 });
    expect(parseSafetyLimit("1,500")).toEqual({ ok: true, value: 1500 });
  });

  it("rejects negatives, fractions, words and numbers past an integer", () => {
    for (const text of ["-1", "1.5", "1e3", "abc", "ten", "2147483648"]) {
      expect(parseSafetyLimit(text)).toEqual({ ok: false });
    }
  });

  it("fills a field with the plain number, or blank", () => {
    expect(fieldText(1500)).toBe("1500");
    expect(fieldText(null)).toBe("");
  });
});

describe("safetyLimitSave", () => {
  const before = { per_minute: 60, per_day: 500 };

  it("sends both numbers when one changes, blank as null", () => {
    expect(safetyLimitSave(before, "30", "500")).toEqual({ per_minute: 30, per_day: 500 });
    expect(safetyLimitSave(before, "60", "")).toEqual({ per_minute: 60, per_day: null });
    expect(safetyLimitSave({ per_minute: null, per_day: 100 }, "10", "100")).toEqual({ per_minute: 10, per_day: 100 });
  });

  it("is null when nothing changed", () => {
    expect(safetyLimitSave(before, "60", "500")).toBeNull();
    expect(safetyLimitSave(before, " 60", "500 ")).toBeNull();
    expect(safetyLimitSave({ per_minute: null, per_day: null }, "", "")).toBeNull();
  });

  it("is null when a field isn't a number", () => {
    expect(safetyLimitSave(before, "-5", "500")).toBeNull();
    expect(safetyLimitSave(before, "60", "2.5")).toBeNull();
  });
});
