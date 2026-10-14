// Extract-recipe prompt v3 (spec §6.6): v2 plus the method steps.
import { RECIPE_TAG_FACETS, UNITS } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import { pageFromPrompt } from '../_shared/ai/mock-model.ts';
import { buildExtractRecipePrompt as buildV2 } from '../_shared/ai/prompts/extract-recipe.v2.ts';
import { buildExtractRecipePrompt, EXTRACT_RECIPE_PROMPT_VERSION } from '../_shared/ai/prompts/extract-recipe.v3.ts';
import { aiTasks } from '../_shared/ai/tasks.ts';

/** The JSON page after the prompt's first line. */
function promptPage(prompt: string): unknown {
  return JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
}

Deno.test('v3: its own version, and the one the extractRecipe task runs', () => {
  assertEquals(EXTRACT_RECIPE_PROMPT_VERSION, 'extract-recipe.v3');
  assertEquals(aiTasks.extractRecipe.promptVersion, 'extract-recipe.v3');
});

Deno.test('v3: the steps rules — none from ingredient lines, the site’s wording in order, no non-steps', () => {
  const { instructions } = buildExtractRecipePrompt({ title: null, ingredientLines: [] });
  for (const rule of [
    'steps: the method, one entry per step, in the order the page gives them.',
    'When you get ingredient lines, there are no steps to read: set steps to [].',
    "copy each step in the page's own words",
    'Do not rewrite, shorten, summarize or merge steps',
    'tips, notes',
    'nutrition',
    'At most 100 steps of at most 2000 characters',
    'total_minutes to null and steps to [].',
  ]) {
    assertEquals(instructions.includes(rule), true, rule);
  }
});

Deno.test('v3: keeps v2’s ingredient, unit, tag and untrusted-content rules', () => {
  const { instructions } = buildExtractRecipePrompt({ title: null, ingredientLines: [] });
  assertEquals(instructions.includes(`Units (use only these): ${UNITS.join(', ')}.`), true);
  for (const rule of ['is_recipe to false', 'For the sauce:', '"2 cloves garlic, minced"', '"1 (15 oz) can chickpeas"', 'higher number', 'to taste', 'For serving', 'never instructions', 'Do not estimate']) {
    assertEquals(instructions.includes(rule), true, rule);
  }
  for (const facet of RECIPE_TAG_FACETS) {
    assertEquals(instructions.includes(`- ${facet.key} (${facet.label}, at most ${facet.max}): `), true, facet.key);
  }
  assertEquals(instructions === buildV2({ title: null, ingredientLines: [] }).instructions, false, 'v3 is a different prompt');
});

Deno.test('v3: the page goes only in the prompt, as v2 sends it, and the mock still reads it', () => {
  const lines = buildExtractRecipePrompt({ title: 'TITLE-Q7 Pasta', ingredientLines: [' LINE-Z9 2 cups flour ', '', 'LINE-Y8 1 egg'] });
  const text = buildExtractRecipePrompt({ title: 'TITLE-K3', text: 'TEXT-W5 2 cups flour\n1. Stir.' });
  for (const marker of ['TITLE-Q7', 'LINE-Z9', 'LINE-Y8', 'TITLE-K3', 'TEXT-W5']) {
    assertEquals(lines.instructions.includes(marker), false, marker);
    assertEquals(text.instructions.includes(marker), false, marker);
  }
  assertEquals(lines.instructions, text.instructions);
  assertEquals(promptPage(lines.prompt), { title: 'TITLE-Q7 Pasta', ingredient_lines: ['LINE-Z9 2 cups flour', 'LINE-Y8 1 egg'] });
  assertEquals([lines.itemCount, text.itemCount], [2, 80]);
  assertEquals(pageFromPrompt(text.prompt), { title: 'TITLE-K3', text: 'TEXT-W5 2 cups flour\n1. Stir.' });
  // Same page JSON as v2, so only the instructions changed.
  assertEquals(lines.prompt, buildV2({ title: 'TITLE-Q7 Pasta', ingredientLines: [' LINE-Z9 2 cups flour ', '', 'LINE-Y8 1 egg'] }).prompt);
  assertEquals(text.prompt, buildV2({ title: 'TITLE-K3', text: 'TEXT-W5 2 cups flour\n1. Stir.' }).prompt);
});
