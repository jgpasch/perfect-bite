// The "since you looked" card and NEW rows (spec 4.1): what the card and rows say.
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { initI18n } from '@/i18n';

import type { MemberNews, NewsItem } from '../last-seen';
import {
  newRowLabel,
  newRowLine,
  newsCardLabel,
  newsItemsLine,
  newsNames,
  newsSinceLine,
  newsTitle,
  rowNews,
  summarizeNews,
} from '../list-news';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'me' }) }));

// Local times, so "yesterday" and "6:40 PM" don't depend on the machine's time zone.
const NOW = new Date(2026, 9, 16, 9, 0);
const SINCE = new Date(2026, 9, 15, 18, 40);
// Intl puts a narrow no-break space before AM/PM.
const plain = (s: string) => s.replace(/ /g, ' ');

const items = (...names: string[]): NewsItem[] =>
  names.map((displayName, i) => ({ itemId: `i${i}`, displayName, addedAt: new Date(NOW.getTime() - (i + 1) * 60_000) }));

afterEach(() => initI18n('en'));

describe('the title', () => {
  test('one member', () => {
    expect(newsTitle(['Alex'], 4)).toBe('Alex added 4 items');
    expect(newsTitle(['Alex'], 1)).toBe('Alex added 1 item');
  });

  test('two members', () => {
    expect(newsTitle(['Alex', 'Sam'], 7)).toBe('Alex and Sam added 7 items');
  });

  test('three or more: two names and the rest counted', () => {
    expect(newsTitle(['Alex', 'Sam', 'Jo', 'Kim'], 12)).toBe('Alex, Sam and 2 others added 12 items');
    expect(newsTitle(['Alex', 'Sam', 'Jo'], 3)).toBe('Alex, Sam and 1 other added 3 items');
  });

  test('in Spanish', () => {
    initI18n('es');
    expect(newsTitle(['Alex'], 1)).toBe('Alex agregó 1 artículo');
    expect(newsTitle(['Alex', 'Sam'], 7)).toBe('Alex y Sam agregaron 7 artículos');
    expect(newsTitle(['Alex', 'Sam', 'Jo', 'Kim'], 12)).toBe('Alex, Sam y 2 más agregaron 12 artículos');
  });
});

describe('the names line', () => {
  test('up to three names in sentence case', () => {
    expect(newsItemsLine(items('eggs'))).toBe('Eggs');
    expect(newsItemsLine(items('eggs', 'limes'))).toBe('Eggs and limes');
    expect(newsItemsLine(items('eggs', 'limes', 'corn tortillas'))).toBe('Eggs, limes and corn tortillas');
  });

  test('then "and N more"', () => {
    expect(newsItemsLine(items('eggs', 'limes', 'corn tortillas', 'milk'))).toBe('Eggs, limes, corn tortillas and 1 more');
    expect(newsItemsLine(items('eggs', 'limes', 'corn tortillas', 'milk', 'bread'))).toBe(
      'Eggs, limes, corn tortillas and 2 more',
    );
  });

  test('a first name with a capital in it is left alone', () => {
    expect(newsItemsLine(items('iPhone charger', 'limes'))).toBe('iPhone charger and limes');
  });
});

describe('since you looked', () => {
  test('when as the Added rows read it, with the time', () => {
    expect(plain(newsSinceLine(SINCE, NOW))).toBe('Since you looked, yesterday at 6:40 PM');
    expect(plain(newsSinceLine(new Date(2026, 9, 16, 7, 5), NOW))).toBe('Since you looked, today at 7:05 AM');
    expect(plain(newsSinceLine(new Date(2026, 9, 13, 8, 0), NOW))).toBe('Since you looked, Tuesday at 8:00 AM');
    expect(plain(newsSinceLine(new Date(2026, 8, 4, 8, 0), NOW))).toBe('Since you looked, Sep 4 at 8:00 AM');
  });

  test('under an hour ago, the minutes alone', () => {
    expect(newsSinceLine(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('Since you looked, 5 min ago');
  });

  test('in Spanish', () => {
    initI18n('es');
    expect(plain(newsSinceLine(SINCE, NOW))).toBe('Desde que lo viste, ayer a las 18:40');
  });
});

describe('summarizeNews', () => {
  const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
  const news: MemberNews[] = [
    {
      userId: 'alex',
      items: [
        { itemId: 'eggs', displayName: 'eggs', addedAt: at(1) },
        { itemId: 'limes', displayName: 'limes', addedAt: at(30) },
      ],
    },
    { userId: 'sam', items: [{ itemId: 'limes', displayName: 'limes', addedAt: at(10) }] },
  ];

  test('an item two members added to counts once, under whoever added to it last', () => {
    const s = summarizeNews(SINCE, NOW, news)!;
    expect(s.members).toEqual(['alex', 'sam']);
    expect(s.items.map((i) => i.itemId)).toEqual(['eggs', 'limes']);
    expect(s.byItem.get('limes')).toEqual({ userId: 'sam', addedAt: at(10) });
    expect(s.byItem.get('eggs')).toEqual({ userId: 'alex', addedAt: at(1) });
    expect(s.since).toBe(SINCE);
    expect(s.at).toBe(NOW);
  });

  test('nothing new is no news at all', () => {
    expect(summarizeNews(SINCE, NOW, [])).toBeNull();
    expect(summarizeNews(SINCE, NOW, [{ userId: 'alex', items: [] }])).toBeNull();
  });

  test("members' names: short names, or Someone for one not on the device", () => {
    const s = summarizeNews(SINCE, NOW, news)!;
    expect(newsNames(s, new Map([['alex', 'Alex']]), 'me')).toEqual(['Alex', 'Someone']);
  });

  test('a row in the news gets its line and VoiceOver part; others get nothing', () => {
    const s = summarizeNews(SINCE, NOW, news)!;
    const names = new Map([
      ['alex', 'Alex'],
      ['sam', 'Sam'],
    ]);
    expect(rowNews(s, 'limes', names, 'me')).toEqual({ line: 'Sam · 10 min ago', label: 'new, added by Sam' });
    expect(rowNews(s, 'bread', names, 'me')).toBeUndefined();
    expect(rowNews(null, 'limes', names, 'me')).toBeUndefined();
  });
});

describe('VoiceOver', () => {
  test('the card is one sentence', () => {
    const s = summarizeNews(SINCE, NOW, [
      { userId: 'alex', items: items('eggs', 'limes', 'corn tortillas', 'milk') },
    ])!;
    expect(plain(newsCardLabel(s, ['Alex'], NOW))).toBe(
      'Alex added 4 items since yesterday, 6:40 PM: eggs, limes, corn tortillas and 1 more',
    );
  });

  test('under an hour, the minutes alone', () => {
    const s = summarizeNews(new Date(NOW.getTime() - 5 * 60_000), NOW, [{ userId: 'alex', items: items('eggs') }])!;
    expect(newsCardLabel(s, ['Alex'], NOW)).toBe('Alex added 1 item since 5 min ago: eggs');
  });

  test('a new row', () => {
    expect(newRowLabel('Alex')).toBe('new, added by Alex');
    expect(newRowLine('Alex', SINCE, NOW)).toBe('Alex · yesterday');
    initI18n('es');
    expect(newRowLabel('Alex')).toBe('nuevo, lo agregó Alex');
    expect(newRowLine('Alex', SINCE, NOW)).toBe('Alex · ayer');
  });
});
