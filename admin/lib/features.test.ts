import { describe, expect, it } from "vitest";

import { FEATURE_KEYS, FEATURES, featureColors, featureLabel, isFeature } from "./features";

describe("FEATURES", () => {
  it("lists the six features in the server's fixed order", () => {
    expect(FEATURE_KEYS).toEqual([
      "categorize",
      "recipe_import",
      "recipe_import_photo",
      "recipe_tags",
      "step_ingredients",
      "recipe_photo_ai",
    ]);
  });

  it("counts categorize in names and the rest in calls", () => {
    expect(FEATURES.categorize.unit).toBe("names");
    expect(FEATURE_KEYS.filter((f) => FEATURES[f].unit === "calls")).toEqual(FEATURE_KEYS.slice(1));
  });

  it("gives each feature its own aisle colour", () => {
    const hues = FEATURE_KEYS.map((f) => FEATURES[f].hue);
    expect(new Set(hues).size).toBe(FEATURE_KEYS.length);
    expect(hues).not.toContain("grey");
    expect(FEATURES.recipe_photo_ai.hue).toBe("plum");
  });

  it("labels each feature once", () => {
    const labels = FEATURE_KEYS.map((f) => FEATURES[f].label);
    expect(new Set(labels).size).toBe(FEATURE_KEYS.length);
    expect(labels.every((l) => l.trim() !== "")).toBe(true);
  });
});

describe("isFeature", () => {
  it("knows the six keys and nothing else", () => {
    expect(isFeature("recipe_tags")).toBe(true);
    expect(isFeature("recipe")).toBe(false);
    expect(isFeature("")).toBe(false);
    expect(isFeature("toString")).toBe(false);
    expect(isFeature("__proto__")).toBe(false);
  });
});

describe("featureLabel", () => {
  it("reads a known key's label", () => {
    expect(featureLabel("categorize")).toBe("Categorize");
    expect(featureLabel("recipe_import_photo")).toBe("Photo import");
  });

  it("falls back to the raw key for an unknown one", () => {
    expect(featureLabel("meal_planner")).toBe("meal_planner");
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
