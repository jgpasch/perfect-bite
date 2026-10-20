// The image call for generate-recipe-photo (spec 6.11): a plain fetch to OpenAI's Images API, no
// SDK. `AI_IMAGE_MODEL=mock` answers a fixed JPEG with no network call; `off` is the kill switch,
// checked by the caller with `isImageEnabled` before anything is reserved.
import { MOCK_RECIPE_PHOTO_JPEG } from '../_shared/fixtures/mock-recipe-photo.ts';
import { AI_OFF } from '../_shared/ai/tasks.ts';
import { MOCK_MODEL_ID } from '../_shared/ai/registry.ts';

export const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
export const DEFAULT_IMAGE_MODEL = 'gpt-image-1-mini';
export const DEFAULT_IMAGE_QUALITY = 'medium';
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
/** Landscape, the closest to the app's 4:3 photos. */
export const IMAGE_SIZE = '1536x1024';
export const IMAGE_COMPRESSION = 80;
/** No answer within this is a failure (502). */
export const IMAGE_TIMEOUT_MS = 60_000;

type Env = (key: string) => string | undefined;
const defaultEnv: Env = (key) => Deno.env.get(key);

/** `AI_IMAGE_MODEL`, else `gpt-image-1-mini`. May be `mock` or `off`. */
export function imageModel(env: Env = defaultEnv): string {
  return env('AI_IMAGE_MODEL')?.trim() || DEFAULT_IMAGE_MODEL;
}

/** `AI_IMAGE_QUALITY` when it's one OpenAI takes, else `medium`. */
export function imageQuality(env: Env = defaultEnv): string {
  const value = env('AI_IMAGE_QUALITY')?.trim() ?? '';
  return (IMAGE_QUALITIES as readonly string[]).includes(value) ? value : DEFAULT_IMAGE_QUALITY;
}

/** The image model as `ai_calls` names models: `openai:gpt-image-1-mini`, or `mock` for the mock. */
export function imageModelId(model: string): string {
  return model === MOCK_MODEL_ID ? model : `openai:${model}`;
}

/** False when `AI_IMAGE_MODEL=off`. */
export function isImageEnabled(env: Env = defaultEnv): boolean {
  return imageModel(env) !== AI_OFF;
}

export type ImageUsage = { inputTokens: number | null; outputTokens: number | null };

export type GeneratedImage = {
  bytes: Uint8Array;
  model: string;
  quality: string;
  ms: number;
  /** OpenAI's token counts, when it sent them; null for the mock. */
  usage: ImageUsage | null;
};

/** OpenAI's HTTP answer to a failed call, when there was one, for its `ai_calls` row. */
export type ImageErrorAnswer = { httpStatus: number | null; body: string | null };

/** The image model refused the prompt (`moderation_blocked` or another content-policy error): `not_food`. */
export class ImageRefusedError extends Error {
  override name = 'ImageRefusedError';
  readonly httpStatus: number | null;
  readonly body: string | null;
  constructor(message: string, answer: ImageErrorAnswer = { httpStatus: null, body: null }) {
    super(message);
    this.httpStatus = answer.httpStatus;
    this.body = answer.body;
  }
}

/**
 * Why an image call failed, as its `ai_calls` status: an HTTP error or a network error
 * `api_error`, the timeout `timeout`, no image or bad base64 `invalid_output`, anything else (no
 * key, `off`) `error`.
 */
export type ImageFailure = 'api_error' | 'timeout' | 'invalid_output' | 'error';

/** Any other failure: an HTTP error, no image in the answer, a network error or the timeout. */
export class ImageFailedError extends Error {
  override name = 'ImageFailedError';
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

export type ImageOptions = {
  env?: Env;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** True for OpenAI's content-policy refusals, whatever code or wording it uses for them. */
export function isContentPolicyError(error: { code?: unknown; type?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return (
    code === 'moderation_blocked' ||
    code === 'content_policy_violation' ||
    /safety system|content policy/i.test(message)
  );
}

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * One image for `prompt`: `IMAGE_SIZE`, JPEG at `IMAGE_COMPRESSION`, moderation left at OpenAI's
 * default. Throws `ImageRefusedError` for a content-policy refusal and `ImageFailedError` for
 * anything else, including no answer within `IMAGE_TIMEOUT_MS`.
 */
export async function generateImage(prompt: string, options: ImageOptions = {}): Promise<GeneratedImage> {
  const env = options.env ?? defaultEnv;
  const model = imageModel(env);
  const quality = imageQuality(env);
  const started = Date.now();
  if (model === AI_OFF) throw new ImageFailedError('AI_IMAGE_MODEL is off', 'error');
  if (model === MOCK_MODEL_ID) return { bytes: MOCK_RECIPE_PHOTO_JPEG.slice(), model, quality, ms: Date.now() - started, usage: null };

  const apiKey = env('OPENAI_API_KEY')?.trim();
  if (!apiKey) throw new ImageFailedError('OPENAI_API_KEY is not set', 'error');

  let res: Response;
  let text: string;
  try {
    res = await (options.fetch ?? fetch)(OPENAI_IMAGES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, quality, size: IMAGE_SIZE, n: 1, output_format: 'jpeg', output_compression: IMAGE_COMPRESSION }),
      signal: AbortSignal.timeout(options.timeoutMs ?? IMAGE_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (timedOut) throw new ImageFailedError('No image within the timeout', 'timeout');
    throw new ImageFailedError(`Request failed: ${err instanceof Error ? err.message : String(err)}`, 'api_error');
  }
  let body: { data?: { b64_json?: unknown }[]; usage?: { input_tokens?: unknown; output_tokens?: unknown }; error?: { code?: unknown; type?: unknown; message?: unknown } } | null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok) {
    // Only failed answers keep their body: a successful one holds the image.
    const answer = { httpStatus: res.status, body: text === '' ? null : text };
    if (isContentPolicyError(body?.error)) throw new ImageRefusedError(`Refused: ${String(body?.error?.message ?? body?.error?.code).slice(0, 200)}`, answer);
    throw new ImageFailedError(`OpenAI answered ${res.status}: ${String(body?.error?.message ?? '').slice(0, 200)}`, 'api_error', answer);
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || b64 === '') throw new ImageFailedError('No image in the answer', 'invalid_output');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(b64);
  } catch {
    throw new ImageFailedError('The image is not valid base64', 'invalid_output');
  }
  const tokens = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const usage = body?.usage ? { inputTokens: tokens(body.usage.input_tokens), outputTokens: tokens(body.usage.output_tokens) } : null;
  return { bytes, model, quality, ms: Date.now() - started, usage };
}

/**
 * GPT Image mini's prices (USD per million tokens): text input $2, image output $8. About a cent
 * for a medium 1536×1024 image (about 1,600 output tokens).
 */
const MINI_PRICES = { input: 2, output: 8 } as const;

/** Roughly what one image cost, in USD, from its token counts; null when we can't tell (another model, no usage). */
export function estimateImageCost(image: Pick<GeneratedImage, 'model' | 'usage'>): number | null {
  if (image.model !== DEFAULT_IMAGE_MODEL || !image.usage) return null;
  return ((image.usage.inputTokens ?? 0) * MINI_PRICES.input + (image.usage.outputTokens ?? 0) * MINI_PRICES.output) / 1_000_000;
}
