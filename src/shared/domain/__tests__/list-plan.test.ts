// Runs under Jest and Deno (`supabase/functions/_shared/shared-domain.test.ts`).
import { describe, expect, it } from '@jest/globals';

import {
  knownUnit,
  planListAdds,
  type IdSource,
  type ListSnapshot,
  type PlannedAdd,
  type SnapshotItem,
  type UnitKnowledge,
} from '../list-plan.ts';

const LIST = { id: 'list-1', householdId: 'hh-1' };
const AT = new Date('2026-03-02T12:00:00.000Z');
const ISO = AT.toISOString();
const META = { userId: 'user-1', at: AT };

/** Ids by purpose and index, recording the order they were asked for. */
function idSource() {
  const asked: string[] = [];
  const ids: IdSource = (purpose, index) => {
    const id = `${purpose}-${index}`;
    asked.push(id);
    return id;
  };
  return { ids, asked };
}

const snapshot = (items: SnapshotItem[] = [], extra: Partial<ListSnapshot> = {}): ListSnapshot => ({
  list: LIST,
  combineLanguages: false,
  families: {},
  items,
  ...extra,
});

const item = (over: Partial<SnapshotItem> & { id: string; ingredientName: string }): SnapshotItem => ({
  displayName: over.ingredientName,
  familyKey: over.ingredientName,
  checkedAt: null,
  checkedBy: null,
  liveContributions: [],
  ...over,
});

const add = (
  ingredientName: string,
  quantity: number | null,
  unit: PlannedAdd['unit'],
  source: PlannedAdd['source'] = 'manual',
  recipeId: string | null = null,
): PlannedAdd => ({ ingredientName, displayName: ingredientName, quantity, unit, source, recipeId });

const usage = (name: string, displayName = name) => ({
  op: 'upsert',
  table: 'ingredient_usage',
  key: { household_id: 'hh-1', ingredient_name: name },
  fields: { display_name: displayName, last_used_at: ISO, hidden_at: null },
  counters: { use_count: 1 },
});
const unitUsage = (name: string, unitKey: string) => ({
  op: 'upsert',
  table: 'ingredient_unit_usage',
  key: { household_id: 'hh-1', ingredient_name: name, unit_key: unitKey },
  fields: { last_used_at: ISO },
  counters: { use_count: 1 },
});
const contribution = (
  id: string,
  itemId: string,
  quantity: number | null,
  unit: string | null,
  source = 'manual',
  recipeId: string | null = null,
) => ({
  op: 'insert',
  table: 'list_item_contributions',
  id,
  fields: {
    list_item_id: itemId,
    household_id: 'hh-1',
    source,
    recipe_id: recipeId,
    quantity,
    unit,
    added_by: 'user-1',
    created_at: ISO,
  },
});

