import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { addedByLabel, addedBySummary, addedLine, addedWhen, checkedLine } from '@/domain/added-by';
import { i18n } from '@/i18n';

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

  it("names another member's add with their short name", () => {
    const names = new Map([['user-other', 'Alex']]);
    expect(addedByLabel({ source: 'manual', addedBy: 'user-other', recipeName: null }, ME, names)).toBe('Alex');
    expect(addedByLabel({ source: 'recipe', addedBy: 'user-other', recipeName: 'Tacos' }, ME, names)).toBe('Tacos · Alex');
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

  describe("with the household's names (spec 4.4)", () => {
    const now = new Date(2026, 9, 9, 15, 30);
    const tuesday = new Date(2026, 9, 6, 9);
    const yesterday = new Date(2026, 9, 8, 18);
    const names = new Map([[ME, 'Jo'], ['user-2', 'Alex'], ['user-3', 'Sam R.']]);
    const manual = (addedBy: string | null, createdAt = tuesday) =>
      ({ source: 'manual', addedBy, recipeName: null, createdAt }) as const;
    const recipe = (addedBy: string | null, recipeName: string | null = 'Shakshuka') =>
      ({ source: 'recipe', addedBy, recipeName, createdAt: yesterday }) as const;

    it('names another member by their short name', () => {
      expect(addedLine(manual('user-2'), ME, now, names)).toBe('Alex, Tuesday');
      expect(addedLine(manual('user-3', now), ME, now, names)).toBe('Sam R., just now');
    });

    it("is Someone else for a member whose name isn't on the device, and for an old add with no one", () => {
      expect(addedLine(manual('user-gone'), ME, now, names)).toBe('Someone else, Tuesday');
      expect(addedLine(manual(null), ME, now, names)).toBe('Someone else, Tuesday');
      // Names not loaded yet.
      expect(addedLine(manual('user-2'), ME, now)).toBe('Someone else, Tuesday');
    });

    it('is You for your own add, even with your name cached', () => {
      expect(addedLine(manual(ME), ME, now, names)).toBe('You, Tuesday');
    });

    it('names another member after the recipe for their recipe add, and not you for yours', () => {
      expect(addedLine(recipe('user-2'), ME, now, names)).toBe('Shakshuka · Alex, yesterday');
      expect(addedLine(recipe(ME), ME, now, names)).toBe('Shakshuka, yesterday');
      expect(addedLine(recipe(null), ME, now, names)).toBe('Shakshuka, yesterday');
    });

    it('is Someone else after the recipe for an unknown member, and "A recipe" once it is gone', () => {
      expect(addedLine(recipe('user-gone'), ME, now, names)).toBe('Shakshuka · Someone else, yesterday');
      expect(addedLine(recipe('user-2', null), ME, now, names)).toBe('A recipe · Alex, yesterday');
    });

    it('is Siri for a Siri add, whoever asked Siri', () => {
      expect(addedLine({ source: 'siri', addedBy: 'user-2', recipeName: null, createdAt: tuesday }, ME, now, names)).toBe(
        'Siri, Tuesday',
      );
    });

    it('signed out, every member is named', () => {
      expect(addedLine(manual(ME), null, now, names)).toBe('Jo, Tuesday');
      expect(addedLine(recipe('user-2'), null, now, names)).toBe('Shakshuka · Alex, yesterday');
    });
  });
});

describe('checkedLine', () => {
  const now = new Date(2026, 9, 9, 15, 30);

  it('says when, and "by you" for your own check', () => {
    expect(checkedLine(new Date(2026, 9, 9, 15, 25), ME, ME, now)).toBe('Checked 5 min ago by you');
    expect(checkedLine(new Date(2026, 9, 8, 18), ME, ME, now)).toBe('Checked yesterday by you');
  });

  it("names another member by their short name, even signed out", () => {
    const names = new Map([['user-2', 'Alex'], ['user-3', 'Sam R.']]);
    expect(checkedLine(new Date(2026, 9, 6, 9), 'user-2', ME, now, names)).toBe('Checked Tuesday by Alex');
    expect(checkedLine(new Date(2026, 9, 9, 15, 25), 'user-3', ME, now, names)).toBe('Checked 5 min ago by Sam R.');
    expect(checkedLine(now, 'user-2', null, now, names)).toBe('Checked just now by Alex');
  });

  it("says someone for a member whose name isn't on the device (removed, deleted, not loaded)", () => {
    const names = new Map([['user-2', 'Alex']]);
    expect(checkedLine(new Date(2026, 9, 6, 9), 'user-gone', ME, now, names)).toBe('Checked Tuesday by someone');
    expect(checkedLine(now, 'user-2', ME, now)).toBe('Checked just now by someone');
  });

  it('says "by you" for your own check even when your name is cached', () => {
    expect(checkedLine(now, ME, ME, now, new Map([[ME, 'Jo']]))).toBe('Checked just now by you');
  });

  it('leaves the "by" off when no one is recorded', () => {
    expect(checkedLine(new Date(2026, 1, 3), null, ME, now)).toBe('Checked Feb 3');
  });
});

