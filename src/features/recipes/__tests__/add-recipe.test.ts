import { describe, expect, test } from '@jest/globals';

import { linkInName, nameAction } from '../add-recipe';

describe('linkInName', () => {
  test('a link with a scheme is itself', () => {
    expect(linkInName('https://smittenkitchen.com/2008/09/moms-apple-cake')).toBe('https://smittenkitchen.com/2008/09/moms-apple-cake');
    expect(linkInName('http://example.com')).toBe('http://example.com');
  });

  test('a bare host and path gets https://', () => {
    expect(linkInName('nytimes.com/recipes/1')).toBe('https://nytimes.com/recipes/1');
    expect(linkInName('www.bbcgoodfood.com')).toBe('https://www.bbcgoodfood.com');
  });

  test('a recipe name is not a link', () => {
    expect(linkInName('Tacos')).toBeNull();
    expect(linkInName("Mom's apple cake")).toBeNull();
    expect(linkInName('Dr. Pepper ribs')).toBeNull();
    expect(linkInName('localhost')).toBeNull();
  });

  test('other schemes are not recipe links', () => {
    expect(linkInName('mailto:me@example.com')).toBeNull();
    expect(linkInName('ftp://example.com/cake')).toBeNull();
  });
});

describe('nameAction', () => {
  test('empty or blank does nothing', () => {
    expect(nameAction('', true)).toEqual({ kind: 'none' });
    expect(nameAction('   ', false)).toEqual({ kind: 'none' });
  });

  test('a name creates, trimmed, with or without import', () => {
    expect(nameAction('  Tacos ', true)).toEqual({ kind: 'create', name: 'Tacos' });
    expect(nameAction('Tacos', false)).toEqual({ kind: 'create', name: 'Tacos' });
  });

  test('a link imports with import, and is refused without it', () => {
    expect(nameAction(' https://example.com/cake ', true)).toEqual({ kind: 'import', url: 'https://example.com/cake' });
    expect(nameAction('example.com/cake', true)).toEqual({ kind: 'import', url: 'https://example.com/cake' });
    expect(nameAction('https://example.com/cake', false)).toEqual({ kind: 'refuse' });
  });
});