describe('planListAdds', () => {
  it('makes a new item with its amount, taking the amount id before the item id', () => {
    const { ids, asked } = idSource();
    const plan = planListAdds(snapshot(), [add('chicken thighs', 2, 'lb')], META, {}, ids);
    expect(asked).toEqual(['contribution-0', 'item-0']);
    expect(plan.writes).toEqual([
      usage('chicken thighs'),
      unitUsage('chicken thighs', 'lb'),
      {
        op: 'insert',
        table: 'list_items',
        id: 'item-0',
        fields: {
          list_id: 'list-1',
          household_id: 'hh-1',
          ingredient_name: 'chicken thighs',
          display_name: 'chicken thighs',
          added_by: 'user-1',
          created_at: ISO,
        },
      },
      contribution('contribution-0', 'item-0', 2, 'lb'),
    ]);
    expect(plan.preconditions).toEqual([{ kind: 'new', listId: 'list-1', key: 'chicken thighs' }]);
    expect(plan.results).toEqual([{ itemId: 'item-0', contributionId: 'contribution-0', kind: 'new' }]);
  });

  it('counts no unit for an add with no quantity', () => {
    const plan = planListAdds(snapshot(), [add('milk', null, null)], META, {}, idSource().ids);
    expect(plan.writes.map((w) => w.table)).toEqual(['ingredient_usage', 'list_items', 'list_item_contributions']);
  });

  it("counts a bare number as the unit 'count'", () => {
    const plan = planListAdds(snapshot(), [add('eggs', 3, null)], META, {}, idSource().ids);
    expect(plan.writes[1]).toEqual(unitUsage('eggs', 'count'));
  });

  it('Combines into an open item, with the total for the toast', () => {
    const eggs = item({
      id: 'eggs-item',
      ingredientName: 'eggs',
      displayName: 'Eggs',
      liveContributions: [{ id: 'c-old', source: 'manual', quantity: 2, unit: null }],
    });
    const { ids, asked } = idSource();
    const plan = planListAdds(snapshot([eggs]), [add('eggs', 3, null)], META, {}, ids);
    expect(asked).toEqual(['contribution-0']);
    expect(plan.writes).toEqual([usage('eggs'), unitUsage('eggs', 'count'), contribution('contribution-0', 'eggs-item', 3, null)]);
    expect(plan.preconditions).toEqual([{ kind: 'combine', itemId: 'eggs-item' }]);
    expect(plan.results).toEqual([
      {
        itemId: 'eggs-item',
        contributionId: 'contribution-0',
        kind: 'combine',
        existingName: 'Eggs',
        // The add's own unit use counts already: 3 eggs make the usual unit a count.
        total: {
          amounts: [
            { id: 'c-old', source: 'manual', quantity: 2, unit: null },
            { id: 'contribution-0', source: 'manual', quantity: 3, unit: null },
          ],
          usualUnit: null,
        },
      },
    ]);
  });

  it('prefers an open item over a checked one', () => {
    const checked = item({ id: 'old', ingredientName: 'milk', checkedAt: new Date('2026-03-01T00:00:00Z') });
    const open = item({ id: 'open', ingredientName: 'milk' });
    const plan = planListAdds(snapshot([checked, open]), [add('milk', 1, 'gal')], META, {}, idSource().ids);
    expect(plan.results[0]).toMatchObject({ kind: 'combine', itemId: 'open' });
  });

  it('reopens a checked item, replacing its amounts, and records what it replaced', () => {
    const checkedAt = new Date('2026-03-01T09:00:00.000Z');
    const milk = item({
      id: 'milk-item',
      ingredientName: 'milk',
      checkedAt,
      checkedBy: 'user-2',
      liveContributions: [
        { id: 'c1', source: 'manual', quantity: 1, unit: 'gal' },
        { id: 'c2', source: 'recipe', quantity: null, unit: null },
      ],
    });
    const plan = planListAdds(snapshot([milk]), [add('milk', 2, 'gal')], META, {}, idSource().ids);
    expect(plan.writes).toEqual([
      usage('milk'),
      unitUsage('milk', 'gal'),
      { op: 'update', table: 'list_item_contributions', id: 'c1', fields: { deleted_at: ISO } },
      { op: 'update', table: 'list_item_contributions', id: 'c2', fields: { deleted_at: ISO } },
      { op: 'update', table: 'list_items', id: 'milk-item', fields: { checked_at: null, checked_by: null } },
      contribution('contribution-0', 'milk-item', 2, 'gal'),
    ]);
    expect(plan.preconditions).toEqual([
      { kind: 'reopen', itemId: 'milk-item', checkedAt: '2026-03-01T09:00:00.000Z', contributionIds: ['c1', 'c2'] },
    ]);
    expect(plan.results).toEqual([
      {
        itemId: 'milk-item',
        contributionId: 'contribution-0',
        kind: 'reopen',
        reopened: { checkedAt, checkedBy: 'user-2', contributionIds: ['c1', 'c2'] },
      },
    ]);
  });

  it('reopens the latest checked item, and one with no amounts deletes none', () => {
    const older = item({ id: 'older', ingredientName: 'milk', checkedAt: new Date('2026-02-01T00:00:00Z') });
    const newer = item({ id: 'newer', ingredientName: 'milk', checkedAt: new Date('2026-02-20T00:00:00Z') });
    const plan = planListAdds(snapshot([older, newer]), [add('milk', null, null)], META, {}, idSource().ids);
    expect(plan.results[0]).toMatchObject({ kind: 'reopen', itemId: 'newer', reopened: { contributionIds: [] } });
    expect(plan.writes.filter((w) => w.table === 'list_item_contributions' && w.op === 'update')).toEqual([]);
    expect(plan.preconditions).toEqual([
      { kind: 'reopen', itemId: 'newer', checkedAt: '2026-02-20T00:00:00.000Z', contributionIds: [] },
    ]);
  });

  it('folds the same ingredient twice in a batch into the item the first made', () => {
    const { ids, asked } = idSource();
    const plan = planListAdds(
      snapshot(),
      [add('flour', 1, 'cup', 'recipe', 'r1'), add('flour', 2, 'cup', 'recipe', 'r1')],
      META,
      {},
      ids,
    );
    expect(asked).toEqual(['contribution-0', 'item-0', 'contribution-1']);
    // Only the first add assumed anything about the list; the second goes onto the new item.
    expect(plan.preconditions).toEqual([{ kind: 'new', listId: 'list-1', key: 'flour' }]);
    expect(plan.writes.slice(-1)).toEqual([contribution('contribution-1', 'item-0', 2, 'cup', 'recipe', 'r1')]);
    expect(plan.results[1]).toEqual({
      itemId: 'item-0',
      contributionId: 'contribution-1',
      kind: 'combine',
      existingName: 'flour',
      total: {
        amounts: [
          { id: 'contribution-0', source: 'recipe', quantity: 1, unit: 'cup' },
          { id: 'contribution-1', source: 'recipe', quantity: 2, unit: 'cup' },
        ],
        usualUnit: 'cup',
      },
    });
  });

  it('checks an open item once when several adds Combine into it', () => {
    const eggs = item({ id: 'eggs-item', ingredientName: 'eggs' });
    const plan = planListAdds(snapshot([eggs]), [add('eggs', 1, null), add('eggs', 2, null)], META, {}, idSource().ids);
    expect(plan.preconditions).toEqual([{ kind: 'combine', itemId: 'eggs-item' }]);
    expect(plan.results.map((r) => r?.itemId)).toEqual(['eggs-item', 'eggs-item']);
    // Each total is as it stood after that add.
    expect(plan.results.map((r) => r?.total?.amounts.length)).toEqual([1, 2]);
  });

  describe('family twins (spec 4.15)', () => {
    const cucumber = item({ id: 'cuke', ingredientName: 'cucumber', familyKey: 'cucumber' });
    const knowledge: UnitKnowledge = {
      cucumber: { unitUsage: [{ unitKey: 'count', useCount: 3, lastUsedAt: new Date('2026-01-01T00:00:00Z') }], defaultUnit: null },
    };

    it("Combine into the twin when the household combines languages, counting the add's own key", () => {
      const plan = planListAdds(
        snapshot([cucumber], { combineLanguages: true, families: { pepino: 'cucumber' } }),
        [add('pepino', 2, 'lb')],
        META,
        knowledge,
        idSource().ids,
      );
      expect(plan.writes.slice(0, 2)).toEqual([usage('pepino'), unitUsage('pepino', 'lb')]);
      // The total reads in the item's usual unit, not the add's.
      expect(plan.results[0]).toMatchObject({ kind: 'combine', itemId: 'cuke', ingredientName: 'pepino', total: { usualUnit: null } });
      expect(plan.preconditions).toEqual([{ kind: 'combine', itemId: 'cuke' }]);
    });

    it('is a new item when the household keeps languages apart, keyed by its own name', () => {
      const plan = planListAdds(
        snapshot([{ ...cucumber, familyKey: 'cucumber' }], { combineLanguages: false, families: { pepino: 'cucumber' } }),
        [add('pepino', 2, null)],
        META,
        knowledge,
        idSource().ids,
      );
      expect(plan.results[0]).toMatchObject({ kind: 'new' });
      expect(plan.results[0]).not.toHaveProperty('ingredientName');
      expect(plan.preconditions).toEqual([{ kind: 'new', listId: 'list-1', key: 'pepino' }]);
    });

    it('folds two names of one family in a batch into the first, and keys the new item by family', () => {
      const plan = planListAdds(
        snapshot([], { combineLanguages: true, families: { pepino: 'cucumber', cucumber: 'cucumber' } }),
        [add('cucumber', 1, null), add('pepino', 1, null)],
        META,
        {},
        idSource().ids,
      );
      expect(plan.preconditions).toEqual([{ kind: 'new', listId: 'list-1', key: 'cucumber' }]);
      expect(plan.results[1]).toMatchObject({ kind: 'combine', itemId: 'item-0', ingredientName: 'pepino' });
    });
  });

  describe('the counted-one rule (spec 4.4)', () => {
    it('makes a recipe line with no amount of something counted one of it', () => {
      const plan = planListAdds(
        snapshot(),
        [add('red onion', null, null, 'recipe', 'r1')],
        META,
        { 'red onion': { unitUsage: [], defaultUnit: 'count' } },
        idSource().ids,
      );
      expect(plan.writes).toEqual([
        usage('red onion'),
        unitUsage('red onion', 'count'),
        expect.objectContaining({ table: 'list_items' }),
        contribution('contribution-0', 'item-0', 1, null, 'recipe', 'r1'),
      ]);
    });

    it('leaves it without an amount when nothing is known, the unit is not a count, or the add is manual', () => {
      const plan = planListAdds(
        snapshot(),
        [add('eggs', null, null, 'recipe'), add('milk', null, null, 'recipe'), add('bananas', null, null, 'manual')],
        META,
        {
          milk: { unitUsage: [], defaultUnit: 'gal' },
          bananas: { unitUsage: [], defaultUnit: 'count' },
        },
        idSource().ids,
      );
      const quantities = plan.writes.filter((w) => w.table === 'list_item_contributions').map((w) => w.fields.quantity);
      expect(quantities).toEqual([null, null, null]);
      expect(plan.writes.filter((w) => w.table === 'ingredient_unit_usage')).toEqual([]);
    });

    it('sees the units of earlier adds in the batch', () => {
      // 2 lb red onion makes lb the usual unit, so the recipe line after it isn't counted one.
      const plan = planListAdds(
        snapshot(),
        [add('red onion', 2, 'lb'), add('red onion', null, null, 'recipe')],
        META,
        { 'red onion': { unitUsage: [], defaultUnit: 'count' } },
        idSource().ids,
      );
      expect(plan.writes.filter((w) => w.table === 'list_item_contributions').map((w) => w.fields.quantity)).toEqual([2, null]);
      expect(plan.results[1]?.total?.usualUnit).toBe('lb');
    });
  });

  it('gives null for an empty add, writing nothing for it', () => {
    const plan = planListAdds(snapshot(), [null, add('milk', null, null), null], META, {}, idSource().ids);
    expect(plan.results).toEqual([null, { itemId: 'item-1', contributionId: 'contribution-1', kind: 'new' }, null]);
    const empty = planListAdds(snapshot(), [null, null], META, {}, idSource().ids);
    expect(empty.results).toEqual([null, null]);
    expect(empty.writes).toEqual([]);
    expect(empty.preconditions).toEqual([]);
  });

  it('uses no user for an add with none', () => {
    const plan = planListAdds(snapshot(), [add('milk', null, null)], { userId: null, at: AT }, {}, idSource().ids);
    expect(plan.writes[1].fields.added_by).toBeNull();
    expect(plan.writes[2].fields.added_by).toBeNull();
  });
});

describe('knownUnit', () => {
  it('prefers household history, then the catalog default, else nothing', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(knownUnit({ unitUsage: [{ unitKey: 'lb', useCount: 2, lastUsedAt: at }], defaultUnit: 'count' })).toBe('lb');
    expect(knownUnit({ unitUsage: [], defaultUnit: 'count' })).toBeNull();
    expect(knownUnit({ unitUsage: [], defaultUnit: null })).toBeUndefined();
    expect(knownUnit(undefined)).toBeUndefined();
  });
});
