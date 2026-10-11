// Spec 6.2: common grocery items, pre-categorized, so most adds never need the LLM. Shipped in the
// app for offline use; the Supabase seed migration is generated from the same list
// (scripts/gen-seed-sql.ts). Names are written as people type them; the key is
// `normalizeIngredientName(name)`.
//
// Each category groups its names by default unit (spec 4.2): how the item is usually bought in a
// US supermarket, used as the usual unit until the household has its own history. `count` is a
// plain number (`3 lemons`, `2 ketchup`).

import type { UnitKey } from '../quantity-parser.ts';
import type { CategorySlug } from './categories.ts';

export type SeedCategory = Exclude<CategorySlug, 'other'>;

export const SEED_INGREDIENTS: Record<SeedCategory, Partial<Record<UnitKey, readonly string[]>>> = {
  produce: {
    count: [
      'apples', 'oranges', 'lemons', 'limes', 'grapefruit', 'peaches', 'nectarines', 'plums', 'pears',
      'mangoes', 'pineapple', 'watermelon', 'cantaloupe', 'honeydew', 'kiwis', 'avocados', 'tomatoes',
      'sweet potatoes', 'onions', 'yellow onions', 'red onions', 'shallots', 'garlic', 'ginger',
      'cauliflower', 'broccoli', 'cabbage', 'red cabbage', 'lettuce', 'romaine', 'iceberg lettuce',
      'cucumbers', 'zucchini', 'yellow squash', 'butternut squash', 'spaghetti squash', 'bell peppers',
      'red bell peppers', 'green bell peppers', 'jalapeños', 'serrano peppers', 'poblano peppers',
      'portobello mushrooms', 'corn on the cob', 'eggplant', 'leeks', 'fennel', 'bok choy', 'artichokes',
      'lemongrass', 'celery', 'tofu', 'pomegranate', 'coconut', 'papaya', 'plantains',
    ],
    lb: [
      'grapes', 'cherries', 'strawberries', 'potatoes', 'yukon gold potatoes', 'red potatoes', 'carrots',
      'green beans', 'snap peas', 'snow peas', 'brussels sprouts', 'turnips', 'parsnips',
    ],
    oz: ['mushrooms', 'cremini mushrooms', 'shiitake mushrooms', 'figs', 'dates'],
    pt: ['blueberries', 'raspberries', 'blackberries', 'cherry tomatoes', 'grape tomatoes'],
    bag: ['spinach', 'baby spinach', 'arugula', 'spring mix', 'bean sprouts', 'coleslaw mix', 'salad kit'],
    bunch: [
      'bananas', 'green onions', 'kale', 'asparagus', 'beets', 'radishes', 'cilantro', 'parsley', 'basil',
      'mint', 'dill', 'rosemary', 'thyme', 'sage', 'chives',
    ],
  },
  bakery: {
    count: [
      'bread', 'sandwich bread', 'sourdough', 'whole wheat bread', 'rye bread', 'baguette', 'ciabatta',
      'english muffins', 'croissants', 'hamburger buns', 'hot dog buns', 'dinner rolls', 'pita', 'naan',
      'tortillas', 'flour tortillas', 'corn tortillas', 'muffins', 'cake', 'pie', 'brownies', 'cookies',
      'brioche',
    ],
    bag: ['bagels'],
    dozen: ['donuts'],
  },
  deli: {
    count: ['rotisserie chicken', 'hummus', 'pimento cheese', 'guacamole'],
    oz: ['pepperoni'],
    lb: [
      'sliced turkey', 'deli turkey', 'deli ham', 'roast beef', 'salami', 'prosciutto', 'bologna',
      'pastrami', 'potato salad', 'chicken salad', 'sliced cheese', 'provolone', 'swiss cheese', 'olives',
    ],
  },
  'meat-seafood': {
    count: ['whole chicken', 'hot dogs', 'bratwurst', 'lobster'],
    lb: [
      'chicken breasts', 'chicken thighs', 'chicken drumsticks', 'chicken wings', 'ground chicken',
      'ground turkey', 'turkey breast', 'ground beef', 'steak', 'ribeye', 'sirloin', 'flank steak',
      'skirt steak', 'chuck roast', 'brisket', 'short ribs', 'stew meat', 'beef', 'pork chops',
      'pork tenderloin', 'pork shoulder', 'ground pork', 'pork belly', 'ribs', 'ham', 'bacon',
      'turkey bacon', 'sausage', 'italian sausage', 'breakfast sausage', 'chorizo', 'lamb', 'ground lamb',
      'salmon', 'shrimp', 'cod', 'tilapia', 'halibut', 'tuna steaks', 'scallops', 'crab', 'mussels',
      'clams', 'chicken',
    ],
  },
  'dairy-eggs': {
    count: [
      'oat milk', 'almond milk', 'soy milk', 'sour cream', 'cream cheese', 'yogurt', 'greek yogurt',
      'cottage cheese', 'ricotta', 'american cheese', 'string cheese', 'whipped cream', 'coffee creamer',
      'egg whites', 'kefir',
    ],
    oz: [
      'cheddar', 'mozzarella', 'fresh mozzarella', 'parmesan', 'feta', 'goat cheese', 'brie', 'gouda',
      'monterey jack', 'pepper jack', 'blue cheese', 'cheese',
    ],
    lb: ['butter', 'unsalted butter', 'salted butter'],
    pt: ['half and half', 'heavy cream', 'whipping cream'],
    qt: ['buttermilk'],
    gal: ['milk', 'whole milk', '2% milk', 'skim milk'],
    jar: ['ghee'],
    bag: ['shredded cheese'],
    dozen: ['eggs'],
  },
  frozen: {
    count: ['frozen pizza', 'ice cream', 'frozen burritos', 'frozen meals', 'pie crust'],
    bag: [
      'frozen peas', 'frozen corn', 'frozen broccoli', 'frozen spinach', 'frozen mixed vegetables',
      'frozen berries', 'frozen strawberries', 'frozen fruit', 'frozen fries', 'tater tots',
      'frozen dumplings', 'frozen shrimp', 'chicken nuggets', 'ice', 'frozen edamame',
    ],
    box: ['frozen waffles', 'fish sticks', 'popsicles', 'puff pastry', 'veggie burgers'],
  },
  pantry: {
    count: [
      'maple syrup', 'olive oil', 'extra virgin olive oil', 'vegetable oil', 'canola oil', 'coconut oil',
      'sesame oil', 'avocado oil', 'chicken broth', 'beef broth', 'vegetable broth', 'chicken stock',
      'breadcrumbs', 'panko',
    ],
    lb: ['dried beans', 'lentils', 'split peas'],
    can: ['cooking spray', 'soup'],
    jar: ['peanut butter', 'almond butter', 'jelly', 'jam', 'honey', 'nutella', 'bouillon'],
    bag: [
      'nuts', 'almonds', 'walnuts', 'pecans', 'cashews', 'peanuts', 'pistachios', 'pine nuts',
      'sunflower seeds', 'chia seeds', 'flax seeds', 'raisins', 'dried cranberries', 'dried fruit',
      'croutons',
    ],
  },
  'canned-jarred': {
    can: [
      'canned tomatoes', 'diced tomatoes', 'crushed tomatoes', 'tomato paste', 'tomato sauce',
      'black beans', 'kidney beans', 'pinto beans', 'chickpeas', 'cannellini beans', 'refried beans',
      'baked beans', 'canned corn', 'canned tuna', 'tuna', 'canned salmon', 'coconut milk',
      'chipotles in adobo', 'green chiles', 'canned pumpkin', 'evaporated milk', 'sweetened condensed milk',
      'canned peaches', 'water chestnuts', 'bamboo shoots',
    ],
    jar: [
      'marinara', 'pasta sauce', 'roasted red peppers', 'artichoke hearts', 'capers', 'pickles',
      'sauerkraut', 'applesauce',
    ],
  },
  'pasta-grains': {
    count: ['ramen', 'udon', 'soba', 'polenta'],
    bag: [
      'egg noodles', 'rice', 'white rice', 'brown rice', 'jasmine rice', 'basmati rice', 'arborio rice',
      'quinoa', 'farro', 'barley', 'bulgur',
    ],
    box: [
      'pasta', 'spaghetti', 'penne', 'rigatoni', 'fusilli', 'linguine', 'fettuccine', 'macaroni',
      'lasagna noodles', 'orzo', 'rice noodles', 'wild rice', 'couscous', 'grits', 'mac and cheese',
    ],
  },
  baking: {
    count: [
      'baking powder', 'yeast', 'vanilla extract', 'cocoa powder', 'baking chocolate', 'food coloring',
      'corn syrup',
    ],
    can: ['frosting'],
    jar: ['sprinkles', 'molasses'],
    bag: [
      'flour', 'all-purpose flour', 'bread flour', 'whole wheat flour', 'almond flour', 'sugar',
      'brown sugar', 'powdered sugar', 'chocolate chips', 'cornmeal', 'shredded coconut', 'marshmallows',
    ],
    box: [
      'baking soda', 'cornstarch', 'gelatin', 'cake mix', 'brownie mix', 'graham crackers', 'pancake mix',
    ],
  },
  spices: {
    count: ['salt', 'sea salt', 'taco seasoning', 'vanilla beans'],
    jar: [
      'black pepper', 'peppercorns', 'garlic powder', 'onion powder', 'paprika', 'smoked paprika',
      'chili powder', 'cumin', 'coriander', 'oregano', 'dried basil', 'dried thyme', 'bay leaves',
      'cinnamon', 'nutmeg', 'cloves', 'allspice', 'ground ginger', 'turmeric', 'curry powder',
      'garam masala', 'cayenne', 'red pepper flakes', 'italian seasoning', 'everything bagel seasoning',
      'cajun seasoning', 'old bay', "za'atar", 'sumac', 'cardamom', 'fennel seeds', 'mustard seeds',
      'sesame seeds', 'saffron', 'five spice',
    ],
    box: ['kosher salt'],
  },
  condiments: {
    count: [
      'ketchup', 'mustard', 'yellow mustard', 'barbecue sauce', 'hot sauce', 'sriracha', 'soy sauce',
      'tamari', 'fish sauce', 'oyster sauce', 'teriyaki sauce', 'worcestershire sauce', 'ranch',
      'salad dressing', 'italian dressing', 'balsamic vinegar', 'red wine vinegar', 'apple cider vinegar',
      'rice vinegar', 'white vinegar', 'vinegar', 'gochujang', 'miso', 'buffalo sauce', 'steak sauce',
    ],
    can: ['enchilada sauce'],
    jar: [
      'dijon mustard', 'mayonnaise', 'mayo', 'relish', 'hoisin sauce', 'salsa', 'tahini', 'pesto',
      'chili crisp', 'horseradish', 'curry paste',
    ],
  },
  snacks: {
    count: ['rice cakes', 'chocolate', 'gum', 'breath mints', 'seaweed snacks', 'dark chocolate'],
    bag: [
      'chips', 'potato chips', 'tortilla chips', 'pretzels', 'popcorn', 'goldfish', 'pita chips',
      'trail mix', 'beef jerky', 'candy', 'cheese puffs', 'veggie straws',
    ],
    box: ['crackers', 'granola bars', 'protein bars', 'fruit snacks'],
  },
  beverages: {
    count: [
      'water', 'sparkling water', 'bottled water', 'seltzer', 'club soda', 'tonic water', 'soda', 'coke',
      'diet coke', 'ginger ale', 'orange juice', 'apple juice', 'cranberry juice', 'lemonade', 'iced tea',
      'cold brew', 'kombucha', 'sports drinks', 'energy drinks', 'coconut water', 'beer', 'wine',
      'red wine', 'white wine', 'sparkling wine', 'vodka', 'gin', 'tequila', 'whiskey', 'rum', 'bitters',
    ],
    bag: ['coffee', 'ground coffee', 'coffee beans'],
    box: ['tea', 'green tea', 'black tea', 'herbal tea'],
  },
  breakfast: {
    count: ['oats', 'rolled oats', 'steel cut oats'],
    bag: ['granola', 'muesli'],
    box: ['cereal', 'oatmeal', 'instant oatmeal', 'cream of wheat', 'pop tarts', 'waffle mix', 'breakfast bars'],
  },
  household: {
    count: [
      'paper towels', 'toilet paper', 'napkins', 'aluminum foil', 'plastic wrap', 'parchment paper',
      'wax paper', 'dish soap', 'dishwasher detergent', 'dishwasher pods', 'laundry detergent',
      'fabric softener', 'bleach', 'all-purpose cleaner', 'glass cleaner', 'disinfecting wipes', 'sponges',
      'light bulbs', 'batteries', 'candles', 'paper plates', 'plastic cups', 'coffee filters',
      'air freshener',
    ],
    box: [
      'tissues', 'trash bags', 'zip top bags', 'sandwich bags', 'freezer bags', 'dryer sheets', 'matches',
      'plastic forks',
    ],
  },
  'personal-care': {
    count: [
      'shampoo', 'conditioner', 'body wash', 'bar soap', 'hand soap', 'toothpaste', 'toothbrushes', 'floss',
      'mouthwash', 'deodorant', 'razors', 'shaving cream', 'lotion', 'sunscreen', 'lip balm', 'ibuprofen',
      'acetaminophen', 'allergy medicine', 'vitamins', 'contact solution', 'face wash',
    ],
    bag: ['cotton balls'],
    box: ['cotton swabs', 'band-aids', 'tampons', 'pads'],
  },
  baby: {
    count: ['diapers', 'baby wipes', 'diaper cream', 'baby shampoo'],
    can: ['formula'],
    jar: ['baby food'],
    box: ['teething biscuits'],
  },
  pet: {
    count: ['cat food', 'cat litter', 'poop bags', 'fish food'],
    bag: ['dog food', 'dog treats', 'cat treats', 'bird seed'],
  },
};

export type SeedEntry = { name: string; category: SeedCategory; unit: UnitKey };

/** Every seed name with its category and default unit, in file order. */
export function seedEntries(): SeedEntry[] {
  const entries: SeedEntry[] = [];
  for (const [category, byUnit] of Object.entries(SEED_INGREDIENTS) as [SeedCategory, Partial<Record<UnitKey, readonly string[]>>][]) {
    for (const [unit, names] of Object.entries(byUnit) as [UnitKey, readonly string[]][]) {
      for (const name of names) entries.push({ name, category, unit });
    }
  }
  return entries;
}
