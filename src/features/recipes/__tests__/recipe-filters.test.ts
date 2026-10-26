import { describe, expect, test } from '@jest/globals';

import { i18n } from '@/i18n';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';

import {
  activeFilterCount,
  availableFilterFacets,
  collectionNameKey,
  filterRecipes,
  filtersPillAccessibilityLabel,
  filtersPillLabel,
  isFilterPicked,
  isUntaggedRecipe,
  matchesRecipeFilters,
  noRecipeFilters,
  recipeFilterChips,
  removeFilterChip,
  showRecipesLabel,
  toggleRecipeFilter,
  untaggedFootnote,
  untaggedOnlyFilters,
  withoutGoneCollections,
  type RecipeFilters,
} from '../recipe-filters';
import type { CollectionsByRecipe } from '../collections';
import type { FavoritesByRecipe } from '../favorites';

const tags = (over: Partial<RecipeTags>): RecipeTags => ({ ...emptyRecipeTags(), ...over });
const recipe = (name: string, t: Partial<RecipeTags> | null, totalMinutes: number | null = null) => ({
  id: name,
  name,
  tags: t ? tags(t) : null,
  totalMinutes,
});
const pick = (...picks: [Parameters<typeof toggleRecipeFilter>[1], string][]): RecipeFilters =>
  picks.reduce((f, [facet, slug]) => toggleRecipeFilter(f, facet, slug), noRecipeFilters());
const names = (rs: { name: string }[]) => rs.map((r) => r.name);

const tacos = recipe('Tacos', { meal: ['dinner'], cuisine: ['mexican'], protein: ['chicken'] }, 25);
const pancakes = recipe('Pancakes', { meal: ['breakfast'], diet: ['vegetarian'] }, 30);
const curry = recipe('Curry', { meal: ['dinner', 'lunch'], cuisine: ['indian'], protein: ['chicken', 'beans-lentils'] }, 90);
const salad = recipe('Salad', { meal: ['lunch'], diet: ['vegan'], method: ['no-cook'] }, null);
const plain = recipe('Plain', null);
const empty = recipe('Empty import', {});
const ALL = [tacos, pancakes, curry, salad, plain, empty];

describe('matching', () => {
  test('no filters keeps every recipe, in order', () => {
    expect(names(filterRecipes(ALL, noRecipeFilters()))).toEqual(['Tacos', 'Pancakes', 'Curry', 'Salad', 'Plain', 'Empty import']);
  });

  test('OR within a facet', () => {
    expect(names(filterRecipes(ALL, pick(['meal', 'dinner'])))).toEqual(['Tacos', 'Curry']);
    expect(names(filterRecipes(ALL, pick(['meal', 'dinner'], ['meal', 'breakfast'])))).toEqual(['Tacos', 'Pancakes', 'Curry']);
  });

  test('AND across facets', () => {
    expect(names(filterRecipes(ALL, pick(['meal', 'dinner'], ['cuisine', 'indian'])))).toEqual(['Curry']);
    expect(names(filterRecipes(ALL, pick(['meal', 'lunch'], ['diet', 'vegan'])))).toEqual(['Salad']);
    expect(names(filterRecipes(ALL, pick(['meal', 'breakfast'], ['protein', 'chicken'])))).toEqual([]);
  });

  test('time buckets: under 30, 30 to 60, over 60; no time matches none', () => {
    expect(names(filterRecipes(ALL, pick(['time', 'under-30'])))).toEqual(['Tacos']);
    expect(names(filterRecipes(ALL, pick(['time', 'under-60'])))).toEqual(['Pancakes']);
    expect(names(filterRecipes(ALL, pick(['time', 'over-60'])))).toEqual(['Curry']);
    expect(names(filterRecipes(ALL, pick(['time', 'under-30'], ['time', 'over-60'])))).toEqual(['Tacos', 'Curry']);
    expect(names(filterRecipes(ALL, pick(['time', 'under-60'], ['meal', 'dinner'])))).toEqual([]);
  });

  test('an unknown stored slug never matches, and the recipe still matches on known ones', () => {
    const future = recipe('Future', { meal: ['brunch', 'dinner'] });
    expect(matchesRecipeFilters(future, pick(['meal', 'dinner']))).toBe(true);
    expect(matchesRecipeFilters(future, pick(['meal', 'lunch']))).toBe(false);
  });

  test('a stored value missing a facet (older row) is treated as empty', () => {
    const partial = { id: 'partial', name: 'Partial', tags: { meal: ['dinner'] } as unknown as RecipeTags, totalMinutes: null };
    expect(matchesRecipeFilters(partial, pick(['cuisine', 'thai']))).toBe(false);
    expect(matchesRecipeFilters(partial, pick(['meal', 'dinner']))).toBe(true);
  });
});

