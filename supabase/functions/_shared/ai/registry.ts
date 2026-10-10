// Provider registry (spec §6.4), copied from stash. A provider is registered only if its key is
// present, so a model string for a missing provider fails with AI_NoSuchProviderError.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createProviderRegistry, type LanguageModel } from 'ai';

/** `AI_MODEL_*=mock`: each task's deterministic fake (spec §8.3). */
export const MOCK_MODEL_ID = 'mock';

let registry: ReturnType<typeof build> | undefined;

function build() {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const googleKey = Deno.env.get('GOOGLE_GENERATIVE_AI_API_KEY');
  return createProviderRegistry({
    ...(anthropicKey ? { anthropic: createAnthropic({ apiKey: anthropicKey }) } : {}),
    ...(googleKey ? { google: createGoogleGenerativeAI({ apiKey: googleKey }) } : {}),
  });
}

/**
 * Resolves a `provider:model` string, e.g. `google:gemini-3.8-flash`. `mock` is the task's
 * deterministic fake, passed as `mock`, which never touches the network. `off` isn't a model:
 * callers check `isAiEnabled` first.
 */
export function resolveModel(spec: string, mock?: () => LanguageModel): LanguageModel {
  if (spec === MOCK_MODEL_ID) {
    if (!mock) throw new Error('This AI task has no mock model');
    return mock();
  }
  registry ??= build();
  return registry.languageModel(spec as Parameters<typeof registry.languageModel>[0]);
}
