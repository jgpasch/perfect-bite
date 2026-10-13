// Spec 6.6 step 5. Reads a schema.org Recipe out of a page's JSON-LD blocks, so most imports
// hand the LLM clean ingredient lines instead of page text. Keep it pure (runs under Deno too).
import { MAX_TOTAL_MINUTES, MIN_TOTAL_MINUTES } from './recipe-tags.ts';

export type JsonLdRecipe = {
  name: string | null;
  ingredientLines: string[];
  servings: number | null;
  /** `totalTime`, else `prepTime` + `cookTime`, in minutes (spec 4.14); null when none is usable. */
  totalMinutes: number | null;
};

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

function readName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = cleanJsonLdText(raw);
  return name.length > 0 ? name : null;
}

/**
 * The first schema.org Recipe with at least one ingredient line across `jsonLdBlocks`, or null
 * when none holds one. A block that isn't valid JSON is skipped without spoiling the others.
 */
export function findRecipe(jsonLdBlocks: string[]): JsonLdRecipe | null {
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
      return {
        name: readName(node.name),
        ingredientLines,
        servings: readServings(node.recipeYield),
        totalMinutes: readTotalMinutes(node),
      };
    }
  }
  return null;
}
