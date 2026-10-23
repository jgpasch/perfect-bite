// Spec 4.2, 4.4, 4.15: what adding to a list writes, as data (share-server-import plan §1, §5).
// The device runs `writes` through its sync helpers; the server's commit runs them through
// `private.apply_mutation` after checking `preconditions`. Pure.
import type { Unit } from '../quantity-parser.ts';
import type { Amount } from './quantity-math.ts';
import { planBulkAdd } from './duplicate-detector.ts';
import { unitKey, usualUnit, withDefaultUnit, type UnitUsageRow } from './usual-unit.ts';

/** A JSON value as a write carries it: dates as ISO strings. */
export type WireValue = string | number | boolean | null | WireValue[] | { [key: string]: WireValue };

export type WriteTable =
  | 'list_items'
  | 'list_item_contributions'
  | 'ingredient_usage'
  | 'ingredient_unit_usage'
  | 'recipes'
  | 'recipe_ingredients';

/**
 * One row write, in the outbox's wire shape (`Mutation` without its HLC): Postgres table and
 * column names. `insert` makes a new row, `update` patches an existing one, and `upsert` does
 * either (its `fields` set on both); `counters` add their deltas either way.
 */
export type Write = {
  op: 'insert' | 'update' | 'upsert';
  table: WriteTable;
  /** The row, for tables keyed by `id`. */
  id?: string;
  /** The row, for tables with a composite key, by column name. */
  key?: Record<string, string>;
  fields: Record<string, WireValue>;
  counters?: Record<string, number>;
};

/**
 * What the plan assumed about rows it didn't create (plan §5): a commit checks them, and a
 * failure means planning again.
 * - `combine`: the item is live and unchecked.
 * - `reopen`: the item is live, still checked at `checkedAt`, with exactly these live amounts.
 * - `new`: the list has no live item, open or checked, with this own or family key.
 * - `recipeAbsent` / `recipeReuse`: the recipe isn't there (it's created) / is there and live.
 */
export type Precondition =
  | { kind: 'combine'; itemId: string }
  | { kind: 'reopen'; itemId: string; checkedAt: string; contributionIds: string[] }
  | { kind: 'new'; listId: string; key: string }
  | { kind: 'recipeAbsent'; recipeId: string }
  | { kind: 'recipeReuse'; recipeId: string };

type Source = 'manual' | 'recipe' | 'siri';

/** One live amount on an item, oldest first. */
export type SnapshotContribution = Amount & { id: string; source: Source };

export type SnapshotItem = {
  id: string;
  ingredientName: string;
  displayName: string;
  /** Its family key (spec 4.15) when the household combines languages, else its own key. */
  familyKey: string;
  checkedAt: Date | null;
  checkedBy: string | null;
  liveContributions: SnapshotContribution[];
};

export type ListSnapshot = {
  list: { id: string; householdId: string };
  combineLanguages: boolean;
  /** The family key of each name in the batch (`familyKey`); a name left out is its own family. */
  families: Record<string, string>;
  /** The list's live items whose own or family key matches a name in the batch (more is fine). */
  items: SnapshotItem[];
};

/** What the household knows about one ingredient's unit: its unit history and the catalog's default unit. */
export type IngredientUnits = { unitUsage: UnitUsageRow[]; defaultUnit: string | null };

/**
 * Per ingredient key, for the batch's names and the snapshot items' names. A name left out has no
 * history and no default unit.
 */
export type UnitKnowledge = Record<string, IngredientUnits | undefined>;

/** Ids for new rows, by purpose and the add's (or ingredient's) index. Deterministic on the server. */
export type IdSource = (purpose: 'contribution' | 'item' | 'recipe' | 'recipeIngredient', index: number) => string;

export type ParsedAdd = { ingredientName: string; displayName: string; quantity: number | null; unit: Unit | null };

/** One add in a batch: its parsed text or ingredient, where it came from, and its recipe. */
export type PlannedAdd = ParsedAdd & { source: Source; recipeId?: string | null };

export type AddMeta = { userId: string | null; at: Date };

