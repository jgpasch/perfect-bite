// generate-recipe-photo (spec 6.11): pure logic behind a store interface, so it runs in Deno tests
// with a fake store, a mock description model and a fake image call. index.ts wires the real ones.
import type { GenerateRecipePhotoRequest, GenerateRecipePhotoResponse } from '@shared/index.ts';
import type { LanguageModel } from 'ai';

import { buildRecipePhotoImagePrompt, RECIPE_PHOTO_IMAGE_PROMPT_VERSION } from '../_shared/ai/prompts/recipe-photo-image.v1.ts';
import { MOCK_MODEL_ID } from '../_shared/ai/registry.ts';
import { RECIPE_PHOTO_IMAGE_TASK, RECIPE_PHOTO_MODERATION_TASK, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { isAiEnabled } from '../_shared/ai/tasks.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { DescribeFailedError, describeRecipePhoto, photoRecipe } from './describe.ts';
import { generateImage as realGenerateImage, hasMockRefusalWord, ImageFailedError, ImageRefusedError, imageModel, MOCK_REFUSAL_WORD, imageModelId, isImageEnabled, safetyIdentifierFor, type GeneratedImage, type ImageOptions } from './image.ts';
import { moderateText, ModerationFailedError, moderationModelId, type ModerationResult } from './moderation.ts';

/**
 * `reserve_recipe_photo_ai`'s answer. `blocked`: the caller's AI photos are blocked after repeated
 * refusals (6.11). `monthly_limit`: the caller has reserved their plan's AI photos this month.
 */
export type ReserveResult =
  | { status: 'ok'; householdId: string }
  | { status: 'blocked' | 'not_found' | 'already_generated' | 'monthly_limit' };

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
  /** The image call, given the caller's hashed `safetyIdentifier` (none without a caller). Defaults to OpenAI's Images API (`generateImage`). */
  generateImage?: (prompt: string, options: Pick<ImageOptions, 'safetyIdentifier'>) => Promise<GeneratedImage>;
  /** The moderation check of the image prompt, before the image call. Defaults to OpenAI's moderation endpoint (`moderateText`). */
  moderate?: (text: string) => Promise<ModerationResult>;
  /** The new object's file name. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Reads an env var, for the image kill switch. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

/** Why a generation failed; request.ts turns it into the HTTP status. */
export type GenerateFailure =
  | { code: 'not_entitled' }
  | { code: 'ai_photos_blocked' }
  | { code: 'not_found' }
  | { code: 'already_generated' }
  | { code: 'limit_reached' }
  | { code: 'not_food'; by: 'description' | 'moderation' | 'image' }
  | { code: 'generation_failed'; step: 'description' | 'moderation' | 'image' }
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

/** Writes the moderation or image call's `ai_calls` row. A failure to log is logged, never thrown, as `runAiTask` does. */
async function logImageCall(store: RecipePhotoStore, call: AiCallRecord): Promise<void> {
  try {
    await store.logAiCall(call);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'ai_call_log_failed', id: call.id, error: String(err).slice(0, 200) }));
  }
}

/** One line per generation that got past the reservation: the outcome, the models, the description and the time. */
function logOutcome(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level: 'info', event: 'recipe_photo_ai', ...fields }));
}

