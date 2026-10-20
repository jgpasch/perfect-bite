// generate-recipe-photo (spec 6.11): pure logic behind a store interface, so it runs in Deno tests
// with a fake store, a mock description model and a fake image call. index.ts wires the real ones.
import type { GenerateRecipePhotoRequest, GenerateRecipePhotoResponse } from '@shared/index.ts';
import type { LanguageModel } from 'ai';

import { buildRecipePhotoImagePrompt } from '../_shared/ai/prompts/recipe-photo-image.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { isAiEnabled } from '../_shared/ai/tasks.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { DescribeFailedError, describeRecipePhoto, photoRecipe } from './describe.ts';
import { generateImage as realGenerateImage, ImageFailedError, ImageRefusedError, imageModel, isImageEnabled, type GeneratedImage } from './image.ts';

/** `reserve_recipe_photo_ai`'s answer. `monthly_limit`: the caller has reserved their plan's AI photos this month. */
export type ReserveResult = { status: 'ok'; householdId: string } | { status: 'not_found' | 'already_generated' | 'monthly_limit' };

/** The recipe as stored: its name, its live ingredients' display names in order, and its `tags`. */
export type StoredRecipe = { name: string; ingredients: string[]; tags: unknown };

/** The tables and bucket generate-recipe-photo uses, as it sees them. index.ts implements it with the service role. */
export interface RecipePhotoStore {
  /** Throws NotEntitledError unless the caller's plan has `feature`. Called first. */
  requireFeature(feature: Feature): Promise<void>;
  /** `public.reserve_recipe_photo_ai` for the caller and this recipe. */
  reserve(recipeId: string): Promise<ReserveResult>;
  /** The live recipe in `householdId`, or null when it's gone. */
  readRecipe(recipeId: string, householdId: string): Promise<StoredRecipe | null>;
  /** Uploads the JPEG to `recipe-photos` at `path`. */
  upload(path: string, bytes: Uint8Array): Promise<void>;
  /** `public.complete_recipe_photo_ai`: false when the slot was gone (the recipe was deleted meanwhile). */
  complete(recipeId: string, description: string, path: string): Promise<boolean>;
  /** `public.release_recipe_photo_ai`: gives the recipe its slot back. */
  release(recipeId: string): Promise<void>;
  /** Writes one `ai_calls` row. */
  logAiCall(call: AiCallRecord): Promise<void>;
}

export type GenerateDeps = {
  store: RecipePhotoStore;
  /** The signed-in caller, recorded on each `ai_calls` row with the recipe's household. */
  userId?: string;
  /** Tests inject a MockLanguageModelV4 for the description; otherwise the task's env model. */
  model?: { instance: LanguageModel; modelId: string };
  /** The image call. Defaults to OpenAI's Images API (`generateImage`). */
  generateImage?: (prompt: string) => Promise<GeneratedImage>;
  /** The new object's file name. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Reads an env var, for the image kill switch. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

/** Why a generation failed; request.ts turns it into the HTTP status. */
export type GenerateFailure =
  | { code: 'not_entitled' }
  | { code: 'not_found' }
  | { code: 'already_generated' }
  | { code: 'limit_reached' }
  | { code: 'not_food'; by: 'description' | 'image' }
  | { code: 'generation_failed'; step: 'description' | 'image' }
  | { code: 'unavailable'; reason: 'ai_off' };

export class GeneratePhotoError extends Error {
  override name = 'GeneratePhotoError';
  constructor(
    readonly failure: GenerateFailure,
    message: string,
  ) {
    super(message);
  }
}

/** One line per generation that got past the reservation: the outcome, the models, the description and the time. */
function logOutcome(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level: 'info', event: 'recipe_photo_ai', ...fields }));
}

/**
 * Makes a recipe's one AI photo (spec 6.11): the plan, the kill switches, the reservation, the
 * recipe (title, ingredient names, cuisines; read here, never sent by the app), the description,
 * the image, the upload. Every failure after the reservation releases it, so the recipe keeps its
 * one photo. Throws `GeneratePhotoError` for every expected failure. Never writes `recipes`: the
 * app sets the answered path as `photo_path`.
 */
