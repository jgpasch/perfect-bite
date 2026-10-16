import { describe, expect, it } from '@jest/globals';

import { MEXICAN_WORDS, NO_LINK_EXAMPLES } from '../../../supabase/functions/_shared/ai/spanish-words';
import { englishSingular, normalizeIngredientName, singularize } from '../ingredient-normalizer';
import { UNIT_KEYS } from '../quantity-parser';
import { buildSpanishEsPlurals, lastWord, lastWordPlural, spanishPlural } from '../seed/es-plurals';
import { seedEntries } from '../seed/ingredients';
import { SEED_INGREDIENTS_ES, seedEsEntries, type SpanishSeedName } from '../seed/ingredients-es';
import { SPANISH_ES_PLURALS } from '../spanish-plurals';

const english = seedEntries();
const spanish = seedEsEntries();
const key = normalizeIngredientName;

/** Every entry as written, with where the file puts it. */
function written(): { entry: SpanishSeedName; category: string; unit: string }[] {
  return Object.entries(SEED_INGREDIENTS_ES).flatMap(([category, byUnit]) =>
    Object.entries(byUnit ?? {}).flatMap(([unit, names]) => (names ?? []).map((entry) => ({ entry, category, unit }))),
  );
}

/** English plurals of a lowercase word: `+s`, `+es` after s/x/z/ch/sh/o, `-y` → `-ies`. */
function englishPlurals(word: string): string[] {
  const out = [`${word}s`];
  if (/(s|x|z|ch|sh|o)$/.test(word)) out.push(`${word}es`);
  if (/[^aeiou]y$/.test(word)) out.push(`${word.slice(0, -1)}ies`);
  return out;
}

describe('Spanish seed', () => {
  it('has about 200 names, each with its own key, none an English seed key', () => {
    const englishKeys = new Set(english.map((e) => key(e.name)));
    const owners = new Map<string, string[]>();
    for (const { name } of spanish) {
      expect(key(name)).not.toBe('');
      owners.set(key(name), [...(owners.get(key(name)) ?? []), name]);
    }
    expect([...owners.values()].filter((o) => o.length > 1)).toEqual([]);
    expect(spanish.map((e) => e.name).filter((n) => englishKeys.has(key(n)))).toEqual([]);
    expect(spanish.length).toBeGreaterThanOrEqual(200);
  });

  it('uses supported units and no empty groups', () => {
    const unitKeys = new Set<string>(UNIT_KEYS);
    for (const byUnit of Object.values(SEED_INGREDIENTS_ES)) {
      for (const [unit, names] of Object.entries(byUnit ?? {})) {
        expect(unitKeys.has(unit)).toBe(true);
        expect(names!.length).toBeGreaterThan(0);
      }
    }
  });

  it('links only to English seed names, and files each linked name under its target', () => {
    const targets = new Map(english.map((e) => [e.name, e]));
    const misplaced = written()
      .filter((w): w is { entry: readonly [string, string]; category: string; unit: string } => typeof w.entry !== 'string')
      .map(({ entry: [name, to], category, unit }) => ({ name, to, category, unit, target: targets.get(to) }))
      .filter(({ target, category, unit }) => !target || target.category !== category || target.unit !== unit)
      .map(({ name, to, target }) => `${name} -> ${to}: ${target ? `${target.category}/${target.unit}` : 'not in the English seed'}`);
    expect(misplaced).toEqual([]);
  });

  it('gives a linked name its target category and unit, and an unlinked one its own', () => {
    const byName = new Map(spanish.map((e) => [e.name, e]));
    expect(byName.get('leche')).toEqual({ name: 'leche', category: 'dairy-eggs', unit: 'gal', sameAs: 'milk' });
    expect(byName.get('huevos')).toEqual({ name: 'huevos', category: 'dairy-eggs', unit: 'dozen', sameAs: 'eggs' });
    expect(byName.get('jitomates')).toMatchObject({ category: 'produce', sameAs: 'tomatoes' });
    // The English seed's rows already: one name is one ingredient.
    for (const name of ['cilantro', 'chorizo', 'queso fresco']) expect(byName.get(name)).toBeUndefined();
    for (const name of ['flor de jamaica', 'tomate verde', 'tomate', 'chile', 'limón', 'calabacita']) {
      expect(byName.get(name)).toMatchObject({ sameAs: null });
    }
    expect(byName.get('flor de jamaica')).toEqual({ name: 'flor de jamaica', category: 'pantry', unit: 'bag', sameAs: null });
  });

  it("leaves every no-link example unlinked, and doesn't link anything to the English seed's own Spanish words", () => {
    const linked = new Map(spanish.filter((e) => e.sameAs).map((e) => [key(e.name), e.sameAs]));
    for (const [name] of NO_LINK_EXAMPLES) expect([name, linked.get(key(name))]).toEqual([name, undefined]);
    // crema and queso fresco are English seed rows: unlinked, since nothing points at them.
    const targets = new Set(spanish.map((e) => e.sameAs));
    expect(targets.has('crema')).toBe(false);
    expect(targets.has('queso fresco')).toBe(false);
  });

  it('uses the preferred Mexican words, never the ones to avoid, and leaves the ambiguous ones unlinked', () => {
    const names = new Set(spanish.map((e) => key(e.name)));
    expect(['jitomate', 'aguacate', 'frijol', 'papa', 'elote', 'ejote', 'camote'].filter((w) => !names.has(key(w)))).toEqual([]);
    const avoided = MEXICAN_WORDS.map(([, , avoid]) => key(avoid)).filter((w) => names.has(w));
    // `tomate` is both a word to avoid for a red tomato and the unlinked Mexican name for a tomatillo.
    expect(avoided).toEqual(['tomate']);
    expect(spanish.find((e) => e.name === 'tomate')!.sameAs).toBeNull();
  });

  it('writes consonant-ending words in the singular, so their plurals can be generated', () => {
    // `limones`, `nueces`, `reyes`; and `-ches`, which the English rules cut to `-ch`. Not
    // `chipotles` (no Spanish word ends in `-tl`) or `res`.
    const plural = /([aeiou][lnrdjzy]|ch|sh|x)es$/;
    const properNouns = ['rosca de reyes'];
    expect(spanish.map((e) => e.name).filter((n) => plural.test(lastWord(n)) && !properNouns.includes(n))).toEqual([]);
    expect(['limones', 'reyes', 'pistaches', 'chipotles', 'res', 'aguacates'].map((w) => plural.test(w))).toEqual([
      true, true, true, false, false, false,
    ]);
  });
});

