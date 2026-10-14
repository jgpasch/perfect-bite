// Spec 4.2. Light quantity parsing for typed and dictated adds: a leading amount and optional
// unit come off the front, the rest is the name. Shared with the Edge Functions (siri-add).
// Spanish amounts (spec 4.15) are read whatever the app's language.

/** Supported units (spec 4.2). A count has no unit. */
export const UNITS = [
  'g',
  'kg',
  'oz',
  'lb',
  'ml',
  'l',
  'tsp',
  'tbsp',
  'cup',
  'fl oz',
  'pt',
  'qt',
  'gal',
  'can',
  'jar',
  'bag',
  'box',
  'bunch',
  'clove',
  'pinch',
  'dozen',
] as const;
export type Unit = (typeof UNITS)[number];

/**
 * A stored unit key (`ingredient_unit_usage.unit_key`, `ingredients.default_unit`): a unit, or
 * `count` for a plain number.
 */
export const UNIT_KEYS = ['count', ...UNITS] as const;
export type UnitKey = (typeof UNIT_KEYS)[number];

/** Spellings (lowercase, accents folded, no trailing period) → unit. */
const UNIT_ALIASES: Record<string, Unit> = {
  g: 'g', gr: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  pt: 'pt', pint: 'pt', pints: 'pt',
  qt: 'qt', quart: 'qt', quarts: 'qt',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  can: 'can', cans: 'can',
  jar: 'jar', jars: 'jar',
  bag: 'bag', bags: 'bag',
  box: 'box', boxes: 'box',
  bunch: 'bunch', bunches: 'bunch',
  clove: 'clove', cloves: 'clove',
  pinch: 'pinch', pinches: 'pinch',
  dozen: 'dozen', dozens: 'dozen',
  // Spanish (spec 4.15). `kilo(s)` and `gr` are shared with English.
  gramo: 'g', gramos: 'g',
  kilogramo: 'kg', kilogramos: 'kg',
  mililitro: 'ml', mililitros: 'ml',
  litro: 'l', litros: 'l',
  libra: 'lb', libras: 'lb',
  onza: 'oz', onzas: 'oz',
  cucharadita: 'tsp', cucharaditas: 'tsp', cdta: 'tsp', cdtas: 'tsp',
  cucharada: 'tbsp', cucharadas: 'tbsp', cda: 'tbsp', cdas: 'tbsp',
  taza: 'cup', tazas: 'cup',
  galon: 'gal', galones: 'gal',
  lata: 'can', latas: 'can',
  frasco: 'jar', frascos: 'jar',
  bolsa: 'bag', bolsas: 'bag',
  caja: 'box', cajas: 'box',
  manojo: 'bunch', manojos: 'bunch',
  diente: 'clove', dientes: 'clove',
  pizca: 'pinch', pizcas: 'pinch',
  docena: 'dozen', docenas: 'dozen',
};

/** Spanish words for a plain count (`3 piezas de aguacate` is 3 `aguacate`). */
const COUNT_WORDS = new Set(['pieza', 'piezas', 'pza', 'pzas']);

/** Two-word units, checked before single words. */
const TWO_WORD_UNITS: Record<string, Unit> = {
  'fl oz': 'fl oz',
  'fluid ounce': 'fl oz',
  'fluid ounces': 'fl oz',
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, half: 0.5,
  // Spanish (spec 4.15), accents folded.
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, medio: 0.5, media: 0.5,
};

/** Number words that are only an amount before a unit or an article: `half and half`, `media crema`. */
const HALF_WORDS = new Set(['half', 'medio', 'media']);

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅛': 1 / 8,
};

export type ParsedQuantity = {
  /** null: no amount given (`milk`). */
  quantity: number | null;
  unit: Unit | null;
  /** The rest of the text, as typed (trimmed, whitespace collapsed). */
  name: string;
};

/** `12`, `1.5`, `1/2`, `½`, `1½`, `500g` (number part only). Returns null if not a number. */
function parseNumberToken(token: string): number | null {
  const fraction = UNICODE_FRACTIONS[token.slice(-1)];
  if (fraction !== undefined) {
    const whole = token.slice(0, -1);
    if (whole === '') return fraction;
    return /^\d+$/.test(whole) ? Number(whole) + fraction : null;
  }
  if (/^\d+(\.\d+)?$/.test(token) || /^\.\d+$/.test(token)) return Number(token);
  const slash = /^(\d+)\/(\d+)$/.exec(token);
  if (slash && Number(slash[2]) !== 0) return Number(slash[1]) / Number(slash[2]);
  return null;
}

