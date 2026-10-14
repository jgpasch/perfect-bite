// Spec 4.15, 6.2: the Spanish starter seed. The commonest grocery names as people in Mexico type
// them, plus Mexico-only names with no English twin, in the shape of `ingredients.ts`: by category,
// then by default unit as a US supermarket sells them (`leche` is `gal`, like `milk`). The words
// follow the shared list in supabase/functions/_shared/ai/spanish-words.ts (`jitomate`, not
// `tomate`, for a tomato), which the categorizer's prompt uses too.
//
// `['leche', 'milk']` links the name to the English seed name it means (`same_as`, linked_by
// 'seed'): only where the two are the same thing on a shopping list. The no-link examples in
// spanish-words.ts (`tomate`, `crema`, `chile`, `limón`...) stay plain strings. A linked name takes
// its target's category and unit (the seed test checks it sits under them here); a plain string
// has its own.
//
// Names whose singular ends in a consonant (`limón`, `frijol`, `nuez`, `camarón`) are written in
// the singular: their `-es` plurals are generated from them into `../spanish-plurals.ts`
// (`yarn seed:es-plurals`). Spanish words the English seed already has (`epazote`, `crema`,
// `bolillo`, `queso oaxaca`, `crema`, `chorizo`, `cilantro`, `queso fresco`) are left there: one
// name is one ingredient.

import type { UnitKey } from '../quantity-parser.ts';
import { seedEntries, type SeedCategory } from './ingredients.ts';

/** A Spanish name, or `[name, english]` to link it to that English seed name. */
export type SpanishSeedName = string | readonly [name: string, english: string];

