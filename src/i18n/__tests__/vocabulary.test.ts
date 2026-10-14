// Spec 4.15: fixed vocabularies (system aisles, recipe tags, units) shown by slug or unit key in the
// app's language, and dates through Intl. English must read exactly as before.
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { addedWhen } from '@/domain/added-by';
import { formatAmount } from '@/domain/quantity-display';
import { inviteDateLabel } from '@/features/households/pending-invites';
import { unitLabel, unitMenuSections } from '@/features/lists/amount-stepper';
import { availableFilterFacets, noRecipeFilters, recipeFilterChips } from '@/features/recipes/recipe-filters';
import { recipeTagPills } from '@/features/recipes/recipe-tags-view';
import { en } from '@/i18n/en';
import { es } from '@/i18n/es';
import { initI18n, shortDate } from '@/i18n';
import {
  aisleName,
  cuisineRegionLabel,
  systemAisleSlug,
  tagFacetLabel,
  tagLabel,
  unitName,
  withAisleNames,
} from '@/i18n/vocabulary';
import { UNITS } from '@/shared';
import {
  CUISINE_REGION_LABELS,
  emptyRecipeTags,
  RECIPE_TAG_FACETS,
  recipeTagLabel,
  type CuisineRegion,
} from '@/shared/recipe-tags';
import { SYSTEM_CATEGORIES } from '@/shared/seed/categories';
import { formatLastSync } from '@/sync/status';

jest.mock('@/global.css', () => ({}));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
// The native SDK isn't in Jest; Google sign-in isn't configured here, so it's never called.
jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: {}, statusCodes: {} }));

afterEach(() => initI18n('en'));

describe('English is the shared constants, unchanged', () => {
  it('names every system aisle as the seed does', () => {
    expect(Object.keys(en.vocab.aisles)).toEqual(SYSTEM_CATEGORIES.map((c) => c.slug));
    for (const c of SYSTEM_CATEGORIES) expect(aisleName(c)).toBe(c.name);
  });

  it('labels every facet and tag as recipe-tags.ts does', () => {
    expect(Object.keys(en.vocab.tagFacets)).toEqual(RECIPE_TAG_FACETS.map((f) => f.key));
    for (const facet of RECIPE_TAG_FACETS) {
      expect(tagFacetLabel(facet.key)).toBe(facet.label);
      expect(Object.keys(en.vocab.tags[facet.key])).toEqual(facet.values.map((v) => v.slug));
      for (const v of facet.values) expect(tagLabel(facet.key, v.slug)).toBe(v.label);
    }
    for (const [region, label] of Object.entries(CUISINE_REGION_LABELS)) {
      expect(cuisineRegionLabel(region as CuisineRegion)).toBe(label);
    }
  });

  it('shows each unit as its key, whatever the amount', () => {
    for (const unit of UNITS) {
      expect(unitName(unit)).toBe(unit);
      expect(unitName(unit, 2)).toBe(unit);
    }
    expect(formatAmount({ quantity: 2, unit: 'cup' })).toBe('2 cup');
    expect(formatAmount({ quantity: 1.5, unit: 'cup' })).toBe('1½ cup');
    expect(formatAmount({ quantity: 2, unit: 'fl oz' })).toBe('2 fl oz');
    expect(unitLabel('tbsp')).toBe('tbsp');
    expect(unitLabel(null)).toBe('Count');
  });
});

