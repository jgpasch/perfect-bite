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
} from 'ai';
import type { z } from 'zod';

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

/** One model attempt, as stored in `public.ai_calls`. No user id (spec §6.5). */
export type AiCallRecord = {
  id: string;
  task: AiTaskName;
  model: string;
  prompt_version: string;
  status: 'ok' | 'api_error' | 'invalid_output' | 'timeout' | 'error';
  instructions: string;
  prompt: string;
  output: unknown;
  response_text: string | null;
  finish_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  duration_ms: number;
  error: string | null;
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
      console.error(JSON.stringify({ level: 'error', event: 'ai_call_log_failed', id: call.id, error: String(err).slice(0, 200) }));
    }
  };

  let lastCallId: string | null = null;
  const attempt = async (model: { instance?: LanguageModel; modelId: string }) => {
    const id = crypto.randomUUID();
    const fallbackOf = lastCallId;
    lastCallId = id;
    const started = Date.now();
    const base = {
      id,
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
        include: { requestBody: traceListener !== null, responseBody: traceListener !== null },
      });
      // An empty answer (a safety block, say) has no output, and reading it throws
      // NoOutputGeneratedError, which callers don't handle. Make it invalid output, which they do,
      // so it is recorded with its finish reason.
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
        ...usageColumns(invalid?.usage),
        duration_ms: Date.now() - started,
        error: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000),
      };
      await record(failed);
      emitTrace({
        ...failed,
        ...settings,
        request_body: apiError?.requestBodyValues ?? null,
        response_body: apiError?.responseBody ?? invalid?.response?.body ?? null,
        warnings: [],
      });
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
      ...usageColumns(result.usage),
      duration_ms: Date.now() - started,
      error: null,
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
    if (!fallback || !isApiFailure(err)) throw err;
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
