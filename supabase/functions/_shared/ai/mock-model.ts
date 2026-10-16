// `AI_MODEL_*=mock` (spec §8.3): deterministic fakes with no key, no network and no cost. The
// categorizer uses keyword rules only; good enough to watch items leave "Sorting...".
import { normalizeIngredientName, parseQuantity, type CategorySlug, type UnitKey } from '@shared/index.ts';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { MOCK_MODEL_ID } from './registry.ts';
import { MEXICAN_WORDS, NO_LINK_EXAMPLES } from './spanish-words.ts';
import type { CategorizeOutput, ExtractRecipeOutput, MatchRecipeStepsOutput, SuggestTagsOutput } from './tasks.ts';

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

type MockTranslation = { lang: 'en' | 'es'; translation: string; exact_equivalent: boolean };

/**
 * Translations by name key, from the shared word lists (spec 4.15): `MEXICAN_WORDS` pairs are exact
 * both ways (`tomato` ↔ `jitomate`), `NO_LINK_EXAMPLES` pairs aren't (`tomate` → `tomato`), and a
 * word-list pair whose Spanish word is a no-link example is left out (`cream` ↔ `crema`,
 * `chili pepper` ↔ `chile`). So is a pair spelt the same (`tuna`): there's no translation. A no-link
 * example's English word keeps its word-list translation (`tomato` → `jitomate`, not `tomate`).
 */
const MOCK_TRANSLATIONS: ReadonlyMap<string, MockTranslation> = (() => {
  const map = new Map<string, MockTranslation>();
  const add = (english: string, spanish: string, exact: boolean) => {
    const en = normalizeIngredientName(english);
    const es = normalizeIngredientName(spanish);
    if (en === es) return;
    if (!map.has(en)) map.set(en, { lang: 'en', translation: spanish, exact_equivalent: exact });
    map.set(es, { lang: 'es', translation: english, exact_equivalent: exact });
  };
  const noLink = new Set(NO_LINK_EXAMPLES.map(([spanish]) => normalizeIngredientName(spanish)));
  for (const [english, mexican] of MEXICAN_WORDS) {
    if (!noLink.has(normalizeIngredientName(mexican))) add(english, mexican, true);
  }
  for (const [spanish, english] of NO_LINK_EXAMPLES) add(english, spanish, false);
  return map;
})();

const NO_TRANSLATION = { lang: 'en' as const, translation: null, exact_equivalent: false };

/**
 * The keyword categorizer. Language and translation come from the shared word lists
 * (`MOCK_TRANSLATIONS`); any other name is English with no translation.
 */
