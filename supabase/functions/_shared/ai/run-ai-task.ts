// The only code that calls the AI SDK (spec §6.4), copied from stash.
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
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

type InjectedModel = { instance: LanguageModel; modelId: string };

export type RunAiTaskInput = {
  instructions: string;
  prompt: string;
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

/** Provider/API failures (overload, 5xx, network) are worth trying on another model; bad output isn't. */
function isApiFailure(err: unknown): boolean {
  return APICallError.isInstance(err) || RetryError.isInstance(err);
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
    let result;
    try {
      result = await generateText({
        model: model.instance ?? resolveModel(model.modelId),
        output: Output.object({ schema: task.output }),
        instructions: input.instructions,
        prompt: input.prompt,
        temperature: task.temperature,
        maxOutputTokens: task.maxOutputTokens(input.itemCount),
        abortSignal: AbortSignal.timeout(task.timeoutMs),
        // At most one retry within an attempt. Schema-invalid output is not retried.
        maxRetries: 1,
      });
    } catch (err) {
      const invalid = NoObjectGeneratedError.isInstance(err) ? err : null;
      await record({
        ...base,
        status: callStatus(err),
        output: null,
        response_text: invalid?.text ?? null,
        finish_reason: invalid?.finishReason ?? null,
        ...usageColumns(invalid?.usage),
        duration_ms: Date.now() - started,
        error: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000),
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
    await record({
      ...base,
      status: 'ok',
      output: result.output,
      response_text: result.text,
      finish_reason: result.finishReason,
      ...usageColumns(result.usage),
      duration_ms: Date.now() - started,
      error: null,
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
