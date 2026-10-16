// Cook mode with ingredients under each step (spec 4.5; board 3 G and I): the ticks, one per use of
// an ingredient (in a step, or in Also needed for one in no step), and how each use's amount reads.
import { formatAmount, type Amount } from '@/domain/quantity-display';
import { i18n } from '@/i18n';

import { scaledAmount } from './recipe-view';
import type { StepMatch } from './step-match';

/** One use's tick: the step's index (from 0), or `also` for Also needed, and the ingredient. */
export function tickKey(step: number | 'also', ingredientId: string): string {
  return `${step}:${ingredientId}`;
}

/** Per ingredient id, the keys of all its uses: each step it's in, or Also needed. */
export function usesByIngredient(match: StepMatch<{ id: string }>): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  const add = (id: string, key: string) => uses.set(id, [...(uses.get(id) ?? []), key]);
  match.steps.forEach((step, index) => step.forEach((use) => add(use.ingredient.id, tickKey(index, use.ingredient.id))));
  for (const ingredient of match.unplaced) add(ingredient.id, tickKey('also', ingredient.id));
  return uses;
}

/** Ticking a step ticks its ingredients there; unticking it leaves them as they are. */
export function tickUses(ticked: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  return new Set([...ticked, ...keys]);
}

/** An All ingredients row is ticked when every one of its uses is. */
export function allTicked(ticked: ReadonlySet<string>, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => ticked.has(key));
}

/** Ticking an All ingredients row ticks all its uses; unticking it (all ticked) unticks them all. */
export function toggleAllUses(ticked: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(ticked);
  if (allTicked(ticked, keys)) keys.forEach((key) => next.delete(key));
  else keys.forEach((key) => next.add(key));
  return next;
}

/** One use ticked or unticked on its own. */
export function toggleUse(ticked: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(ticked);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** An amount at the chosen servings, as the cook screen shows it (as written without servings). */
export function cookAmount(amount: Amount, servings: number | null, base: number | null): string {
  return base !== null && servings !== null ? scaledAmount(amount, servings, base) : formatAmount(amount);
}

/**
 * How a use's amount reads under a step: a share is its own scaled amount "of 3" (`text`; read
 * "1 of 3 limes"); a split with no share (the ingredient is in more than one step) is the whole
 * amount followed by "part"; otherwise the whole amount. Empty with no quantity.
 */
export function stepAmount(
  ingredient: Amount & { displayName: string },
  share: number | null,
  split: boolean,
  servings: number | null,
  base: number | null,
): { text: string; spoken: string } {
  const whole = cookAmount(ingredient, servings, base);
  if (share !== null && ingredient.quantity !== null) {
    const part = cookAmount({ quantity: share, unit: ingredient.unit }, servings, base);
    const total = cookAmount({ quantity: ingredient.quantity, unit: null }, servings, base);
    return {
      text: i18n.t('recipes.cook.share', { share: part, total }),
      spoken: i18n.t('recipes.cook.shareSpoken', { share: part, total: whole, name: ingredient.displayName }),
    };
  }
  if (split && whole) {
    return { text: i18n.t('recipes.cook.part', { amount: whole }), spoken: i18n.t('recipes.cook.partSpoken', { amount: whole }) };
  }
  return { text: whole, spoken: whole };
}
