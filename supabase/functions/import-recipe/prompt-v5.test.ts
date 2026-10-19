// Extract-recipe prompt v5 (spec §6.6 "Sections", 4.5): v4 plus the method's sections and the
// alternatives among them (`choice_sections`), and how the server reads them back.
import { assert, assertEquals, assertStringIncludes } from '@std/assert';

import { mockExtractRecipe, pageFromPrompt } from '../_shared/ai/mock-model.ts';
import { buildExtractRecipePrompt as buildV4 } from '../_shared/ai/prompts/extract-recipe.v4.ts';
import {
  buildExtractRecipePrompt,
  EXTRACT_RECIPE_PROMPT_VERSION,
  MAX_PROMPT_INGREDIENT_LINES,
  PAGE_TEXT_STEP_ALLOWANCE,
} from '../_shared/ai/prompts/extract-recipe.v5.ts';
import {
  CHOICE_SECTIONS_RULES,
  INGREDIENT_ENTRY_RULES,
  SECTION_HEADING_RULE,
  SECTION_NOT_A_STEP_RULE,
  STEP_COPY_RULE,
  STEP_LIMIT_RULES,
  TAG_AND_TIME_RULES,
} from '../_shared/ai/prompts/recipe-extract-rules.ts';
import { STEP_MATCH_RULES } from '../_shared/ai/prompts/step-match-rules.ts';
import { aiTasks, cleanExtractedRecipe, ExtractRecipeOutputSchema, markChoices, type ExtractRecipeOutput } from '../_shared/ai/tasks.ts';

/** The JSON page after the prompt's first line. */
function promptPage(prompt: string): unknown {
  return JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
}

const tags = { meal: [], cuisine: [], protein: [], diet: [], method: [] };

function answer(overrides: Partial<ExtractRecipeOutput>): ExtractRecipeOutput {
  return { is_recipe: true, name: 'Chicken', servings: null, ingredients: [], tags, total_minutes: null, steps: [], step_ingredients: [], choice_sections: [], ...overrides };
}

const step = (n: number, ...uses: [number, number | null][]) => ({ step: n, uses: uses.map(([ingredient, quantity]) => ({ ingredient, quantity })) });

/** The marinade's shape: a shared section, then four ways to cook it. */
const MARINADE = [
  { section: 'Marinate the chicken' },
  'Whisk the marinade.',
  'Coat the chicken.',
  { section: 'Grilling' },
  'Grill it.',
  { section: 'Baking' },
  'Bake it.',
  { section: 'Pan-Frying' },
  'Fry it.',
  { section: 'Broiling' },
  'Broil it.',
];

Deno.test('v5: its own version, the one the extractRecipe task runs', () => {
  assertEquals(EXTRACT_RECIPE_PROMPT_VERSION, 'extract-recipe.v5');
  assertEquals(aiTasks.extractRecipe.promptVersion, 'extract-recipe.v5');
});

Deno.test('v5: the section rules, the choice rules and every rule it keeps from v4', () => {
  const { instructions } = buildExtractRecipePrompt({ title: null, ingredientLines: [], steps: [] });
  for (const block of [INGREDIENT_ENTRY_RULES, STEP_LIMIT_RULES, STEP_MATCH_RULES, CHOICE_SECTIONS_RULES, TAG_AND_TIME_RULES]) {
    assertStringIncludes(instructions, block.join('\n'));
  }
  for (const rule of [
    SECTION_HEADING_RULE,
    SECTION_NOT_A_STEP_RULE,
    'a "## " line without a number is the heading of the section whose steps follow it',
    'Never a section the others build on',
    'Never just one heading',
    'choice_sections to [].',
    'step_ingredients to [] and choice_sections to [].',
    "match these, don't rewrite them, and set steps to [].",
  ]) {
    assertStringIncludes(instructions, rule);
  }
  // v4 told the model to leave headings out; v5 keeps them.
  assert(!instructions.includes(STEP_COPY_RULE), 'not v4’s copy rule');
  assert(!instructions.includes('headings that only group steps'));
  assert(instructions !== buildV4({ title: null, ingredientLines: [], steps: [] }).instructions, 'v5 is a different prompt');
});

