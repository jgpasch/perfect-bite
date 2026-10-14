// Every AI task and its model, in one place (spec §6.4). Switch a model with
// `supabase secrets set AI_MODEL_CATEGORIZE=google:gemini-3.8-flash`; no code change.
import {
  cleanRecipeSteps,
  ExtractedRecipeSchema,
  ExtractedRecipeTagsSchema,
  MAX_RECIPE_INGREDIENT_NAME_LENGTH,
  MAX_RECIPE_INGREDIENTS,
  MAX_RECIPE_NAME_LENGTH,
  MAX_RECIPE_NOTE_LENGTH,
  MAX_TOTAL_MINUTES,
  MIN_TOTAL_MINUTES,
  normalizeIngredientName,
  parseAmount,
  SYSTEM_CATEGORIES,
  UNIT_KEYS,
  type CategorySlug,
  type ExtractedRecipe,
  type RecipeTags,
  type Unit,
} from '@shared/index.ts';
import { z } from 'zod';

import { mockCategorizeModel, mockRecipeModel, mockTagsModel } from './mock-model.ts';
import { CATEGORIZE_PROMPT_VERSION } from './prompts/categorize.v3.ts';
import { EXTRACT_RECIPE_PROMPT_VERSION, truncateText } from './prompts/extract-recipe.v3.ts';
import { SUGGEST_RECIPE_TAGS_PROMPT_VERSION } from './prompts/suggest-recipe-tags.v1.ts';

/** `AI_MODEL_*=off` is the kill switch: no model call at all. */
export const AI_OFF = 'off';

const CATEGORY_SLUGS = SYSTEM_CATEGORIES.map((c) => c.slug) as [CategorySlug, ...CategorySlug[]];

/** The languages the categorizer tells apart (spec 4.15); `other` is stored as an unknown (null) `lang`. */
export const CATEGORIZE_LANGS = ['en', 'es', 'other'] as const;

export const CategorizeOutputSchema = z.object({
  results: z.array(
    z.object({
      name: z.string(),
      category: z.enum(CATEGORY_SLUGS),
      is_grocery_item: z.boolean(),
      /** How it's usually bought (spec 4.2): a unit key, `count` for a plain number. */
      unit: z.enum(UNIT_KEYS),
      /** The name's language. */
      lang: z.enum(CATEGORIZE_LANGS),
      /**
       * Mexican Spanish for an English name, English for a Spanish one; null when there's none or
       * it's the same word. Model-written text: the handler's `cleanTranslation` checks it first.
       */
      translation: z.string().nullable(),
      /** True only when the name and its translation are the same thing on a shopping list. */
      exact_equivalent: z.boolean(),
    }),
  ),
});
export type CategorizeOutput = z.infer<typeof CategorizeOutputSchema>;

/**
 * About 80 output tokens per name plus 200, capped at 8,500 (LLM boundaries: call limits). v3's
 * language, translation and link flag take about 30 of the 80.
 */
export function maxOutputTokens(nameCount: number): number {
  return Math.min(8_500, 200 + 80 * Math.max(0, nameCount));
}

function env(name: string): string | null {
  return Deno.env.get(name)?.trim() || null;
}

/**
 * Gemini thinking, per task. `off` is a zero thinking budget, `minimal`..`high` a thinking level,
 * and `default` sends nothing, so the model thinks as much as it likes (40-60 s per categorize call
 * on Gemini 3.8 Flash). Other providers ignore Google's options.
 */
export const THINKING_SETTINGS = ['off', 'minimal', 'low', 'medium', 'high', 'default'] as const;
export type ThinkingSetting = (typeof THINKING_SETTINGS)[number];

export function isThinkingSetting(value: string): value is ThinkingSetting {
  return (THINKING_SETTINGS as readonly string[]).includes(value);
}

/** Provider options for a thinking setting; `undefined` for `default`. */
export function thinkingProviderOptions(setting: ThinkingSetting) {
  if (setting === 'default') return undefined;
  const thinkingConfig = setting === 'off' ? { thinkingBudget: 0 } : { thinkingLevel: setting };
  return { google: { thinkingConfig } };
}

/**
 * `AI_THINKING_<TASK>` overrides the task's setting, e.g. for `yarn ai:categorize --thinking`.
 * An unknown value is logged and ignored.
 */
function thinking(name: string, fallback: ThinkingSetting): ThinkingSetting {
  const value = env(name);
  if (value === null) return fallback;
  if (isThinkingSetting(value)) return value;
  console.warn(JSON.stringify({ level: 'warn', event: 'ai_thinking_unknown', env: name, value: value.slice(0, 40) }));
  return fallback;
}