export function mockCategorize(names: readonly string[]): CategorizeOutput {
  return {
    results: names.map((name) => {
      const lower = name.toLowerCase();
      if (NOT_GROCERY.some((k) => lower.includes(k))) {
        return { name, category: 'other' as const, is_grocery_item: false, unit: 'count' as const, ...NO_TRANSLATION };
      }
      const rule = KEYWORD_RULES.find(([, keywords]) => keywords.some((k) => lower.includes(k)));
      const unit = UNIT_RULES.find(([, keywords]) => keywords.some((k) => lower.includes(k)));
      return {
        name,
        category: rule ? rule[0] : ('pantry' as const),
        is_grocery_item: true,
        unit: unit ? unit[0] : ('count' as const),
        ...(MOCK_TRANSLATIONS.get(normalizeIngredientName(name)) ?? NO_TRANSLATION),
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
 * dropped; anything after the first comma is the note. No ingredients means not a recipe. It
 * never tags and gives no time or steps, so an import shows the JSON-LD time and steps (the
 * handler's) or none.
 */
export function mockExtractRecipe(page: MockRecipePage): ExtractRecipeOutput {
  const tags = { meal: [], cuisine: [], protein: [], diet: [], method: [] };
  const lines = page.ingredient_lines ?? (page.text ?? '').split('\n').filter((line) => AMOUNT_LINE.test(line));
  const ingredients = lines
    .filter((line) => !/:\s*$/.test(line))
    .map((line) => {
      const parsed = parseQuantity(line);
      const [name, ...rest] = parsed.name.split(',');
      return { name: name.trim(), quantity: parsed.quantity, unit: parsed.unit, note: rest.join(',').trim() };
    });
  if (ingredients.length === 0) return { is_recipe: false, name: '', servings: null, ingredients: [], tags, total_minutes: null, steps: [] };
  return { is_recipe: true, name: page.title ?? '', servings: null, ingredients, tags, total_minutes: null, steps: [] };
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

/** The recipe the suggest-recipe-tags prompt carries (`buildSuggestRecipeTagsPrompt`). */
export type MockTagsRecipe = { name: string; ingredients: string[] };

/** Per facet, slug and the words that suggest it. Every match counts; the schema caps the facet. */
const TAG_RULES: { facet: keyof SuggestTagsOutput; slug: string; words: RegExp }[] = [
  { facet: 'meal', slug: 'breakfast', words: /\b(pancakes?|waffles?|oatmeal|granola)\b/ },
  { facet: 'meal', slug: 'dessert', words: /\b(cakes?|cookies?|brownies?|pie|cheesecake)\b/ },
  { facet: 'cuisine', slug: 'mexican', words: /\b(tacos?|enchiladas?|salsa|burritos?)\b/ },
  { facet: 'cuisine', slug: 'italian', words: /\b(pasta|spaghetti|risotto|lasagna)\b/ },
  { facet: 'cuisine', slug: 'indian', words: /\b(curry|masala|dal|tikka)\b/ },
  { facet: 'protein', slug: 'chicken', words: /\bchicken\b/ },
  { facet: 'protein', slug: 'beef', words: /\b(beef|steak)\b/ },
  { facet: 'protein', slug: 'pork', words: /\b(pork|bacon)\b/ },
  { facet: 'protein', slug: 'fish', words: /\b(salmon|cod|tuna|fish)\b/ },
  { facet: 'protein', slug: 'shellfish', words: /\b(shrimp|prawns?|crab|scallops?)\b/ },
  { facet: 'protein', slug: 'eggs', words: /\beggs?\b/ },
  { facet: 'protein', slug: 'tofu-tempeh', words: /\b(tofu|tempeh)\b/ },
  { facet: 'protein', slug: 'beans-lentils', words: /\b(beans?|lentils?|chickpeas?)\b/ },
  { facet: 'method', slug: 'slow-cooker', words: /\b(slow cooker|crock ?pot)\b/ },
  { facet: 'method', slug: 'pressure-cooker', words: /\b(instant pot|pressure cooker)\b/ },
  { facet: 'method', slug: 'sheet-pan', words: /\bsheet pan\b/ },
];

/**
 * `AI_MODEL_TAGS=mock` (spec 6.7): tags from words in the name and ingredient lines ("chicken" →
 * protein chicken, "tofu" → tofu-tempeh, "cake" → meal dessert), in rule order. Never a diet: a
 * wrong one would matter.
 */
export function mockSuggestTags(recipe: MockTagsRecipe): SuggestTagsOutput {
  const text = [recipe.name, ...recipe.ingredients].join('\n').toLowerCase();
  const tags: SuggestTagsOutput = { meal: [], cuisine: [], protein: [], diet: [], method: [] };
  for (const rule of TAG_RULES) if (rule.words.test(text)) tags[rule.facet].push(rule.slug);
  return tags;
}

/** The recipe is the first JSON object in the user prompt; anything else is an empty recipe. */
export function tagsRecipeFromPrompt(prompt: string): MockTagsRecipe {
  const start = prompt.indexOf('{');
  const end = prompt.lastIndexOf('}');
  const empty: MockTagsRecipe = { name: '', ingredients: [] };
  if (start < 0 || end < start) return empty;
  try {
    const parsed: unknown = JSON.parse(prompt.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
    const { name, ingredients } = parsed as Record<string, unknown>;
    return {
      name: typeof name === 'string' ? name : '',
      ingredients: Array.isArray(ingredients) ? ingredients.filter((l): l is string => typeof l === 'string') : [],
    };
  } catch {
    return empty;
  }
}

/** The recipe the match-recipe-steps prompt carries (`buildMatchRecipeStepsPrompt`). */
export type MockStepsRecipe = { steps: string[]; ingredients: string[] };

/** A text's words as ingredient keys (lowercase, singular), for the steps mock. */
function wordKeys(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean).map(normalizeIngredientName));
}

/**
 * `AI_MODEL_STEPS=mock` (spec 4.5): a step uses an ingredient when the last word of the
 * ingredient's name appears in the step's text (`chicken thighs` in "toss the thighs"), singular
 * or plural. Every step that names it gets it, with no share.
 */
export function mockMatchSteps(recipe: MockStepsRecipe): MatchRecipeStepsOutput {
  const heads = recipe.ingredients.map((name) => normalizeIngredientName(name).split(' ').pop() ?? '');
  return {
    steps: recipe.steps.map((text, i) => {
      const words = wordKeys(text);
      const uses = heads.flatMap((head, j) => (head !== '' && words.has(head) ? [{ ingredient: j + 1, quantity: null }] : []));
      return { step: i + 1, uses };
    }),
  };
}

/** The recipe is the first JSON object in the user prompt; anything else is an empty recipe. */
export function stepsRecipeFromPrompt(prompt: string): MockStepsRecipe {
  const start = prompt.indexOf('{');
  const end = prompt.lastIndexOf('}');
  const empty: MockStepsRecipe = { steps: [], ingredients: [] };
  if (start < 0 || end < start) return empty;
  try {
    const parsed: unknown = JSON.parse(prompt.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
    const { steps, ingredients } = parsed as Record<string, unknown>;
    const field = (list: unknown, key: string) =>
      Array.isArray(list) ? list.map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : null)).map((v) => (typeof v === 'string' ? v : '')) : [];
    return { steps: field(steps, 'text'), ingredients: field(ingredients, 'name') };
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

export function mockTagsModel(): LanguageModel {
  return mockModel((prompt) => mockSuggestTags(tagsRecipeFromPrompt(prompt)));
}

export function mockStepsModel(): LanguageModel {
  return mockModel((prompt) => mockMatchSteps(stepsRecipeFromPrompt(prompt)));
}
