import { expect, test } from '@jest/globals';

import { LIST_ADD_LABEL, LIST_ADD_PLACEHOLDER } from '../add-bar-copy';

test('the placeholder says a recipe name works too', () => {
  expect(LIST_ADD_PLACEHOLDER).toBe('Add an item or recipe');
});

test('the placeholder no longer carries the long example that was cut off on small phones', () => {
  expect(LIST_ADD_PLACEHOLDER).not.toContain('chicken thighs');
  expect(LIST_ADD_PLACEHOLDER).not.toContain(',');
  expect(LIST_ADD_PLACEHOLDER.length).toBeLessThanOrEqual(21);
});

test('the VoiceOver label stays "Add an item"', () => {
  expect(LIST_ADD_LABEL).toBe('Add an item');
});
