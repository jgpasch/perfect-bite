// The only code that calls the AI SDK (spec §6.4), copied from stash.
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  type LanguageModel,
  type LanguageModelUsage,
  type ProviderMetadata,
} from 'ai';
import type { z } from 'zod';

import { asError, reportError } from '../sentry.ts';
import { resolveModel } from './registry.ts';
import { aiTasks, type AiTaskName } from './tasks.ts';

export type AiTaskResult<T> = {
  output: T;
  /** `provider:model`, stored as `ingredients.categorized_by`. */
  model: string;
  promptVersion: string;
  usage: LanguageModelUsage;
  /** `ai_calls.id` of the attempt that produced the output. */
  callId: string;
};

/** Who made a call: the signed-in user and, when the request has one, the household. */
export type AiCaller = { userId: string; householdId: string | null };

/**
 * The caller with a request's `householdId` when they're a member of it, else none (spec 6.4). For
 * functions that only record the household (tags, step matching), so a household the caller isn't
 * in is ignored rather than refused. No caller (the CLIs) asks nothing.
 */
export async function recordedCaller(
  caller: AiCaller | undefined,
  householdId: string | undefined,
  store: { isMember(householdId: string): Promise<boolean> },
): Promise<AiCaller | undefined> {
  if (!caller) return undefined;
  const member = householdId !== undefined && (await store.isMember(householdId));
  return { ...caller, householdId: member ? householdId : null };
}

/** The AI photo's image call (spec §6.11): not an `aiTasks` task, but logged in `ai_calls` beside them. */
export const RECIPE_PHOTO_IMAGE_TASK = 'recipePhotoImage';

/** The AI photo's moderation check of the image prompt (spec §6.11), logged beside the image call. */
export const RECIPE_PHOTO_MODERATION_TASK = 'recipePhotoModeration';

/** One model attempt, as stored in `public.ai_calls`, with who made it (spec §6.4, §6.5). */
export type AiCallRecord = {
  id: string;
  /** Null for calls with no signed-in caller (the `yarn ai:*` scripts, evals). */
  user_id: string | null;
  household_id: string | null;
  /** The recipe an AI photo's rows are for (description, moderation and image); null for every other task. */
  recipe_id: string | null;
  task: AiTaskName | typeof RECIPE_PHOTO_IMAGE_TASK | typeof RECIPE_PHOTO_MODERATION_TASK;
  model: string;
  prompt_version: string;
  /** `refused`: the image model's content-policy refusal, or a flagged moderation check (image and moderation rows only). */
  status: 'ok' | 'api_error' | 'invalid_output' | 'timeout' | 'refused' | 'error';
  instructions: string;
  prompt: string;
  output: unknown;
  response_text: string | null;
  finish_reason: string | null;
  /** The provider's own finish reason (Gemini's `RECITATION`, Anthropic's `refusal`); null on image rows. */
  raw_finish_reason: string | null;
  /** A failed attempt's block details: per provider, safetyRatings, promptFeedback, finishMessage. Null otherwise. */
  provider_metadata: Record<string, Record<string, unknown>> | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  duration_ms: number;
  error: string | null;
  /** A failed attempt's HTTP status, when the provider answered; null otherwise. */
  http_status: number | null;
  /** That answer's body, cut to 4000 characters. */
  error_body: string | null;
  fallback_of: string | null;
};

/**
 * One attempt with everything a person debugging it wants to see: the stored record plus the call
 * settings and, when the provider sent them, the raw HTTP bodies. Only the trace listener gets
 * this; it is never stored.
 */
export type AiTrace = AiCallRecord & {
  temperature: number;
  max_output_tokens: number;
  timeout_ms: number;
  /** The JSON body sent to the provider API. */
  request_body: unknown;
  /** The provider's raw response body. */
  response_body: unknown;
  /** Provider warnings, e.g. a setting the model ignored. */
  warnings: unknown[];
};

let traceListener: ((trace: AiTrace) => void) | null = null;

/**
 * Dev scripts (`yarn ai:*`) see every attempt in full through this. Pass null to stop. Production
 * code never sets it; with no listener, raw bodies aren't kept.
 */
export function setAiTraceListener(listener: ((trace: AiTrace) => void) | null): void {
  traceListener = listener;
}

function emitTrace(trace: AiTrace) {
  try {
    traceListener?.(trace);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'ai_trace_failed', id: trace.id, error: String(err).slice(0, 200) }));
  }
}

type InjectedModel = { instance: LanguageModel; modelId: string };

/** One part of a user message that carries images (extract-recipe-photo). */
export type PromptPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string };

export type RunAiTaskInput = {
  instructions: string;
  /** The user prompt. With `content`, only what's recorded: the parts' text with each image described, never its bytes. */
  prompt: string;
  /** Sent instead of `prompt` when given: text and base64 image parts, in order. */
  content?: readonly PromptPart[];
  /** Items in the prompt (names, for categorize); sizes `maxOutputTokens`. */
  itemCount: number;
};