describe('addedBySummary (spec 4.4)', () => {
  // Friday 9 October 2026, 15:30 local time; Tuesday is the 6th.
  const now = new Date(2026, 9, 9, 15, 30);
  const tuesday = new Date(2026, 9, 6, 10, 0);
  const at = (day: number, hour = 10) => new Date(2026, 9, day, hour);
  const names = new Map([
    [ME, 'Jo'],
    ['alex', 'Alex'],
    ['sam', 'Sam'],
    ['kim', 'Kim'],
  ]);
  const add = (addedBy: string | null, createdAt: Date, extra: { source?: string; deletedAt?: Date | null } = {}) => ({
    source: extra.source ?? 'manual',
    addedBy,
    createdAt,
    deletedAt: extra.deletedAt ?? null,
  });
  const plain = (s: ReturnType<typeof addedBySummary>) => s!.text.map((p) => p.text).join('');
  const bold = (s: ReturnType<typeof addedBySummary>) => s!.text.filter((p) => p.bold).map((p) => p.text);

  it('names one other member in bold, with when they first added it', () => {
    const s = addedBySummary([add('alex', tuesday), add('alex', at(8))], ME, names, now);
    expect(s!.text).toEqual([
      { text: 'Added by ', bold: false },
      { text: 'Alex', bold: true },
      { text: ' · Tuesday', bold: false },
    ]);
    expect(s!.people).toEqual([{ userId: 'alex', initial: 'A' }]);
    expect(s!.label).toBe('Added by Alex, Tuesday');
  });

  it('uses the earliest live add for the time, whatever order they come in', () => {
    const s = addedBySummary([add('alex', at(8)), add('alex', tuesday)], ME, names, now);
    expect(plain(s)).toBe('Added by Alex · Tuesday');
  });

  it('is "Added by you" for your own adds, not in bold', () => {
    const s = addedBySummary([add(ME, at(9, 9))], ME, names, now);
    expect(plain(s)).toBe('Added by you · today');
    expect(bold(s)).toEqual([]);
    expect(s!.people).toEqual([{ userId: ME, initial: 'J' }]);
    expect(s!.label).toBe('Added by you, today');
  });

  it('names two people with you last and no time', () => {
    const s = addedBySummary([add(ME, at(5)), add('alex', at(7))], ME, names, now);
    expect(plain(s)).toBe('Added by Alex and you');
    expect(bold(s)).toEqual(['Alex']);
    expect(s!.people.map((p) => p.userId)).toEqual(['alex', ME]);
    expect(s!.label).toBe('Added by Alex and you');
  });

  it('names two other members in the order they first added it', () => {
    const s = addedBySummary([add('sam', at(7)), add('alex', at(5)), add('sam', at(4))], ME, names, now);
    expect(plain(s)).toBe('Added by Sam and Alex');
    expect(bold(s)).toEqual(['Sam', 'Alex']);
    expect(s!.people.map((p) => p.initial)).toEqual(['S', 'A']);
  });

  it('names the first two of three or more and counts the rest, with up to three avatars', () => {
    const four = addedBySummary(
      [add(ME, at(1)), add('alex', at(2)), add('sam', at(3)), add('kim', at(4))],
      ME,
      names,
      now,
    );
    expect(plain(four)).toBe('Added by Alex, Sam and 2 others');
    expect(bold(four)).toEqual(['Alex', 'Sam']);
    expect(four!.people.map((p) => p.userId)).toEqual(['alex', 'sam', 'kim']);
    expect(four!.label).toBe('Added by Alex, Sam and 2 others');

    const three = addedBySummary([add('alex', at(2)), add(ME, at(1)), add('sam', at(3))], ME, names, now);
    expect(plain(three)).toBe('Added by Alex, Sam and 1 other');
    expect(three!.people.map((p) => p.userId)).toEqual(['alex', 'sam', ME]);
  });

  it('calls a member whose name is not on the device "someone", with a "?" avatar', () => {
    const one = addedBySummary([add('gone', tuesday)], ME, names, now);
    expect(plain(one)).toBe('Added by someone · Tuesday');
    expect(bold(one)).toEqual([]);
    expect(one!.people).toEqual([{ userId: 'gone', initial: '?' }]);
    expect(one!.label).toBe('Added by someone, Tuesday');

    const two = addedBySummary([add('gone', at(1)), add(ME, at(2))], ME, names, now);
    expect(plain(two)).toBe('Added by someone and you');
  });

  it('counts a Siri add as the person who asked, so yours is you', () => {
    const s = addedBySummary([add(ME, tuesday, { source: 'siri' })], ME, names, now);
    expect(plain(s)).toBe('Added by you · Tuesday');
    const theirs = addedBySummary([add('alex', tuesday, { source: 'siri' }), add(ME, at(8))], ME, names, now);
    expect(plain(theirs)).toBe('Added by Alex and you');
  });

  it('counts a recipe add as whoever added the recipe to the list', () => {
    const s = addedBySummary([add('sam', tuesday, { source: 'recipe' })], ME, names, now);
    expect(plain(s)).toBe('Added by Sam · Tuesday');
    expect(s!.people).toEqual([{ userId: 'sam', initial: 'S' }]);
  });

  it('skips a deleted add, even when it was the earliest', () => {
    const s = addedBySummary(
      [add('alex', at(1), { deletedAt: at(2) }), add('sam', at(3)), add('sam', at(1), { deletedAt: at(2) })],
      ME,
      names,
      now,
    );
    // Sam's live add is on Saturday the 3rd, within the week.
    expect(plain(s)).toBe('Added by Sam · Saturday');
    expect(s!.people.map((p) => p.userId)).toEqual(['sam']);
  });

  it('skips adds with no one recorded, and is null when none are left', () => {
    expect(plain(addedBySummary([add(null, at(1)), add('alex', tuesday)], ME, names, now))).toBe('Added by Alex · Tuesday');
    expect(addedBySummary([add(null, at(1))], ME, names, now)).toBeNull();
    expect(addedBySummary([add('alex', at(1), { deletedAt: at(2) })], ME, names, now)).toBeNull();
    expect(addedBySummary([], ME, names, now)).toBeNull();
  });

  it('has no "you" when signed out', () => {
    expect(plain(addedBySummary([add(ME, tuesday)], null, names, now))).toBe('Added by Jo · Tuesday');
  });

  it('a name that is also in the sentence is still the only bold run', () => {
    const s = addedBySummary([add('odd', tuesday)], ME, new Map([['odd', 'Added']]), now);
    expect(s!.text).toEqual([
      { text: 'Added by ', bold: false },
      { text: 'Added', bold: true },
      { text: ' · Tuesday', bold: false },
    ]);
  });

  describe('in Spanish', () => {
    beforeAll(() => void i18n.changeLanguage('es'));
    afterAll(() => void i18n.changeLanguage('en'));

    it('uses "por ti" for you and Spanish plurals for the rest', () => {
      expect(plain(addedBySummary([add(ME, at(9, 9))], ME, names, now))).toBe('Agregado por ti · hoy');
      expect(plain(addedBySummary([add(ME, at(1)), add('alex', at(2))], ME, names, now))).toBe(
        'Agregado por Alex y por ti',
      );
      expect(plain(addedBySummary([add('alex', at(1)), add('sam', at(2))], ME, names, now))).toBe(
        'Agregado por Alex y Sam',
      );
      expect(plain(addedBySummary([add('alex', at(1)), add('sam', at(2)), add(ME, at(3))], ME, names, now))).toBe(
        'Agregado por Alex, Sam y 1 persona más',
      );
      expect(
        plain(addedBySummary([add('alex', at(1)), add('sam', at(2)), add('kim', at(3)), add(ME, at(4))], ME, names, now)),
      ).toBe('Agregado por Alex, Sam y 2 personas más');
      expect(addedBySummary([add('gone', tuesday)], ME, names, now)!.label).toBe('Agregado por alguien, martes');
    });
  });
});
