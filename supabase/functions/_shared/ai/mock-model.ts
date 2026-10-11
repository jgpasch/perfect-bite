// `AI_MODEL_CATEGORIZE=mock` (spec §8.3): a deterministic fake categorizer with no key, no
// network and no cost. Keyword rules only; good enough to watch items leave "Sorting...".
import type { CategorySlug, UnitKey } from '@shared/index.ts';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { MOCK_MODEL_ID } from './registry.ts';
import type { CategorizeOutput } from './tasks.ts';

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

export function mockCategorizeModel(): LanguageModel {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: MOCK_MODEL_ID,
    doGenerate: async (options) => {
      const user = options.prompt.find((m) => m.role === 'user');
      const text =
        user && Array.isArray(user.content)
          ? user.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
          : '';
      const answer = mockCategorize(namesFromPrompt(text));
      return {
        content: [{ type: 'text', text: JSON.stringify(answer) }],
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