export type RunAiTaskOptions = {
  /** Tests inject a MockLanguageModelV4 here; `modelId` is then what gets recorded. */
  model?: InjectedModel;
  /** Tests inject the fallback the same way. */
  fallbackModel?: InjectedModel;
  /** Called once per attempt, success or failure. Its errors are logged, never thrown. */
  onCall?: (call: AiCallRecord) => Promise<void>;
  /** Copied onto every attempt's record; without it `user_id` and `household_id` are null. */
  caller?: AiCaller;
  /** Copied onto every attempt's record as `recipe_id` (the AI photo's description); null without it. */
  recipeId?: string;
};

function callStatus(err: unknown): AiCallRecord['status'] {
  if (NoObjectGeneratedError.isInstance(err)) return 'invalid_output';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (isApiFailure(err)) return 'api_error';
  return 'error';
}

function usageColumns(usage: LanguageModelUsage | undefined) {
  return {
    input_tokens: usage?.inputTokens ?? null,
    output_tokens: usage?.outputTokens ?? null,
    cached_input_tokens: usage?.inputTokenDetails?.cacheReadTokens ?? null,
    reasoning_tokens: usage?.outputTokenDetails?.reasoningTokens ?? null,
  };
}

const BLOCK_DETAIL_KEYS = ['safetyRatings', 'promptFeedback', 'finishMessage'];

/** The parts of a step's provider metadata that say why it was blocked, or null if there are none. */
function blockDetails(metadata: ProviderMetadata | undefined): AiCallRecord['provider_metadata'] {
  const details: Record<string, Record<string, unknown>> = {};
  for (const [provider, fields] of Object.entries(metadata ?? {})) {
    const kept = Object.fromEntries(
      BLOCK_DETAIL_KEYS.filter((key) => fields[key] != null && !(Array.isArray(fields[key]) && fields[key].length === 0)).map((key) => [key, fields[key]]),
    );
    if (Object.keys(kept).length > 0) details[provider] = kept;
  }
  return Object.keys(details).length > 0 ? details : null;
}

/** The HTTP-level error inside `err`, if any, for its request and response bodies. */
function apiCallError(err: unknown): APICallError | null {
  if (APICallError.isInstance(err)) return err;
  if (RetryError.isInstance(err) && APICallError.isInstance(err.lastError)) return err.lastError;
  return null;
}

/** Provider/API failures (overload, 5xx, network) are worth trying on another model; bad output isn't. */
function isApiFailure(err: unknown): boolean {
  return APICallError.isInstance(err) || RetryError.isInstance(err);
}

/**
 * Gemini's `RECITATION` block: the answer copied too much of a source it knows (a published
 * recipe's steps, copied word for word as the prompts ask). It says nothing about harm, so unlike
 * the other safety blocks it's worth trying on the fallback model.
 */
function isRecitationBlock(err: unknown, rawFinishReason: string | undefined): boolean {
  return NoObjectGeneratedError.isInstance(err) && err.finishReason === 'content-filter' && rawFinishReason === 'RECITATION';
}

/** False when the model's answer had no structured output (`result.output` would throw). */
function hasOutput(result: { readonly output: unknown }): boolean {
  try {
    void result.output;
    return true;
  } catch (err) {
    if (NoOutputGeneratedError.isInstance(err)) return false;
    throw err;
  }
}

/**
 * A call's `ai_calls` row couldn't be written: logged and sent to Sentry, never thrown, so the
 * request carries on. Every call of a broken insert fails the same way, so Sentry groups them.
 */
export function reportAiCallLogFailed(call: Pick<AiCallRecord, 'id' | 'task'>, err: unknown): void {
  const error = asError(err);
  console.error(JSON.stringify({ level: 'error', event: 'ai_call_log_failed', id: call.id, task: call.task, error: error.message.slice(0, 500) }));
  reportError('ai_calls', error, { event: 'ai_call_log_failed', task: call.task });
}

