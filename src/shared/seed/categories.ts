// Spec 6.2: system categories in default store-walk order. Ids are fixed so the app bundle and
// the Supabase seed migration agree without a round trip. Never renumber; append new ones.

export const SYSTEM_CATEGORIES = [
  { id: '019a4c10-0000-7000-8000-00000000ca01', slug: 'produce', name: 'Produce' },
  { id: '019a4c10-0000-7000-8000-00000000ca02', slug: 'bakery', name: 'Bakery' },
  { id: '019a4c10-0000-7000-8000-00000000ca03', slug: 'deli', name: 'Deli' },
  { id: '019a4c10-0000-7000-8000-00000000ca04', slug: 'meat-seafood', name: 'Meat & Seafood' },
  { id: '019a4c10-0000-7000-8000-00000000ca05', slug: 'dairy-eggs', name: 'Dairy & Eggs' },
  { id: '019a4c10-0000-7000-8000-00000000ca06', slug: 'frozen', name: 'Frozen' },
  { id: '019a4c10-0000-7000-8000-00000000ca07', slug: 'pantry', name: 'Pantry & Dry Goods' },
  { id: '019a4c10-0000-7000-8000-00000000ca08', slug: 'canned-jarred', name: 'Canned & Jarred' },
  { id: '019a4c10-0000-7000-8000-00000000ca09', slug: 'pasta-grains', name: 'Pasta & Grains' },
  { id: '019a4c10-0000-7000-8000-00000000ca10', slug: 'baking', name: 'Baking' },
  { id: '019a4c10-0000-7000-8000-00000000ca11', slug: 'spices', name: 'Spices & Seasonings' },
  { id: '019a4c10-0000-7000-8000-00000000ca12', slug: 'condiments', name: 'Condiments & Sauces' },
  { id: '019a4c10-0000-7000-8000-00000000ca13', slug: 'snacks', name: 'Snacks' },
  { id: '019a4c10-0000-7000-8000-00000000ca14', slug: 'beverages', name: 'Beverages' },
  { id: '019a4c10-0000-7000-8000-00000000ca15', slug: 'breakfast', name: 'Breakfast & Cereal' },
  { id: '019a4c10-0000-7000-8000-00000000ca16', slug: 'household', name: 'Household & Cleaning' },
  { id: '019a4c10-0000-7000-8000-00000000ca17', slug: 'personal-care', name: 'Personal Care' },
  { id: '019a4c10-0000-7000-8000-00000000ca18', slug: 'baby', name: 'Baby' },
  { id: '019a4c10-0000-7000-8000-00000000ca19', slug: 'pet', name: 'Pet' },
  { id: '019a4c10-0000-7000-8000-00000000ca20', slug: 'other', name: 'Other' },
] as const;

export type CategorySlug = (typeof SYSTEM_CATEGORIES)[number]['slug'];

export const OTHER_CATEGORY_ID = '019a4c10-0000-7000-8000-00000000ca20';