describe('Spanish -es plurals', () => {
  it('builds plurals the English rules get wrong', () => {
    expect(spanishPlural('limon')).toBe('limones');
    expect(spanishPlural('nuez')).toBe('nueces');
    expect(spanishPlural('frijol')).toBe('frijoles');
    expect(spanishPlural('leche')).toBe('leches');
    expect(spanishPlural('mamey')).toBe('mameyes');
    expect(spanishPlural('bistec')).toBe('bistecs');
    expect(spanishPlural('aguacates')).toBeNull();
    expect(buildSpanishEsPlurals(['Limón', 'nuez moscada', 'frijol', 'aguacates', 'papa', 'leche', 'bistec'])).toEqual({
      frijoles: 'frijol',
      leches: 'leche',
      limones: 'limon',
    });
  });

  it('builds an empty list from no names, or from names the English rules already handle', () => {
    expect(buildSpanishEsPlurals([])).toEqual({});
    expect(buildSpanishEsPlurals(['carne para asar', 'crema para batir', 'pan para hamburguesa'])).toEqual({});
    expect(buildSpanishEsPlurals(['papa', 'aguacates', '', '!!'])).toEqual({});
  });

  it('is up to date with the Spanish seed (run `yarn seed:es-plurals`)', () => {
    expect(SPANISH_ES_PLURALS).toEqual(buildSpanishEsPlurals(spanish.map((e) => e.name)));
    expect(SPANISH_ES_PLURALS).toMatchObject({ limones: 'limon', nueces: 'nuez', frijoles: 'frijol' });
  });

  // A plural collides when an English seed name, or its plural, ends in it and the list would
  // give it another singular than the English rules do. `leches` is fine: `dulce de leche`'s
  // plural wants `leche` too.
  it("doesn't collide with an English seed name or its plural", () => {
    const collisions: string[] = [];
    const check = (word: string, wanted: string, from: string) => {
      if (Object.hasOwn(SPANISH_ES_PLURALS, word) && SPANISH_ES_PLURALS[word] !== wanted) {
        collisions.push(`${word} (${from}): ${SPANISH_ES_PLURALS[word]}, not ${wanted}`);
      }
    };
    for (const { name } of english) {
      const typed = lastWord(name);
      const singular = englishSingular(typed);
      check(typed, singular, name);
      for (const plural of englishPlurals(singular)) check(plural, singular, `${name}, plural`);
    }
    expect(collisions).toEqual([]);
    expect(SPANISH_ES_PLURALS.leches).toBe('leche');
    expect(key('dulce de leches')).toBe('dulce de leche');
    expect(key('tres leches cake')).toBe('tres leches cake');
  });

  it('would catch a plural that changes an English key', () => {
    // `scones` and `slices` end like Spanish -es plurals; the English rules must keep them.
    for (const word of ['scones', 'slices', 'olives']) {
      expect([word, Object.hasOwn(SPANISH_ES_PLURALS, word)]).toEqual([word, false]);
    }
    expect(englishPlurals('scone')).toContain('scones');
    expect(englishPlurals('box')).toEqual(['boxs', 'boxes']);
    expect(englishPlurals('berry')).toEqual(['berrys', 'berries']);
  });

  it('makes the plural and the singular one key', () => {
    for (const name of ['limones', 'Limón', 'limon']) expect(key(name)).toBe('limon');
    expect(key('nueces')).toBe('nuez');
    expect(key('frijoles')).toBe('frijol');
    expect(key('Frijoles negros')).toBe('frijoles negro');
    expect(key('camarones')).toBe('camaron');
    expect(key('leches')).toBe('leche');
    for (const { name } of spanish) {
      const plural = lastWordPlural(name);
      if (plural) expect([name, key(name.replace(/\S+$/, plural))]).toEqual([name, key(name)]);
    }
  });

  it('leaves every English seed key as the English rules make it', () => {
    expect(englishSingular('limones')).toBe('limone');
    for (const name of ['scones', 'slices', 'peaches', 'tomatoes', 'berries', 'olives']) {
      expect(key(name)).toBe(englishSingular(name));
    }
    const changed = english
      .map((e) => e.name)
      .filter((name) => singularize(lastWord(name)) !== englishSingular(lastWord(name)));
    expect(changed).toEqual([]);
  });
});