export async function runAiTask<N extends AiTaskName>(
  name: N,
  input: RunAiTaskInput,
  options: RunAiTaskOptions = {},
): Promise<AiTaskResult<z.infer<(typeof aiTasks)[N]['output']>>> {
  const task = aiTasks[name];
  const primaryId = options.model?.modelId ?? task.model();
  if (!primaryId) throw new Error(`No model configured for AI task "${name}"`);
  const primary = options.model ?? { modelId: primaryId };
  const fallbackId = options.fallbackModel?.modelId ?? task.fallbackModel();
  const fallback = fallbackId && fallbackId !== primary.modelId ? (options.fallbackModel ?? { modelId: fallbackId }) : null;

  const record = async (call: AiCallRecord) => {
    if (!options.onCall) return;
    try {
      await options.onCall(call);
    } catch (err) {
      reportAiCallLogFailed(call, err);
    }
  };

  let lastCallId: string | null = null;
  /** Errors from attempts Gemini blocked for recitation, which the fallback may retry. */
  const recitations = new WeakSet<object>();
  const attempt = async (model: { instance?: LanguageModel; modelId: string }) => {
    const id = crypto.randomUUID();
    const fallbackOf = lastCallId;
    lastCallId = id;
    const started = Date.now();
    const base = {
      id,
      user_id: options.caller?.userId ?? null,
      household_id: options.caller?.householdId ?? null,
      recipe_id: options.recipeId ?? null,
      task: name,
      model: model.modelId,
      prompt_version: task.promptVersion,
      instructions: input.instructions,
      prompt: input.prompt,
      fallback_of: fallbackOf,
    };
    const settings = {
      temperature: task.temperature,
      max_output_tokens: task.maxOutputTokens(input.itemCount),
      timeout_ms: task.timeoutMs,
    };
    // The SDK's own NoObjectGeneratedError (unparseable output) carries neither, so keep the step's.
    const step: { rawFinishReason?: string; providerMetadata?: ProviderMetadata } = {};
    let result;
    try {
      result = await generateText({
        model: model.instance ?? resolveModel(model.modelId, task.mock),
        // Widened: TS can't pick one schema from the union of every task's. Still validated against it.
        output: Output.object({ schema: task.output as z.ZodType<unknown> }),
        instructions: input.instructions,
        ...(input.content
          ? {
              messages: [
                {
                  role: 'user' as const,
                  content: input.content.map((part) =>
                    part.type === 'text' ? part : { type: 'image' as const, image: part.data, mediaType: part.mediaType },
                  ),
                },
              ],
            }
          : { prompt: input.prompt }),
        temperature: settings.temperature,
        maxOutputTokens: settings.max_output_tokens,
        providerOptions: task.providerOptions(),
        abortSignal: AbortSignal.timeout(settings.timeout_ms),
        // At most one retry within an attempt. Schema-invalid output is not retried.
        maxRetries: 1,
        onStepEnd: (end) => {
          step.rawFinishReason = end.rawFinishReason;
          step.providerMetadata = end.providerMetadata;
        },
        include: { requestBody: traceListener !== null, responseBody: traceListener !== null },
      });
      // An empty answer (a safety block, say) has no output, and reading it throws
      // NoOutputGeneratedError, which callers don't handle. Make it invalid output, which they do,
      // so it is recorded with its finish reason. The SDK already reports every safety block we can
      // get as `content-filter` (Gemini's blocked prompt, its SAFETY/PROHIBITED_CONTENT finishes,
      // an Anthropic refusal), with or without partial text, so it needs no mapping here.
      if (!hasOutput(result)) {
        throw new NoObjectGeneratedError({
          message: `No output generated (finish reason: ${result.finishReason})`,
          text: result.text,
          response: result.response,
          usage: result.usage,
          finishReason: result.finishReason,
        });
      }
    } catch (err) {
      const invalid = NoObjectGeneratedError.isInstance(err) ? err : null;
      const apiError = apiCallError(err);
      const failed: AiCallRecord = {
        ...base,
        status: callStatus(err),
        output: null,
        response_text: invalid?.text ?? null,
        finish_reason: invalid?.finishReason ?? null,
        raw_finish_reason: step.rawFinishReason ?? null,
        provider_metadata: blockDetails(step.providerMetadata),
        ...usageColumns(invalid?.usage),
        duration_ms: Date.now() - started,
        error: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000),
        http_status: apiError?.statusCode ?? null,
        error_body: apiError?.responseBody?.slice(0, 4000) ?? null,
      };
      await record(failed);
      emitTrace({
        ...failed,
        ...settings,
        request_body: apiError?.requestBodyValues ?? null,
        response_body: apiError?.responseBody ?? invalid?.response?.body ?? null,
        warnings: [],
      });
      if (isRecitationBlock(err, step.rawFinishReason)) recitations.add(err as object);
      throw err;
    }
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'ai_task',
        task: name,
        ai_model: model.modelId,
        prompt_version: task.promptVersion,
        ms: Date.now() - started,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      }),
    );
    const ok: AiCallRecord = {
      ...base,
      status: 'ok',
      output: result.output,
      response_text: result.text,
      finish_reason: result.finishReason,
      raw_finish_reason: result.rawFinishReason ?? null,
      provider_metadata: null,
      ...usageColumns(result.usage),
      duration_ms: Date.now() - started,
      error: null,
      http_status: null,
      error_body: null,
    };
    await record(ok);
    emitTrace({
      ...ok,
      ...settings,
      request_body: result.request.body ?? null,
      response_body: result.response.body ?? null,
      warnings: result.warnings ?? [],
    });
    return { result, modelId: model.modelId, callId: id };
  };

  let ran;
  try {
    ran = await attempt(primary);
  } catch (err) {
    if (!fallback || !(isApiFailure(err) || recitations.has(err as object))) throw err;
    console.warn(
      JSON.stringify({ level: 'warn', event: 'ai_fallback', task: name, from: primary.modelId, to: fallback.modelId, error: String(err).slice(0, 200) }),
    );
    ran = await attempt(fallback);
  }
  const { result, modelId, callId } = ran;
  // Validated against task.output by the SDK; TS can't narrow the indexed generic itself.
  const output = result.output as z.infer<(typeof aiTasks)[N]['output']>;
  return { output, model: modelId, promptVersion: task.promptVersion, usage: result.usage, callId };
}
