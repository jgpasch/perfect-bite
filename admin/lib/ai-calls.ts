// The wording of the AI calls pages (spec 4.12, admin_list_ai_calls and admin_ai_call): the tabs,
// filters and paging in the URL, the task, status and flag labels, who made a call, an error's first
// line, a response body pretty-printed, and a user's AI flags line, kept out of the pages so they
// can be tested.
import { isUuid, parsePage, parseQuery } from "./users";
import type { AdminAiCallRow, AiCallFlag, AiCallKind, AiCallStatus } from "./types";

/** Calls a page on /ai-calls. */
export const AI_CALLS_PAGE_SIZE = 50;

/** How long the photos' signed URLs last, in seconds. */
export const PHOTO_URL_SECONDS = 60 * 60;

/** The tabs, in order, with their labels and empty states. */
export const AI_CALL_KINDS = {
  flagged: { label: "Flagged", empty: "No flagged AI calls in the last 180 days." },
  failed: { label: "Failed", empty: "No failed AI calls in the last 30 days." },
  photos: { label: "AI photos", empty: "No AI photos in the last 30 days." },
} as const satisfies Record<AiCallKind, { label: string; empty: string }>;

export const AI_CALL_KIND_KEYS = Object.keys(AI_CALL_KINDS) as AiCallKind[];

/** `ai_calls.task` as stored, in the order the functions were built, with readable labels. */
export const TASK_LABELS = {
  categorize: "Categorize",
  extractRecipe: "Recipe import",
  extractRecipePhoto: "Photo import",
  suggestRecipeTags: "Tag suggestions",
  matchRecipeSteps: "Step matching",
  recipePhotoDescription: "AI photo: description",
  recipePhotoImage: "AI photo: image",
} as const satisfies Record<string, string>;

export const TASK_KEYS = Object.keys(TASK_LABELS) as (keyof typeof TASK_LABELS)[];

export const STATUS_LABELS = {
  ok: "OK",
  api_error: "API error",
  invalid_output: "Invalid output",
  timeout: "Timed out",
  refused: "Refused",
  error: "Error",
} as const satisfies Record<AiCallStatus, string>;

export const STATUS_KEYS = Object.keys(STATUS_LABELS) as AiCallStatus[];

export const FLAG_LABELS = {
  not_food: "Not food",
  refused: "Refused",
  content_filter: "Content filter",
} as const satisfies Record<AiCallFlag, string>;

export const FLAG_KEYS = Object.keys(FLAG_LABELS) as AiCallFlag[];

function label(labels: Record<string, string>, key: string): string {
  return Object.hasOwn(labels, key) ? labels[key] : key;
}

/** "Recipe import" for `extractRecipe`; the raw name for a task the portal doesn't know. */
export function taskLabel(task: string): string {
  return label(TASK_LABELS, task);
}

/** "API error" for `api_error`; the raw value for an unknown one. */
export function statusLabel(status: string): string {
  return label(STATUS_LABELS, status);
}

/** "Not food" for `not_food`; the raw value for an unknown one. */
export function flagLabel(flag: string): string {
  return label(FLAG_LABELS, flag);
}

/** A row's badge: its flag when it has one, else its status. `danger` for anything but an unflagged `ok`. */
export function callBadge(row: Pick<AdminAiCallRow, "status" | "flag">): { label: string; tone: "danger" | "ok" } {
  if (row.flag) return { label: flagLabel(row.flag), tone: "danger" };
  return { label: statusLabel(row.status), tone: row.status === "ok" ? "ok" : "danger" };
}

// --- The URL ---------------------------------------------------------------------------------