describe('untagged', () => {
  test('null tags, empty facets or only unknown slugs, with no time, is untagged', () => {
    expect(isUntaggedRecipe(plain)).toBe(true);
    expect(isUntaggedRecipe(empty)).toBe(true);
    expect(isUntaggedRecipe(recipe('Unknown', { meal: ['brunch'] }))).toBe(true);
  });

  test('a tag or a time makes it tagged', () => {
    expect(isUntaggedRecipe(salad)).toBe(false);
    expect(isUntaggedRecipe(recipe('Timed', null, 45))).toBe(false);
  });

  test('the Untagged filter shows only untagged recipes', () => {
    expect(names(filterRecipes(ALL, untaggedOnlyFilters()))).toEqual(['Plain', 'Empty import']);
  });

  test('picking a value leaves Untagged', () => {
    const f = toggleRecipeFilter(untaggedOnlyFilters(), 'meal', 'dinner');
    expect(f.untagged).toBe(false);
    expect(f.tags.meal).toEqual(['dinner']);
    expect(toggleRecipeFilter(untaggedOnlyFilters(), 'time', 'over-60')).toEqual({ ...noRecipeFilters(), time: ['over-60'] });
  });

  test('the footer text', () => {
    expect(untaggedFootnote(1)).toBe("1 recipe without tags isn't shown");
    expect(untaggedFootnote(3)).toBe("3 recipes without tags aren't shown");
  });
});

