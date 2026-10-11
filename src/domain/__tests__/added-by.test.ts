import { describe, expect, it } from '@jest/globals';

import { addedByLabel, addedLine, addedWhen, checkedLine } from '@/domain/added-by';

const ME = 'user-me';

describe('addedByLabel', () => {
  it('names Siri adds Siri, whoever made them', () => {
    expect(addedByLabel({ source: 'siri', addedBy: ME, recipeName: null }, ME)).toBe('Siri');
  });

  it('names recipe adds by the recipe', () => {
    expect(addedByLabel({ source: 'recipe', addedBy: ME, recipeName: 'Lasagne' }, ME)).toBe('Lasagne');
    expect(addedByLabel({ source: 'recipe', addedBy: ME, recipeName: '  Tacos ' }, ME)).toBe('Tacos');
  });

  it('falls back to "A recipe" once the recipe is gone or has a blank name', () => {
    expect(addedByLabel({ source: 'recipe', addedBy: ME, recipeName: null }, ME)).toBe('A recipe');
    expect(addedByLabel({ source: 'recipe', addedBy: ME, recipeName: '   ' }, ME)).toBe('A recipe');
  });

  it('is You for your own manual adds', () => {
    expect(addedByLabel({ source: 'manual', addedBy: ME, recipeName: null }, ME)).toBe('You');
  });

  it('is Someone else for another member, an unknown adder, or when signed out', () => {
    expect(addedByLabel({ source: 'manual', addedBy: 'user-other', recipeName: null }, ME)).toBe('Someone else');
    expect(addedByLabel({ source: 'manual', addedBy: null, recipeName: null }, ME)).toBe('Someone else');
    expect(addedByLabel({ source: 'manual', addedBy: null, recipeName: null }, null)).toBe('Someone else');
  });
});

describe('addedWhen', () => {
  // Friday 9 October 2026, 15:30 local time.
  const now = new Date(2026, 9, 9, 15, 30);
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;

  it('is "just now" under a minute, and for times in the future', () => {
    expect(addedWhen(now, now)).toBe('just now');
    expect(addedWhen(ago(59_999), now)).toBe('just now');
    expect(addedWhen(ago(-5 * MIN), now)).toBe('just now');
  });

  it('counts minutes under an hour', () => {
    expect(addedWhen(ago(MIN), now)).toBe('1 min ago');
    expect(addedWhen(ago(5 * MIN + 30_000), now)).toBe('5 min ago');
    expect(addedWhen(ago(59 * MIN), now)).toBe('59 min ago');
  });

  it('is "today" from an hour ago back to midnight', () => {
    expect(addedWhen(ago(60 * MIN), now)).toBe('today');
    expect(addedWhen(new Date(2026, 9, 9, 0, 0), now)).toBe('today');
  });

  it('is "yesterday" for any time the day before', () => {
    expect(addedWhen(new Date(2026, 9, 8, 23, 59), now)).toBe('yesterday');
    expect(addedWhen(new Date(2026, 9, 8, 0, 1), now)).toBe('yesterday');
  });

  it('names the weekday within the last week', () => {
    expect(addedWhen(new Date(2026, 9, 7, 12, 0), now)).toBe('Wednesday');
    expect(addedWhen(new Date(2026, 9, 6, 9, 0), now)).toBe('Tuesday');
    expect(addedWhen(new Date(2026, 9, 3, 9, 0), now)).toBe('Saturday');
  });

  it('gives the date from a week back, with the year only when it differs', () => {
    expect(addedWhen(new Date(2026, 9, 2, 9, 0), now)).toBe('Oct 2');
    expect(addedWhen(new Date(2026, 0, 31, 9, 0), now)).toBe('Jan 31');
    expect(addedWhen(new Date(2025, 11, 25, 9, 0), now)).toBe('Dec 25, 2025');
  });

  it('counts calendar days across a daylight-saving change', () => {
    // US clocks go back on 1 November 2026; whatever the test machine's zone, the days still count.
    const after = new Date(2026, 10, 2, 12, 0);
    expect(addedWhen(new Date(2026, 10, 1, 12, 0), after)).toBe('yesterday');
    expect(addedWhen(new Date(2026, 9, 31, 12, 0), after)).toBe('Saturday');
  });
});

describe('addedLine', () => {
  it('joins who and when like the board: "You, Tuesday", "Siri, just now"', () => {
    const now = new Date(2026, 9, 9, 15, 30);
    expect(addedLine({ source: 'manual', addedBy: ME, recipeName: null, createdAt: new Date(2026, 9, 6, 9) }, ME, now)).toBe(
      'You, Tuesday',
    );
    expect(addedLine({ source: 'siri', addedBy: ME, recipeName: null, createdAt: now }, ME, now)).toBe('Siri, just now');
  });
});

describe('checkedLine', () => {
  const now = new Date(2026, 9, 9, 15, 30);

  it('says when, and "by you" for your own check', () => {
    expect(checkedLine(new Date(2026, 9, 9, 15, 25), ME, ME, now)).toBe('Checked 5 min ago by you');
    expect(checkedLine(new Date(2026, 9, 8, 18), ME, ME, now)).toBe('Checked yesterday by you');
  });

  it("says someone else for another member, whose name isn't on the device", () => {
    expect(checkedLine(new Date(2026, 9, 6, 9), 'user-2', ME, now)).toBe('Checked Tuesday by someone else');
    expect(checkedLine(now, 'user-2', null, now)).toBe('Checked just now by someone else');
  });

  it('leaves the "by" off when no one is recorded', () => {
    expect(checkedLine(new Date(2026, 1, 3), null, ME, now)).toBe('Checked Feb 3');
  });
});