describe('Spanish', () => {
  it('has a different name for every aisle, tag and facet', () => {
    initI18n('es');
    for (const c of SYSTEM_CATEGORIES) expect(aisleName(c)).not.toBe(c.name);
    expect(new Set(Object.values(es.vocab.aisles)).size).toBe(SYSTEM_CATEGORIES.length);
    for (const facet of RECIPE_TAG_FACETS) {
      expect(tagFacetLabel(facet.key)).not.toBe(facet.label);
      for (const v of facet.values) {
        expect(tagLabel(facet.key, v.slug)).not.toBe(v.label);
        expect(tagLabel(facet.key, v.slug)).toBeTruthy();
      }
    }
  });

  it('names system aisles by slug, and leaves custom aisles as typed', () => {
    initI18n('es');
    expect(aisleName({ slug: 'produce', name: 'Produce' })).toBe('Frutas y verduras');
    expect(aisleName({ slug: 'dairy-eggs', name: 'Dairy & Eggs' })).toBe('Lácteos');
    expect(aisleName({ slug: 'other', name: 'Other' })).toBe('Otros');
    expect(aisleName({ slug: null, name: 'Costco' })).toBe('Costco');
    // A slug a newer app added: its stored name.
    expect(aisleName({ slug: 'garden', name: 'Garden' })).toBe('Garden');
    const rows = [
      { id: '1', slug: 'snacks', name: 'Snacks', position: 3 },
      { id: '2', slug: null, name: 'Mercado', position: null },
    ];
    expect(withAisleNames(rows)).toEqual([
      { id: '1', slug: 'snacks', name: 'Botanas', position: 3 },
      { id: '2', slug: null, name: 'Mercado', position: null },
    ]);
    // The rows themselves don't change.
    expect(rows[0].name).toBe('Snacks');
  });

  it('labels tags and facets, and knows nothing of unknown slugs', () => {
    initI18n('es');
    expect(tagFacetLabel('meal')).toBe('Comida');
    expect(tagLabel('meal', 'dinner')).toBe('Cena');
    expect(tagLabel('cuisine', 'middle-eastern')).toBe('De Medio Oriente');
    expect(tagLabel('protein', 'beans-lentils')).toBe('Frijoles y lentejas');
    expect(tagLabel('method', 'pressure-cooker')).toBe('Olla de presión');
    expect(tagLabel('meal', 'brunch')).toBeNull();
    expect(tagLabel('meal', 'chicken')).toBeNull();
    expect(cuisineRegionLabel('latin')).toBe('Latina');
    // The shared label (and what's stored) stays English.
    expect(recipeTagLabel('meal', 'dinner')).toBe('Dinner');
  });

  it('shows tag pills, filter groups and chips in Spanish', () => {
    initI18n('es');
    const tags = { ...emptyRecipeTags(), meal: ['dinner', 'brunch'], protein: ['chicken'] };
    expect(recipeTagPills(tags, 20).map((p) => [p.facet, p.value, p.accessibilityLabel])).toEqual([
      ['Comida', 'Cena', expect.stringContaining('Cena')],
      ['Proteína', 'Pollo', expect.stringContaining('Pollo')],
      [expect.any(String), expect.any(String), expect.any(String)],
    ]);
    const facets = availableFilterFacets([{ tags, totalMinutes: null }], noRecipeFilters());
    expect(facets.slice(0, 2)).toEqual([
      { key: 'meal', label: 'Comida', values: [{ slug: 'dinner', label: 'Cena' }] },
      { key: 'protein', label: 'Proteína', values: [{ slug: 'chicken', label: 'Pollo' }] },
    ]);
    const filters = { ...noRecipeFilters(), tags: { ...emptyRecipeTags(), cuisine: ['mexican'] } };
    expect(recipeFilterChips(filters).map((c) => c.label)).toEqual(['Mexicana']);
  });

  it('pluralizes units: one or less singular, more plural; abbreviations unchanged', () => {
    initI18n('es');
    expect(formatAmount({ quantity: 1, unit: 'cup' })).toBe('1 taza');
    expect(formatAmount({ quantity: 2, unit: 'cup' })).toBe('2 tazas');
    expect(formatAmount({ quantity: 0.5, unit: 'cup' })).toBe('½ taza');
    expect(formatAmount({ quantity: 1.5, unit: 'cup' })).toBe('1½ tazas');
    expect(formatAmount({ quantity: 1, unit: 'tbsp' })).toBe('1 cda');
    expect(formatAmount({ quantity: 3, unit: 'tbsp' })).toBe('3 cdas');
    expect(formatAmount({ quantity: 0.25, unit: 'tsp' })).toBe('¼ cdta');
    expect(formatAmount({ quantity: 2, unit: 'tsp' })).toBe('2 cdtas');
    expect(formatAmount({ quantity: 2, unit: 'clove' })).toBe('2 dientes');
    expect(formatAmount({ quantity: 1, unit: 'dozen' })).toBe('1 docena');
    expect(formatAmount({ quantity: 1000000, unit: 'can' })).toBe('1000000 latas');
    expect(formatAmount({ quantity: 2, unit: 'kg' })).toBe('2 kg');
    expect(formatAmount({ quantity: 1.5, unit: 'lb' })).toBe('1.5 lb');
    expect(formatAmount({ quantity: 3, unit: 'gal' })).toBe('3 gal');
    expect(formatAmount({ quantity: 8, unit: 'fl oz' })).toBe('8 fl oz');
    expect(formatAmount({ quantity: 3, unit: null })).toBe('3');
    expect(formatAmount({ quantity: null, unit: 'cup' })).toBe('');
    for (const unit of ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl oz', 'pt', 'qt', 'gal'] as const) {
      expect(unitName(unit, 5)).toBe(unit);
    }
  });

  it('names units in the unit menu', () => {
    initI18n('es');
    expect(unitLabel('cup')).toBe('taza');
    expect(unitLabel('bunch')).toBe('manojo');
    expect(unitLabel(null)).toBe('Piezas');
    const packages = unitMenuSections('jar', undefined).find((s) => s.title === 'Paquetes')!;
    expect(packages.items.map((i) => i.label)).toEqual([
      'lata',
      'frasco',
      'bolsa',
      'caja',
      'manojo',
      'diente',
      'pizca',
      'docena',
    ]);
  });
});