describe('saved: Favorites, My favorites and Want to try', () => {
  // Favorites per person (4.14) come from `recipe_favorites`, by recipe id; an old `favorite` slug is unknown.
  const loved = recipe('Loved', { meal: ['dinner'] }); // mine
  const theirs = recipe('Theirs', { meal: ['dinner'], cuisine: ['mexican'] }); // only Sam's
  const someday = recipe('Someday', { saved: ['want-to-try'] });
  const both = recipe('Both', { saved: ['want-to-try'], meal: ['lunch'] }); // mine and Ana's
  const oldTag = recipe('Old tag', { saved: ['favorite'] });
  const SAVED = [tacos, loved, theirs, someday, both, oldTag, plain];
  const FAVORITES: FavoritesByRecipe = new Map([
    ['Loved', { mine: true, others: [] }],
    ['Theirs', { mine: false, others: ['Sam'] }],
    ['Both', { mine: true, others: ['Ana'] }],
  ]);
  const ONLY_MINE: FavoritesByRecipe = new Map([['Loved', { mine: true, others: [] }]]);
  const filter = (f: RecipeFilters, favorites = FAVORITES) => names(filterRecipes(SAVED, f, favorites));

  test('Favorites is anyone’s, My favorites the user’s own, Want to try the tag', () => {
    expect(filter(pick(['saved', 'favorites']))).toEqual(['Loved', 'Theirs', 'Both']);
    expect(filter(pick(['saved', 'my-favorites']))).toEqual(['Loved', 'Both']);
    expect(filter(pick(['saved', 'want-to-try']))).toEqual(['Someday', 'Both']);
  });

  test('OR with Want to try within Saved', () => {
    expect(filter(pick(['saved', 'favorites'], ['saved', 'want-to-try']))).toEqual(['Loved', 'Theirs', 'Someday', 'Both']);
    expect(filter(pick(['saved', 'my-favorites'], ['saved', 'want-to-try']))).toEqual(['Loved', 'Someday', 'Both']);
    expect(filter(pick(['saved', 'favorites'], ['saved', 'my-favorites']))).toEqual(['Loved', 'Theirs', 'Both']);
  });

  test('AND with the other facets', () => {
    expect(filter(pick(['saved', 'favorites'], ['meal', 'dinner']))).toEqual(['Loved', 'Theirs']);
    expect(filter(pick(['saved', 'my-favorites'], ['meal', 'dinner']))).toEqual(['Loved']);
    expect(filter(pick(['saved', 'favorites'], ['cuisine', 'mexican']))).toEqual(['Theirs']);
    expect(filter(pick(['saved', 'favorites'], ['saved', 'want-to-try'], ['meal', 'lunch']))).toEqual(['Both']);
    expect(filter(pick(['saved', 'want-to-try'], ['meal', 'dinner']))).toEqual([]);
  });

  test('without the favorites data nothing is a favorite', () => {
    expect(names(filterRecipes(SAVED, pick(['saved', 'favorites'])))).toEqual([]);
    expect(filter(pick(['saved', 'favorites']), new Map())).toEqual([]);
  });

  test('an old stored `favorite` slug matches no saved filter', () => {
    expect(matchesRecipeFilters(oldTag, pick(['saved', 'favorites']), FAVORITES)).toBe(false);
    expect(matchesRecipeFilters(oldTag, pick(['saved', 'want-to-try']), FAVORITES)).toBe(false);
    expect(isUntaggedRecipe(oldTag, FAVORITES)).toBe(true);
  });

  test('older stored tags without saved never match a saved filter', () => {
    const older = { id: 'older', name: 'Older', tags: { meal: ['dinner'] } as unknown as RecipeTags, totalMinutes: null };
    expect(matchesRecipeFilters(older, pick(['saved', 'want-to-try']), FAVORITES)).toBe(false);
    expect(matchesRecipeFilters(older, pick(['saved', 'favorites']), FAVORITES)).toBe(false);
  });

  test('only a saved tag or only a favorite isn’t untagged', () => {
    const lonely = recipe('Lonely', null);
    expect(isUntaggedRecipe(someday)).toBe(false);
    expect(isUntaggedRecipe(lonely)).toBe(true);
    expect(isUntaggedRecipe(lonely, new Map([['Lonely', { mine: false, others: ['Sam'] }]]))).toBe(false);
    expect(names(filterRecipes([...SAVED, lonely], untaggedOnlyFilters(), new Map([['Lonely', { mine: true, others: [] }]])))).toEqual([
      'Old tag',
      'Plain',
    ]);
    expect(isUntaggedRecipe(recipe('Unknown saved', { saved: ['loved'] }))).toBe(true);
  });

  test('the group comes first: Favorites, My favorites, Want to try, each only when some recipe has it', () => {
    expect(availableFilterFacets(SAVED, noRecipeFilters(), FAVORITES)[0]).toEqual({
      key: 'saved',
      label: 'Saved',
      values: [
        { slug: 'favorites', label: 'Favorites' },
        { slug: 'my-favorites', label: 'My favorites' },
        { slug: 'want-to-try', label: 'Want to try' },
      ],
    });
    expect(availableFilterFacets([tacos, someday], noRecipeFilters(), FAVORITES)[0]).toEqual({
      key: 'saved',
      label: 'Saved',
      values: [{ slug: 'want-to-try', label: 'Want to try' }],
    });
    expect(availableFilterFacets([tacos, plain, oldTag], noRecipeFilters(), FAVORITES).map((f) => f.key)).not.toContain('saved');
  });

  test('My favorites is hidden until another member has a favorite', () => {
    const saved = (favorites: FavoritesByRecipe) =>
      availableFilterFacets(SAVED, noRecipeFilters(), favorites)[0].values.map((v) => v.slug);
    const plus = (id: string, others: string[]): FavoritesByRecipe => new Map([...ONLY_MINE, [id, { mine: false, others }]]);
    expect(saved(ONLY_MINE)).toEqual(['favorites', 'want-to-try']);
    expect(saved(plus('Theirs', ['Sam']))).toEqual([
      'favorites',
      'my-favorites',
      'want-to-try',
    ]);
    // Another member's favorite on a recipe the list doesn't hold doesn't count.
    expect(saved(plus('elsewhere', ['Sam']))).toEqual(['favorites', 'want-to-try']);
    // Picked, it stays so it can be turned off.
    expect(availableFilterFacets(SAVED, pick(['saved', 'my-favorites']), ONLY_MINE)[0].values.map((v) => v.slug)).toEqual([
      'favorites',
      'my-favorites',
      'want-to-try',
    ]);
  });

  test('toggling the favorites values keeps them out of the tags', () => {
    const f = pick(['saved', 'my-favorites'], ['saved', 'want-to-try'], ['saved', 'favorites']);
    expect(f.favorites).toEqual(['my-favorites', 'favorites']);
    expect(f.tags.saved).toEqual(['want-to-try']);
    expect(isFilterPicked(f, 'saved', 'favorites')).toBe(true);
    expect(toggleRecipeFilter(toggleRecipeFilter(f, 'saved', 'favorites'), 'saved', 'my-favorites')).toEqual({
      ...noRecipeFilters(),
      tags: { ...emptyRecipeTags(), saved: ['want-to-try'] },
    });
    expect(toggleRecipeFilter(untaggedOnlyFilters(), 'saved', 'favorites')).toEqual({ ...noRecipeFilters(), favorites: ['favorites'] });
  });

  test('active chips, before the other facets, in the sheet’s order', () => {
    const f = pick(['meal', 'dinner'], ['saved', 'want-to-try'], ['saved', 'my-favorites'], ['saved', 'favorites']);
    const chips = recipeFilterChips(f);
    expect(chips.map((c) => c.label)).toEqual(['Favorites', 'My favorites', 'Want to try', 'Dinner']);
    expect(chips[0]).toEqual({
      key: 'saved:favorites',
      facet: 'saved',
      slug: 'favorites',
      label: 'Favorites',
      accessibilityLabel: 'Remove Favorites filter',
    });
    expect(chips[1].accessibilityLabel).toBe('Remove My favorites filter');
    expect(removeFilterChip(f, chips[0])).toMatchObject({ favorites: ['my-favorites'], tags: { saved: ['want-to-try'] } });
    expect(removeFilterChip(f, chips[2])).toMatchObject({ favorites: ['my-favorites', 'favorites'], tags: { saved: [] } });
    expect(activeFilterCount(f)).toBe(4);
  });
});