export const SEED_INGREDIENTS_ES: Partial<Record<SeedCategory, Partial<Record<UnitKey, readonly SpanishSeedName[]>>>> = {
  produce: {
    count: [
      ['aguacates', 'avocados'], ['ajo', 'garlic'], ['berenjena', 'eggplant'], ['coco', 'coconut'],
      ['col', 'cabbage'], ['coliflor', 'cauliflower'], ['elote', 'corn'], ['fresas', 'strawberries'],
      ['granada', 'pomegranate'], ['lechuga', 'lettuce'], ['limón amarillo', 'lemons'], ['manzanas', 'apples'],
      ['pepinos', 'cucumbers'], ['pimiento morrón', 'bell peppers'], ['pimiento rojo', 'red bell peppers'],
      ['pimiento verde', 'green bell peppers'], ['piña', 'pineapple'], ['repollo', 'cabbage'],
      ['sandía', 'watermelon'], ['toronja', 'grapefruit'], ['zarzamoras', 'blackberries'],
      'arándanos', 'calabaza', 'limón', 'mamey', 'melón', 'pitahaya',
    ],
    lb: [
      ['betabel', 'beets'], ['camote', 'sweet potatoes'], ['cebolla blanca', 'white onions'],
      ['cebolla morada', 'red onions'], ['cebollas', 'onions'], ['cerezas', 'cherries'], ['chabacanos', 'apricots'],
      ['champiñón', 'mushrooms'], ['chile habanero', 'habanero peppers'], ['chile jalapeño', 'jalapeno'],
      ['chile poblano', 'poblano peppers'], ['chile serrano', 'serrano peppers'], ['ciruelas', 'plums'],
      ['col de bruselas', 'brussels sprouts'], ['duraznos', 'peaches'], ['echalote', 'shallots'],
      ['ejotes', 'green beans'], ['espárragos', 'asparagus'], ['guayabas', 'guava'], ['jengibre', 'ginger'],
      ['jitomates', 'tomatoes'], ['mandarinas', 'tangerines'], ['nabo', 'turnips'], ['naranjas', 'oranges'],
      ['papas', 'potatoes'], ['peras', 'pears'], ['plátano macho', 'plantains'], ['plátanos', 'bananas'],
      ['uvas', 'grapes'], ['zanahorias', 'carrots'],
      'calabacita', 'chícharos', 'chile', 'chile chilaca', 'chile güero', 'chile manzano', 'romeritos',
      'tejocotes', 'tomate', 'tomate verde', 'xoconostle',
    ],
    pt: [['frambuesas', 'raspberries']],
    bag: [['espinacas', 'spinach']],
    box: [['tamarindo', 'tamarind']],
    bunch: [
      ['albahaca', 'basil'], ['apio', 'celery'], ['brócoli', 'broccoli'],
      ['menta', 'mint'], ['perejil', 'parsley'], ['poro', 'leeks'], ['rábanos', 'radishes'], ['tomillo', 'thyme'],
      'cebolla de cambray', 'cebollín', 'flor de calabaza', 'hierbabuena', 'hoja santa', 'pápalo', 'quelites',
      'verdolagas',
    ],
  },
  bakery: {
    count: [
      ['donas', 'donuts'], ['pan para hamburguesa', 'hamburger buns'], ['pan para hot dog', 'hot dog buns'],
      ['pastel', 'cake'], ['tortillas de harina', 'flour tortillas'], ['tortillas de maíz', 'corn tortillas'],
      'birote', 'pan de caja', 'pan de muerto', 'rosca de reyes',
    ],
  },
  deli: {
    lb: ['queso de puerco'],
  },
  'meat-seafood': {
    count: [['pollo entero', 'whole chicken'], ['tocino', 'bacon'], 'salchicha'],
    lb: [
      ['alitas de pollo', 'chicken wings'], ['almejas', 'clams'], ['bacalao', 'cod'], ['bagre', 'catfish'],
      ['calamar', 'squid'], ['camarón', 'shrimp'], ['cangrejo', 'crab'], ['carne molida', 'ground beef'],
      ['carne molida de cerdo', 'ground pork'], ['carne molida de pavo', 'ground turkey'],
      ['chuletas de cerdo', 'pork chops'], ['jamón', 'ham'], ['lengua de res', 'beef tongue'],
      ['mejillón', 'mussels'], ['muslos de pollo', 'chicken thighs'], ['pavo', 'turkey'],
      ['pechuga de pollo', 'chicken breasts'], ['pollo', 'chicken'], ['pulpo', 'octopus'],
      'arrachera', 'barbacoa', 'bistec', 'carne al pastor', 'carne de cerdo', 'carne de res', 'carne para asar',
      'carnitas', 'cecina', 'chamorro', 'chorizo verde', 'costilla de cerdo', 'espinazo', 'filete de pescado',
      'longaniza', 'milanesa de pollo', 'milanesa de res', 'pancita', 'pescado', 'retazo', 'suadero',
    ],
    dozen: [['ostión', 'oysters']],
  },
  'dairy-eggs': {
    count: [
      ['crema mexicana', 'mexican crema'], ['leche de avena', 'oat milk'], ['leche de soya', 'soy milk'],
      ['queso amarillo', 'american cheese'], ['queso cotija', 'cotija'], ['queso crema', 'cream cheese'],
      ['queso mozzarella', 'mozzarella'], ['queso panela', 'panela'],
      ['yogur', 'yogurt'],
      'jocoque', 'media crema', 'queso añejo', 'queso asadero', 'queso chihuahua', 'queso manchego', 'requesón',
    ],
    oz: [['crema ácida', 'sour cream'], ['queso parmesano', 'parmesan']],
    lb: [['margarina', 'margarine'], ['queso suizo', 'swiss cheese']],
    pt: ['crema para batir'],
    gal: [['leche', 'milk'], ['leche de almendra', 'almond milk'], ['leche deslactosada', 'lactose free milk']],
    box: [['mantequilla', 'butter']],
    dozen: [['huevos', 'eggs']],
  },
  frozen: {
    pt: [['helado', 'ice cream']],
    bag: [['hielo', 'ice'], 'verduras congeladas'],
    box: ['paletas de hielo'],
  },
  pantry: {
    count: [['aceite de oliva', 'olive oil'], ['aceite vegetal', 'vegetable oil'], ['miel', 'honey'], 'aceite'],
    jar: [['crema de cacahuate', 'peanut butter'], ['mermelada de fresa', 'strawberry jam']],
    bag: ['flor de jamaica', 'frijol', 'frijol bayo', 'frijol peruano'],
  },
  'canned-jarred': {
    can: [
      ['atún', 'tuna'], ['caldo de pollo', 'chicken broth'], ['frijol negro', 'black beans'],
      ['frijol pinto', 'pinto beans'], ['frijoles refritos', 'refried beans'], ['garbanzos', 'chickpeas'],
      ['pasta de tomate', 'tomato paste'],
      'chiles chipotles', 'chiles en vinagre', 'elote en lata', 'huitlacoche', 'puré de tomate', 'sardinas',
    ],
    jar: ['consomé de pollo'],
  },
  'pasta-grains': {
    bag: [['arroz', 'rice'], ['arroz integral', 'brown rice'], ['lentejas', 'lentils'], 'maíz pozolero'],
    box: [['espagueti', 'spaghetti'], ['macarrón', 'macaroni'], 'codito', 'fideo', 'sopa de pasta'],
  },
  baking: {
    count: [['extracto de vainilla', 'vanilla extract'], ['pan molido', 'bread crumbs'], 'piloncillo', 'vainilla'],
    can: [
      ['leche condensada', 'sweetened condensed milk'], ['leche evaporada', 'evaporated milk'],
      ['polvo para hornear', 'baking powder'],
    ],
    jar: [['ajonjolí', 'sesame seeds']],
    bag: [
      ['azúcar', 'sugar'], ['azúcar morena', 'brown sugar'], ['harina', 'flour'], ['nuez de castilla', 'walnuts'],
      'harina de maíz', 'masa para tortillas', 'nuez',
    ],
    box: [['bicarbonato', 'baking soda'], ['levadura', 'yeast'], ['maicena', 'cornstarch'], ['manteca de cerdo', 'lard'], 'gelatina', 'grenetina'],
  },
  spices: {
    count: [['sal', 'salt']],
    jar: [
      ['ajo en polvo', 'garlic powder'], ['anís estrella', 'star anise'], ['canela', 'cinnamon'],
      ['clavo de olor', 'cloves'], ['comino', 'cumin'], ['hojas de laurel', 'bay leaves'], ['laurel', 'bay leaves'],
      ['nuez moscada', 'nutmeg'],
      ['pimienta de cayena', 'cayenne'], ['pimienta gorda', 'allspice'], ['pimienta negra', 'black pepper'],
      'chile en polvo', 'pimienta',
    ],
    bag: [
      ['chile ancho', 'dried ancho chiles'], ['chile guajillo', 'dried guajillo chiles'],
      'chile cascabel', 'chile de árbol', 'chile morita', 'chile mulato', 'chile pasilla',
    ],
  },
  condiments: {
    count: [
      ['catsup', 'ketchup'], ['mostaza', 'mustard'], ['salsa de soya', 'soy sauce'], ['salsa inglesa', 'worcestershire sauce'],
      ['vinagre', 'vinegar'],
      'jugo maggi', 'salsa valentina',
    ],
    jar: [['mayonesa', 'mayonnaise'], 'achiote', 'mole poblano'],
  },
  snacks: {
    count: ['mazapán'],
    bag: [
      ['almendras', 'almonds'], ['cacahuates', 'peanuts'], ['nuez de la india', 'cashews'], ['palomitas', 'popcorn'],
      ['papitas', 'potato chips'], ['pistache', 'pistachios'], ['semillas de calabaza', 'pumpkin seeds'],
      ['semillas de girasol', 'sunflower seeds'], ['totopos', 'tortilla chips'],
      'cacahuates japoneses', 'dulces',
    ],
    box: [['galletas saladas', 'crackers'], ['pasas', 'raisins'], 'galletas'],
  },
  beverages: {
    count: [
      ['agua de coco', 'coconut water'], ['agua embotellada', 'bottled water'], ['cerveza', 'beer'],
      ['jugo de naranja', 'orange juice'], ['refresco', 'soda'], ['ron', 'rum'], ['vino tinto', 'red wine'],
      'agua mineral', 'horchata', 'jugo', 'rompope',
    ],
    bag: [['café', 'coffee']],
    box: [['té', 'tea']],
  },
  breakfast: {
    count: [['miel de maple', 'maple syrup']],
    box: ['avena', 'harina para hot cakes'],
  },
  household: {
    count: [
      ['cloro', 'bleach'], ['escoba', 'broom'], ['esponjas', 'sponges'], ['focos', 'light bulbs'],
      ['jabón para trastes', 'dish soap'], ['papel de baño', 'toilet paper'], ['papel higiénico', 'toilet paper'],
      ['pilas', 'batteries'], ['suavizante', 'fabric softener'], ['detergente para ropa', 'laundry detergent'],
      ['toallas de papel', 'paper towels'], ['trapeador', 'mop'], ['velas', 'candles'],
      'detergente', 'fibras', 'jabón en polvo',
    ],
    box: [
      ['bolsas de basura', 'trash bags'], ['cerillos', 'matches'], ['papel aluminio', 'aluminum foil'],
      ['plástico autoadherible', 'plastic wrap'], ['servilletas', 'napkins'],
      'popotes',
    ],
  },
  'personal-care': {
    count: [
      ['aspirina', 'aspirin'], ['champú', 'shampoo'], ['desodorante', 'deodorant'], ['pasta de dientes', 'toothpaste'],
      ['pasta dental', 'toothpaste'], ['rastrillos', 'razors'], ['vitaminas', 'vitamins'],
      'cepillo de dientes', 'jabón de baño',
    ],
    bag: [['bolitas de algodón', 'cotton balls']],
    box: [['toallas femeninas', 'pads']],
  },
  baby: {
    box: [['pañal', 'diapers'], ['toallitas húmedas', 'wipes']],
  },
  pet: {
    can: [['comida para gato', 'cat food']],
    bag: [['arena para gato', 'cat litter'], ['comida para perro', 'dog food'], 'croquetas'],
  },
};

