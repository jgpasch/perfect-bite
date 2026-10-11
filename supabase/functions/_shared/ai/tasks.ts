// Every AI task and its model, in one place (spec §6.4). Switch a model with
// `supabase secrets set AI_MODEL_CATEGORIZE=google:gemini-3.8-flash`; no code change.
import { SYSTEM_CATEGORIES, type CategorySlug } from '@shared/index.ts';
import { z } from 'zod';

import { mockCategorizeModel } from './mock-model.ts';
import { CATEGORIZE_PROMPT_VERSION } from './prompts/categorize.v1.ts';

/** `AI_MODEL_*=off` is the kill switch: no model call at all. */
export const AI_OFF = 'off';

const CATEGORY_SLUGS = SYSTEM_CATEGORIES.map((c) => c.slug) as [CategorySlug, ...CategorySlug[]];

export const CategorizeOutputSchema = z.object({
  results: z.array(
    z.object({
      name: z.string(),
      category: z.enum(CATEGORY_SLUGS),
      is_grocery_item: z.boolean(),
    }),
  ),
});
export type CategorizeOutput = z.infer<typeof CategorizeOutputSchema>;

/** About 40 output tokens per name plus 200, capped at 4,500 (LLM boundaries: call limits). */
export function maxOutputTokens(nameCount: number): number {
  return Math.min(4_500, 200 + 40 * Math.max(0, nameCount));
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

export const aiTasks = {
  /** Shelf category for 1..100 normalized ingredient names in one call. */
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
} as const;

export type AiTaskName = keyof typeof aiTasks;

/** False when the task's model is unset or `off`. Check it before `runAiTask`. */
export function isAiEnabled(name: AiTaskName): boolean {
  const model = aiTasks[name].model();
  return model !== null && model !== AI_OFF;
}