describe('availableFilterFacets', () => {
  test('only values some recipe has, in display order, then Time', () => {
    expect(availableFilterFacets(ALL, noRecipeFilters())).toEqual([
      { key: 'meal', label: 'Meal', values: [{ slug: 'breakfast', label: 'Breakfast' }, { slug: 'lunch', label: 'Lunch' }, { slug: 'dinner', label: 'Dinner' }] },
      { key: 'cuisine', label: 'Cuisine', values: [{ slug: 'mexican', label: 'Mexican' }, { slug: 'indian', label: 'Indian' }] },
      { key: 'protein', label: 'Protein', values: [{ slug: 'chicken', label: 'Chicken' }, { slug: 'beans-lentils', label: 'Beans & lentils' }] },
      { key: 'diet', label: 'Diet', values: [{ slug: 'vegetarian', label: 'Vegetarian' }, { slug: 'vegan', label: 'Vegan' }] },
      { key: 'method', label: 'Method', values: [{ slug: 'no-cook', label: 'No cook' }] },
      {
        key: 'time',
        label: 'Time',
        values: [{ slug: 'under-30', label: 'Under 30 min' }, { slug: 'under-60', label: 'Under 1 hour' }, { slug: 'over-60', label: 'Over 1 hour' }],
      },
    ]);
  });

  test('a facet with no values left is hidden; unknown slugs are not offered', () => {
    const facets = availableFilterFacets([tacos, recipe('Unknown', { method: ['smoker'] })], noRecipeFilters());
    expect(facets.map((f) => f.key)).toEqual(['meal', 'cuisine', 'protein', 'time']);
    expect(facets.find((f) => f.key === 'time')!.values).toEqual([{ slug: 'under-30', label: 'Under 30 min' }]);
  });

  test('no tagged recipes: no facets', () => {
    expect(availableFilterFacets([plain, empty], noRecipeFilters())).toEqual([]);
    expect(availableFilterFacets([], noRecipeFilters())).toEqual([]);
  });

  test('a picked value stays offered after its last recipe goes, so it can be turned off', () => {
    const facets = availableFilterFacets([pancakes], pick(['cuisine', 'thai']));
    expect(facets.find((f) => f.key === 'cuisine')).toEqual({ key: 'cuisine', label: 'Cuisine', values: [{ slug: 'thai', label: 'Thai' }] });
  });
});

