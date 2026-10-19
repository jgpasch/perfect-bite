// The six AI features (spec 4.12), in the server's fixed order (`private.feature_keys()`), with
// how the portal shows each: its label, the unit its usage is counted in, and the one aisle colour
// it keeps everywhere (usage tiles, charts, the plan grid). A root Jest test checks these keys are
// exactly the app's `FEATURES` (src/features/plans/features.ts).

export type AisleHue = "green" | "teal" | "blue" | "plum" | "rose" | "orange" | "amber" | "grey";

export type FeatureInfo = {
  label: string;
  /** What `used` and limits count: LLM-bound names for categorize, calls for the rest. */
  unit: "names" | "calls";
  hue: AisleHue;
};

export const FEATURES = {
  categorize: { label: "Categorize", unit: "names", hue: "green" },
  recipe_import: { label: "Recipe import", unit: "calls", hue: "blue" },
  recipe_import_photo: { label: "Photo import", unit: "calls", hue: "teal" },
  recipe_tags: { label: "Tag suggestions", unit: "calls", hue: "amber" },
  step_ingredients: { label: "Step matching", unit: "calls", hue: "orange" },
  recipe_photo_ai: { label: "AI photos", unit: "calls", hue: "plum" },
} as const satisfies Record<string, FeatureInfo>;

export type Feature = keyof typeof FEATURES;

/** The feature keys in the fixed order. */
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

export function isFeature(key: string): key is Feature {
  return Object.hasOwn(FEATURES, key);
}

/** The feature's label, or the raw key for one this portal doesn't know yet. */
export function featureLabel(key: string): string {
  return isFeature(key) ? FEATURES[key].label : key;
}

/** CSS colours for the feature's aisle hue (tokens.css): `color` for bars and dots, `soft` for tints, `strong` for text on a tint. */
export function featureColors(key: string): { color: string; soft: string; strong: string } {
  const hue: AisleHue = isFeature(key) ? FEATURES[key].hue : "grey";
  return { color: `var(--aisle-${hue})`, soft: `var(--aisle-${hue}-soft)`, strong: `var(--aisle-${hue}-strong)` };
}
