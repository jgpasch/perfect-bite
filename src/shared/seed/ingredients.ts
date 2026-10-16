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
      'apples', 'artichokes', 'avocados', 'bell peppers', 'blackberries', 'blueberries', 'butternut squash',
      'cabbage', 'cantaloupe', 'cauliflower', 'coconut', 'corn', 'corn on the cob', 'cucumbers', 'eggplant',
      'extra firm tofu', 'fennel', 'firm tofu', 'garlic', 'grapefruit', 'green bell peppers', 'honeydew',
      'iceberg', 'kiwi', 'lemon juice', 'lemons', 'lettuce', 'lime juice', 'limes', 'mangoes', 'pineapple',
      'pomegranate', 'pumpkin', 'red bell peppers', 'spaghetti squash', 'strawberries', 'watermelon',
      'wonton wrappers',
    ],
    lb: [
      'apricots', 'asparagus', 'bananas', 'beets', 'bok choy', 'brussels sprouts', 'carrots', 'cherries',
      'ginger', 'grapes', 'green beans', 'habanero peppers', 'jalapeno', 'mushrooms', 'napa cabbage',
      'nectarines', 'okra', 'onions', 'oranges', 'papaya', 'parsnips', 'peaches', 'pears', 'plantains',
      'plums', 'poblano', 'portobello mushrooms', 'potatoes', 'red cabbage', 'red onions', 'red potatoes',
      'rhubarb', 'roma tomatoes', 'russet potatoes', 'serrano', 'shallots', 'shiitake mushrooms', 'snap peas',
      'snow peas', 'sugar snap peas', 'sweet onions', 'sweet potatoes', 'tangerines', 'tomatoes', 'turnips',
      'white onions', 'yellow onions', 'yellow squash', 'yukon gold potatoes', 'zucchini',
    ],
    pt: ['cherry tomatoes', 'grape tomatoes', 'raspberries'],
    jar: ['minced garlic'],
    bag: [
      'baby carrots', 'bagged salad', 'bean sprouts', 'cauliflower rice', 'clementines', 'coleslaw mix',
      'cranberries', 'salad mix', 'spinach', 'spring mix',
    ],
    box: ['baby spinach', 'cremini mushrooms', 'dates', 'figs', 'mixed greens', 'tofu'],
    bunch: [
      'arugula', 'basil', 'broccoli', 'celery', 'chives', 'cilantro', 'collard greens', 'dill', 'fresh herbs',
      'green onions', 'kale', 'leeks', 'mint', 'parsley', 'radishes', 'romaine', 'rosemary', 'sage',
      'scallion', 'swiss chard', 'thyme',
    ],
  },
  bakery: {
    count: [
      'bagels', 'baguette', 'biscuits', 'bread', 'brioche', 'brownies', 'cake', 'cheesecake', 'ciabatta',
      'cinnamon rolls', 'cookies', 'corn tortillas', 'cornbread', 'croissants', 'cupcakes', 'dinner rolls',
      'donuts', 'english muffins', 'flour tortillas', 'focaccia', 'french bread', 'garlic bread',
      'hamburger buns', 'hawaiian rolls', 'hoagie rolls', 'hot dog buns', 'italian bread', 'muffins',
      'multigrain bread', 'naan', 'pie', 'potato bread', 'rye bread', 'sandwich bread', 'sourdough',
      'sub rolls', 'tortillas', 'wheat bread', 'white bread', 'whole wheat bread', 'whole wheat tortillas',
      'wraps',
    ],
    bag: ['burger buns', 'pita', 'slider buns'],
  },
  deli: {
    count: [
      'blue cheese', 'brie', 'camembert', 'fresh salsa', 'guacamole', 'hummus', 'pico de gallo',
      'pimento cheese', 'queso', 'rotisserie chicken', 'sushi', 'tzatziki sauce',
    ],
    oz: [
      'fontina', 'fresh mozzarella', 'goat cheese', 'gorgonzola', 'gouda', 'gruyere', 'manchego',
      'parmigiano', 'pecorino',
    ],
    lb: [
      'asiago', 'bologna', 'chicken salad', 'cold cuts', 'coleslaw', 'corned beef', 'deli ham', 'deli meat',
      'deli turkey', 'egg salad', 'genoa salami', 'lunch meat', 'macaroni salad', 'pancetta', 'pasta salad',
      'pastrami', 'pepperoni', 'potato salad', 'prosciutto', 'provolone', 'roast beef', 'salami',
      'sliced cheddar', 'sliced cheese', 'sliced ham', 'sliced provolone', 'sliced swiss', 'sliced turkey',
      'smoked gouda', 'smoked turkey', 'tuna salad',
    ],
    bag: ['pizza dough'],
  },
  'meat-seafood': {
    count: [
      'andouille', 'bacon', 'bratwurst', 'breakfast sausage', 'cornish hens', 'duck', 'hot dogs',
      'turkey bacon', 'whole chicken',
    ],
    oz: ['canadian bacon'],
    lb: [
      'baby back ribs', 'beef', 'beef brisket', 'beef stew meat', 'beef tenderloin',
      'boneless skinless chicken breasts', 'boneless skinless chicken thighs', 'brisket', 'calamari',
      'catfish', 'chicken', 'chicken breasts', 'chicken drumsticks', 'chicken legs', 'chicken sausage',
      'chicken tenders', 'chicken thighs', 'chicken wings', 'chorizo', 'chuck roast', 'clams', 'cod',
      'cooked shrimp', 'crab', 'crab legs', 'crab meat', 'filet mignon', 'fish', 'flank steak', 'ground beef',
      'ground chicken', 'ground lamb', 'ground pork', 'ground turkey', 'ground turkey sausage', 'halibut',
      'ham', 'ham hocks', 'italian sausage', 'kielbasa', 'lamb', 'lamb chops', 'lobster', 'lobster tails',
      'london broil', 'mahi mahi', 'meatballs', 'mussels', 'new york strip', 'pork belly', 'pork chops',
      'pork loin', 'pork ribs', 'pork shoulder', 'pork tenderloin', 'pot roast', 'prime rib', 'ribeye',
      'ribs', 'salmon', 'sausage', 'scallops', 'short ribs', 'shrimp', 'sirloin', 'skirt steak',
      'smoked sausage', 'spare ribs', 'steak', 'stew meat', 'swordfish', 'tilapia', 'tri tip', 'trout',
      'tuna steaks', 'turkey', 'turkey breast', 'veal',
    ],
    dozen: ['oysters'],
  },
  'dairy-eggs': {
    count: [
      'american cheese', 'cheddar', 'cheese', 'cheese slices', 'cheese sticks', 'coffee creamer',
      'cookie dough', 'cotija', 'cottage cheese', 'cream cheese', 'egg whites', 'feta', 'fresh pasta',
      'fresh tortellini', 'greek yogurt', 'kefir', 'mascarpone', 'mexican crema', 'monterey jack',
      'mozzarella', 'oat milk', 'panela', 'pepper jack', 'provolone slices', 'sharp cheddar', 'soy milk',
      'vanilla yogurt', 'yogurt',
    ],
    oz: ['grated parmesan', 'parmesan', 'plain yogurt', 'queso fresco', 'ricotta', 'sour cream'],
    lb: ['colby jack', 'margarine', 'swiss cheese'],
    pt: ['heavy cream', 'heavy whipping cream', 'whipping cream'],
    qt: ['buttermilk', 'goat milk', 'half and half'],
    gal: [
      '1% milk', '2% milk', 'almond milk', 'chocolate milk', 'lactose free milk', 'milk', 'skim milk',
      'whole milk',
    ],
    can: ['crescent rolls', 'refrigerated biscuits', 'whipped cream'],
    bag: [
      'mexican blend cheese', 'shredded cheddar', 'shredded cheese', 'shredded mozzarella',
      'shredded parmesan', 'string cheese',
    ],
    box: ['butter', 'miso', 'pudding cups', 'refrigerated pie crust', 'salted butter', 'unsalted butter'],
    dozen: ['eggs', 'large eggs'],
  },
  frozen: {
    count: [
      'chocolate ice cream', 'frozen burritos', 'frozen meals', 'frozen pizza', 'frozen whipped topping',
      'whipped topping',
    ],
    pt: ['frozen yogurt', 'gelato', 'ice cream', 'sherbet', 'sorbet', 'vanilla ice cream'],
    can: ['frozen orange juice concentrate'],
    bag: [
      'chicken nuggets', 'frozen berries', 'frozen blueberries', 'frozen broccoli', 'frozen cauliflower rice',
      'frozen chicken breasts', 'frozen chicken wings', 'frozen corn', 'frozen dumplings', 'frozen edamame',
      'frozen fries', 'frozen fruit', 'frozen green beans', 'frozen hash browns', 'frozen mango',
      'frozen meatballs', 'frozen mixed berries', 'frozen mixed vegetables', 'frozen peas',
      'frozen peas and carrots', 'frozen pineapple', 'frozen potstickers', 'frozen ravioli', 'frozen salmon',
      'frozen shrimp', 'frozen spinach', 'frozen stir fry vegetables', 'frozen strawberries',
      'frozen tater tots', 'hash browns', 'ice', 'onion rings', 'pizza rolls', 'sweet potato fries',
      'tater tots',
    ],
    box: [
      'fish sticks', 'frozen burgers', 'frozen dinners', 'frozen garlic bread', 'frozen lasagna',
      'frozen pancakes', 'frozen pie shells', 'frozen pierogies', 'frozen puff pastry', 'frozen waffles',
      'ice cream bars', 'ice cream cones', 'ice cream sandwiches', 'mozzarella sticks', 'phyllo dough',
      'popsicles', 'pot pies', 'puff pastry', 'taquitos', 'veggie burgers',
    ],
  },
  pantry: {
    count: [
      'avocado oil', 'canola oil', 'extra virgin olive oil', 'gravy mix', 'honey', 'italian bread crumbs',
      'nori', 'olive oil', 'peanut oil', 'pizza crust', 'sesame oil', 'sunflower oil', 'vegetable oil',
      'whey protein',
    ],
    can: ['olive oil spray'],
    jar: [
      'almond butter', 'coconut oil', 'creamy peanut butter', 'crunchy peanut butter', 'ghee',
      'hazelnut spread', 'hot salsa', 'jarred salsa', 'medium salsa', 'mild salsa', 'peanut butter',
      'popcorn kernels', 'preserves', 'red curry paste', 'strawberry jam',
    ],
    bag: ['chia seeds', 'croutons', 'flax seeds', 'green lentils', 'hemp seeds'],
    box: ['instant mashed potatoes', 'onion soup mix', 'stuffing', 'taco shells', 'tostadas'],
  },
  'canned-jarred': {
    can: [
      'anchovies', 'artichoke hearts', 'baked beans', 'bamboo shoots', 'beef broth', 'beef stew',
      'black beans', 'black eyed peas', 'black olives', 'butter beans', 'canned chicken', 'canned corn',
      'canned green beans', 'canned peaches', 'canned pineapple', 'canned salmon', 'canned tomatoes',
      'canned tuna', 'cannellini', 'chicken broth', 'chicken noodle soup', 'chickpeas', 'chili',
      'chipotle peppers in adobo', 'clam chowder', 'coconut milk', 'corned beef hash', 'cranberry sauce',
      'cream of celery soup', 'cream of chicken soup', 'cream of mushroom soup', 'creamed corn',
      'crushed tomatoes', 'diced green chiles', 'diced tomatoes', 'enchilada sauce', 'fruit cocktail',
      'garbanzo beans', 'great northern beans', 'green chiles', 'hominy', 'kidney beans', 'lentil soup',
      'lima beans', 'mandarin oranges', 'minestrone', 'navy beans', 'pinto beans', 'pizza sauce',
      'refried beans', 'sauerkraut', 'soup', 'tomato paste', 'tomato sauce', 'tomato soup', 'tuna',
      'water chestnuts', 'white beans', 'whole peeled tomatoes',
    ],
    jar: [
      'apple butter', 'applesauce', 'banana pepper rings', 'beef bouillon', 'bouillon', 'capers',
      'chicken base', 'chicken bouillon', 'dill pickles', 'grape jelly', 'green olives', 'jalapeno slices',
      'jam', 'jelly', 'kalamata olives', 'maraschino cherries', 'marmalade', 'olives', 'orange marmalade',
      'pepperoncini', 'pickles', 'roasted red peppers', 'spaghetti sauce', 'sun dried tomatoes',
      'sweet pickles',
    ],
    box: ['beef stock', 'bone broth', 'chicken stock', 'vegetable broth', 'vegetable stock'],
  },
  'pasta-grains': {
    count: ['instant ramen', 'ramen'],
    jar: ['alfredo sauce', 'marinara', 'pasta sauce', 'pesto', 'vodka sauce'],
    bag: [
      'arborio rice', 'barley', 'basmati', 'brown lentils', 'brown rice', 'cheese ravioli',
      'cheese tortellini', 'dried beans', 'dry black beans', 'dry pinto beans', 'egg noodles', 'farro',
      'jasmine rice', 'lentils', 'lo mein', 'long grain rice', 'quinoa', 'red lentils', 'rice', 'rice paper',
      'split peas', 'sushi rice', 'white rice', 'wild rice', 'yellow rice',
    ],
    box: [
      'angel hair pasta', 'bow tie pasta', 'bulgur', 'couscous', 'elbow macaroni', 'farfalle', 'fettuccine',
      'fettuccini', 'gnocchi', 'instant rice', 'jumbo shells', 'lasagna', 'linguine', 'mac and cheese',
      'macaroni', 'macaroni and cheese', 'manicotti', 'orzo', 'pasta', 'penne', 'polenta', 'rice noodles',
      'rigatoni', 'rotini', 'shells', 'soba', 'spaghetti', 'spanish rice', 'udon', 'vermicelli',
      'whole wheat pasta', 'ziti',
    ],
  },
  baking: {
    count: [
      'active dry yeast', 'agave', 'almond extract', 'baking chocolate', 'bread crumbs', 'corn syrup',
      'food coloring', 'frosting', 'graham cracker crust', 'instant yeast', 'lemon extract', 'maple extract',
      'peppermint extract', 'vanilla extract',
    ],
    can: [
      'apple pie filling', 'baking powder', 'canned pumpkin', 'cherry pie filling', 'cocoa powder',
      'condensed milk', 'cooking spray', 'dutch process cocoa', 'evaporated milk', 'pie filling',
      'seasoned bread crumbs', 'shortening', 'sweetened condensed milk', 'unsweetened cocoa',
    ],
    jar: ['molasses', 'poppy seeds', 'sesame seeds', 'sprinkles', 'vanilla bean paste'],
    bag: [
      'all-purpose flour', 'almond flour', 'bread flour', 'brown sugar', 'butterscotch chips',
      'chocolate chips', 'chopped pecans', 'chopped walnuts', 'coconut flakes', 'coconut flour', 'cornmeal',
      'dark brown sugar', 'dark chocolate chips', 'flour', 'gluten free flour', 'granulated sugar',
      'light brown sugar', 'marshmallows', 'masa', 'milk chocolate chips', 'mini marshmallows',
      'peanut butter chips', 'pecans', 'pine nuts', 'powdered sugar', 'self rising flour',
      'semi sweet chocolate chips', 'shredded coconut', 'sliced almonds', 'slivered almonds', 'sugar',
      'toffee bits', 'walnuts', 'white chocolate chips', 'whole wheat flour', 'xanthan gum',
    ],
    box: [
      'baking soda', 'brownie mix', 'cake flour', 'cake mix', 'chocolate cake mix', 'cornbread mix',
      'cornstarch', 'cupcake liners', 'gelatin', 'graham cracker crumbs', 'instant pudding', 'lard',
      'muffin liners', 'muffin mix', 'panko', 'parchment paper', 'pickling salt', 'pie crust', 'pudding mix',
      'stevia', 'sugar substitute', 'unflavored gelatin', 'yeast', 'yellow cake mix',
    ],
  },
  spices: {
    count: ['ranch packet', 'salt', 'sea salt', 'taco seasoning'],
    can: ['old bay'],
    jar: [
      'adobo', 'allspice', 'bay leaves', 'bbq rub', 'black pepper', 'cajun seasoning', 'cardamom', 'cayenne',
      'celery salt', 'celery seed', 'chili flakes', 'chili powder', 'chili seasoning', 'chinese five spice',
      'chipotle powder', 'cinnamon', 'cinnamon sticks', 'cloves', 'coriander', 'cracked black pepper',
      'creole seasoning', 'crushed red pepper', 'cumin', 'cumin seeds', 'curry powder', 'dried basil',
      'dried dill', 'dried oregano', 'dried parsley', 'dried rosemary', 'dried sage', 'dried thyme',
      'dry mustard', 'everything bagel seasoning', 'fennel seeds', 'garam masala', 'garlic powder',
      'garlic salt', 'ginger powder', 'greek seasoning', 'ground allspice', 'ground cinnamon',
      'ground cloves', 'ground coriander', 'ground cumin', 'ground ginger', 'ground nutmeg',
      'ground turmeric', 'herbes de provence', 'himalayan pink salt', 'italian seasoning', 'jerk seasoning',
      'lemon pepper', 'minced onion', 'montreal steak seasoning', 'mustard seeds', 'nutmeg', 'onion flakes',
      'onion powder', 'oregano', 'paprika', 'peppercorns', 'poultry seasoning', 'pumpkin pie spice',
      'red pepper flakes', 'saffron', 'seasoned salt', 'smoked paprika', 'star anise', 'steak seasoning',
      'sumac', 'turmeric', 'white pepper', "za'atar",
    ],
    bag: ['fajita seasoning', 'gochugaru'],
    box: ['flaky sea salt', 'kosher salt', 'ranch seasoning', 'sazon'],
  },
  condiments: {
    count: [
      'apple cider vinegar', 'balsamic glaze', 'balsamic vinaigrette', 'balsamic vinegar', 'barbecue sauce',
      'bbq sauce', 'blue cheese dressing', 'buffalo sauce', 'caesar dressing', 'chimichurri',
      'chocolate syrup', 'cocktail sauce', 'coconut aminos', 'cooking sherry', 'cooking wine',
      'distilled white vinegar', 'fish sauce', 'french dressing', 'greek dressing', 'honey mustard',
      'hot honey', 'hot sauce', 'italian dressing', 'ketchup', 'liquid smoke', 'low sodium soy sauce',
      'malt vinegar', 'marsala cooking wine', 'mirin', 'mustard', 'oyster sauce', 'plum sauce', 'ponzu',
      'poppy seed dressing', 'ranch', 'raspberry vinaigrette', 'red wine vinegar', 'rice vinegar',
      'salad dressing', 'sesame ginger dressing', 'shaoxing wine', 'sherry vinegar', 'soy sauce',
      'spicy brown mustard', 'sriracha', 'steak sauce', 'sweet and sour', 'sweet chili sauce', 'taco sauce',
      'tamari', 'teriyaki sauce', 'thousand island', 'vinegar', 'wasabi', 'white vinegar',
      'white wine vinegar', 'worcestershire', 'worcestershire sauce', 'yellow mustard', 'yum yum sauce',
    ],
    can: ['red enchilada sauce'],
    jar: [
      'adobo sauce', 'aioli', 'caramel sauce', 'chili crisp', 'chili garlic sauce', 'chili oil', 'chutney',
      'curry paste', 'dijon', 'duck sauce', 'hoisin sauce', 'horseradish', 'hot fudge', 'mayo', 'mayonnaise',
      'mole', 'peanut sauce', 'pickle relish', 'relish', 'salsa', 'salsa verde', 'sambal', 'tahini',
      'tartar sauce', 'whole grain mustard',
    ],
    box: ['gochujang', 'white miso'],
  },
  snacks: {
    count: ['breath mints', 'chocolate', 'chocolate bar', 'dark chocolate', 'energy bar', 'gum'],
    can: ['bean dip', 'mixed nuts'],
    jar: ['cheese dip'],
    bag: [
      'almonds', 'beef jerky', 'brazil nuts', 'candy', 'cashews', 'cheese puffs', 'chips',
      'chocolate covered almonds', 'dried apples', 'dried apricots', 'dried cherries', 'dried cranberries',
      'dried figs', 'dried fruit', 'dried mango', 'dried plums', 'gummy bears', 'hard candy', 'jelly beans',
      'jerky', 'kettle chips', 'licorice', 'lollipops', 'macadamia nuts', 'nuts', 'oyster crackers',
      'peanuts', 'pepitas', 'pistachios', 'pita chips', 'popcorn', 'potato chips', 'pretzel sticks',
      'pretzels', 'pumpkin seeds', 'rice cakes', 'roasted almonds', 'seaweed snacks', 'snack mix',
      'sunflower seeds', 'tortilla chips', 'trail mix', 'veggie chips',
    ],
    box: [
      'animal crackers', 'butter cookies', 'cheese crackers', 'crackers', 'fruit leather', 'fruit snacks',
      'gingersnaps', 'graham crackers', 'granola bars', 'microwave popcorn', 'peanut butter crackers',
      'protein bars', 'raisins', 'saltines', 'sandwich cookies', 'vanilla wafers', 'water crackers',
    ],
  },
  beverages: {
    count: [
      'amaretto', 'aperol', 'apple juice', 'beer', 'bitters', 'bottled water', 'bourbon', 'brandy',
      'cabernet', 'champagne', 'chardonnay', 'cherry juice', 'club soda', 'coconut water', 'cointreau',
      'cold brew', 'cranberry juice', 'dark rum', 'dry vermouth', 'electrolyte drink', 'fruit punch', 'gin',
      'grape juice', 'grapefruit juice', 'grenadine', 'hard cider', 'iced coffee', 'iced tea', 'irish cream',
      'kahlua', 'kombucha', 'lemonade', 'margarita mix', 'merlot', 'mezcal', 'mineral water', 'orange juice',
      'pinot grigio', 'pinot noir', 'pomegranate juice', 'port', 'prosecco', 'protein shake', 'prune juice',
      'red wine', 'rose', 'rum', 'sake', 'sauvignon blanc', 'scotch', 'sherry', 'simple syrup', 'smoothie',
      'soda', 'sparkling water', 'sparkling wine', 'sports drinks', 'sweet tea', 'sweet vermouth', 'tequila',
      'tonic', 'triple sec', 'vermouth', 'vodka', 'water', 'whiskey', 'white grape juice', 'white rum',
      'white wine', 'wine',
    ],
    gal: ['apple cider', 'cider', 'distilled water'],
    can: [
      'diet soda', 'energy drinks', 'ginger ale', 'hard seltzer', 'light beer', 'matcha',
      'non alcoholic beer', 'pineapple juice', 'root beer', 'seltzer', 'tomato juice', 'vegetable juice',
    ],
    jar: ['instant coffee'],
    bag: ['coffee', 'coffee beans', 'decaf coffee', 'espresso', 'ground coffee', 'whole bean coffee'],
    box: [
      'black tea', 'chai', 'chamomile', 'cocoa mix', 'coffee pods', 'earl grey', 'ginger tea', 'green tea',
      'herbal tea', 'hot chocolate', 'hot cocoa mix', 'juice boxes', 'k cups', 'peppermint tea', 'tea',
    ],
  },
  breakfast: {
    count: ['maple syrup', 'pancake syrup', 'pure maple syrup', 'sugar free syrup'],
    can: ['old fashioned oats', 'quick oats'],
    bag: ['granola', 'muesli', 'oats', 'overnight oats', 'puffed rice', 'rolled oats', 'steel cut oats'],
    box: [
      'bran flakes', 'breakfast bars', 'buttermilk pancake mix', 'cereal', 'cereal bars', 'corn flakes',
      'grits', 'hot cereal', 'instant grits', 'instant oatmeal', 'oatmeal', 'pancake mix', 'raisin bran',
      'toaster pastries', 'waffle mix',
    ],
  },
  household: {
    count: [
      '9v batteries', 'aa batteries', 'aaa batteries', 'air freshener', 'all purpose spray',
      'all-purpose cleaner', 'bath tissue', 'batteries', 'bleach', 'broom', 'candles', 'dish soap',
      'dish towels', 'disinfectant spray', 'disinfectant wipes', 'drain cleaner', 'duct tape',
      'fabric softener', 'floor cleaner', 'foil pans', 'glass cleaner', 'hangers', 'laundry detergent',
      'light bulbs', 'lighter', 'mason jars', 'microfiber cloths', 'mop', 'mosquito repellent',
      'paper towels', 'plunger', 'rubber gloves', 'scrub brush', 'shower cleaner', 'sponges', 'stain remover',
      'storage containers', 'tape', 'toilet bowl cleaner', 'toilet brush', 'toilet paper', 'trash can',
      'water filter',
    ],
    can: ['oven cleaner', 'propane'],
    bag: [
      'charcoal briquettes', 'dishwasher pods', 'ice melt', 'paper cups', 'paper plates', 'plastic cups',
      'skewers',
    ],
    box: [
      'aluminum foil', 'ant traps', 'birthday candles', 'c batteries', 'cleaning wipes', 'cling wrap',
      'coffee filters', 'd batteries', 'dish gloves', 'dish sponges', 'dishwasher detergent',
      'dishwasher tabs', 'disposable gloves', 'dryer balls', 'dryer sheets', 'facial tissue', 'foil',
      'freezer bags', 'gallon bags', 'garbage bags', 'heavy duty foil', 'kitchen trash bags', 'laundry pods',
      'magic eraser', 'matches', 'mouse traps', 'napkins', 'paper napkins', 'parchment rounds',
      'plastic forks', 'plastic knives', 'plastic spoons', 'plastic utensils', 'plastic wrap', 'quart bags',
      'sandwich bags', 'snack bags', 'storage bags', 'straws', 'tissue box', 'tissues', 'toothpicks',
      'trash bags', 'wax paper', 'zip top bags',
    ],
  },
  'personal-care': {
    count: [
      'acetaminophen', 'allergy medicine', 'antacid', 'antibiotic ointment', 'aspirin', 'bar soap',
      'body lotion', 'body wash', 'conditioner', 'contact solution', 'cough syrup', 'deodorant', 'eye drops',
      'face wash', 'first aid kit', 'fish oil', 'floss', 'hair gel', 'hair ties', 'hand sanitizer',
      'hand soap', 'hydrogen peroxide', 'lip balm', 'lotion', 'makeup', 'makeup remover', 'mascara',
      'melatonin', 'moisturizer', 'mouthwash', 'multivitamin', 'nail clippers', 'nasal spray',
      'pain reliever', 'probiotics', 'razors', 'rubbing alcohol', 'shampoo', 'sunscreen', 'thermometer',
      'toothbrushes', 'toothpaste', 'vitamin c', 'vitamin d', 'vitamins',
    ],
    can: ['dry shampoo', 'hairspray', 'shaving cream'],
    jar: ['petroleum jelly', 'protein powder'],
    bag: ['cotton balls', 'cotton pads', 'cough drops', 'epsom salt'],
    box: [
      'bandages', 'cold medicine', 'cotton swabs', 'ibuprofen', 'pads', 'panty liners', 'pregnancy test',
      'tampons',
    ],
  },
  baby: {
    count: [
      'baby bottles', 'baby laundry detergent', 'baby lotion', 'baby oil', 'baby powder', 'baby puffs',
      'baby shampoo', 'baby sunscreen', 'baby wash', 'baby wipes', 'bibs', 'diaper cream',
      'diaper rash cream', 'gas drops', 'infant ibuprofen', 'puffs', 'sippy cups',
    ],
    can: ['formula'],
    jar: ['baby food'],
    bag: ['training pants', 'yogurt melts'],
    box: [
      'baby cereal', 'diapers', 'infant tylenol', 'nursing pads', 'rice cereal', 'teething biscuits',
      'toddler snacks', 'wipes',
    ],
  },
  pet: {
    count: ['cat toys', 'catnip', 'dog toys'],
    can: ['canned cat food', 'canned dog food', 'cat food', 'fish food', 'wet cat food', 'wet dog food'],
    bag: [
      'bird food', 'bird seed', 'birdseed', 'cat litter', 'cat treats', 'dog chews', 'dog food', 'dog treats',
      'dry cat food', 'dry dog food', 'kibble', 'kitten food', 'puppy food',
    ],
    box: ['flea treatment', 'poop bags', 'puppy pads'],
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
