// The rules for matching a recipe's ingredients to its steps (cook mode, spec 4.5). In their own
// file so the extract-recipe prompt can carry the same rules when imports start matching too.

export const STEP_MATCH_RULES = [
  'For each step, list the ingredients that step adds, mixes in, cuts or otherwise puts its hands on for the first time, so a cook can gather them for that step.',
  'Only list an ingredient when the step clearly uses it. A wrong ingredient on a step is worse than a missing one.',
  'An ingredient made or prepared in an earlier step is not used again: "add the chicken back", "pour over the sauce", "stir in the onion mixture" use nothing new.',
  'A step that says "the sauce ingredients", "the rub" or "all the ingredients" uses the ingredients that make that part, when the list makes clear which they are.',
  'An ingredient listed twice (butter for the pan and butter for the sauce) is two ingredients: give each step the one it uses.',
  'An ingredient can be used by several steps when the recipe divides it ("half the oil", "juice 1 of the limes", "1 cup of the stock"). Then give each of those steps the ingredient with quantity: that step\'s share, as a number in the ingredient\'s own unit (1 for one of 3 limes; 0.5 for half of 1 tbsp). When a step uses all of it, or the share isn\'t stated, quantity is null.',
  'Salt, pepper and water count only when the step names them ("season with salt", "add the water"), not for "salted water" or "to taste" at the table.',
  'An ingredient that no step uses (a garnish the steps never mention, a serving suggestion) goes in no step. That is fine.',
  'Steps that only preheat, rest, wait or serve usually use nothing: give them an empty list.',
] as const;
