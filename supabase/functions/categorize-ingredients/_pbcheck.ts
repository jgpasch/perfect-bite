import { normalizeIngredientName, seedEntries } from '@shared/index.ts';
const g = JSON.parse(await Deno.readTextFile('eval/golden.json'));
const seed = new Set(seedEntries().map((e) => normalizeIngredientName(e.name)));
console.log('cases', g.cases.length);
for (const c of g.cases) {
  const k = normalizeIngredientName(c.name);
  if (seed.has(k)) console.log('IN SEED', c.name);
  if (c.injection) console.log(JSON.stringify(k), [...k].length);
}
