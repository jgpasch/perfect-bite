// The wire shape of one outbox entry (spec 7.1): a field-level patch, as `apply_mutations` takes it.
// Kept free of imports so the schema can use the type.

/** A JSON value as it goes over the wire: dates are ISO strings, `jsonb` columns (e.g. `recipes.tags`) JSON. */
export type WireValue = string | number | boolean | null | WireValue[] | { [key: string]: WireValue };

export type Mutation = {
  /** The Postgres table, e.g. 'list_items'. */
  table: string;
  /** The row, for tables keyed by `id`. */
  id?: string;
  /** The row, for tables with a composite key (snake_case columns), e.g. `{ household_id, ingredient_name }`. */
  key?: Record<string, string>;
  hlc: string;
  /** Fields set, by Postgres column name. An insert sends every column but the key and server-owned ones. */
  fields: Record<string, WireValue>;
  /** Deltas that add up across devices (the usage tables' `use_count`). */
  counters?: Record<string, number>;
  /**
   * The row was removed. Only for the user's own aisle order, which hard-deletes; household
   * tables soft-delete with a `deleted_at` field (or a null override) instead.
   */
  delete?: true;
};
