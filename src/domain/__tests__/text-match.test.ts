import { describe, expect, it } from '@jest/globals';

import { matchParts } from '@/domain/text-match';

describe('matchParts', () => {
  it('splits off a matched prefix', () => {
    expect(matchParts('chicken thighs', 'chi')).toEqual({ before: '', match: 'chi', after: 'cken thighs' });
  });

  it('keeps the text’s own case for the match', () => {
    expect(matchParts('Chipotle in adobo', 'CHI')).toEqual({ before: '', match: 'Chi', after: 'potle in adobo' });
  });

  it('prefers the start of a word over a match inside one', () => {
    expect(matchParts('peach chips', 'chi')).toEqual({ before: 'peach ', match: 'chi', after: 'ps' });
  });

  it('falls back to a match inside a word', () => {
    expect(matchParts('zucchini', 'chi')).toEqual({ before: 'zuc', match: 'chi', after: 'ni' });
  });

  it('ignores spaces around the query', () => {
    expect(matchParts('milk', '  mi ')).toEqual({ before: '', match: 'mi', after: 'lk' });
  });

  it('matches the whole text', () => {
    expect(matchParts('milk', 'milk')).toEqual({ before: '', match: 'milk', after: '' });
  });

  it('is null for a blank query or no match', () => {
    expect(matchParts('milk', '')).toBeNull();
    expect(matchParts('milk', '   ')).toBeNull();
    expect(matchParts('milk', 'eggs')).toBeNull();
    expect(matchParts('', 'mi')).toBeNull();
  });

  it('finds the name in a toast message', () => {
    expect(matchParts('Added to milk, now 1 gal + 1', 'milk')).toEqual({
      before: 'Added to ',
      match: 'milk',
      after: ', now 1 gal + 1',
    });
  });
});
