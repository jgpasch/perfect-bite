// Spec 6.6 step 5. Reads a schema.org Recipe out of a page's JSON-LD blocks, so most imports
// hand the LLM clean ingredient lines instead of page text. Keep it pure (runs under Deno too).
import { isStepHeading, MAX_RECIPE_SECTION_LENGTH, MAX_RECIPE_SECTIONS, type RecipeStepEntry } from './recipe-steps.ts';
import { MAX_TOTAL_MINUTES, MIN_TOTAL_MINUTES } from './recipe-tags.ts';

export type JsonLdRecipe = {
  name: string | null;
  ingredientLines: string[];
  servings: number | null;
  /** `totalTime`, else `prepTime` + `cookTime`, in minutes (spec 4.14); null when none is usable. */
  totalMinutes: number | null;
  /** `recipeInstructions` as clean, numbered-free steps in order; empty when there are none. */
  steps: string[];
  /**
   * The first usable `image` (an `@id` reference resolved), else `thumbnailUrl`, cleaned by
   * `cleanImageUrl`; null when none is.
   */
  imageUrl: string | null;
};

/** Bounds of `recipes.steps` and `recipes.image_url` (spec 5). */
export const MAX_RECIPE_STEPS = 100;
export const MAX_RECIPE_STEP_LENGTH = 2000;
export const MAX_IMAGE_URL_LENGTH = 2048;

const DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/**
 * An ISO 8601 duration as whole minutes: `PT45M` → 45, `PT1H20M` → 80, `P0DT2H30M` → 150.
 * Days, hours, minutes and seconds only (years, months and weeks aren't recipe times). Anything
 * else, or a duration of no time at all, is null.
 */
export function parseIsoDuration(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = DURATION.exec(raw.trim());
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const total = Math.round(days * 1440 + hours * 60 + minutes + seconds / 60);
  return total > 0 ? total : null;
}

/** The recipe's time within `recipes.total_minutes` bounds: `totalTime`, else prep + cook. */
function readTotalMinutes(node: Record<string, unknown>): number | null {
  let minutes = parseIsoDuration(node.totalTime);
  if (minutes === null) {
    const prep = parseIsoDuration(node.prepTime);
    const cook = parseIsoDuration(node.cookTime);
    minutes = prep === null && cook === null ? null : (prep ?? 0) + (cook ?? 0);
  }
  return minutes !== null && minutes >= MIN_TOTAL_MINUTES && minutes <= MAX_TOTAL_MINUTES ? minutes : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  deg: '°',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  rsquo: '’',
};

/** Decodes numeric entities and the named ones recipe pages use; unknown names stay as written. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Strips tags, decodes HTML entities and collapses whitespace. */
export function cleanJsonLdText(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for "Recipe", "schema:Recipe" or "https://schema.org/Recipe", alone or in an array. */
function isRecipeNode(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && /(^|[/:])Recipe$/.test(t.trim()));
}

/** Every object reachable through top-level arrays and `@graph`, in document order. */
function collectNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out);
  } else if (isObject(value)) {
    out.push(value);
    if ('@graph' in value) collectNodes(value['@graph'], out);
  }
}

function readIngredientLines(node: Record<string, unknown>): string[] {
  const raw = node.recipeIngredient ?? node.ingredients;
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map(cleanJsonLdText)
    .filter((line) => line.length > 0);
}

/** The first positive number in a yield: 4, "4", "4 servings", "Makes 12", "4-6". */
function readServings(raw: unknown): number | null {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const servings = readServings(item);
      if (servings !== null) return servings;
    }
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) || null : null;
  }
  if (typeof raw === 'string') {
    const match = /\d+(?:\.\d+)?/.exec(cleanJsonLdText(raw));
    return match ? readServings(Number(match[0])) : null;
  }
  return null;
}

/**
 * "1.", "2)", "Step 2:", "STEP 3 -", "Step 4" at the start of a step. A bare number isn't
 * numbering ("2 eggs go in…"), nor is a decimal ("1.5 cups…").
 */
const STEP_NUMBERING = /^(?:step\s*\d+\s*[.):-]?|\d+\s*[.):-](?!\d))\s*/i;

/** A single string of steps splits on line breaks, `<br>` and the end of a paragraph or list item. */
const STEP_BREAK = /\r\n|\r|\n|<br\s*\/?>|<\/(?:p|li|div)>/i;

