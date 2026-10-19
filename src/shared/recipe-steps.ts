// Spec 4.5 "Step sections", 5. `recipes.steps` holds the method's step strings and, between them,
// section headings. A section runs from its heading to the next; steps before the first heading
// are an untitled section. Two or more `choice` sections next to each other are one choice group
// (ways to do the same part); a lone `choice` section reads as an ordinary one. Only the step
// strings are counted, numbered or matched (`stepTexts`). Keep it pure (runs under Deno too).

/** A section heading in `recipes.steps`. */
export type RecipeStepHeading = { section: string; choice?: true };

/** One entry of `recipes.steps`: a step's text, or a section heading. */
export type RecipeStepEntry = string | RecipeStepHeading;

/** Bounds of a heading in `recipes.steps` (spec 5, `private.recipe_steps_ok`). */
export const MAX_RECIPE_SECTIONS = 20;
export const MAX_RECIPE_SECTION_LENGTH = 80;

export type RecipeSection = {
  /** The heading's name; null for the steps before the first heading. */
  title: string | null;
  /** One way of several to do the same part: only in a group of two or more. */
  choice: boolean;
  /** The section's steps, as indexes into `stepTexts`. */
  steps: number[];
};

export function isStepHeading(entry: RecipeStepEntry): entry is RecipeStepHeading {
  return typeof entry !== 'string';
}

/** The step strings, in order: what everything counts, numbers and matches. */
export function stepTexts(entries: readonly RecipeStepEntry[] | null | undefined): string[] {
  return (entries ?? []).filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The method as sections, in order. Without headings it's one untitled section of every step (none
 * without steps). A heading straight after another gives a section with no steps.
 */
export function recipeSections(entries: readonly RecipeStepEntry[] | null | undefined): RecipeSection[] {
  const sections: (RecipeSection & { marked: boolean })[] = [];
  let step = 0;
  for (const entry of entries ?? []) {
    if (isStepHeading(entry)) {
      sections.push({ title: entry.section, choice: false, marked: entry.choice === true, steps: [] });
    } else {
      if (sections.length === 0) sections.push({ title: null, choice: false, marked: false, steps: [] });
      sections[sections.length - 1].steps.push(step++);
    }
  }
  // A marked section counts as a choice only next to another marked one.
  sections.forEach((section, i) => {
    section.choice = section.marked && (sections[i - 1]?.marked === true || sections[i + 1]?.marked === true);
  });
  return sections.map(({ title, choice, steps }) => ({ title, choice, steps }));
}

/** The choice groups, in order: each the indexes (into `recipeSections`) of its options. */
export function choiceGroups(sections: readonly RecipeSection[]): number[][] {
  const groups: number[][] = [];
  sections.forEach((section, i) => {
    if (!section.choice) return;
    if (sections[i - 1]?.choice) groups[groups.length - 1].push(i);
    else groups.push([i]);
  });
  return groups;
}

/**
 * The steps shown (indexes into `stepTexts`, in order) for one pick per choice group: `picks[g]` is
 * the option (from 0) picked in group `g`. A group with no pick, or one out of range, shows its first.
 */
export function stepPath(entries: readonly RecipeStepEntry[] | null | undefined, picks: readonly (number | null | undefined)[] = []): number[] {
  const sections = recipeSections(entries);
  const shown = new Set(sections.map((_, i) => i));
  choiceGroups(sections).forEach((group, g) => {
    const pick = picks[g];
    const picked = pick != null && Number.isInteger(pick) && pick >= 0 && pick < group.length ? pick : 0;
    group.forEach((section, option) => {
      if (option !== picked) shown.delete(section);
    });
  });
  return sections.flatMap((section, i) => (shown.has(i) ? section.steps : []));
}