Deno.test('v5: JSON-LD headings go as unnumbered ## lines between the steps, which are numbered alone', () => {
  const built = buildExtractRecipePrompt({ title: 'Marinade', ingredientLines: ['2 lb chicken thighs'], steps: MARINADE });
  assertEquals(promptPage(built.prompt), {
    title: 'Marinade',
    ingredient_lines: ['2 lb chicken thighs'],
    steps: [
      '## Marinate the chicken',
      { step: 1, text: 'Whisk the marinade.' },
      { step: 2, text: 'Coat the chicken.' },
      '## Grilling',
      { step: 3, text: 'Grill it.' },
      '## Baking',
      { step: 4, text: 'Bake it.' },
      '## Pan-Frying',
      { step: 5, text: 'Fry it.' },
      '## Broiling',
      { step: 6, text: 'Broil it.' },
    ],
  });
  assertEquals(built.itemCount, 7, 'one line and six steps; headings are not items');
});

Deno.test('v5: without headings the page is v4’s; page text too, with the same room for steps', () => {
  const plain = { title: 'T', ingredientLines: ['1 egg'], steps: ['Boil.', 'Peel.'] };
  assertEquals(buildExtractRecipePrompt(plain).prompt, buildV4(plain).prompt);
  assertEquals(buildExtractRecipePrompt({ title: 'T', ingredientLines: ['1 egg'], steps: [] }).prompt, buildV4({ title: 'T', ingredientLines: ['1 egg'], steps: [] }).prompt);
  const text = buildExtractRecipePrompt({ title: 'Soup', text: '2 leeks\n1. Slice.' });
  assertEquals(text.prompt, buildV4({ title: 'Soup', text: '2 leeks\n1. Slice.' }).prompt);
  assertEquals(text.itemCount, MAX_PROMPT_INGREDIENT_LINES + PAGE_TEXT_STEP_ALLOWANCE);
});

Deno.test('the mock skips the ## lines: it matches the steps only, and marks no choice', () => {
  const { prompt } = buildExtractRecipePrompt({ title: 'Marinade', ingredientLines: ['2 lb chicken thighs'], steps: MARINADE });
  const page = pageFromPrompt(prompt);
  assertEquals(page.steps, ['Whisk the marinade.', 'Coat the chicken.', 'Grill it.', 'Bake it.', 'Fry it.', 'Broil it.']);
  const mock = mockExtractRecipe(page);
  assertEquals(mock.step_ingredients.length, 6);
  assertEquals(mock.choice_sections, []);
});

// --- markChoices and cleanExtractedRecipe ---------------------------------------------------------

const headingsOf = (entries: readonly unknown[]) => entries.filter((e) => typeof e !== 'string');

Deno.test('markChoices: [2,3,4,5] marks those four headings only, numbered over the headings', () => {
  assertEquals(headingsOf(markChoices(MARINADE, [2, 3, 4, 5])), [
    { section: 'Marinate the chicken' },
    { section: 'Grilling', choice: true },
    { section: 'Baking', choice: true },
    { section: 'Pan-Frying', choice: true },
    { section: 'Broiling', choice: true },
  ]);
  // In any order, repeats counted once; steps untouched.
  assertEquals(markChoices(MARINADE, [5, 4, 4, 3, 2]), markChoices(MARINADE, [2, 3, 4, 5]));
  assertEquals(markChoices(MARINADE, [2, 3]).filter((e) => typeof e === 'string'), MARINADE.filter((e) => typeof e === 'string'));
});

Deno.test('markChoices: one number, or numbers that aren’t headings, mark nothing', () => {
  const none = MARINADE.filter((e) => typeof e !== 'string');
  for (const choices of [[], [1], [9], [0, 9], [-1, 2], [2, 2], [1.5, 2], [6, 7]]) {
    assertEquals(headingsOf(markChoices(MARINADE, choices)), none, JSON.stringify(choices));
  }
  // Two good numbers among bad ones still count.
  assertEquals(headingsOf(markChoices(MARINADE, [9, 2, 3, 0])).filter((h) => (h as { choice?: true }).choice).length, 2);
  // A choice the input already had is dropped unless the answer names it.
  assertEquals(markChoices([{ section: 'A', choice: true }, 'x', { section: 'B' }, 'y'], []), [{ section: 'A' }, 'x', { section: 'B' }, 'y']);
  assertEquals(markChoices(['x'], [1, 2]), ['x']);
});

