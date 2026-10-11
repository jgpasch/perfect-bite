import { assertEquals } from '@std/assert';

import { compareSeed, formatDisagreements } from './check-seed.ts';

Deno.test('compareSeed: lists aisle, grocery and unit differences; unanswered names are skipped', () => {
  const entries = [
    { name: 'milk', category: 'dairy-eggs', unit: 'gal' },
    { name: 'tahini', category: 'condiments', unit: 'jar' },
    { name: 'lemons', category: 'produce', unit: 'count' },
    { name: 'kale', category: 'produce', unit: 'bunch' },
  ] as const;
  const answers = {
    milk: { category: 'dairy-eggs', is_grocery_item: true, unit: 'gal' },
    tahini: { category: 'pantry', is_grocery_item: true, unit: 'jar' },
    lemon: { category: 'produce', is_grocery_item: false, unit: 'lb' },
  };
  const rows = compareSeed(entries, answers);
  assertEquals(rows.map((r) => [r.name, r.kinds]), [
    ['tahini', ['category']],
    ['lemons', ['not_grocery', 'unit']],
  ]);
  assertEquals(formatDisagreements(rows).split('\n').slice(1, 3), [
    'lemons\tnot_grocery,unit\tproduce\tproduce\tcount\tlb\tfalse',
    'tahini\tcategory\tcondiments\tpantry\tjar\tjar\ttrue',
  ]);
});