export type AiCallsParams = {
  kind: AiCallKind;
  /** "" for none. */
  task: string;
  status: string;
  /** Flagged only. */
  flag: string;
  /** A user id, "" for none. */
  user: string;
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

/** `?kind=` as a tab; anything else, none included, is Flagged (the first). */
export function parseKind(value: string | string[] | undefined): AiCallKind {
  const raw = parseQuery(value);
  return Object.hasOwn(AI_CALL_KINDS, raw) ? (raw as AiCallKind) : "flagged";
}

/**
 * The page's state from its search params. A user that isn't a uuid is dropped (the function
 * would reject it), and so is a filter the tab doesn't have: AI photos are all `ok` image calls,
 * so there they filter by user only, and only Flagged filters by flag.
 */
export function parseAiCallsParams(params: SearchParams): AiCallsParams {
  const kind = parseKind(params.kind);
  const user = parseQuery(params.user);
  const photos = kind === "photos";
  return {
    kind,
    task: photos ? "" : parseQuery(params.task),
    status: photos ? "" : parseQuery(params.status),
    flag: kind === "flagged" ? parseQuery(params.flag) : "",
    user: isUuid(user) ? user.toLowerCase() : "",
    page: parsePage(params.page),
  };
}

/** The page's URL: `/ai-calls?kind=failed&task=extractRecipe&page=2`. Blank filters and page 1 are left out. */
export function aiCallsHref(params: Partial<AiCallsParams> & { kind: AiCallKind }): string {
  const search = new URLSearchParams({ kind: params.kind });
  for (const key of ["task", "status", "flag", "user"] as const) {
    const value = params[key]?.trim() ?? "";
    if (value !== "") search.set(key, value);
  }
  if ((params.page ?? 1) > 1) search.set("page", String(params.page));
  return `/ai-calls?${search.toString()}`;
}

/** `admin_list_ai_calls`'s arguments for the page's state. */
export function listArgs(params: AiCallsParams) {
  const blank = (value: string) => (value === "" ? null : value);
  return {
    p_kind: params.kind,
    p_task: blank(params.task),
    p_status: blank(params.status),
    p_flag: blank(params.flag),
    p_user_id: blank(params.user),
    p_limit: AI_CALLS_PAGE_SIZE,
    p_offset: (params.page - 1) * AI_CALLS_PAGE_SIZE,
  };
}

/** A filter's choices: the known ones, plus the current one when it isn't known. */
export function filterOptions(
  labels: Record<string, string>,
  current: string,
  exclude: readonly string[] = [],
): { value: string; label: string }[] {
  const options = Object.entries(labels)
    .filter(([value]) => !exclude.includes(value))
    .map(([value, text]) => ({ value, label: text }));
  if (current !== "" && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
  return options;
}

// --- A call's pieces -------------------------------------------------------------------------

export type CallUser =
  | { kind: "user"; label: string; href: string }
  | { kind: "deleted" | "script"; label: string };

/** Who made it: their email linking to their page, "Deleted user" once they're gone, "Dev script" with no user id. */
export function callUser(row: Pick<AdminAiCallRow, "user_id" | "user_email">): CallUser {
  if (row.user_id === null) return { kind: "script", label: "Dev script" };
  if (row.user_email === null) return { kind: "deleted", label: "Deleted user" };
  return { kind: "user", label: row.user_email, href: `/users/${row.user_id}` };
}

/** The error's first non-blank line, trimmed; "" with none. */
export function errorFirstLine(error: string | null): string {
  if (error === null) return "";
  return error.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
}

/** A response or error body: JSON pretty-printed, other text as it is, "(none)" when null or blank. */
export function prettyBody(body: string | null): string {
  if (body === null || body.trim() === "") return "(none)";
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) return JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON: shown as it came.
  }
  return body;
}

/** "850 ms", "12.4 s". */
export function durationText(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

const number = new Intl.NumberFormat("en-US");

/** "1,234 in · 56 out · 1,000 cached · 12 reasoning", leaving out what's null; "—" with none. */
export function tokensText(call: {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
}): string {
  const parts = (
    [
      [call.input_tokens, "in"],
      [call.output_tokens, "out"],
      [call.cached_input_tokens, "cached"],
      [call.reasoning_tokens, "reasoning"],
    ] as const
  )
    .filter(([value]) => value !== null)
    .map(([value, name]) => `${number.format(value as number)} ${name}`);
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/**
 * How a linked attempt reads on a call's page: "Fallback" and "Primary", except that an AI photo's
 * description and image call link to each other ("Image call" / "Description"), not as fallbacks.
 */
export function linkLabel(direction: "fallback" | "primary", callTask: string, linkedTask: string): string {
  const image = "recipePhotoImage";
  if (direction === "fallback") return linkedTask === image && callTask !== image ? "Image call" : "Fallback";
  return callTask === image && linkedTask !== image ? "Description" : "Primary";
}

/**
 * Each photo's signed URL from one `createSignedUrls` answer, by path; null for one that failed
 * (the object is gone). Paths missing from the answer are null too.
 */
export function signedUrlsByPath(
  paths: readonly string[],
  answer: readonly { path: string | null; signedUrl: string | null; error: string | null }[] | null,
): Map<string, string | null> {
  const urls = new Map<string, string | null>(paths.map((path) => [path, null]));
  for (const entry of answer ?? []) {
    if (entry.path !== null && urls.has(entry.path) && entry.error === null && entry.signedUrl) {
      urls.set(entry.path, entry.signedUrl);
    }
  }
  return urls;
}

/** The user page's AI flags line: "2 not food, 1 refused in the last 30 days", or "None". */
export function aiFlagsLine(flags: Record<string, number> | null | undefined): string {
  const counts = Object.entries(flags ?? {}).filter(([, n]) => typeof n === "number" && n > 0);
  if (counts.length === 0) return "None";
  const order = (flag: string) => {
    const index = (FLAG_KEYS as string[]).indexOf(flag);
    return index === -1 ? FLAG_KEYS.length : index;
  };
  counts.sort(([a], [b]) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
  const parts = counts.map(([flag, n]) => `${number.format(n)} ${flagLabel(flag).toLowerCase()}`);
  return `${parts.join(", ")} in the last 30 days`;
}
