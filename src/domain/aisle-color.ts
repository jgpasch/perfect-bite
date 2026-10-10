// Pantry redesign: each aisle has a hue so you can find your place in a long list at a glance.
// The hue picks a `dot` and `soft` pair from the theme's `aisles` tokens (DESIGN.md, aisle colours).

import type { CategorySlug } from '@/shared/seed/categories';

export type AisleHue = 'green' | 'blue' | 'rose' | 'amber' | 'grey';

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