/**
 * Makes a recipe's one AI photo (spec 6.11): the plan, the kill switches, the reservation, the
 * recipe (title, ingredient names, cuisines; read here, never sent by the app), the description,
 * the moderation check of the image prompt, the image, the upload. Every failure after the reservation releases it, so the recipe keeps its
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
    case 'blocked':
      throw new GeneratePhotoError({ code: 'ai_photos_blocked' }, 'AI photos are turned off for your account');
    case 'not_found':
      throw new GeneratePhotoError({ code: 'not_found' }, 'No such recipe');
    case 'already_generated':
      throw new GeneratePhotoError({ code: 'already_generated' }, 'This recipe already has had its AI photo');
    case 'monthly_limit':
      throw new GeneratePhotoError({ code: 'limit_reached' }, "This month's AI photos are used up");
  }
  const { householdId } = reserved;
  const caller = deps.userId ? { userId: deps.userId, householdId } : undefined;
  const recipeKey = recipeId.toLowerCase();

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
        caller,
        recipeId: recipeKey,
        onCall: (call) => store.logAiCall(call),
      });
    } catch (err) {
      if (!(err instanceof DescribeFailedError)) throw err;
      return await fail({ code: 'generation_failed', step: 'description' }, err.message, 'description_failed');
    }
    descriptionModel = described.model;
    if (!described.isFood) return await fail({ code: 'not_food', by: 'description' }, "This recipe can't have an AI photo", 'not_food');
    description = described.description;

    const path = `${householdId}/${recipeId}/${(deps.newId ?? (() => crypto.randomUUID()))()}.jpg`.toLowerCase();
    // Mock only: the description never repeats the title, so a title with the refusal word carries
    // it into the prompt, where the mock moderation check flags it (testing blocks by hand, 6.11).
    const mockRefusal = image === MOCK_MODEL_ID && hasMockRefusalWord(stored.name);
    const imagePrompt = buildRecipePhotoImagePrompt(mockRefusal ? `${description} (${MOCK_REFUSAL_WORD})` : description);
    type StepFields = Pick<AiCallRecord, 'model' | 'status' | 'output' | 'input_tokens' | 'output_tokens' | 'error' | 'http_status' | 'error_body'>;
    // One row per moderation and per image call, success or failure, each linked to the description row.
    const logStep = (task: typeof RECIPE_PHOTO_MODERATION_TASK | typeof RECIPE_PHOTO_IMAGE_TASK, stepStarted: number, fields: StepFields) =>
      logImageCall(store, {
        id: crypto.randomUUID(),
        user_id: caller?.userId ?? null,
        household_id: caller?.householdId ?? null,
        recipe_id: recipeKey,
        task,
        prompt_version: RECIPE_PHOTO_IMAGE_PROMPT_VERSION,
        instructions: '',
        prompt: imagePrompt,
        response_text: null,
        finish_reason: null,
        raw_finish_reason: null,
        provider_metadata: null,
        cached_input_tokens: null,
        reasoning_tokens: null,
        duration_ms: Date.now() - stepStarted,
        fallback_of: described.callId,
        ...fields,
      });

    // The exact image prompt goes through moderation first, so a bad one is stopped by us rather
    // than refused by the image model (a refusal there counts against our OpenAI account).
    const moderationStarted = Date.now();
    let moderation: ModerationResult;
    try {
      moderation = await (deps.moderate ?? ((text) => moderateText(text, { env: deps.env })))(imagePrompt);
    } catch (err) {
      const known = err instanceof ModerationFailedError ? err : null;
      await logStep(RECIPE_PHOTO_MODERATION_TASK, moderationStarted, {
        model: moderationModelId(deps.env),
        status: known?.failure ?? 'error',
        output: null,
        input_tokens: null,
        output_tokens: null,
        error: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000),
        http_status: known?.httpStatus ?? null,
        error_body: known?.body?.slice(0, 4000) ?? null,
      });
      // Fails closed: no answer from moderation, no image call.
      if (known) return await fail({ code: 'generation_failed', step: 'moderation' }, known.message, 'moderation_failed');
      throw err;
    }
    await logStep(RECIPE_PHOTO_MODERATION_TASK, moderationStarted, {
      model: moderationModelId(deps.env),
      status: moderation.flagged ? 'refused' : 'ok',
      output: { flagged: moderation.flagged, categories: moderation.categories },
      input_tokens: null,
      output_tokens: null,
      error: moderation.flagged ? `Flagged: ${moderation.categories.join(', ') || 'no category'}`.slice(0, 2000) : null,
      http_status: null,
      error_body: null,
    });
    if (moderation.flagged) return await fail({ code: 'not_food', by: 'moderation' }, "This recipe can't have an AI photo", 'moderation_flagged');

    const imageStarted = Date.now();
    const logImage = (fields: StepFields) => logStep(RECIPE_PHOTO_IMAGE_TASK, imageStarted, fields);

    let generated: GeneratedImage;
    try {
      const generate = deps.generateImage ?? ((prompt, options) => realGenerateImage(prompt, { env: deps.env, ...options }));
      // The hash of the caller's id, never the id itself; no caller, no identifier.
      generated = await generate(imagePrompt, deps.userId ? { safetyIdentifier: await safetyIdentifierFor(deps.userId) } : {});
    } catch (err) {
      const known = err instanceof ImageRefusedError || err instanceof ImageFailedError ? err : null;
      await logImage({
        model: imageModelId(image),
        status: err instanceof ImageRefusedError ? 'refused' : err instanceof ImageFailedError ? err.failure : 'error',
        output: null,
        input_tokens: null,
        output_tokens: null,
        error: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000),
        http_status: known?.httpStatus ?? null,
        error_body: known?.body?.slice(0, 4000) ?? null,
      });
      if (err instanceof ImageRefusedError) return await fail({ code: 'not_food', by: 'image' }, "This recipe can't have an AI photo", 'image_refused');
      if (err instanceof ImageFailedError) return await fail({ code: 'generation_failed', step: 'image' }, err.message, 'image_failed');
      throw err;
    }
    // Never the image bytes: the row keeps where the photo goes.
    await logImage({
      model: imageModelId(generated.model),
      status: 'ok',
      output: { quality: generated.quality, path },
      input_tokens: generated.usage?.inputTokens ?? null,
      output_tokens: generated.usage?.outputTokens ?? null,
      error: null,
      http_status: null,
      error_body: null,
    });

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
