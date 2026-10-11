import { describe, expect, test } from '@jest/globals';

import { importedToast, importErrorMessage, urlFromText } from '../import-sheet';

describe('urlFromText', () => {
  test('a plain link comes back as it is', () => {
    expect(urlFromText('https://www.bonappetit.com/recipe/chicken-tikka-masala')).toBe(
      'https://www.bonappetit.com/recipe/chicken-tikka-masala',
    );
    expect(urlFromText('http://example.com/a?b=1&c=2#step-3')).toBe('http://example.com/a?b=1&c=2#step-3');
  });

  test('surrounding whitespace and newlines are dropped', () => {
    expect(urlFromText('  \n https://example.com/tacos \n')).toBe('https://example.com/tacos');
  });

  test('the first link is pulled out of shared text', () => {
    expect(urlFromText('Made this last night!! https://cooking.nytimes.com/recipes/1017518 so good')).toBe(
      'https://cooking.nytimes.com/recipes/1017518',
    );
    expect(urlFromText('one https://a.com/1 two https://b.com/2')).toBe('https://a.com/1');
  });

  test('sentence punctuation after a link is not part of it', () => {
    expect(urlFromText('Try this: https://example.com/dal.')).toBe('https://example.com/dal');
    expect(urlFromText('https://example.com/dal?!')).toBe('https://example.com/dal');
    expect(urlFromText('"https://example.com/dal",')).toBe('https://example.com/dal');
  });

  test('a closing bracket is dropped only when the link did not open it', () => {
    expect(urlFromText('(see https://example.com/dal)')).toBe('https://example.com/dal');
    expect(urlFromText('(see https://example.com/dal).')).toBe('https://example.com/dal');
    expect(urlFromText('https://en.wikipedia.org/wiki/Dal_(food)')).toBe('https://en.wikipedia.org/wiki/Dal_(food)');
    expect(urlFromText('[https://example.com/a]')).toBe('https://example.com/a');
  });

  test('the scheme is matched in any case', () => {
    expect(urlFromText('HTTPS://Example.com/Tacos')).toBe('HTTPS://Example.com/Tacos');
  });

  test('a bare host and path typed on its own gets https', () => {
    expect(urlFromText('smittenkitchen.com/2008/09/moms-apple-cake/')).toBe(
      'https://smittenkitchen.com/2008/09/moms-apple-cake/',
    );
    expect(urlFromText('www.example.co.uk')).toBe('https://www.example.co.uk');
    expect(urlFromText(' example.com/dal. ')).toBe('https://example.com/dal');
  });

  test('text with no link is null', () => {
    expect(urlFromText('')).toBeNull();
    expect(urlFromText('   ')).toBeNull();
    expect(urlFromText('chicken tikka masala')).toBeNull();
    expect(urlFromText('see example.com/dal for more')).toBeNull();
    expect(urlFromText('ftp://example.com/recipe')).toBeNull();
    expect(urlFromText('https://')).toBeNull();
    expect(urlFromText('version 1.5')).toBeNull();
  });
});

describe('importErrorMessage', () => {
  test('each failure has its plain copy', () => {
    expect(importErrorMessage({ ok: false, error: 'not_a_recipe' })).toBe("That page doesn't look like a recipe");
    expect(importErrorMessage({ ok: false, error: 'failed', reason: 'fetch_failed' })).toBe("Couldn't reach that site");
    expect(importErrorMessage({ ok: false, error: 'rate_limited' })).toBe('Try again in a minute');
    expect(importErrorMessage({ ok: false, error: 'failed', reason: 'invalid_url' })).toBe("That doesn't look like a link");
    expect(importErrorMessage({ ok: false, error: 'offline' })).toBe("You're offline");
    expect(importErrorMessage({ ok: false, error: 'blocked' })).toBe(
      'This site blocked the import. Open it in Safari and tap Share → The Perfect Bite.',
    );
  });

  test('an unexplained failure asks to try again', () => {
    expect(importErrorMessage({ ok: false, error: 'failed' })).toBe("Couldn't import that recipe. Try again.");
  });
});

describe('importedToast', () => {
  test('names the recipe in bold and counts the items', () => {
    expect(importedToast('Chicken tikka masala', 12)).toEqual({
      message: 'Added Chicken tikka masala · 12 items',
      emphasis: 'Chicken tikka masala',
    });
  });

  test('one item is singular', () => {
    expect(importedToast('Toast', 1)).toEqual({ message: 'Added Toast · 1 item', emphasis: 'Toast' });
  });
});
