// Copy for shared aisles (spec 4.3.2, 4.3.3): an aisle choice and a custom aisle belong to the household.

/** The item sheet's footnote under the aisle pills when the chosen aisle isn't the catalog default. */
export function sharedAisleFootnote(householdName: string | null): string {
  const name = householdName?.trim();
  return name ? `Changes it for everyone in ${name}.` : 'Changes it for everyone in your household.';
}

/**
 * The aisle order screen's second line for an aisle: its household's name, so two "Costco" aisles
 * can be told apart. Null for a system aisle, an unknown household, or a user in one household.
 */
export function aisleHouseholdLine(
  householdId: string | null,
  households: readonly { id: string; name: string }[],
): string | null {
  if (householdId === null || households.length < 2) return null;
  return households.find((h) => h.id === householdId)?.name ?? null;
}