/** What one add did (spec 4.4), for undo and the toast. */
export type AddOutcome = {
  itemId: string;
  /** The new amount (contribution) this add created. */
  contributionId: string;
  kind: 'new' | 'combine' | 'reopen';
  /** Combine only: the item's name, and its amounts after this add with its usual unit, for the toast's total. */
  existingName?: string;
  total?: { amounts: (Amount & { source: string })[]; usualUnit: Unit | null };
  /** Reopen only: what it replaced, so Undo can put it back. */
  reopened?: { checkedAt: Date; checkedBy: string | null; contributionIds: string[] };
  /** The key this add counted a use of, when it isn't the item's (it went onto a twin, spec 4.15). */
  ingredientName?: string;
};

export type ListPlan = { writes: Write[]; preconditions: Precondition[]; results: (AddOutcome | null)[] };

/** The usual unit `knowledge` gives (spec 4.2): null for a plain count, undefined when nothing is known. */
export function knownUnit(knowledge: IngredientUnits | undefined): Unit | null | undefined {
  return withDefaultUnit(usualUnit(knowledge?.unitUsage ?? []), knowledge?.defaultUnit);
}

type ItemState = {
  id: string;
  ingredientName: string;
  displayName: string;
  /** From the snapshot (so its preconditions apply), not made by this batch. */
  existing: boolean;
  live: SnapshotContribution[];
};

/**
 * Plans a batch of adds to one list, as the device's bulk add does (spec 4.4): each counts one use
 * of its ingredient (and one of its unit when it has a quantity); an open match gets the amount
 * (Combine), a checked one is unchecked with its amounts replaced, the same ingredient (or family,
 * when the household combines languages) twice in the batch folds into the first, and a recipe line
 * with no amount of something bought by count is one of it. Null adds (nothing to add) give null.
 */
