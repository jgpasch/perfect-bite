import { expect, test } from '@jest/globals';

import { LIST_ADD_LABEL, LIST_ADD_PLACEHOLDER } from '../add-bar-copy';

test('the placeholder is the short one from the Pantry boards', () => {
  expect(LIST_ADD_PLACEHOLDER).toBe('Add an item');
});

test('the placeholder no longer carries the long example that was cut off on small phones', () => {
  expect(LIST_ADD_PLACEHOLDER).not.toContain('chicken thighs');
  expect(LIST_ADD_PLACEHOLDER).not.toContain(',');
  expect(LIST_ADD_PLACEHOLDER.length).toBeLessThanOrEqual(12);
});

test('the VoiceOver label stays "Add an item"', () => {
  expect(LIST_ADD_LABEL).toBe('Add an item');
});
