// How `yarn ai:steps` and `yarn ai:recipe` print a step match: each step with its ingredients under
// it, then "Not in a step".
import { displayItemName } from '@shared/index.ts';

import type { StepMatch } from '../_shared/ai/tasks.ts';

/** What the printout needs of a recipe: its steps and ingredients, in order. */
export type PrintedRecipe = {
  steps: readonly string[];
  ingredients: readonly { name: string; quantity: number | null; unit: string | null }[];
};

function number(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Pure: an ingredient's amount as the cook screen reads it, with a step's share: "2 lb", "1 of 3", "0.5 of 2 tbsp". */
export function formatAmount(quantity: number | null, unit: string | null, share: number | null = null): string {
  if (quantity === null) return unit ?? '';
  const total = [number(quantity), unit].filter(Boolean).join(' ');
  return share === null ? total : `${number(share)} of ${total}`;
}

function table(rows: string[][], indent: string): string {
  const width = Math.max(...rows.map((r) => [...r[0]].length));
  return rows.map((r) => `${indent}${r[0]}${' '.repeat(width - [...r[0]].length)}  ${r[1]}`.trimEnd()).join('\n');
}

/** Pure: each step with its ingredients under it, then "Not in a step". */
export function formatMatch(recipe: PrintedRecipe, match: StepMatch): string {
  const placed = new Set(match.flat().map((use) => use.ingredient));
  const lines: string[] = [];
  recipe.steps.forEach((text, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${text}`);
    const uses = match[i];
    if (uses.length === 0) {
      lines.push('      (no ingredients)');
    } else {
      const rows = uses.map((use) => {
        const item = recipe.ingredients[use.ingredient];
        return [displayItemName(item.name), formatAmount(item.quantity, item.unit, use.quantity)];
      });
      lines.push(table(rows, '      '));
    }
    lines.push('');
  });
  const unplaced = recipe.ingredients.filter((_, i) => !placed.has(i));
  lines.push('Not in a step');
  lines.push(
    unplaced.length === 0
      ? '      (none)'
      : table(unplaced.map((item) => [displayItemName(item.name), formatAmount(item.quantity, item.unit)]), '      '),
  );
  return lines.join('\n');
}
