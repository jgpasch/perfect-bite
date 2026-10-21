// The moderation check for generate-recipe-photo (spec 6.11): the image prompt goes to OpenAI's
// free moderation endpoint before the image call, so a bad prompt stops with us instead of being
// refused by the image model (each refusal there counts against our OpenAI account). A plain
// fetch, no SDK, as image.ts. It follows `AI_IMAGE_MODEL`: `mock` answers not flagged with no
// network call; `off` never gets here (the caller checks `isImageEnabled` first).
import { MOCK_MODEL_ID } from '../_shared/ai/registry.ts';
import { AI_OFF } from '../_shared/ai/tasks.ts';
import { imageModel, type ImageErrorAnswer, type ImageFailure } from './image.ts';

export const OPENAI_MODERATIONS_URL = 'https://api.openai.com/v1/moderations';
export const MODERATION_MODEL = 'omni-moderation-latest';
/** No answer within this is a failure (502). */
export const MODERATION_TIMEOUT_MS = 10_000;

type Env = (key: string) => string | undefined;
const defaultEnv: Env = (key) => Deno.env.get(key);

/** `flagged`, and the names of the categories OpenAI set true, sorted. */
export type ModerationResult = { flagged: boolean; categories: string[] };

/** The moderation model as `ai_calls` names models: `openai:omni-moderation-latest`, or `mock` with the mock image model. */
export function moderationModelId(env: Env = defaultEnv): string {
  return imageModel(env) === MOCK_MODEL_ID ? MOCK_MODEL_ID : `openai:${MODERATION_MODEL}`;
}

/**
 * Why a moderation call failed, as its `ai_calls` status: an HTTP error or a network error
 * `api_error`, the timeout `timeout`, an answer without `results[0].flagged` `invalid_output`,
 * anything else (no key, `off`) `error`.
 */
export class ModerationFailedError extends Error {
  override name = 'ModerationFailedError';
  readonly httpStatus: number | null;
  readonly body: string | null;
  constructor(
    message: string,
    readonly failure: ImageFailure = 'error',
    answer: ImageErrorAnswer = { httpStatus: null, body: null },
  ) {
    super(message);
    this.httpStatus = answer.httpStatus;
    this.body = answer.body;
  }
}

export type ModerationOptions = {
  env?: Env;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Moderates `text` with `omni-moderation-latest`. Throws `ModerationFailedError` for an HTTP
 * error, a network error, no answer within `MODERATION_TIMEOUT_MS`, or an answer without
 * `results[0].flagged`.
 */
export async function moderateText(text: string, options: ModerationOptions = {}): Promise<ModerationResult> {
  const env = options.env ?? defaultEnv;
  const model = imageModel(env);
  if (model === AI_OFF) throw new ModerationFailedError('AI_IMAGE_MODEL is off', 'error');
  if (model === MOCK_MODEL_ID) return { flagged: false, categories: [] };

  const apiKey = env('OPENAI_API_KEY')?.trim();
  if (!apiKey) throw new ModerationFailedError('OPENAI_API_KEY is not set', 'error');

  let res: Response;
  let raw: string;
  try {
    res = await (options.fetch ?? fetch)(OPENAI_MODERATIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODERATION_MODEL, input: text }),
      signal: AbortSignal.timeout(options.timeoutMs ?? MODERATION_TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (timedOut) throw new ModerationFailedError('No moderation answer within the timeout', 'timeout');
    throw new ModerationFailedError(`Request failed: ${err instanceof Error ? err.message : String(err)}`, 'api_error');
  }
  let body: { results?: { flagged?: unknown; categories?: unknown }[]; error?: { message?: unknown } } | null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new ModerationFailedError(`OpenAI answered ${res.status}: ${String(body?.error?.message ?? '').slice(0, 200)}`, 'api_error', {
      httpStatus: res.status,
      body: raw === '' ? null : raw,
    });
  }
  const result = body?.results?.[0];
  if (typeof result?.flagged !== 'boolean') {
    throw new ModerationFailedError('No flagged in the moderation answer', 'invalid_output', { httpStatus: res.status, body: raw === '' ? null : raw });
  }
  const categories =
    result.categories && typeof result.categories === 'object'
      ? Object.entries(result.categories as Record<string, unknown>)
          .filter(([, value]) => value === true)
          .map(([name]) => name)
          .sort()
      : [];
  return { flagged: result.flagged, categories };
}
