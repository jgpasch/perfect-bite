// Mexican Spanish food words (spec 4.15), shared by the Spanish seed
// (src/shared/seed/ingredients-es.ts) and the categorizer's prompt, so both name things and link
// them the same way. Plain data with no imports: the app's Jest tests read it too.

/**
 * The word people in Mexico use, where other Spanish has another: `[english, mexican, avoid]`.
 * `avoid` is the word from elsewhere (Spain, South America) not to use for that meaning.
 */
export const MEXICAN_WORDS: readonly (readonly [english: string, mexican: string, avoid: string])[] = [
  ['tomato', 'jitomate', 'tomate'],
  ['tomatillo', 'tomate verde', 'tomatillo'],
  ['avocado', 'aguacate', 'palta'],
  ['beans', 'frijol', 'judía'],
  ['green beans', 'ejote', 'judía verde'],
  ['peas', 'chícharo', 'guisante'],
  ['potato', 'papa', 'patata'],
  ['corn on the cob', 'elote', 'mazorca'],
  ['peanut', 'cacahuate', 'maní'],
  ['strawberry', 'fresa', 'frutilla'],
  ['peach', 'durazno', 'melocotón'],
  ['apricot', 'chabacano', 'albaricoque'],
  ['pineapple', 'piña', 'ananá'],
  ['banana', 'plátano', 'banana'],
  ['grapefruit', 'toronja', 'pomelo'],
  ['beet', 'betabel', 'remolacha'],
  ['sweet potato', 'camote', 'boniato'],
  ['bell pepper', 'pimiento morrón', 'pimentón'],
  ['leek', 'poro', 'puerro'],
  ['chili pepper', 'chile', 'ají'],
  ['butter', 'mantequilla', 'manteca'],
  ['cream', 'crema', 'nata'],
  ['shrimp', 'camarón', 'gamba'],
  ['pork', 'cerdo', 'chancho'],
  ['ground beef', 'carne molida', 'carne picada'],
  ['bacon', 'tocino', 'beicon'],
  ['ketchup', 'catsup', 'kétchup'],
  ['juice', 'jugo', 'zumo'],
  ['soda', 'refresco', 'gaseosa'],
  ['cake', 'pastel', 'tarta'],
  ['popcorn', 'palomitas', 'pochoclo'],
  ['tortilla chips', 'totopos', 'nachos'],
  ['cornstarch', 'maicena', 'almidón de maíz'],
  ['dish soap', 'jabón para trastes', 'lavavajillas'],
  ['bleach', 'cloro', 'lejía'],
  ['straws', 'popotes', 'pajitas'],
  ['matches', 'cerillos', 'fósforos'],
  ['light bulbs', 'focos', 'bombillas'],
  ['mop', 'trapeador', 'fregona'],
];

/**
 * Pairs that look like translations but aren't the same thing on a shopping list, so they stay
 * unlinked (spec 4.15): `[spanish, english, why]`. When in doubt, don't link: a wrong link
 * combines two different things on a list.
 */
export const NO_LINK_EXAMPLES: readonly (readonly [spanish: string, english: string, why: string])[] = [
  ['tomate', 'tomato', 'a tomatillo in much of Mexico; a red tomato is jitomate'],
  ['crema', 'cream', 'Mexican crema is soured and pourable, not heavy cream or sour cream'],
  ['chile', 'chili', 'any hot pepper, fresh or dried; the kind decides what to buy'],
  ['queso fresco', 'fresh cheese', 'a specific Mexican cheese, not any fresh cheese'],
  ['limón', 'lemon', 'a lime in Mexico, a lemon elsewhere'],
  ['calabacita', 'zucchini', 'usually the pale Mexican grey squash, not a zucchini'],
  ['nuez', 'walnut', 'a pecan in most of Mexico; a walnut is nuez de castilla'],
  ['galletas', 'cookies', 'cookies or crackers'],
  ['pimienta', 'pepper', 'black pepper or allspice (pimienta gorda)'],
  ['melón', 'melon', 'usually a cantaloupe, but any melon'],
  ['salchicha', 'sausage', 'a hot dog wiener in Mexico, any sausage elsewhere'],
  ['chile en polvo', 'chili powder', 'ground dried chile, while US chili powder is a spice blend'],
  ['detergente', 'detergent', 'laundry detergent in Mexico, any detergent elsewhere'],
  ['agua mineral', 'mineral water', 'sparkling water in Mexico'],
  ['tuna', 'tuna', 'a prickly pear in Mexico, the fish in English'],
];
