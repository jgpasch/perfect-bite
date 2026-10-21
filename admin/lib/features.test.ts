import { describe, expect, it } from "vitest";

import {
  FEATURE_KEYS,
  FEATURES,
  featureColors,
  featureLabel,
  isFeature,
  isUsageFeature,
  USAGE_FEATURE_KEYS,
  USAGE_FEATURES,
} from "./features";

describe("FEATURES", () => {
  it("lists the two plan features in the server's fixed order", () => {
    expect(FEATURE_KEYS).toEqual(["recipe_import", "recipe_photo_ai"]);
  });

  it("counts both in calls", () => {
    expect(FEATURE_KEYS.map((f) => FEATURES[f].unit)).toEqual(["calls", "calls"]);
  });
});

describe("USAGE_FEATURES", () => {
  it("lists AI usage's keys in its order: the plan features, then categorize, step matching and tags", () => {
    expect(USAGE_FEATURE_KEYS).toEqual(["recipe_import", "recipe_photo_ai", "categorize", "step_match", "recipe_tags"]);
  });

  it("counts categorize in names and the rest in calls", () => {
    expect(USAGE_FEATURES.categorize.unit).toBe("names");
    expect(USAGE_FEATURE_KEYS.filter((f) => USAGE_FEATURES[f].unit === "calls")).toEqual([
      "recipe_import",
      "recipe_photo_ai",
      "step_match",
      "recipe_tags",
    ]);
  });

  it("gives each feature its own aisle colour", () => {
    const hues = USAGE_FEATURE_KEYS.map((f) => USAGE_FEATURES[f].hue);
    expect(new Set(hues).size).toBe(USAGE_FEATURE_KEYS.length);
    expect(hues).not.toContain("grey");
    expect(USAGE_FEATURES.recipe_photo_ai.hue).toBe("plum");
  });

  it("labels each feature once", () => {
    const labels = USAGE_FEATURE_KEYS.map((f) => USAGE_FEATURES[f].label);
    expect(new Set(labels).size).toBe(USAGE_FEATURE_KEYS.length);
    expect(labels.every((l) => l.trim() !== "")).toBe(true);
  });
});

describe("isFeature", () => {
  it("knows the two plan features and nothing else", () => {
    expect(isFeature("recipe_import")).toBe(true);
    expect(isFeature("recipe_photo_ai")).toBe(true);
    expect(isFeature("categorize")).toBe(false);
    expect(isFeature("recipe_import_photo")).toBe(false);
    expect(isFeature("")).toBe(false);
    expect(isFeature("toString")).toBe(false);
    expect(isFeature("__proto__")).toBe(false);
  });
});

describe("isUsageFeature", () => {
  it("knows the five usage keys and not the old feature keys", () => {
    expect(isUsageFeature("categorize")).toBe(true);
    expect(isUsageFeature("step_match")).toBe(true);
    expect(isUsageFeature("recipe_tags")).toBe(true);
    expect(isUsageFeature("step_ingredients")).toBe(false);
    expect(isUsageFeature("recipe_import_photo")).toBe(false);
    expect(isUsageFeature("toString")).toBe(false);
  });
});

describe("featureLabel", () => {
  it("reads a known key's label", () => {
    expect(featureLabel("categorize")).toBe("Categorize");
    expect(featureLabel("step_match")).toBe("Step matching");
    expect(featureLabel("recipe_import")).toBe("Recipe import");
  });

  it("falls back to the raw key for an unknown one", () => {
    expect(featureLabel("meal_planner")).toBe("meal_planner");
    expect(featureLabel("recipe_import_photo")).toBe("recipe_import_photo");
  });
});

describe("featureColors", () => {
  it("points at the hue's variables in tokens.css", () => {
    expect(featureColors("recipe_photo_ai")).toEqual({
      color: "var(--aisle-plum)",
      soft: "var(--aisle-plum-soft)",
      strong: "var(--aisle-plum-strong)",
    });
    expect(featureColors("categorize").color).toBe("var(--aisle-green)");
  });

  it("is grey for an unknown key", () => {
    expect(featureColors("meal_planner")).toEqual({
      color: "var(--aisle-grey)",
      soft: "var(--aisle-grey-soft)",
      strong: "var(--aisle-grey-strong)",
    });
  });
});