describe('toggling and counting', () => {
  test('toggles a value on and off, without changing the input', () => {
    const start = noRecipeFilters();
    const on = toggleRecipeFilter(start, 'protein', 'chicken');
    expect(on.tags.protein).toEqual(['chicken']);
    expect(start.tags.protein).toEqual([]);
    expect(isFilterPicked(on, 'protein', 'chicken')).toBe(true);
    expect(toggleRecipeFilter(on, 'protein', 'chicken')).toEqual(noRecipeFilters());
  });

  test('no maximum when filtering', () => {
    const f = pick(['meal', 'breakfast'], ['meal', 'lunch'], ['meal', 'dinner'], ['meal', 'snack']);
    expect(f.tags.meal).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
  });

  test('activeFilterCount counts every value and Untagged', () => {
    expect(activeFilterCount(noRecipeFilters())).toBe(0);
    expect(activeFilterCount(pick(['meal', 'dinner'], ['meal', 'lunch'], ['time', 'over-60']))).toBe(3);
    expect(activeFilterCount(untaggedOnlyFilters())).toBe(1);
  });

  test('the Filters pill, its VoiceOver label, and the CTA', () => {
    expect(filtersPillLabel(0)).toBe('Filters');
    expect(filtersPillLabel(2)).toBe('Filters · 2');
    expect(filtersPillAccessibilityLabel(0)).toBe('Filters');
    expect(filtersPillAccessibilityLabel(2)).toBe('Filters, 2 active');
    expect(showRecipesLabel(0)).toBe('Show 0 recipes');
    expect(showRecipesLabel(1)).toBe('Show 1 recipe');
    expect(showRecipesLabel(12)).toBe('Show 12 recipes');
  });
});

describe('chips', () => {
  test('one per value in the sheet order, whatever order they were picked in', () => {
    const f = pick(['time', 'under-30'], ['protein', 'chicken'], ['meal', 'dinner'], ['meal', 'breakfast']);
    expect(recipeFilterChips(f)).toEqual([
      { key: 'meal:breakfast', facet: 'meal', slug: 'breakfast', label: 'Breakfast', accessibilityLabel: 'Remove Breakfast filter' },
      { key: 'meal:dinner', facet: 'meal', slug: 'dinner', label: 'Dinner', accessibilityLabel: 'Remove Dinner filter' },
      { key: 'protein:chicken', facet: 'protein', slug: 'chicken', label: 'Chicken', accessibilityLabel: 'Remove Chicken filter' },
      { key: 'time:under-30', facet: 'time', slug: 'under-30', label: 'Under 30 min', accessibilityLabel: 'Remove Under 30 min filter' },
    ]);
    expect(recipeFilterChips(noRecipeFilters())).toEqual([]);
  });

  test('removing a chip takes out only its value', () => {
    const f = pick(['meal', 'dinner'], ['meal', 'lunch'], ['time', 'over-60']);
    const [lunch, , overHour] = recipeFilterChips(f);
    expect(lunch.label).toBe('Lunch');
    expect(removeFilterChip(f, lunch)).toEqual({ ...noRecipeFilters(), tags: { ...emptyRecipeTags(), meal: ['dinner'] }, time: ['over-60'] });
    expect(removeFilterChip(f, overHour)).toEqual({ ...noRecipeFilters(), tags: { ...emptyRecipeTags(), meal: ['dinner', 'lunch'] } });
  });

  test('removing a chip that is no longer picked changes nothing', () => {
    const f = pick(['meal', 'dinner']);
    const [dinner] = recipeFilterChips(f);
    const without = removeFilterChip(f, dinner);
    expect(removeFilterChip(without, dinner)).toBe(without);
  });

  test('Untagged is one chip, and removing it clears it', () => {
    const [chip] = recipeFilterChips(untaggedOnlyFilters());
    expect(recipeFilterChips(untaggedOnlyFilters())).toEqual([
      { key: 'untagged:untagged', facet: 'untagged', slug: 'untagged', label: 'Untagged', accessibilityLabel: 'Remove Untagged filter' },
    ]);
    expect(removeFilterChip(untaggedOnlyFilters(), chip)).toEqual(noRecipeFilters());
  });
});

