// Spec 4.2. How a stored item or ingredient name is shown for reading: sentence case, so a list
// reads consistently whether a name was typed, suggested, imported or said to Siri. Display only:
// never write the result back. Keep it pure (runs under Deno too).

/**
 * Uppercases the first character when it's a lowercase letter and leaves the rest as stored:
 * "chicken thighs" → "Chicken thighs", "2% milk" stays. A first word that already has a capital
 * in it is a deliberate spelling, so "iPhone charger" stays too.
 */
export function displayItemName(name: string): string {
  const [first] = name;
  if (first === undefined) return name;
  const firstWord = name.split(/\s/u, 1)[0];
  if (/\p{Lu}/u.test(firstWord)) return name;
  if (!/\p{Ll}/u.test(first)) return name;
  const upper = first.toLocaleUpperCase();
  // "ß" uppercases to "SS"; a one-letter change only.
  if ([...upper].length !== 1) return name;
  return upper + name.slice(first.length);
}