export type SpanishSeedEntry = {
  name: string;
  category: SeedCategory;
  unit: UnitKey;
  /** The English seed name it means (`same_as`), or null when unlinked. */
  sameAs: string | null;
};

/**
 * Every Spanish seed name in file order. A linked name takes its English target's category and
 * unit, so a link never shelves a twin differently; an unlinked one keeps where this file puts it.
 * Throws on a link to a name the English seed lacks.
 */
export function seedEsEntries(): SpanishSeedEntry[] {
  const targets = new Map(seedEntries().map((e) => [e.name, e]));
  const entries: SpanishSeedEntry[] = [];
  for (const [category, byUnit] of Object.entries(SEED_INGREDIENTS_ES) as [SeedCategory, Partial<Record<UnitKey, readonly SpanishSeedName[]>>][]) {
    for (const [unit, names] of Object.entries(byUnit) as [UnitKey, readonly SpanishSeedName[]][]) {
      for (const entry of names) {
        if (typeof entry === 'string') {
          entries.push({ name: entry, category, unit, sameAs: null });
          continue;
        }
        const [name, sameAs] = entry;
        const target = targets.get(sameAs);
        if (!target) throw new Error(`ingredients-es: '${name}' links to '${sameAs}', which isn't in the English seed`);
        entries.push({ name, category: target.category, unit: target.unit, sameAs });
      }
    }
  }
  return entries;
}
