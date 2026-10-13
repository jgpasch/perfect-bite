// The recipe link (spec 4.5): what opens, how it's saved and shown, and opening it in Safari.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { normalizeRecipeLink, openRecipeLink, recipeLinkParts, recipeLinkUrl } from '../recipe-link';

const mockOpenURL = jest.fn<(url: string) => Promise<true>>();
jest.mock('expo-linking', () => ({ openURL: (url: string) => mockOpenURL(url) }));

beforeEach(() => {
  mockOpenURL.mockReset();
});

describe('recipeLinkParts', () => {
  test.each([
    ['https://www.seriouseats.com/the-best-tacos', 'seriouseats.com', '/the-best-tacos'],
    ['https://cooking.nytimes.com/recipes/1015819-chocolate-chip-cookies', 'cooking.nytimes.com', '/recipes/1015819-chocolate-chip-cookies'],
    ['http://WWW.Example.com/a/b?serves=4#step-2', 'example.com', '/a/b?serves=4#step-2'],
    ['https://www.bonappetit.com/', 'bonappetit.com', ''],
    ['https://bonappetit.com', 'bonappetit.com', ''],
    ['https://example.com:8080/x', 'example.com:8080', '/x'],
    ['https://wwwfoods.com/x', 'wwwfoods.com', '/x'],
  ])('%s → %s + %s', (url, host, path) => {
    expect(recipeLinkParts(url)).toEqual({ host, path });
  });

  test.each([[''], [null], [undefined], ['grandma’s card'], ['ftp://example.com/x'], ['https://tacos'], ['mailto:a@b.com']])(
    'not a link that opens: %p',
    (text) => {
      expect(recipeLinkParts(text)).toBeNull();
      expect(recipeLinkUrl(text)).toBeNull();
    },
  );
});

describe('normalizeRecipeLink', () => {
  test('adds https:// when there is no scheme, and trims', () => {
    expect(normalizeRecipeLink('  seriouseats.com/tacos \n')).toBe('https://seriouseats.com/tacos');
    expect(normalizeRecipeLink('www.example.com')).toBe('https://www.example.com');
    expect(normalizeRecipeLink('example.com:8080/x')).toBe('https://example.com:8080/x');
  });

  test('keeps an existing http(s) scheme', () => {
    expect(normalizeRecipeLink(' http://example.com/a ')).toBe('http://example.com/a');
    expect(normalizeRecipeLink('https://example.com/a')).toBe('https://example.com/a');
  });

  test('an empty or blank field clears the link', () => {
    expect(normalizeRecipeLink('')).toBe('');
    expect(normalizeRecipeLink('   ')).toBe('');
  });

  test('text that is not a link is kept as typed (trimmed)', () => {
    expect(normalizeRecipeLink('  Grandma’s recipe card ')).toBe('Grandma’s recipe card');
    expect(normalizeRecipeLink('tacos')).toBe('tacos');
    expect(normalizeRecipeLink('ftp://example.com/x')).toBe('ftp://example.com/x');
    expect(normalizeRecipeLink('localhost:3000')).toBe('localhost:3000');
  });
});

describe('openRecipeLink', () => {
  test('opens the URL with Linking.openURL', async () => {
    mockOpenURL.mockResolvedValue(true);
    await expect(openRecipeLink('https://example.com/tacos')).resolves.toBe(true);
    expect(mockOpenURL).toHaveBeenCalledWith('https://example.com/tacos');
  });

  test('resolves false instead of rejecting when iOS cannot open it', async () => {
    mockOpenURL.mockRejectedValue(new Error('no app'));
    await expect(openRecipeLink('https://example.com/tacos')).resolves.toBe(false);
  });
});
