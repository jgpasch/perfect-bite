// The Add to collection sheet with several recipes (board D) closes back to the Recipes tab's Select mode,
// which leaves Select mode and shows what Done did ("Added 4 recipes to Mom's cookbook"): the sheet stores
// the result as it closes, and the tab takes it as it gains focus (or at once, if it's showing).
import { i18n } from '@/i18n';

export type CollectionTicksResult = {
  recipeCount: number;
  /** The collections Done put all of them in, and took all of them out of. */
  added: readonly { id: string; name: string }[];
  removed: readonly { id: string; name: string }[];
};

let pending: CollectionTicksResult | null = null;
const listeners = new Set<() => void>();

export function setCollectionTicksResult(result: CollectionTicksResult): void {
  pending = result;
  for (const listener of [...listeners]) listener();
}

/** Tells a screen that's already showing about a result set while it shows. */
export function onCollectionTicksResult(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The pending result, once: taking it clears it. */
export function takeCollectionTicksResult(): CollectionTicksResult | null {
  const result = pending;
  pending = null;
  return result;
}

/**
 * The toast for a Done: what it added ("Added 4 recipes to Mom's cookbook", or "… to 2 collections"), else
 * what it removed ("Removed 4 recipes from Mom's cookbook"); null when it changed nothing.
 */
export function collectionTicksToast(result: CollectionTicksResult): { message: string; emphasis?: string } | null {
  const recipes = i18n.t('recipes.collections.count', { count: result.recipeCount });
  const changed = result.added.length > 0 ? result.added : result.removed;
  const adding = result.added.length > 0;
  if (changed.length === 0) return null;
  if (changed.length === 1) {
    const { name } = changed[0];
    return { message: i18n.t(adding ? 'recipes.collections.addedTo' : 'recipes.collections.removedFrom', { recipes, name }), emphasis: name };
  }
  return {
    message: i18n.t(adding ? 'recipes.collections.addedToMany' : 'recipes.collections.removedFromMany', { recipes, count: changed.length }),
  };
}
