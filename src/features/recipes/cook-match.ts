// Cook mode with ingredients under each step (spec 4.5; board 3 G and I): the ticks, one per use of
// an ingredient (in a step, or in Also needed for one in no step), and how each use's amount reads; and the
// page's step sections (spec 4.5 "Step sections", boards B and C): titles, the method picker and folds.
import { formatAmount, type Amount } from '@/domain/quantity-display';
import { i18n } from '@/i18n';
import { choiceGroups, recipeSections, stepPath, type RecipeStepEntry } from '@/shared';

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

/**
 * A use as one phrase, amount first: "2 tbsp butter", a share "1 of 3 limes", a split "2 lb chicken thighs,
 * part", or just "spaghetti" with no quantity. An upcoming step's ingredient line joins these with " · ".
 */
export function stepUseText(
  ingredient: Amount & { displayName: string },
  share: number | null,
  split: boolean,
  servings: number | null,
  base: number | null,
): string {
  if (share !== null && ingredient.quantity !== null) return stepAmount(ingredient, share, split, servings, base).spoken;
  const whole = cookAmount(ingredient, servings, base);
  if (!whole) return ingredient.displayName;
  return i18n.t(split ? 'recipes.cook.useTextPart' : 'recipes.cook.useText', { amount: whole, name: ingredient.displayName });
}

/**
 * One thing on the cook screen's page, in order (spec 4.5 "Step sections", boards B and C). `title`: a named
 * section's title over its cards; `group` is set for a choice group's picked option, which has Change method.
 * `fold`: a named section all ticked and behind the current step's card, folded to one row. `picker`: an unpicked
 * choice group's "How are you cooking it?" card, `current` when every step before it is ticked. `step`: a step
 * card, `index` into `stepTexts`, `number` from 1 along `stepPath`.
 */
export type CookBlock =
  | { kind: 'title'; section: number; title: string; group: number | null }
  | { kind: 'fold'; section: number; title: string; count: number }
  | { kind: 'picker'; group: number; options: { title: string; count: number }[]; current: boolean }
  | { kind: 'step'; index: number; number: number; state: 'done' | 'current' | 'upcoming' };

/** The current card: the first unticked step shown, or a choice group with no pick; null when everything's done. */
export type CookCurrent = { kind: 'step'; index: number } | { kind: 'picker'; group: number } | null;

export type CookPlan = {
  blocks: CookBlock[];
  current: CookCurrent;
  /** Ticked steps among those shown: the shared ones and the picked options'. */
  done: number;
  /** The steps shown (all of them once every choice group has a pick). */
  total: number;
  /** Some choice group has no pick yet ("3 steps done · pick a method"). */
  picking: boolean;
};

type CookUnit = { kind: 'section'; section: number; group: number | null } | { kind: 'picker'; group: number };

/**
 * The cook screen's page for the recipe's `entries`, the pick in each choice group (`picks[g]`, null or
 * missing for none), the ticks (by index into `stepTexts`) and the sections unfolded by a tap. Ticks in an
 * option not picked are kept but don't count. Without headings it's every step in turn, as before sections.
 */
export function cookPlan(
  entries: readonly RecipeStepEntry[] | null | undefined,
  picks: readonly (number | null | undefined)[],
  ticked: readonly boolean[],
  unfolded: ReadonlySet<number> = new Set(),
): CookPlan {
  const sections = recipeSections(entries);
  const groups = choiceGroups(sections);
  const pickOf = (g: number) => {
    const pick = picks[g];
    return pick != null && Number.isInteger(pick) && pick >= 0 && pick < groups[g].length ? pick : null;
  };
  // What the page runs through: the sections, each choice group standing as its picked option or its picker.
  const units: CookUnit[] = [];
  sections.forEach((section, i) => {
    const group = groups.findIndex((options) => options[0] === i);
    if (group >= 0) {
      const pick = pickOf(group);
      units.push(pick === null ? { kind: 'picker', group } : { kind: 'section', section: groups[group][pick], group });
    } else if (!section.choice) {
      units.push({ kind: 'section', section: i, group: null });
    }
  });

  let current: CookCurrent = null;
  let currentUnit = units.length;
  for (const [u, unit] of units.entries()) {
    if (unit.kind === 'picker') current = { kind: 'picker', group: unit.group };
    else {
      const index = sections[unit.section].steps.find((step) => !ticked[step]);
      if (index !== undefined) current = { kind: 'step', index };
    }
    if (current) {
      currentUnit = u;
      break;
    }
  }

  // Sections fold only behind a current step: with the picker current, the steps just done stay open (board B).
  const foldBefore = current?.kind === 'step' ? currentUnit : -1;
  const numbers = new Map(stepPath(entries, picks.map((pick) => pick ?? 0)).map((index, i) => [index, i + 1]));
  const blocks: CookBlock[] = [];
  let done = 0;
  let total = 0;
  units.forEach((unit, u) => {
    if (unit.kind === 'picker') {
      const options = groups[unit.group].map((o) => ({ title: sections[o].title ?? '', count: sections[o].steps.length }));
      blocks.push({ kind: 'picker', group: unit.group, options, current: u === currentUnit });
      return;
    }
    const { title, steps } = sections[unit.section];
    const ticks = steps.filter((step) => ticked[step]).length;
    total += steps.length;
    done += ticks;
    if (title !== null && steps.length > 0 && ticks === steps.length && u < foldBefore &&!unfolded.has(unit.section)) {
      blocks.push({ kind: 'fold', section: unit.section, title, count: steps.length });
      return;
    }
    if (title !== null) blocks.push({ kind: 'title', section: unit.section, title, group: unit.group });
    for (const index of steps) {
      const state = ticked[index] ? 'done' : current?.kind === 'step' && current.index === index ? 'current' : 'upcoming';
      blocks.push({ kind: 'step', index, number: numbers.get(index) ?? 0, state });
    }
  });
  return { blocks, current, done, total, picking: units.some((unit) => unit.kind === 'picker') };
}

/** `picks` with group `group`'s set to `option`, or cleared with null (Change method). */
export function withCookPick(picks: readonly (number | null)[], group: number, option: number | null): (number | null)[] {
  const next = Array.from({ length: Math.max(picks.length, group + 1) }, (_, g) => picks[g] ?? null);
  next[group] = option;
  return next;
}
