// Provider registry (spec §6.4), copied from stash. A provider is registered only if its key is
// present, so a model string for a missing provider fails with AI_NoSuchProviderError.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createProviderRegistry, type LanguageModel } from 'ai';

import { MOCK_MODEL_ID, mockCategorizeModel } from './mock-model.ts';

let registry: ReturnType<typeof build> | undefined;

function build() {
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  return createProviderRegistry({
    ...(anthropicKey ? { anthropic: createAnthropic({ apiKey: anthropicKey }) } : {}),
  });
}

/**
 * Resolves a `provider:model` string, e.g. `anthropic:claude-haiku-5-5`. `mock` is the
 * deterministic fake (spec §8.3), which never touches the network. `off` isn't a model: callers
 * check `isAiEnabled` first.
 */
export function resolveModel(spec: string): LanguageModel {
  if (spec === MOCK_MODEL_ID) return mockCategorizeModel();
  registry ??= build();
  return registry.languageModel(spec as Parameters<typeof registry.languageModel>[0]);
}