/** The raw step texts of `recipeInstructions`, in order, before cleaning. */
function collectStepTexts(raw: unknown, out: string[]): void {
  if (typeof raw === 'string') {
    out.push(raw);
  } else if (Array.isArray(raw)) {
    for (const item of raw) collectStepTexts(item, out);
  } else if (isObject(raw)) {
    if ('itemListElement' in raw) {
      // A HowToSection: its steps in order, without the section's name.
      collectStepTexts(raw.itemListElement, out);
      return;
    }
    // A HowToStep: its text, else its name.
    const text = typeof raw.text === 'string' && cleanJsonLdText(raw.text) !== '' ? raw.text : raw.name;
    if (typeof text === 'string') out.push(text);
  }
}

/** Clean steps from `recipeInstructions`, as `cleanRecipeSteps` leaves them. */
function readSteps(raw: unknown): string[] {
  const texts: string[] = [];
  // A single string holds every step; in an array or HowToStep each string is one step.
  if (typeof raw === 'string') texts.push(...raw.split(STEP_BREAK));
  else collectStepTexts(raw, texts);
  return cleanRecipeSteps(texts);
}

/** A step's or heading's text: no HTML or leading numbering, at most `max` code points. */
function cleanStepText(text: string, max: number): string {
  const clean = cleanJsonLdText(text).replace(STEP_NUMBERING, '').trim();
  // By code point, so an emoji isn't cut in half.
  return clean.length > max ? Array.from(clean).slice(0, max).join('').trimEnd() : clean;
}

/**
 * Steps as `recipes.steps` keeps them: no HTML, no leading numbering, no blanks or repeats of the
 * step before, steps of at most 2000 characters (code points). Headings (spec 4.5) are cleaned the
 * same way, at most 80 characters, keep `choice` only when it's `true`, and are dropped when empty,
 * when no step follows them, when another heading follows straight after, or past the 20th. At
 * most 100 entries in all. Shared by JSON-LD's steps and the model's; step strings in give step
 * strings out.
 */
export function cleanRecipeSteps(entries: readonly string[]): string[];
export function cleanRecipeSteps(entries: readonly RecipeStepEntry[]): RecipeStepEntry[];
export function cleanRecipeSteps(entries: readonly RecipeStepEntry[]): RecipeStepEntry[] {
  const cleaned: RecipeStepEntry[] = [];
  for (const entry of entries) {
    if (isStepHeading(entry)) {
      const section = cleanStepText(entry.section, MAX_RECIPE_SECTION_LENGTH);
      if (section !== '') cleaned.push(entry.choice === true ? { section, choice: true } : { section });
      continue;
    }
    const step = cleanStepText(entry, MAX_RECIPE_STEP_LENGTH);
    if (step.length === 0 || step === cleaned.at(-1)) continue;
    cleaned.push(step);
  }
  const kept: RecipeStepEntry[] = [];
  let headings = 0;
  cleaned.forEach((entry, i) => {
    if (isStepHeading(entry)) {
      const next = cleaned[i + 1];
      if (next === undefined || isStepHeading(next) || headings === MAX_RECIPE_SECTIONS) return;
      headings++;
    }
    kept.push(entry);
  });
  const capped = kept.slice(0, MAX_RECIPE_STEPS);
  // The cap may cut a heading off from its steps.
  if (capped.length > 0 && isStepHeading(capped[capped.length - 1])) capped.pop();
  return capped;
}

/**
 * An image URL as `recipes.image_url` keeps it: resolved against `pageUrl` when relative, and only
 * if it's `https://` and at most 2048 characters. Anything else is null. Shared by JSON-LD's
 * `image` and the page's og:image.
 */
export function cleanImageUrl(raw: unknown, pageUrl?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = decodeHtmlEntities(raw).trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = pageUrl ? new URL(trimmed, pageUrl) : new URL(trimmed);
  } catch {
    return null;
  }
  const href = url.href;
  return url.protocol === 'https:' && href.length <= MAX_IMAGE_URL_LENGTH ? href : null;
}

/** Nodes by `@id`, so `{ "@id": … }` references resolve (Yoast and WordPress put images in the `@graph`). */
type NodesById = Map<string, Record<string, unknown>>;

function indexById(nodes: Record<string, unknown>[]): NodesById {
  const byId: NodesById = new Map();
  for (const node of nodes) {
    const id = node['@id'];
    // A bare reference isn't the node it points at.
    if (typeof id === 'string' && Object.keys(node).some((key) => key !== '@id') && !byId.has(id)) byId.set(id, node);
  }
  return byId;
}

