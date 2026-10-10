// Every AI task and its model, in one place (spec §6.4). Switch a model with
// `supabase secrets set AI_MODEL_CATEGORIZE=google:gemini-3.8-flash`; no code change.
import { SYSTEM_CATEGORIES, type CategorySlug } from '@shared/index.ts';
import { z } from 'zod';

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
  },
} as const;

export type AiTaskName = keyof typeof aiTasks;

/** False when the task's model is unset or `off`. Check it before `runAiTask`. */
export function isAiEnabled(name: AiTaskName): boolean {
  const model = aiTasks[name].model();
  return model !== null && model !== AI_OFF;
}
