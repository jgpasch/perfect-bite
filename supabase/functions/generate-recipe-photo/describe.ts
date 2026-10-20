// The description step of generate-recipe-photo (spec 6.11), on its own so `yarn ai:eval:photo`
// can run it without the rest of the function: one recipe-photo-description call, checked.
import { recipeTagLabel } from '@shared/index.ts';
import { NoObjectGeneratedError, type LanguageModel } from 'ai';

import { buildRecipePhotoDescriptionPrompt, type PhotoRecipe } from '../_shared/ai/prompts/recipe-photo-description.v1.ts';
import { runAiTask, type AiCaller, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { cleanPhotoDescription, type PhotoDescription } from '../_shared/ai/tasks.ts';
import { isProviderFailure } from '../categorize-ingredients/handler.ts';

export type { PhotoRecipe };

/** At most this many ingredient names go to the model, as the other recipe tasks' caps. */
export const MAX_PHOTO_INGREDIENTS = 80;
export const MAX_PHOTO_TITLE_LENGTH = 120;
export const MAX_PHOTO_INGREDIENT_LENGTH = 64;

const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max).trimEnd();

/**
 * What the model sees of a recipe as stored: the name, the live ingredients' display names in
 * order (blank ones dropped, the first 80, each cut to 64), and the known cuisine slugs as their
 * English labels (anything else in `tags` is ignored).
 */
export function photoRecipe(row: { name: string; ingredients: readonly string[]; tags: unknown }): PhotoRecipe {
  const cuisine = (row.tags as { cuisine?: unknown } | null)?.cuisine;
  const slugs = Array.isArray(cuisine) ? cuisine.filter((s): s is string => typeof s === 'string') : [];
  return {
    title: clean(row.name, MAX_PHOTO_TITLE_LENGTH),
    ingredients: row.ingredients
      .map((name) => clean(name, MAX_PHOTO_INGREDIENT_LENGTH))
      .filter((name) => name !== '')
      .slice(0, MAX_PHOTO_INGREDIENTS),
    cuisines: [...new Set(slugs.flatMap((slug) => recipeTagLabel('cuisine', slug) ?? []))],
  };
}

/** The description call failed: a provider error, a timeout, output that doesn't fit, or food with no description. */
export class DescribeFailedError extends Error {
  override name = 'DescribeFailedError';
}

export type DescribeOptions = {
  /** Tests inject a MockLanguageModelV4; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  onCall?: (call: AiCallRecord) => Promise<void>;
  /** The signed-in caller, recorded on each `ai_calls` row; none in the CLI and eval. */
  caller?: AiCaller;
  /** The recipe, recorded on each `ai_calls` row; none in the CLI and eval. */
  recipeId?: string;
};

/** `callId`: the `ai_calls` id of the attempt that answered, which the image row links to. */
export type DescribeResult = PhotoDescription & { model: string; callId: string };

/** One recipe-photo-description call. Throws `DescribeFailedError` for every expected failure. */
export async function describeRecipePhoto(recipe: PhotoRecipe, options: DescribeOptions = {}): Promise<DescribeResult> {
  let ran;
  try {
    ran = await runAiTask('recipePhotoDescription', buildRecipePhotoDescriptionPrompt(recipe), options);
  } catch (err) {
    const invalid = NoObjectGeneratedError.isInstance(err);
    if (!invalid && !isProviderFailure(err)) throw err;
    throw new DescribeFailedError(`Description failed: ${invalid ? 'invalid output' : 'provider error or timeout'}`);
  }
  const description = cleanPhotoDescription(ran.output);
  if (description === null) throw new DescribeFailedError('Description failed: food with an empty description');
  return { ...description, model: ran.model, callId: ran.callId };
}
