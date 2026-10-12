// Pantry redesign: each aisle has a hue so you can find your place in a long list at a glance.
// The hue picks a `dot` and `soft` pair from the theme's `aisles` tokens (DESIGN.md, aisle colours).

import type { CategorySlug } from '@/shared/seed/categories';

export type AisleHue = 'green' | 'blue' | 'rose' | 'amber' | 'grey';

/** Every aisle hue, in the order pickers show them. The server's `lists.color` check allows exactly these. */
export const AISLE_HUES: readonly AisleHue[] = ['green', 'blue', 'rose', 'amber', 'grey'];

/**
 * A list's stored colour as a hue, or null for Default (spec 4.1). Anything else, e.g. a hue a newer
 * app version added, reads as Default.
 */
export function listHue(color: string | null | undefined): AisleHue | null {
  return color != null && (AISLE_HUES as readonly string[]).includes(color) ? (color as AisleHue) : null;
}

const HUE_NAMES: Record<AisleHue, string> = { green: 'Green', blue: 'Blue', rose: 'Rose', amber: 'Amber', grey: 'Grey' };

/** A list colour's name in the Colour menu: the hue's name, or "Default" for none. */
export function listColorName(hue: AisleHue | null): string {
  return hue === null ? 'Default' : HUE_NAMES[hue];
}

const HUES: Record<CategorySlug, AisleHue> = {
  produce: 'green',
  bakery: 'amber',
  // Not named in the redesign brief; deli counters are meat and cheese, so it sits with meat.
  deli: 'rose',
  'meat-seafood': 'rose',
  'dairy-eggs': 'blue',
  frozen: 'blue',
  pantry: 'amber',
  'canned-jarred': 'amber',
  'pasta-grains': 'amber',
  baking: 'amber',
  spices: 'amber',
  condiments: 'amber',
  snacks: 'amber',
  beverages: 'blue',
  breakfast: 'amber',
  household: 'green',
  'personal-care': 'blue',
  baby: 'blue',
  pet: 'green',
  other: 'grey',
};

/** The hue for a category slug. Unknown slugs (user-made aisles) and `other` are grey. */
export function aisleColor(slug: string | null | undefined): AisleHue {
  if (slug == null || !Object.hasOwn(HUES, slug)) return 'grey';
  return HUES[slug as CategorySlug];
}

/** The hues a recipe's icon tile or a household can take: the aisle hues without grey. */
const ID_HUES: readonly AisleHue[] = ['green', 'blue', 'rose', 'amber'];

/** A stable hash of an id over `ID_HUES`, the same on every launch and device. */
function idHue(id: string): AisleHue {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ID_HUES[Math.abs(hash) % ID_HUES.length];
}

/** A recipe's tint: a stable hash of its id over the aisle hues, so a recipe keeps its colour everywhere. */
export function recipeHue(recipeId: string): AisleHue {
  return idHue(recipeId);
}

/** A household's colour (its section bar on the Lists home), from its id; there is no column for it. */
export function householdColor(householdId: string): AisleHue {
  return idHue(householdId);
}

/** An aisle's short name for tight spots, e.g. the autocomplete panel: "Meat & seafood" → "Meat". */
export function shortAisleName(name: string): string {
  const short = name.split(/\s*(?:&|,|\band\b)\s*/)[0].trim();
  return short || name.trim();
}