describe('systemAisleSlug', () => {
  it('matches English or Spanish names, ignoring case, accents and spaces', () => {
    expect(systemAisleSlug('Lácteos')).toBe('dairy-eggs');
    expect(systemAisleSlug('LACTEOS')).toBe('dairy-eggs');
    expect(systemAisleSlug('  dairy   &  eggs ')).toBe('dairy-eggs');
    expect(systemAisleSlug('Panaderia')).toBe('bakery');
    expect(systemAisleSlug('Bebés')).toBe('baby');
    expect(systemAisleSlug('produce')).toBe('produce');
    initI18n('es');
    expect(systemAisleSlug('Frozen')).toBe('frozen');
    expect(systemAisleSlug('congelados')).toBe('frozen');
  });

  it('is null for anything else', () => {
    expect(systemAisleSlug('Costco')).toBeNull();
    expect(systemAisleSlug('Lácteos y más')).toBeNull();
    expect(systemAisleSlug('dairy-eggs')).toBeNull();
    expect(systemAisleSlug('')).toBeNull();
  });
});

describe('dates through Intl', () => {
  const now = new Date(2026, 9, 14, 12, 0); // Wednesday, Oct 14 2026

  it('reads as before in English', () => {
    expect(addedWhen(new Date(2026, 9, 13, 9, 0), now)).toBe('yesterday');
    expect(addedWhen(new Date(2026, 9, 11, 9, 0), now)).toBe('Sunday');
    expect(addedWhen(new Date(2026, 8, 4, 9, 0), now)).toBe('Sep 4');
    expect(addedWhen(new Date(2025, 2, 4, 9, 0), now)).toBe('Mar 4, 2025');
    expect(inviteDateLabel(new Date(2026, 9, 18, 12).toISOString(), now)).toBe('Oct 18');
    expect(inviteDateLabel(new Date(2027, 0, 2, 12).toISOString(), now)).toBe('Jan 2, 2027');
    expect(shortDate(new Date(2026, 4, 1), now)).toBe('May 1');
  });

  it('is in Spanish with the app in Spanish', () => {
    initI18n('es');
    expect(addedWhen(new Date(2026, 9, 13, 9, 0), now)).toBe('ayer');
    expect(addedWhen(new Date(2026, 9, 13, 9, 0), new Date(2026, 9, 15, 12))).toBe('martes');
    expect(addedWhen(new Date(2026, 9, 11, 9, 0), now)).toBe('domingo');
    expect(addedWhen(new Date(2026, 8, 4, 9, 0), now)).toBe('4 sept');
    expect(addedWhen(new Date(2025, 2, 4, 9, 0), now)).toBe('4 mar 2025');
    expect(inviteDateLabel(new Date(2026, 9, 18, 12).toISOString(), now)).toBe('18 oct');
    expect(inviteDateLabel('nope', now)).toBeNull();
    const lastSync = formatLastSync(new Date(2026, 9, 12, 15, 5).toISOString(), now);
    expect(lastSync).toContain('12 oct');
    expect(lastSync).not.toMatch(/Oct|PM/);
  });
});
