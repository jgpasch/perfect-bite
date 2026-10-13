// Deleting a household (spec 4.7) goes back to Settings, which shows "Deleted <household>": the
// household screen stores the name as it goes back, and Settings takes it when it gains focus.

let pending: string | null = null;

export function setDeletedHousehold(householdName: string): void {
  pending = householdName;
}

/** The deleted household's name, once: taking it clears it. */
export function takeDeletedHousehold(): string | null {
  const name = pending;
  pending = null;
  return name;
}
