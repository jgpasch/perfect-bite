import { buildExtractRecipePrompt } from '../_shared/ai/prompts/extract-recipe.v4.ts';
const { instructions } = buildExtractRecipePrompt({ title: 'T', ingredientLines: ['1 egg'], steps: ['Boil.'] });
const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(instructions));
console.log(instructions.length, Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''));
