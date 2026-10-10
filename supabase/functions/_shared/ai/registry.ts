// Provider registry (spec §6.4), copied from stash. A provider is registered only if its key is
// present, so a model string for a missing provider fails with AI_NoSuchProviderError.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createProviderRegistry, type LanguageModel } from 'ai';

import { MOCK_MODEL_ID, mockCategorizeModel } from './mock-model.ts';

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
 * Resolves a `provider:model` string, e.g. `google:gemini-3.8-flash`. `mock` is the
 * deterministic fake (spec §8.3), which never touches the network. `off` isn't a model: callers
 * check `isAiEnabled` first.
 */
export function resolveModel(spec: string): LanguageModel {
  if (spec === MOCK_MODEL_ID) return mockCategorizeModel();
  registry ??= build();
  return registry.languageModel(spec as Parameters<typeof registry.languageModel>[0]);
}