export function planListAdds(
  snapshot: ListSnapshot,
  adds: readonly (PlannedAdd | null)[],
  meta: AddMeta,
  unitKnowledge: UnitKnowledge,
  ids: IdSource,
): ListPlan {
  const { list } = snapshot;
  const at = meta.at.toISOString();
  const writes: Write[] = [];
  const preconditions: Precondition[] = [];
  const results: (AddOutcome | null)[] = [];
  // Unit history as it stands after each add, so later adds see the earlier ones' units.
  const units = new Map<string, IngredientUnits>();
  const unitsOf = (name: string) => {
    let found = units.get(name);
    if (!found) {
      const given = unitKnowledge[name];
      found = { unitUsage: [...(given?.unitUsage ?? [])], defaultUnit: given?.defaultUnit ?? null };
      units.set(name, found);
    }
    return found;
  };
  const items = new Map<string, ItemState>(
    snapshot.items.map((i) => [
      i.id,
      {
        id: i.id,
        ingredientName: i.ingredientName,
        displayName: i.displayName,
        existing: true,
        live: [...i.liveContributions],
      },
    ]),
  );
  const combined = new Set<string>();
  const familyOf = (name: string) => (snapshot.combineLanguages ? (snapshot.families[name] ?? name) : name);
  const decisions = planBulkAdd(
    adds.map((a) => a?.ingredientName ?? ''),
    snapshot.items,
    adds.map((a) => (a ? familyOf(a.ingredientName) : '')),
  );

  adds.forEach((add, index) => {
    if (!add) return results.push(null);
    let decision = decisions[index];
    if (decision.kind === 'sameAsEarlier') {
      const first = results[decision.index];
      if (!first) return results.push(null);
      decision = { kind: 'combine', itemId: first.itemId };
    }

    const contributionId = ids('contribution', index);
    const countedOne = add.source === 'recipe' && add.quantity === null && knownUnit(unitsOf(add.ingredientName)) === null;
    const contribution: SnapshotContribution = {
      id: contributionId,
      source: add.source,
      quantity: countedOne ? 1 : add.quantity,
      unit: add.unit,
    };
    const contributionFields = {
      household_id: list.householdId,
      source: add.source,
      recipe_id: add.recipeId ?? null,
      quantity: contribution.quantity,
      unit: contribution.unit,
      added_by: meta.userId,
      created_at: at,
    };
    recordUse(writes, unitsOf(add.ingredientName), list.householdId, add, contribution, meta.at);

    if (decision.kind === 'new') {
      const itemId = ids('item', index);
      preconditions.push({ kind: 'new', listId: list.id, key: familyOf(add.ingredientName) });
      writes.push({
        op: 'insert',
        table: 'list_items',
        id: itemId,
        fields: {
          list_id: list.id,
          household_id: list.householdId,
          ingredient_name: add.ingredientName,
          display_name: add.displayName,
          added_by: meta.userId,
          created_at: at,
        },
      });
      writes.push({ op: 'insert', table: 'list_item_contributions', id: contributionId, fields: { list_item_id: itemId, ...contributionFields } });
      items.set(itemId, {
        id: itemId,
        ingredientName: add.ingredientName,
        displayName: add.displayName,
        existing: false,
        live: [contribution],
      });
      return results.push({ itemId, contributionId, kind: 'new' });
    }

    const item = items.get(decision.itemId);
    if (!item) throw new Error(`No item ${decision.itemId} in the snapshot`);
    const twin = add.ingredientName !== item.ingredientName ? { ingredientName: add.ingredientName } : {};
    const previous = item.live;

    if (decision.kind === 'combine') {
      if (item.existing && !combined.has(item.id)) {
        combined.add(item.id);
        preconditions.push({ kind: 'combine', itemId: item.id });
      }
      writes.push({ op: 'insert', table: 'list_item_contributions', id: contributionId, fields: { list_item_id: item.id, ...contributionFields } });
      item.live = [...previous, contribution];
      return results.push({
        itemId: item.id,
        contributionId,
        kind: 'combine',
        existingName: item.displayName,
        total: { amounts: item.live, usualUnit: knownUnit(unitsOf(item.ingredientName)) ?? null },
        ...twin,
      });
    }

    // Reopen: you bought it before and need it again, so the old amounts no longer apply.
    const snapshotItem = snapshot.items.find((i) => i.id === item.id)!;
    const contributionIds = previous.map((c) => c.id);
    preconditions.push({
      kind: 'reopen',
      itemId: item.id,
      checkedAt: snapshotItem.checkedAt!.toISOString(),
      contributionIds,
    });
    for (const id of contributionIds) {
      writes.push({ op: 'update', table: 'list_item_contributions', id, fields: { deleted_at: at } });
    }
    writes.push({ op: 'update', table: 'list_items', id: item.id, fields: { checked_at: null, checked_by: null } });
    writes.push({ op: 'insert', table: 'list_item_contributions', id: contributionId, fields: { list_item_id: item.id, ...contributionFields } });
    item.live = [contribution];
    results.push({
      itemId: item.id,
      contributionId,
      kind: 'reopen',
      reopened: { checkedAt: snapshotItem.checkedAt!, checkedBy: snapshotItem.checkedBy, contributionIds },
      ...twin,
    });
  });

  return { writes, preconditions, results };
}

/**
 * One use of the add's ingredient in the household's history (spec 4.2), which unhides it, and one
 * use of its unit if its amount has a quantity; `units` learns the unit use.
 */
function recordUse(writes: Write[], units: IngredientUnits, householdId: string, add: ParsedAdd, amount: Amount, at: Date) {
  writes.push({
    op: 'upsert',
    table: 'ingredient_usage',
    key: { household_id: householdId, ingredient_name: add.ingredientName },
    fields: { display_name: add.displayName, last_used_at: at.toISOString(), hidden_at: null },
    counters: { use_count: 1 },
  });
  if (amount.quantity === null) return;
  const key = unitKey(amount.unit);
  writes.push({
    op: 'upsert',
    table: 'ingredient_unit_usage',
    key: { household_id: householdId, ingredient_name: add.ingredientName, unit_key: key },
    fields: { last_used_at: at.toISOString() },
    counters: { use_count: 1 },
  });
  const row = units.unitUsage.find((r) => r.unitKey === key);
  units.unitUsage = row
    ? units.unitUsage.map((r) => (r === row ? { ...r, useCount: r.useCount + 1, lastUsedAt: at } : r))
    : [...units.unitUsage, { unitKey: key, useCount: 1, lastUsedAt: at }];
}