export async function generateRecipePhoto(request: GenerateRecipePhotoRequest, deps: GenerateDeps): Promise<GenerateRecipePhotoResponse> {
  const { store } = deps;
  const { recipeId } = request;
  try {
    await store.requireFeature('recipe_photo_ai');
  } catch (err) {
    if (err instanceof NotEntitledError) throw new GeneratePhotoError({ code: 'not_entitled' }, "AI photos aren't included in your plan");
    throw err;
  }

  // Before the reservation, so a call refused by a kill switch uses no budget and no slot.
  if (!isAiEnabled('recipePhotoDescription') || !isImageEnabled(deps.env)) {
    throw new GeneratePhotoError({ code: 'unavailable', reason: 'ai_off' }, 'AI photos are turned off');
  }

  const reserved = await store.reserve(recipeId);
  switch (reserved.status) {
    case 'not_found':
      throw new GeneratePhotoError({ code: 'not_found' }, 'No such recipe');
    case 'already_generated':
      throw new GeneratePhotoError({ code: 'already_generated' }, 'This recipe already has had its AI photo');
    case 'monthly_limit':
      throw new GeneratePhotoError({ code: 'limit_reached' }, "This month's AI photos are used up");
  }
  const { householdId } = reserved;

  const started = Date.now();
  let descriptionModel: string | null = null;
  let description: string | null = null;
  const image = imageModel(deps.env);
  const fail = async (failure: GenerateFailure, message: string, outcome: string): Promise<never> => {
    await store.release(recipeId);
    logOutcome({ outcome, description_model: descriptionModel, image_model: image, description, ms: Date.now() - started });
    throw new GeneratePhotoError(failure, message);
  };

  try {
    const stored = await store.readRecipe(recipeId, householdId);
    if (stored === null) return await fail({ code: 'not_found' }, 'No such recipe', 'not_found');

    let described;
    try {
      described = await describeRecipePhoto(photoRecipe(stored), {
        model: deps.model,
        caller: deps.userId ? { userId: deps.userId, householdId } : undefined,
        onCall: (call) => store.logAiCall(call),
      });
    } catch (err) {
      if (!(err instanceof DescribeFailedError)) throw err;
      return await fail({ code: 'generation_failed', step: 'description' }, err.message, 'description_failed');
    }
    descriptionModel = described.model;
    if (!described.isFood) return await fail({ code: 'not_food', by: 'description' }, "This recipe can't have an AI photo", 'not_food');
    description = described.description;

    let generated: GeneratedImage;
    try {
      const generate = deps.generateImage ?? ((prompt: string) => realGenerateImage(prompt, { env: deps.env }));
      generated = await generate(buildRecipePhotoImagePrompt(description));
    } catch (err) {
      if (err instanceof ImageRefusedError) return await fail({ code: 'not_food', by: 'image' }, "This recipe can't have an AI photo", 'image_refused');
      if (err instanceof ImageFailedError) return await fail({ code: 'generation_failed', step: 'image' }, err.message, 'image_failed');
      throw err;
    }

    const path = `${householdId}/${recipeId}/${(deps.newId ?? (() => crypto.randomUUID()))()}.jpg`.toLowerCase();
    await store.upload(path, generated.bytes);
    // complete queues the object for cleanup either way, so a recipe deleted meanwhile leaves nothing behind.
    if (!(await store.complete(recipeId, description, path))) {
      logOutcome({ outcome: 'recipe_gone', description_model: descriptionModel, image_model: generated.model, description, ms: Date.now() - started });
      throw new GeneratePhotoError({ code: 'not_found' }, 'No such recipe');
    }
    logOutcome({
      outcome: 'ok',
      description_model: descriptionModel,
      image_model: generated.model,
      image_quality: generated.quality,
      description,
      image_ms: generated.ms,
      ms: Date.now() - started,
      image_input_tokens: generated.usage?.inputTokens ?? null,
      image_output_tokens: generated.usage?.outputTokens ?? null,
    });
    return { path };
  } catch (err) {
    if (err instanceof GeneratePhotoError) throw err;
    // Anything unexpected (a store error, a bug): give the slot back before failing.
    await store.release(recipeId).catch(() => {});
    logOutcome({ outcome: 'error', description_model: descriptionModel, image_model: image, description, ms: Date.now() - started });
    throw err;
  }
}