/**
 * Categorizing is easy, so think as little as the model allows. `low` is the lowest level the
 * Google provider sends for Gemini 3.7+ Flash (it maps "no reasoning" to `low`). Pending the
 * timings in docs/spikes.md §4.
 */
export const CATEGORIZE_THINKING: ThinkingSetting = 'low';

/** Categorize's setting until the recipe eval shows extraction needs more (spec §6.6). */
export const RECIPE_THINKING: ThinkingSetting = CATEGORIZE_THINKING;

/**
 * What the extract-recipe model may answer. Looser than `ExtractedRecipeSchema` (no length caps,
 * any unit string, any tag string), so one long name, odd unit or made-up tag doesn't throw away
 * the whole call; `cleanExtractedRecipe` then enforces the caps and the tag list.
 */
export const ExtractRecipeOutputSchema = z.object({
  is_recipe: z.boolean(),
  name: z.string(),
  servings: z.number().nullable(),
  ingredients: z.array(
    z.object({
      name: z.string(),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      note: z.string(),
    }),
  ),
  tags: z.object({
    meal: z.array(z.string()),
    cuisine: z.array(z.string()),
    protein: z.array(z.string()),
    diet: z.array(z.string()),
    method: z.array(z.string()),
  }),
  total_minutes: z.number().nullable(),
  /** v3: the method from page text; `[]` when the model got JSON-LD ingredient lines. */
  steps: z.array(z.string()),
});
export type ExtractRecipeOutput = z.infer<typeof ExtractRecipeOutputSchema>;