Deno.test('cleanExtractedRecipe: JSON-LD entries keep their headings, choices from the answer, the match on the steps', () => {
  const raw = answer({
    ingredients: [{ name: 'chicken thighs', quantity: 2, unit: 'lb', note: '' }],
    step_ingredients: [1, 2, 3, 4, 5, 6].map((n) => step(n, [1, null])),
    choice_sections: [2, 3, 4, 5],
  });
  const recipe = cleanExtractedRecipe(raw, MARINADE);
  assertEquals(headingsOf(recipe.steps).map((h) => JSON.stringify(h)), [
    '{"section":"Marinate the chicken"}',
    '{"section":"Grilling","choice":true}',
    '{"section":"Baking","choice":true}',
    '{"section":"Pan-Frying","choice":true}',
    '{"section":"Broiling","choice":true}',
  ]);
  assertEquals(recipe.step_ingredients?.length, 6);
  assertEquals(cleanExtractedRecipe({ ...raw, choice_sections: [1] }, MARINADE).steps, MARINADE);
  assertEquals(cleanExtractedRecipe({ ...raw, choice_sections: [9] }, MARINADE).steps, MARINADE);
});

Deno.test('cleanExtractedRecipe: from page text, ## lines are headings (cleaned), numbered for choices as written', () => {
  const recipe = cleanExtractedRecipe(
    answer({
      ingredients: [{ name: 'leeks', quantity: 2, unit: null, note: '' }],
      steps: ['## <b>Prep</b>', '1. Slice the leeks.', '  ## Grill', 'Grill them.', '## Roast', 'Roast them.'],
      step_ingredients: [step(1, [1, null]), step(2, [1, null]), step(3, [1, null])],
      choice_sections: [2, 3],
    }),
  );
  assertEquals(recipe.steps, [{ section: 'Prep' }, 'Slice the leeks.', { section: 'Grill', choice: true }, 'Grill them.', { section: 'Roast', choice: true }, 'Roast them.']);
  assertEquals(recipe.step_ingredients?.length, 3);
});

Deno.test('cleanExtractedRecipe: "##" without a space, or mid-line, is a step, not a heading', () => {
  const recipe = cleanExtractedRecipe(answer({ ingredients: [{ name: 'a', quantity: null, unit: null, note: '' }], steps: ['##Prep', 'Mix ## well.'] }));
  assertEquals(recipe.steps, ['##Prep', 'Mix ## well.']);
});

Deno.test('cleanExtractedRecipe: a step cleaning drops still shifts the match, headings or not', () => {
  const recipe = cleanExtractedRecipe(
    answer({ ingredients: [{ name: 'a', quantity: null, unit: null, note: '' }], steps: ['## Prep', 'Slice.', ' ', 'Simmer.'], step_ingredients: [step(1), step(2), step(3)] }),
  );
  assertEquals(recipe.steps, [{ section: 'Prep' }, 'Slice.', 'Simmer.']);
  assertEquals(recipe.step_ingredients, null);
});

Deno.test('the answer schema: choice_sections that are missing or malformed parse as []', () => {
  const base = answer({ ingredients: [{ name: 'a', quantity: null, unit: null, note: '' }] });
  const { choice_sections: _, ...withoutChoices } = base;
  assertEquals(ExtractRecipeOutputSchema.parse(withoutChoices).choice_sections, []);
  assertEquals(ExtractRecipeOutputSchema.parse({ ...base, choice_sections: 'all' }).choice_sections, []);
  assertEquals(ExtractRecipeOutputSchema.parse({ ...base, choice_sections: [2, 3] }).choice_sections, [2, 3]);
});
