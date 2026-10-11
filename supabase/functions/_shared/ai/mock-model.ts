// `AI_MODEL_*=mock` (spec §8.3): deterministic fakes with no key, no network and no cost. The
// categorizer uses keyword rules only; good enough to watch items leave "Sorting...".
import { parseQuantity, type CategorySlug, type UnitKey } from '@shared/index.ts';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { MOCK_MODEL_ID } from './registry.ts';
import type { CategorizeOutput, ExtractRecipeOutput } from './tasks.ts';

/** First match wins, so more specific rules come first. Anything unmatched is pantry. */
const KEYWORD_RULES: [CategorySlug, string[]][] = [
  ['pet', ['dog food', 'cat food', 'kitty litter']],
  ['baby', ['diaper', 'baby wipe', 'baby food']],
  ['household', ['soap', 'detergent', 'paper towel', 'toilet paper', 'trash bag', 'sponge', 'bleach']],
  ['personal-care', ['shampoo', 'conditioner', 'toothpaste', 'deodorant', 'razor']],
  ['frozen', ['frozen', 'ice cream']],
  ['meat-seafood', ['chicken', 'beef', 'salmon', 'pork', 'turkey', 'shrimp', 'bacon', 'sausage', 'steak']],
  ['dairy-eggs', ['milk', 'cheese', 'yogurt', 'butter', 'egg', 'cream']],
  ['produce', ['apple', 'banana', 'lettuce', 'onion', 'tomato', 'potato', 'carrot', 'lemon', 'lime', 'berry']],
  ['bakery', ['bread', 'bagel', 'bun', 'tortilla', 'croissant']],
  ['beverages', ['coffee', 'tea', 'juice', 'soda', 'water', 'wine', 'beer']],
  ['spices', ['pepper', 'cumin', 'paprika', 'cinnamon', 'oregano', 'salt']],
  ['pasta-grains', ['pasta', 'rice', 'spaghetti', 'noodle', 'quinoa']],
];

/** First match wins; anything unmatched is a count, as are non-groceries. */
const UNIT_RULES: [UnitKey, string[]][] = [
  ['dozen', ['egg']],
  ['gal', ['milk']],
  ['lb', ['chicken', 'beef', 'salmon', 'pork', 'turkey', 'shrimp', 'steak']],
  ['bunch', ['cilantro', 'parsley', 'kale']],
];

/** Errands typed into a list are not groceries (spec §6.4). */
const NOT_GROCERY = ['call ', 'email ', 'pick up '];

export function mockCategorize(names: readonly string[]): CategorizeOutput {
  return {
    results: names.map((name) => {
      const lower = name.toLowerCase();
      if (NOT_GROCERY.some((k) => lower.includes(k))) {
        return { name, category: 'other' as const, is_grocery_item: false, unit: 'count' as const };
      }
      const rule = KEYWORD_RULES.find(([, keywords]) => keywords.some((k) => lower.includes(k)));
      const unit = UNIT_RULES.find(([, keywords]) => keywords.some((k) => lower.includes(k)));
      return {
        name,
        category: rule ? rule[0] : ('pantry' as const),
        is_grocery_item: true,
        unit: unit ? unit[0] : ('count' as const),
      };
    }),
  };
}

/** The names are the first JSON array of strings in the user prompt; anything else gives none. */
export function namesFromPrompt(prompt: string): string[] {
  const start = prompt.indexOf('[');
  const end = prompt.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const parsed: unknown = JSON.parse(prompt.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

/** The page the extract-recipe prompt carries (`buildExtractRecipePrompt`). */
export type MockRecipePage = { title: string | null; ingredient_lines?: string[]; text?: string };

/** A line in page text that starts with an amount: `2 cups flour`, `½ tsp salt`. */
const AMOUNT_LINE = /^\s*[\d½⅓⅔¼¾⅛]/;

/**
 * `AI_MODEL_RECIPE=mock` (spec §6.6): the shared quantity parser over each ingredient line (from
 * page text, each line that starts with an amount). Lines ending in `:` are headings and are
 * dropped; anything after the first comma is the note. No ingredients means not a recipe.
 */
export function mockExtractRecipe(page: MockRecipePage): ExtractRecipeOutput {
  const lines = page.ingredient_lines ?? (page.text ?? '').split('\n').filter((line) => AMOUNT_LINE.test(line));
  const ingredients = lines
    .filter((line) => !/:\s*$/.test(line))
    .map((line) => {
      const parsed = parseQuantity(line);
      const [name, ...rest] = parsed.name.split(',');
      return { name: name.trim(), quantity: parsed.quantity, unit: parsed.unit, note: rest.join(',').trim() };
    });
  if (ingredients.length === 0) return { is_recipe: false, name: '', servings: null, ingredients: [] };
  return { is_recipe: true, name: page.title ?? '', servings: null, ingredients };
}

/** The page is the first JSON object in the user prompt; anything else is an empty page. */
export function pageFromPrompt(prompt: string): MockRecipePage {
  const start = prompt.indexOf('{');
  const end = prompt.lastIndexOf('}');
  const empty: MockRecipePage = { title: null, ingredient_lines: [] };
  if (start < 0 || end < start) return empty;
  try {
    const parsed: unknown = JSON.parse(prompt.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
    const { title, ingredient_lines: lines, text } = parsed as Record<string, unknown>;
    return {
      title: typeof title === 'string' ? title : null,
      ...(Array.isArray(lines) ? { ingredient_lines: lines.filter((l): l is string => typeof l === 'string') } : {}),
      ...(typeof text === 'string' ? { text } : {}),
    };
  } catch {
    return empty;
  }
}

/** A mock model that answers each call with `answer(user prompt text)`. */
function mockModel(answer: (prompt: string) => unknown): LanguageModel {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: MOCK_MODEL_ID,
    doGenerate: async (options) => {
      const user = options.prompt.find((m) => m.role === 'user');
      const text =
        user && Array.isArray(user.content)
          ? user.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
          : '';
      return {
        content: [{ type: 'text', text: JSON.stringify(answer(text)) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, text: 0, reasoning: undefined },
        },
        // What a real provider would have been sent, so `--raw` shows e.g. the thinking setting.
        request: { body: { providerOptions: options.providerOptions ?? null } },
        warnings: [],
      };
    },
  });
}

export function mockCategorizeModel(): LanguageModel {
  return mockModel((prompt) => mockCategorize(namesFromPrompt(prompt)));
}

export function mockRecipeModel(): LanguageModel {
  return mockModel((prompt) => mockExtractRecipe(pageFromPrompt(prompt)));
}