describe('collections (recipe collections board E)', () => {
  // Home has Mom's cookbook and Kid favorites; the cabin has "MOM'S CÓOKBOOK", the same name ignoring case
  // and accents.
  const inCollections: CollectionsByRecipe = new Map([
    ['Tacos', ["Mom's cookbook", 'Kid favorites']],
    ['Pancakes', ['Kid favorites']],
    ['Curry', ["Mom's cookbook"]],
    ['Salad', ["MOM'S CÓOKBOOK"]],
  ]);
  const all = [tacos, pancakes, curry, salad, plain];
  const collectionValues = (f: RecipeFilters, rs = all, c = inCollections) =>
    availableFilterFacets(rs, f, new Map(), c).find((facet) => facet.key === 'collections')?.values.map((v) => v.label);

  test('collectionNameKey ignores case and accents', () => {
    expect(collectionNameKey("MOM'S CÓOKBOOK")).toBe("mom's cookbook");
    expect(collectionNameKey("Mom's cookbook")).toBe("mom's cookbook");
    expect(collectionNameKey('Kid favorites')).not.toBe(collectionNameKey("Mom's cookbook"));
  });

  test('OR within the group', () => {
    const f = pick(['collections', "Mom's cookbook"], ['collections', 'Kid favorites']);
    expect(names(filterRecipes(all, f, new Map(), inCollections))).toEqual(['Tacos', 'Pancakes', 'Curry', 'Salad']);
    expect(names(filterRecipes(all, pick(['collections', 'Kid favorites']), new Map(), inCollections))).toEqual(['Tacos', 'Pancakes']);
  });

  test('AND with the other facets', () => {
    const f = pick(['collections', 'Kid favorites'], ['meal', 'dinner']);
    expect(names(filterRecipes(all, f, new Map(), inCollections))).toEqual(['Tacos']);
    const slow = pick(['collections', "Mom's cookbook"], ['time', 'over-60']);
    expect(names(filterRecipes(all, slow, new Map(), inCollections))).toEqual(['Curry']);
    expect(names(filterRecipes(all, pick(['collections', 'Kid favorites'], ['meal', 'lunch']), new Map(), inCollections))).toEqual([]);
  });

  test('the same name in two households matches both, whichever spelling was picked', () => {
    expect(names(filterRecipes(all, pick(['collections', "Mom's cookbook"]), new Map(), inCollections))).toEqual([
      'Tacos',
      'Curry',
      'Salad',
    ]);
    expect(names(filterRecipes(all, pick(['collections', "MOM'S CÓOKBOOK"]), new Map(), inCollections))).toEqual([
      'Tacos',
      'Curry',
      'Salad',
    ]);
  });

  test('a recipe in no collection, or no collections data, matches no collection pick', () => {
    const f = pick(['collections', 'Kid favorites']);
    expect(matchesRecipeFilters(plain, f, new Map(), inCollections)).toBe(false);
    expect(matchesRecipeFilters(tacos, f)).toBe(false);
    expect(matchesRecipeFilters(tacos, noRecipeFilters(), new Map(), inCollections)).toBe(true);
  });

  test('the group comes right after Saved, one pill per name A–Z, the same name once', () => {
    const favorites: FavoritesByRecipe = new Map([['Tacos', { mine: true, others: [] }]]);
    const facets = availableFilterFacets(all, noRecipeFilters(), favorites, inCollections);
    expect(facets.map((f) => f.key).slice(0, 3)).toEqual(['saved', 'collections', 'meal']);
    expect(facets[1]).toEqual({
      key: 'collections',
      label: 'Collections',
      values: [
        { slug: 'Kid favorites', label: 'Kid favorites' },
        { slug: "Mom's cookbook", label: "Mom's cookbook" },
      ],
    });
  });

  test('without Saved values the group comes first; with no collections data (the collection screen) there is none', () => {
    const facets = availableFilterFacets(all, noRecipeFilters(), new Map(), inCollections);
    expect(facets[0].key).toBe('collections');
    expect(availableFilterFacets(all, noRecipeFilters()).some((f) => f.key === 'collections')).toBe(false);
  });

  test("only collections that hold one of the recipes show; none holding any hides the group", () => {
    expect(collectionValues(noRecipeFilters(), [pancakes])).toEqual(['Kid favorites']);
    expect(collectionValues(noRecipeFilters(), [plain])).toBeUndefined();
  });

  test('a picked name stays offered after its last recipe leaves, so it can be turned off', () => {
    const f = pick(['collections', 'Thanksgiving']);
    expect(collectionValues(f, [pancakes])).toEqual(['Kid favorites', 'Thanksgiving']);
    expect(collectionValues(f, [plain])).toEqual(['Thanksgiving']);
    expect(isFilterPicked(f, 'collections', 'Thanksgiving')).toBe(true);
    expect(isFilterPicked(f, 'collections', 'THANKSGIVING')).toBe(true);
    expect(isFilterPicked(f, 'collections', 'Kid favorites')).toBe(false);
  });

  test('toggling another spelling of a picked name turns it off; picking leaves Untagged', () => {
    const on = toggleRecipeFilter(untaggedOnlyFilters(), 'collections', "Mom's cookbook");
    expect(on.collections).toEqual(["Mom's cookbook"]);
    expect(on.untagged).toBe(false);
    expect(toggleRecipeFilter(on, 'collections', "MOM'S CÓOKBOOK").collections).toEqual([]);
    expect(on.tags).toEqual(emptyRecipeTags());
    expect(on.favorites).toEqual([]);
  });

  test('picks count toward the Filters number', () => {
    const f = pick(['collections', "Mom's cookbook"], ['collections', 'Kid favorites'], ['meal', 'dinner']);
    expect(activeFilterCount(f)).toBe(3);
    expect(filtersPillAccessibilityLabel(activeFilterCount(f))).toBe('Filters, 3 active');
  });

  test('chips: after Saved and before the other facets, in pick order; removing one takes out only it', () => {
    const f = pick(['meal', 'dinner'], ['collections', 'Kid favorites'], ['saved', 'favorites'], ['collections', "Mom's cookbook"]);
    const chips = recipeFilterChips(f);
    expect(chips.map((c) => c.label)).toEqual(['Favorites', 'Kid favorites', "Mom's cookbook", 'Dinner']);
    expect(chips[1]).toEqual({
      key: 'collections:Kid favorites',
      facet: 'collections',
      slug: 'Kid favorites',
      label: 'Kid favorites',
      accessibilityLabel: 'Remove Kid favorites filter',
    });
    const without = removeFilterChip(f, chips[1]);
    expect(without.collections).toEqual(["Mom's cookbook"]);
    expect(without.tags.meal).toEqual(['dinner']);
    expect(removeFilterChip(without, chips[1])).toBe(without);
  });

  test('withoutGoneCollections drops picks no live collection is called, ignoring case and accents', () => {
    const f = pick(['collections', "Mom's cookbook"], ['collections', 'Kid favorites'], ['meal', 'dinner']);
    expect(withoutGoneCollections(f, ["MOM'S CÓOKBOOK", 'Kid favorites', 'Other'])).toBe(f);
    const dropped = withoutGoneCollections(f, ["mom's cookbook"]);
    expect(dropped.collections).toEqual(["Mom's cookbook"]);
    expect(dropped.tags.meal).toEqual(['dinner']);
    expect(withoutGoneCollections(f, []).collections).toEqual([]);
    const none = noRecipeFilters();
    expect(withoutGoneCollections(none, [])).toBe(none);
  });

  test('the group name in Spanish', async () => {
    await i18n.changeLanguage('es');
    try {
      expect(availableFilterFacets(all, noRecipeFilters(), new Map(), inCollections)[0].label).toBe('Colecciones');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