/** About 60 output tokens per ingredient line plus 300, capped at 6,000 (spec §6.6: call limits). */
export function recipeMaxOutputTokens(lineCount: number): number {
  return Math.min(6_000, 300 + 60 * Math.max(0, lineCount));
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A positive finite number, else null. */
function positive(n: number | null): number | null {
  return n !== null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The model's unit as a supported unit, accepting the spellings the quantity parser knows
 * (`cups`, `Tablespoons`, `fluid ounces`). `unsupported` is the wording to keep in the note.
 */
function supportedUnit(raw: string | null): { unit: Unit | null; unsupported: string | null } {
  const wording = collapse(raw ?? '');
  if (wording === '' || wording.toLowerCase() === 'count') return { unit: null, unsupported: null };
  const unit = parseAmount(`1 ${wording}`)?.unit ?? null;
  return unit ? { unit, unsupported: null } : { unit: null, unsupported: wording };
}

/**
 * The model's answer with the output caps applied (spec §6.6: output). Whitespace is collapsed;
 * an ingredient whose name is over 64 characters or normalizes to nothing is dropped; an
 * unsupported unit becomes null with its wording at the front of the note; the recipe name and
 * notes are cut to 120 characters and the list to 80 entries; a quantity or servings that isn't
 * positive is null. Tags go through `ExtractedRecipeTagsSchema` (a facet with a slug the list
 * doesn't have is `[]`, one over its maximum is cut), and `total_minutes` is rounded, null outside
 * 1 to 2880. Steps go through `cleanRecipeSteps` (no numbering, blanks or repeats; at most 100 of
 * 2000 characters). `image_url` is null: the model never reads the photo, the handler sets it. The
 * result always passes `ExtractedRecipeSchema`.
 */
export function cleanExtractedRecipe(raw: ExtractRecipeOutput): ExtractedRecipe {
  const ingredients: ExtractedRecipe['ingredients'] = [];
  for (const item of raw.ingredients) {
    if (ingredients.length === MAX_RECIPE_INGREDIENTS) break;
    const name = collapse(item.name);
    if (name.length > MAX_RECIPE_INGREDIENT_NAME_LENGTH || normalizeIngredientName(name) === '') continue;
    const { unit, unsupported } = supportedUnit(item.unit);
    const note = [unsupported, collapse(item.note)].filter(Boolean).join(', ');
    ingredients.push({
      name,
      quantity: positive(item.quantity),
      unit,
      note: truncateText(note, MAX_RECIPE_NOTE_LENGTH).trimEnd(),
    });
  }
  return ExtractedRecipeSchema.parse({
    is_recipe: raw.is_recipe,
    name: truncateText(collapse(raw.name), MAX_RECIPE_NAME_LENGTH).trimEnd(),
    servings: positive(raw.servings),
    ingredients,
    tags: ExtractedRecipeTagsSchema.parse(raw.tags),
    total_minutes: totalMinutes(raw.total_minutes),
    steps: cleanRecipeSteps(raw.steps),
    image_url: null,
  });
}

/** Whole minutes within `recipes.total_minutes` bounds, else null. */
function totalMinutes(n: number | null): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const minutes = Math.round(n);
  return minutes >= MIN_TOTAL_MINUTES && minutes <= MAX_TOTAL_MINUTES ? minutes : null;
}

/**
 * What the suggest-recipe-tags model may answer: any strings per facet, so one made-up slug costs
 * only its facet. Run it through `cleanSuggestedTags`.
 */
export const SuggestTagsOutputSchema = ExtractRecipeOutputSchema.shape.tags;
export type SuggestTagsOutput = z.infer<typeof SuggestTagsOutputSchema>;

/** The tags with extract-recipe's rules (`ExtractedRecipeTagsSchema`): a facet with an unknown slug is `[]`, one over its maximum is cut. */
export function cleanSuggestedTags(raw: SuggestTagsOutput): RecipeTags {
  return ExtractedRecipeTagsSchema.parse(raw);
}

/** Five short lists of slugs: a fixed budget, whatever the recipe's size (spec 6.7: call limits). */
export const TAGS_MAX_OUTPUT_TOKENS = 400;

/** `AI_MODEL_TAGS`, else extract-recipe's model, so tagging follows it unless set on its own. */
function tagsModel(): string | null {
  return env('AI_MODEL_TAGS') ?? env('AI_MODEL_RECIPE');
}

export const aiTasks = {
  /** Shelf category and default unit for 1..100 normalized ingredient names in one call. */
  categorize: {
    /** No default: the function fails clearly when it isn't set. */
    model: () => env('AI_MODEL_CATEGORIZE'),
    /** Used when the primary model's API call fails. Unset = no fallback. */
    fallbackModel: () => env('AI_MODEL_CATEGORIZE_FALLBACK'),
    promptVersion: CATEGORIZE_PROMPT_VERSION,
    output: CategorizeOutputSchema,
    temperature: 0,
    timeoutMs: 20_000,
    maxOutputTokens,
    /** Passed to the model as `providerOptions`. */
    providerOptions: () => thinkingProviderOptions(thinking('AI_THINKING_CATEGORIZE', CATEGORIZE_THINKING)),
    /** What `AI_MODEL_CATEGORIZE=mock` (or `--model mock`) runs. */
    mock: mockCategorizeModel,
  },
  /**
   * Name, servings and structured ingredients from one recipe page (spec §6.6). Run the output
   * through `cleanExtractedRecipe` before using it.
   */
  extractRecipe: {
    /** No default: the function fails clearly when it isn't set. */
    model: () => env('AI_MODEL_RECIPE'),
    /** Used when the primary model's API call fails. Unset = no fallback. */
    fallbackModel: () => env('AI_MODEL_RECIPE_FALLBACK'),
    promptVersion: EXTRACT_RECIPE_PROMPT_VERSION,
    output: ExtractRecipeOutputSchema,
    temperature: 0,
    /** A bigger call than categorize's 20 s. Pending the extraction timings (docs/spikes.md §4). */
    timeoutMs: 30_000,
    maxOutputTokens: recipeMaxOutputTokens,
    providerOptions: () => thinkingProviderOptions(thinking('AI_THINKING_RECIPE', RECIPE_THINKING)),
    /** What `AI_MODEL_RECIPE=mock` runs. */
    mock: mockRecipeModel,
  },
  /**
   * Tags for a recipe made by hand, from its name, notes and ingredients (spec 6.7). Run the
   * output through `cleanSuggestedTags` before using it.
   */
  suggestRecipeTags: {
    /** `AI_MODEL_TAGS`, defaulting to `AI_MODEL_RECIPE`. */
    model: tagsModel,
    /** `AI_MODEL_TAGS_FALLBACK`; while the model follows `AI_MODEL_RECIPE`, so does its fallback. */
    fallbackModel: () => env('AI_MODEL_TAGS_FALLBACK') ?? (env('AI_MODEL_TAGS') ? null : env('AI_MODEL_RECIPE_FALLBACK')),
    promptVersion: SUGGEST_RECIPE_TAGS_PROMPT_VERSION,
    output: SuggestTagsOutputSchema,
    temperature: 0,
    /** A small call: a short prompt and five short lists. */
    timeoutMs: 15_000,
    maxOutputTokens: () => TAGS_MAX_OUTPUT_TOKENS,
    providerOptions: () => thinkingProviderOptions(thinking('AI_THINKING_TAGS', RECIPE_THINKING)),
    /** What `AI_MODEL_TAGS=mock` runs. */
    mock: mockTagsModel,
  },
} as const;

export type AiTaskName = keyof typeof aiTasks;

/** False when the task's model is unset or `off`. Check it before `runAiTask`. */
export function isAiEnabled(name: AiTaskName): boolean {
  const model = aiTasks[name].model();
  return model !== null && model !== AI_OFF;
}