/**
 * Every usable image in `raw`, in order: a URL string, an `ImageObject` (`url`, else `contentUrl`),
 * a `{ "@id": … }` reference to one in `byId`, or an array of them.
 */
function readImageUrls(raw: unknown, pageUrl: string | null | undefined, byId: NodesById, depth = 0): string[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => readImageUrls(item, pageUrl, byId, depth));
  if (isObject(raw)) {
    const own = cleanImageUrl(raw.url, pageUrl) ?? cleanImageUrl(raw.contentUrl, pageUrl);
    if (own !== null) return [own];
    const target = typeof raw['@id'] === 'string' ? byId.get(raw['@id']) : undefined;
    // One hop is all a reference needs; more would only be a cycle.
    return target && target !== raw && depth < 2 ? readImageUrls(target, pageUrl, byId, depth + 1) : [];
  }
  const url = cleanImageUrl(raw, pageUrl);
  return url === null ? [] : [url];
}

/** A Recipe's photos: its `image`, then its `thumbnailUrl`. */
function recipeImageUrls(node: Record<string, unknown>, pageUrl: string | null | undefined, byId: NodesById): string[] {
  return [...readImageUrls(node.image, pageUrl, byId), ...readImageUrls(node.thumbnailUrl, pageUrl, byId)];
}

/** True when `@type` (a string or an array) has one of `names`, bare or as a schema.org IRI. */
function hasType(node: Record<string, unknown>, names: readonly string[]): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && names.includes(t.trim().replace(/^.*[/:]/, '')));
}

const PAGE_TYPES = ['WebPage', 'ItemPage', 'CollectionPage', 'AboutPage', 'ProfilePage', 'SearchResultsPage'];
const ARTICLE_TYPES = ['Article', 'BlogPosting', 'NewsArticle', 'Report', 'TechArticle'];

/** Every object in every block that parses, in document order. A malformed block is skipped. */
function parseBlocks(jsonLdBlocks: readonly string[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const block of jsonLdBlocks) {
    try {
      collectNodes(JSON.parse(block), nodes);
    } catch {
      // Not JSON; the other blocks still count.
    }
  }
  return nodes;
}

/**
 * The JSON-LD rungs of the photo chain (spec 6.6 step 5), in order and de-duplicated: (1) each
 * Recipe's `image`, then its `thumbnailUrl`; (2) each `WebPage`'s `primaryImageOfPage`, then each
 * `Article`'s `image`. `{ "@id": … }` references resolve against every block's nodes. Each URL is
 * cleaned by `cleanImageUrl`; `pageUrl` resolves relative ones.
 */
export function jsonLdImageCandidates(jsonLdBlocks: readonly string[], pageUrl?: string | null): string[] {
  const nodes = parseBlocks(jsonLdBlocks);
  const byId = indexById(nodes);
  const urls = [
    ...nodes.filter(isRecipeNode).flatMap((node) => recipeImageUrls(node, pageUrl, byId)),
    ...nodes.filter((node) => hasType(node, PAGE_TYPES)).flatMap((node) => readImageUrls(node.primaryImageOfPage, pageUrl, byId)),
    ...nodes.filter((node) => hasType(node, ARTICLE_TYPES)).flatMap((node) => readImageUrls(node.image, pageUrl, byId)),
  ];
  return [...new Set(urls)];
}

function readName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = cleanJsonLdText(raw);
  return name.length > 0 ? name : null;
}

/**
 * The first schema.org Recipe with at least one ingredient line across `jsonLdBlocks`, or null
 * when none holds one. A block that isn't valid JSON is skipped without spoiling the others.
 * `pageUrl` resolves a relative `image`; without it only an absolute one is kept.
 */
export function findRecipe(jsonLdBlocks: string[], pageUrl?: string | null): JsonLdRecipe | null {
  let byId: NodesById | null = null;
  for (const block of jsonLdBlocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    collectNodes(parsed, nodes);
    for (const node of nodes) {
      if (!isRecipeNode(node)) continue;
      const ingredientLines = readIngredientLines(node);
      if (ingredientLines.length === 0) continue;
      byId ??= indexById(parseBlocks(jsonLdBlocks));
      return {
        name: readName(node.name),
        ingredientLines,
        servings: readServings(node.recipeYield),
        totalMinutes: readTotalMinutes(node),
        steps: readSteps(node.recipeInstructions),
        imageUrl: recipeImageUrls(node, pageUrl, byId)[0] ?? null,
      };
    }
  }
  return null;
}
