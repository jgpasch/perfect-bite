// Recipe-photo image prompt, version 1 (spec 6.11): what generate-recipe-photo sends the image
// model. Ours, with only the description model's answer inside it: no text from the recipe itself
// ever reaches the image model. Add a new file and version when it changes.

export const RECIPE_PHOTO_IMAGE_PROMPT_VERSION = 'recipe-photo-image.v1';

/** The image prompt around `description` (already checked and cut to its word cap). */
export function buildRecipePhotoImagePrompt(description: string): string {
  return [
    'A realistic, appetizing food photograph of a home-cooked dish, as a food magazine would shoot it.',
    'Natural daylight, soft shadows, shallow depth of field, shot from a natural angle at the table.',
    'Show only the food or drink and its table setting: the plate, bowl or glass, cutlery, a napkin, the table.',
    'No people, hands or other body parts. No text, letters, labels, logos or watermarks.',
    '',
    `The dish: ${description}`,
  ].join('\n');
}