/** Lowercase, accents folded, no trailing period: the form the lookup tables use. */
function lookupForm(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\.$/, '');
}

function unitFor(word: string | undefined): Unit | null {
  if (!word) return null;
  return UNIT_ALIASES[lookupForm(word)] ?? null;
}

function isCountWord(word: string | undefined): boolean {
  return word !== undefined && COUNT_WORDS.has(lookupForm(word));
}

/**
 * Pulls a leading amount and unit off an add.
 * `2 lbs chicken thighs` → 2 lb `chicken thighs`; `two avocados` → 2 `avocados`;
 * `1 1/2 cups flour` → 1.5 cup `flour`; `milk` → no quantity. Unknown unit words stay in the name.
 * Spanish too: `2 tazas de harina` → 2 cup `harina`; `3 piezas de aguacate` → 3 `aguacate`.
 */
export function parseQuantity(input: string): ParsedQuantity {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const plain: ParsedQuantity = { quantity: null, unit: null, name: words.join(' ') };
  if (words.length < 2 && !/^\d/.test(words[0] ?? '')) return plain;

  let i = 0;
  let quantity: number | null = null;
  let unit: Unit | null = null;

  // Amount: a number (possibly with a unit glued on, `500g`), then an optional fraction (`1 1/2`).
  const glued = /^(\d+(?:\.\d+)?|\d*[½⅓⅔¼¾⅛])([a-z.]+)$/i.exec(words[0]);
  if (glued && unitFor(glued[2])) {
    quantity = parseNumberToken(glued[1]);
    unit = unitFor(glued[2]);
    i = 1;
  } else {
    quantity = parseNumberToken(words[0]) ?? NUMBER_WORDS[lookupForm(words[0])] ?? null;
    if (quantity === null) return plain;
    // "half and half" and "media crema" are names; "half a cup", "half gallon milk" and
    // "medio kilo de queso" are amounts.
    if (HALF_WORDS.has(lookupForm(words[0])) && !/^an?$/i.test(words[1]) && !unitFor(words[1])) {
      return plain;
    }
    i = 1;
    const extra = words[1] !== undefined ? parseNumberToken(words[1]) : null;
    if (extra !== null && extra < 1 && Number.isInteger(quantity)) {
      quantity += extra;
      i = 2;
    }
  }

  // "half a cup": the article is part of the amount.
  if (quantity === 0.5 && /^an?$/i.test(words[i] ?? '')) i += 1;

  if (unit === null) {
    const pair = words.slice(i, i + 2).join(' ').toLowerCase().replace(/\./g, '');
    if (TWO_WORD_UNITS[pair] && words.length > i + 2) {
      unit = TWO_WORD_UNITS[pair];
      i += 2;
    } else if (unitFor(words[i]) && words.length > i + 1) {
      unit = unitFor(words[i]);
      i += 1;
    }
  }

  // "3 piezas de aguacate": a count word, no unit.
  const counted = unit === null && isCountWord(words[i]) && words.length > i + 1;
  if (counted) i += 1;

  // "2 cans of tomatoes", "2 tazas de harina"
  if ((unit !== null || counted) && /^(of|de)$/i.test(words[i] ?? '') && words.length > i + 1) {
    i += 1;
  }

  const name = words.slice(i).join(' ');
  // Nothing left to name ("2", "a"): keep the whole text as the name.
  if (name === '') return plain;
  return { quantity, unit, name };
}

/**
 * Parses an amount on its own, as typed in the item edit sheet: `2 lb`, `1½ cups`, `3`.
 * Empty text is "no amount". Returns null when the text isn't an amount (`lb`, `some`).
 */
export function parseAmount(text: string): Pick<ParsedQuantity, 'quantity' | 'unit'> | null {
  if (!text.trim()) return { quantity: null, unit: null };
  // Parse it as an add with a placeholder name; anything left besides the placeholder isn't an amount.
  const parsed = parseQuantity(`${text.trim()} _`);
  if (parsed.name !== '_' || parsed.quantity === null) return null;
  return { quantity: parsed.quantity, unit: parsed.unit };
}
