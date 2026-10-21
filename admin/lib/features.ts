// The AI features (spec 4.12) and how the portal shows each: its label, the unit its usage is
// counted in, and the one aisle colour it keeps everywhere (usage tiles, charts, the plan grid).
// `FEATURES` are the two plan features, in the server's fixed order (`private.feature_keys()`); a
// root Jest test checks they're exactly the app's `FEATURES` (src/features/plans/features.ts).
// `USAGE_FEATURES` adds the AI every plan has, as AI usage reports it (`private.ai_usage_keys()`,
// named by their safety limits' keys).

export type AisleHue = "green" | "teal" | "blue" | "plum" | "rose" | "orange" | "amber" | "grey";

export type FeatureInfo = {
  label: string;
  /** What `used` and limits count: LLM-bound names for categorize, calls for the rest. */
  unit: "names" | "calls";
  hue: AisleHue;
};

export const FEATURES = {
  recipe_import: { label: "Recipe import", unit: "calls", hue: "blue" },
  recipe_photo_ai: { label: "AI photos", unit: "calls", hue: "plum" },
} as const satisfies Record<string, FeatureInfo>;

/** The AI on every plan, with no monthly limit, in AI usage's order after the plan features. */
const EVERY_PLAN = {
  categorize: { label: "Categorize", unit: "names", hue: "green" },
  step_match: { label: "Step matching", unit: "calls", hue: "orange" },
  recipe_tags: { label: "Tag suggestions", unit: "calls", hue: "amber" },
} as const satisfies Record<string, FeatureInfo>;

export const USAGE_FEATURES = { ...FEATURES, ...EVERY_PLAN } as const;

/** A plan feature: one a plan can include and limit. */
export type Feature = keyof typeof FEATURES;

/** Any AI feature AI usage reports. */
export type UsageFeature = keyof typeof USAGE_FEATURES;

/** The plan feature keys in the fixed order. */
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

/** Every AI usage key in its order: the plan features, then categorize, step matching and tags. */
export const USAGE_FEATURE_KEYS = Object.keys(USAGE_FEATURES) as UsageFeature[];

export function isFeature(key: string): key is Feature {
  return Object.hasOwn(FEATURES, key);
}

export function isUsageFeature(key: string): key is UsageFeature {
  return Object.hasOwn(USAGE_FEATURES, key);
}

/** The feature's label, or the raw key for one this portal doesn't know yet. */
export function featureLabel(key: string): string {
  return isUsageFeature(key) ? USAGE_FEATURES[key].label : key;
}

/** CSS colours for the feature's aisle hue (tokens.css): `color` for bars and dots, `soft` for tints, `strong` for text on a tint. */
export function featureColors(key: string): { color: string; soft: string; strong: string } {
  const hue: AisleHue = isUsageFeature(key) ? USAGE_FEATURES[key].hue : "grey";
  return { color: `var(--aisle-${hue})`, soft: `var(--aisle-${hue}-soft)`, strong: `var(--aisle-${hue}-strong)` };
}
