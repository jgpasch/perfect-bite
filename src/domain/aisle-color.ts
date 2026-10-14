// Pantry redesign: each aisle has a hue so you can find your place in a long list at a glance.
// The hue picks a `dot` and `soft` pair from the theme's `aisles` tokens (DESIGN.md, aisle colours).

import { i18n } from '@/i18n';
import type { CategorySlug } from '@/shared/seed/categories';

export type AisleHue = 'green' | 'teal' | 'blue' | 'plum' | 'rose' | 'orange' | 'amber' | 'grey';

/** The hues a list can take, in the order the Colour menu shows them. The server's `lists.color` check allows exactly these. */
export type ListHue = Extract<AisleHue, 'green' | 'blue' | 'rose' | 'amber' | 'grey'>;
export const LIST_HUES: readonly ListHue[] = ['green', 'blue', 'rose', 'amber', 'grey'];

/**
 * A list's stored colour as a hue, or null for Default (spec 4.1). Anything else, e.g. a hue a newer
 * app version added, reads as Default.
 */
export function listHue(color: string | null | undefined): ListHue | null {
  return color != null && (LIST_HUES as readonly string[]).includes(color) ? (color as ListHue) : null;
}

/** A list colour's name in the Colour menu: the hue's name, or "Default" for none. */
export function listColorName(hue: ListHue | null): string {
  return i18n.t(`lists.colours.${hue ?? 'default'}`);
}

// Neighbouring aisles in the default store order mostly get different hues, so the centre-store run
// (pantry, canned, pasta, spices) doesn't read as one long block of amber.
const HUES: Record<CategorySlug, AisleHue> = {
  produce: 'green',
  bakery: 'amber',
  // Not named in the redesign brief; deli counters are meat and cheese, so it sits with meat.
  deli: 'rose',
  'meat-seafood': 'rose',
  'dairy-eggs': 'blue',
  frozen: 'teal',
  pantry: 'amber',
  'canned-jarred': 'orange',
  'pasta-grains': 'amber',
  baking: 'amber',
  spices: 'orange',
  condiments: 'orange',
  snacks: 'plum',
  beverages: 'plum',
  breakfast: 'amber',
  household: 'teal',
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

/** A household's colour (an invite's avatar), from its id; there is no column for it. */
export function householdColor(householdId: string): AisleHue {
  return idHue(householdId);
}

