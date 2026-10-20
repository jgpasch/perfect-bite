// The Plan tab's week screen (spec 4.16): the toolbar, the grid and the agenda, rendered against the
// in-memory database on Thursday, October 15, 2026 (the week of Sunday, October 11).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { AisleColors, Palette, Rounded, Spacing, Typography } from '@/constants/theme';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe } from '@/features/recipes/recipes';
import {
  getDeviceSetting,
  PLAN_HOUSEHOLD_KEY,
  PLAN_VIEW_KEY,
  setDeviceSetting,
} from '@/features/settings/device-settings';
import { i18n } from '@/i18n';
import { resetDb } from '@/test/db';

import PlanScreen from '@/app/(tabs)/plan/index';

import { setPlanCellStyle } from '../cell-style';
import { resetEarlierDays } from '../earlier-fold-store';
import { groupWeek, weekEntriesQuery } from '../queries';
import { weekDays } from '../week';
import { WeekGrid } from '../week-grid';
import { WeekPlan } from '../week-plan';
import { addRecipeToSlot, setSlot } from '../write';

const mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Host: host('SwiftHost'),
    Menu: ({ label, children, ...props }: { label?: unknown; children?: unknown }) => createElement('SwiftMenu', props, label, children),
    RNHostView: host('RNHostView'),
    Section: host('SwiftSection'),
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
}));
// Reduce Motion, as a test sets it; a layout transition as what it was built with.
const mockMotion = { reduced: false };
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    LinearTransition: { duration: (ms: number) => ({ transition: 'linear', ms }) },
    useReducedMotion: () => mockMotion.reduced,
  };
});
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('expo-router', () => ({ usePathname: () => '/plan', router: { navigate: () => {} } }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
let tree: ReactTestRenderer | null = null;

function render(): ReactTestRenderer {
  act(() => {
    tree = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <PlanScreen />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

function remount(): ReactTestRenderer {
  act(() => tree?.unmount());
  return render();
}

/** A style (or a Pressable's style function, not pressed) as one object. */
const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[typeof style === 'function' ? style({ pressed: false }) : style].flat(Infinity).filter(Boolean));
const byTestID = (root: ReactTestRenderer, id: string) =>
  root.root.findAll((n) => n.type === ('View' as never) && n.props.testID === id);
const one = (root: ReactTestRenderer, id: string) => {
  const found = byTestID(root, id);
  expect(found).toHaveLength(1);
  return found[0];
};
const texts = (node: ReactTestInstance) =>
  node.findAll((n) => n.type === ('Text' as never)).map((n) => [n.props.children].flat().join(''));
/** The Pressable (not its host view) with this VoiceOver label. */
const button = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
const press = (root: ReactTestRenderer, label: string) => act(() => button(root, label).props.onPress());
const unfold = (root: ReactTestRenderer) =>
  act(() =>
    root.root
      .find((n) => n.props.testID === 'earlier-row' && typeof n.props.onPress === 'function' && typeof n.type !== 'string')
      .props.onPress(),
  );
const slot = (root: ReactTestRenderer, day: string, meal: string) => one(root, `slot-${day}-${meal}`);
const label = (root: ReactTestRenderer, day: string, meal: string) => slot(root, day, meal).props.accessibilityLabel;
const icons = (node: ReactTestInstance) => node.findAll((n) => n.type === ('Icon' as never));
const weekLabel = (root: ReactTestRenderer) =>
  one(root, 'week-toolbar').find((n) => n.type === ('Text' as never) && typeof n.props.accessibilityLabel === 'string');
const agendaDays = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => n.type === ('View' as never) && /^agenda-day-/.test(n.props.testID ?? ''))
    .map((n) => (n.props.testID as string).slice('agenda-day-'.length));

let home: string;
let tacos: string;
let soup: string;

function setNow(date: Date) {
  jest.setSystemTime(date);
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 9, 15, 12, 0) });
  resetDb();
  ensureStarterData('user-1');
  resetEarlierDays();
  mockWindow.fontScale = 1;
  mockMotion.reduced = false;
  home =getList(getDefaultListId('user-1')!)!.householdId;
  tacos = createRecipe('Chicken tacos', home);
  soup = createRecipe('Soup', home);
  db.update(recipes).set({ totalMinutes: 35 }).where(eq(recipes.id, tacos)).run();
  setSlot(home, '2026-10-15', 'dinner', { kind: 'recipe', recipeId: tacos });
  setSlot(home, '2026-10-15', 'lunch', { kind: 'leftovers' });
  setSlot(home, '2026-10-16', 'breakfast', { kind: 'note', note: 'Pancakes at Gran’s' });
  setSlot(home, '2026-10-17', 'dinner', { kind: 'eating-out' });
  setSlot(home, '2026-10-12', 'dinner', { kind: 'recipe', recipeId: soup });
  setSlot(home, '2026-10-19', 'dinner', { kind: 'recipe', recipeId: soup }); // next week
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.useRealTimers();
});

describe('the Plan tab', () => {
  test('"This week" as the large title, the toolbar on the green, the grid by default', () => {
    const root = render();
    expect(texts(root.root)).toContain('This week');
    expect(weekLabel(root).props.children).toBe('Oct 11 – 17');
    expect(weekLabel(root).props.accessibilityLabel).toBe('Week of October 11');
    expect(byTestID(root, 'week-grid')).toHaveLength(1);
    expect(byTestID(root, 'week-agenda')).toHaveLength(0);
    // On the green: the arrows in onHeader.
    expect(icons(button(root, 'Previous week'))[0].props).toMatchObject({ name: 'chevron.left', tint: Palette.light.onHeader });
    // The cart (Shop this week, covered in shop.test.tsx).
    const cart = root.root.find((n) => n.type === ('View' as never) && n.props.accessibilityLabel === 'Shop this week');
    expect(cart.props.accessibilityRole).toBe('button');
    expect(icons(cart)[0].props.name).toBe('cart');
  });
});

describe('WeekPlan without a header', () => {
  test('puts the toolbar on the sheet, in ink', () => {
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <WeekPlan onToast={() => {}} />
        </SafeAreaProvider>,
      );
    });
    const root = tree!;
    expect(texts(root.root)).not.toContain('This week');
    expect(icons(button(root, 'Next week'))[0].props).toMatchObject({ name: 'chevron.right', tint: Palette.light.ink });
    expect(flat(one(root, 'plan-view-toggle').props.style).backgroundColor).toBe(Palette.light.surfaceMuted);
    expect(byTestID(root, 'week-grid')).toHaveLength(1);
  });
});

describe('the grid', () => {
  test("shows the week's recipes, notes and empty slots with their VoiceOver labels", () => {
    const root = render();
    expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Chicken tacos');
    // Today is open, so its dinner is a row of the open card; Monday's is a cell.
    expect(texts(slot(root, '2026-10-15', 'dinner'))).toEqual(['Dinner', 'Chicken tacos', '35 min']);
    expect(texts(slot(root, '2026-10-12', 'dinner'))).toEqual(['Soup']);
    expect(label(root, '2026-10-15', 'lunch')).toBe('Thursday lunch, Leftovers');
    expect(label(root, '2026-10-16', 'breakfast')).toBe('Friday breakfast, Pancakes at Gran’s');
    expect(label(root, '2026-10-17', 'dinner')).toBe('Saturday dinner, Eating out');
    expect(label(root, '2026-10-16', 'lunch')).toBe('Friday lunch, empty');
    // Next week's entry isn't in this week.
    expect(byTestID(root, 'slot-2026-10-19-dinner')).toHaveLength(0);
    // Seven days, three meals each.
    expect(root.root.findAll((n) => n.type === ('View' as never) && /^slot-/.test(n.props.testID ?? ''))).toHaveLength(21);
  });

  test('a note is italic inkSecondary on surfaceMuted; an empty slot from today on is a dashed outline with a +', () => {
    const root = render();
    const note = slot(root, '2026-10-16', 'breakfast');
    expect(flat(note.props.style).backgroundColor).toBe(Palette.light.surfaceMuted);
    const noteText = note.find((n) => n.type === ('Text' as never));
    expect(flat(noteText.props.style)).toMatchObject({ fontStyle: 'italic', color: Palette.light.inkSecondary });

    const empty = slot(root, '2026-10-16', 'lunch');
    expect(flat(empty.props.style)).toMatchObject({ borderStyle: 'dashed', borderColor: Palette.light.controlBorder });
    expect(icons(empty).map((i) => i.props.name)).toEqual(['plus']);
    // Today's empty breakfast too.
    expect(icons(slot(root, '2026-10-15', 'breakfast')).map((i) => i.props.name)).toEqual(['plus']);
  });

  test('past days: names in inkSecondary, empty slots plain with no +', () => {
    setSlot(home, '2026-10-16', 'dinner', { kind: 'recipe', recipeId: tacos });
    const root = render();
    const pastRecipe = slot(root, '2026-10-12', 'dinner').find((n) => n.type === ('Text' as never));
    expect(flat(pastRecipe.props.style).color).toBe(Palette.light.inkSecondary);
    const laterRecipe = slot(root, '2026-10-16', 'dinner').find((n) => n.type === ('Text' as never));
    expect(flat(laterRecipe.props.style).color).toBe(Palette.light.ink);

    const pastEmpty = slot(root, '2026-10-14', 'lunch');
    expect(icons(pastEmpty)).toHaveLength(0);
    expect(flat(pastEmpty.props.style).borderStyle).toBeUndefined();
    expect(pastEmpty.props.accessibilityLabel).toBe('Wednesday lunch, empty');
  });

  test("today's day label is a primary pill", () => {
    const root = render();
    const pill = one(root, 'today-pill');
    expect(flat(pill.props.style).backgroundColor).toBe(Palette.light.primary);
    expect(texts(pill)).toEqual(['Thu', '15']);
    expect(one(root, 'grid-day-2026-10-15').findAll((n) => n.type === ('View' as never) && n.props.testID === 'today-pill')).toHaveLength(1);
  });

  test('meal headers in their hues: Breakfast amber, Lunch teal, Dinner plum', () => {
    const root = render();
    const headers = root.root.findAll((n) => n.type === ('View' as never) && n.props.accessibilityRole === 'header');
    expect(headers.map((h) => texts(h)[0])).toEqual(['Breakfast', 'Lunch', 'Dinner']);
    expect(headers.map((h) => flat(h.props.style).backgroundColor)).toEqual(['#F6EBD4', '#DCEFEC', '#ECE3F5']);
  });

  test('scrolls sideways at large text sizes, not at the default', () => {
    expect(byTestID(render(), 'week-grid-scroll')).toHaveLength(0);
    mockWindow.fontScale = 2;
    const root = remount();
    const scroll = root.root.find((n) => n.props.testID === 'week-grid-scroll' && n.props.horizontal === true);
    expect(scroll).toBeDefined();
    expect(byTestID(root, 'week-grid')).toHaveLength(1);
  });
});

describe("the grid's cells and open day", () => {
  const dayButton = (root: ReactTestRenderer, day: string) =>
    root.root.find((n) => n.props.testID === `day-label-${day}` && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
  const toggle = (root: ReactTestRenderer, day: string) => act(() => dayButton(root, day).props.onPress());
  const openDays = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => n.type === ('View' as never) && /^open-day-/.test(n.props.testID ?? ''))
      .map((n) => (n.props.testID as string).slice('open-day-'.length));
  const photoBox = (node: ReactTestInstance) => node.find((n) => n.type === ('View' as never) && n.props.testID === 'plan-photo');
  const photos = (node: ReactTestInstance) => node.findAll((n) => n.type === ('ExpoImage' as never));
  const tileColour = (recipeId: string) => AisleColors.light[recipeHue(recipeId)].soft;

  test('a saved plan.gridStyle from the old design trial is never read: the photo strip cells, and days open', () => {
    for (const saved of ['compact', 'photo', 'expand']) {
      setDeviceSetting('plan.gridStyle', saved);
      const root = remount();
      const cell = slot(root, '2026-10-12', 'dinner');
      expect(flat(cell.props.style).minHeight).toBe(104);
      expect(cell.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-photo')).toHaveLength(1);
      expect(byTestID(root, 'photo-band')).toHaveLength(0);
      expect(openDays(root)).toEqual(['2026-10-15']);
      toggle(root, '2026-10-15');
      expect(openDays(root)).toEqual([]);
      toggle(root, '2026-10-16');
      expect(openDays(root)).toEqual(['2026-10-16']);
    }
  });

  test("the household's own photo wins over the site's in the strip, loaded from Storage by its path", () => {
    db.update(recipes)
      .set({ imageUrl: 'https://example.com/soup.jpg', photoPath: `${home}/soup.jpg` })
      .where(eq(recipes.id, soup))
      .run();
    const root = render();
    const [image] = photos(photoBox(slot(root, '2026-10-12', 'dinner')));
    expect(image.props.source).toMatchObject({
      uri: expect.stringContaining(`/storage/v1/object/authenticated/recipe-photos/${home}/soup.jpg`),
      cacheKey: `${home}/soup.jpg`,
    });
  });

  test('a strip photo that fails to load leaves the tile colour and the name', () => {
    db.update(recipes).set({ imageUrl: 'https://example.com/gone.jpg' }).where(eq(recipes.id, soup)).run();
    const root = render();
    act(() => photos(slot(root, '2026-10-12', 'dinner'))[0].props.onError({ error: 'HTTP 404' }));
    const cell = slot(root, '2026-10-12', 'dinner');
    expect(photos(cell)).toHaveLength(0);
    expect(flat(photoBox(cell).props.style).backgroundColor).toBe(tileColour(soup));
    expect(texts(cell)).toEqual(['Soup']);
  });

  test("past days' filled cells rest at full opacity; only their names are greyed", () => {
    setSlot(home, '2026-10-13', 'lunch', { kind: 'leftovers' });
    const root = render();
    expect(flat(slot(root, '2026-10-12', 'dinner').props.style).opacity).toBe(1);
    expect(flat(slot(root, '2026-10-13', 'lunch').props.style).opacity).toBe(1);
  });

  test("a recipe's photo as a 4:3 strip across the top of a 104 pt cell, the name in caption under it", () => {
    db.update(recipes).set({ imageUrl: 'https://example.com/soup.jpg' }).where(eq(recipes.id, soup)).run();
    const root = render();
    const cell = slot(root, '2026-10-12', 'dinner');
    expect(flat(cell.props.style)).toMatchObject({ minHeight: 104, padding: 4, gap: 4, backgroundColor: Palette.light.surface });
    const strip = photoBox(cell);
    expect(flat(strip.props.style)).toMatchObject({
      width: '100%',
      aspectRatio: 4 / 3,
      borderRadius: Rounded.sm,
      overflow: 'hidden',
      backgroundColor: tileColour(soup),
    });
    const [image] = strip.findAll((n) => n.type === ('ExpoImage' as never));
    expect(image.props).toMatchObject({ source: 'https://example.com/soup.jpg', contentFit: 'cover' });
    const name = cell.find((n) => n.type === ('Text' as never));
    expect(name.props.children).toBe('Soup');
    expect(name.props.numberOfLines).toBe(2);
    expect(flat(name.props.style)).toMatchObject({ fontSize: Typography.caption.fontSize, color: Palette.light.inkSecondary }); // a past day
    // Notes and empty cells at the same height.
    expect(flat(slot(root, '2026-10-16', 'breakfast').props.style)).toMatchObject({ minHeight: 104, backgroundColor: Palette.light.surfaceMuted });
    expect(flat(slot(root, '2026-10-16', 'lunch').props.style)).toMatchObject({ minHeight: 104, borderStyle: 'dashed' });
    expect(icons(slot(root, '2026-10-16', 'lunch')).map((i) => i.props.name)).toEqual(['plus']);
  });

  test("a strip without a photo shows the recipe's tile colour", () => {
    setSlot(home, '2026-10-16', 'dinner', { kind: 'recipe', recipeId: tacos });
    const root = render();
    const strip = photoBox(slot(root, '2026-10-16', 'dinner'));
    expect(flat(strip.props.style).backgroundColor).toBe(tileColour(tacos));
    expect(strip.findAll((n) => n.type === ('ExpoImage' as never))).toHaveLength(0);
  });

  test('today is open when the week first shows; the other days are closed', () => {
    const root = render();
    expect(openDays(root)).toEqual(['2026-10-15']);
    // Thursday's slots are rows of its card; the other days keep their cells.
    const card = one(root, 'open-day-2026-10-15');
    expect(card.findAll((n) => n.type === ('View' as never) && /^slot-/.test(n.props.testID ?? '')).map((n) => n.props.testID)).toEqual([
      'slot-2026-10-15-breakfast',
      'slot-2026-10-15-lunch',
      'slot-2026-10-15-dinner',
    ]);
    expect(root.root.findAll((n) => n.type === ('View' as never) && /^slot-/.test(n.props.testID ?? ''))).toHaveLength(21);
    expect(flat(card.props.style)).toMatchObject({ backgroundColor: Palette.light.surface, borderRadius: Rounded.md, flex: 1 });
  });

  test('the day label is a button: "Thursday 15, expanded" or "Friday 16, collapsed", with the expanded state', () => {
    const root = render();
    expect(dayButton(root, '2026-10-15').props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Thursday 15, expanded',
      accessibilityState: { expanded: true },
    });
    expect(dayButton(root, '2026-10-16').props).toMatchObject({
      accessibilityLabel: 'Friday 16, collapsed',
      accessibilityState: { expanded: false },
    });
    expect(flat(dayButton(root, '2026-10-16').props.style({ pressed: false })).minHeight).toBe(44);
    // Today's pill stays primary while open.
    expect(flat(one(root, 'today-pill').props.style).backgroundColor).toBe(Palette.light.primary);
  });

  test('opening another day closes the first; tapping its label again closes it', () => {
    const root = render();
    toggle(root, '2026-10-16');
    expect(openDays(root)).toEqual(['2026-10-16']);
    expect(dayButton(root, '2026-10-15').props.accessibilityLabel).toBe('Thursday 15, collapsed');
    expect(dayButton(root, '2026-10-16').props.accessibilityState).toEqual({ expanded: true });
    // Thursday is back to its cells.
    expect(flat(slot(root, '2026-10-15', 'dinner').props.style).minHeight).toBe(104);
    // An open day other than today sits in a surface pill.
    const fridayPill = dayButton(root, '2026-10-16').findAll((n) => n.type === ('View' as never))[1];
    expect(flat(fridayPill.props.style).backgroundColor).toBe(Palette.light.surface);

    toggle(root, '2026-10-16');
    expect(openDays(root)).toEqual([]);
    expect(dayButton(root, '2026-10-16').props.accessibilityLabel).toBe('Friday 16, collapsed');
  });

  test('the choice is kept while the screen stays mounted: across weeks and views', () => {
    const root = render();
    toggle(root, '2026-10-13');
    // Next week doesn't hold the open day, so every day is closed.
    press(root, 'Next week');
    expect(openDays(root)).toEqual([]);
    press(root, 'This week');
    expect(openDays(root)).toEqual(['2026-10-13']);
    // Through the agenda and back.
    const segments = one(root, 'plan-view-toggle').findAll(
      (n) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function' && typeof n.type !== 'string',
    );
    act(() => segments[0].props.onPress());
    act(() => segments[1].props.onPress());
    expect(openDays(root)).toEqual(['2026-10-13']);
  });

  test("no day is open in a week that doesn't hold today", () => {
    setNow(new Date(2026, 9, 18, 9, 0)); // the next Sunday
    const root = render();
    press(root, 'Previous week');
    expect(openDays(root)).toEqual([]);
    press(root, 'Next week');
    expect(openDays(root)).toEqual(['2026-10-18']);
  });

  test("the open card's rows: a recipe with its photo, meal, name and time; a note and \"Note\"; an empty slot", () => {
    db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
    const root = render();
    const dinner = slot(root, '2026-10-15', 'dinner');
    expect(texts(dinner)).toEqual(['Dinner', 'Chicken tacos', '35 min']);
    // The meal's name over a row per recipe.
    expect(flat(dinner.props.style)).toMatchObject({ minHeight: 64, borderTopWidth: expect.any(Number) });
    expect(flat(dinner.props.style).flexDirection).toBeUndefined();
    expect(byTestID(root, 'open-row-recipe').map((n) => flat(n.props.style).flexDirection)).toEqual(['row']);
    const [meal, name, time] = dinner.findAll((n) => n.type === ('Text' as never));
    expect(flat(meal.props.style)).toMatchObject({ color: AisleColors.light.plum.strong, fontSize: Typography.caption.fontSize });
    expect(flat(name.props.style)).toMatchObject({ fontSize: Typography.headline.fontSize, color: Palette.light.ink });
    expect(name.props.numberOfLines).toBe(2);
    expect(flat(time.props.style)).toMatchObject({ fontSize: Typography.footnote.fontSize, color: Palette.light.inkSecondary });
    const photo = photoBox(dinner);
    expect(flat(photo.props.style)).toMatchObject({ width: 76, aspectRatio: 4 / 3, borderRadius: Rounded.sm, backgroundColor: tileColour(tacos) });
    expect(photo.findAll((n) => n.type === ('ExpoImage' as never)).map((i) => i.props.source)).toEqual(['https://example.com/tacos.jpg']);
    expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Chicken tacos');

    const lunch = slot(root, '2026-10-15', 'lunch');
    expect(texts(lunch)).toEqual(['Lunch', 'Leftovers', 'Note']);
    expect(flat(lunch.findAll((n) => n.type === ('Text' as never))[0].props.style).color).toBe(AisleColors.light.teal.strong);
    expect(lunch.findAll((n) => n.props.testID === 'plan-photo')).toHaveLength(0);
    expect(label(root, '2026-10-15', 'lunch')).toBe('Thursday lunch, Leftovers');

    const breakfast = slot(root, '2026-10-15', 'breakfast');
    expect(texts(breakfast)).toEqual(['Breakfast', 'Nothing planned']);
    expect(flat(breakfast.props.style).borderTopWidth).toBe(0); // the first row has no rule above it
    const box = one(root, 'open-row-empty-box');
    expect(flat(box.props.style)).toMatchObject({ width: 76, aspectRatio: 4 / 3, borderStyle: 'dashed', borderColor: Palette.light.controlBorder });
    expect(icons(box).map((i) => i.props.name)).toEqual(['plus']);
    expect(label(root, '2026-10-15', 'breakfast')).toBe('Thursday breakfast, empty');
  });

  test('a recipe over an hour reads "1 hr 30 min"; one without a time has no time line', () => {
    db.update(recipes).set({ totalMinutes: 90 }).where(eq(recipes.id, tacos)).run();
    setSlot(home, '2026-10-15', 'breakfast', { kind: 'recipe', recipeId: soup });
    const root = render();
    expect(texts(slot(root, '2026-10-15', 'dinner'))).toEqual(['Dinner', 'Chicken tacos', '1 hr 30 min']);
    expect(texts(slot(root, '2026-10-15', 'breakfast'))).toEqual(['Breakfast', 'Soup']);
  });

  test("a past open day: names in inkSecondary, its empty rows with no outline or +", () => {
    const root = render();
    toggle(root, '2026-10-12');
    const soupName = slot(root, '2026-10-12', 'dinner').findAll((n) => n.type === ('Text' as never))[1];
    expect(soupName.props.children).toBe('Soup');
    expect(flat(soupName.props.style).color).toBe(Palette.light.inkSecondary);
    const boxes = byTestID(root, 'open-row-empty-box');
    expect(boxes).toHaveLength(2); // breakfast and lunch
    boxes.forEach((box) => {
      expect(flat(box.props.style).borderStyle).toBeUndefined();
      expect(icons(box)).toHaveLength(0);
    });
  });

  test('opening and closing animate the height over motion.duration; under Reduce Motion they switch at once', () => {
    let root = render();
    expect(one(root, 'grid-day-2026-10-15').props.layout).toEqual({ transition: 'linear', ms: 250 });
    mockMotion.reduced = true;
    root = remount();
    expect(one(root, 'grid-day-2026-10-15').props.layout).toBeUndefined();
    toggle(root, '2026-10-16');
    expect(openDays(root)).toEqual(['2026-10-16']);
  });

  test("at large text sizes the open card spans the three columns' widths and the grid scrolls", () => {
    mockWindow.fontScale = 2;
    const root = render();
    expect(root.root.findAll((n) => n.props.testID === 'week-grid-scroll' && n.props.horizontal === true)).not.toHaveLength(0);
    expect(flat(one(root, 'open-day-2026-10-15').props.style).width).toBe(160 * 3 + 4 * 2);
  });

  describe('taps', () => {
    const onSlot = jest.fn();
    const onToggleDay = jest.fn();
    function renderGrid(openDay: string | null) {
      const days = weekDays('2026-10-11');
      const plan = groupWeek(weekEntriesQuery(home, '2026-10-11').all());
      act(() => {
        tree = create(<WeekGrid days={days} plan={plan} today="2026-10-15" onSlot={onSlot} openDay={openDay} onToggleDay={onToggleDay} />);
      });
      return tree!;
    }

    beforeEach(() => {
      onSlot.mockClear();
      onToggleDay.mockClear();
    });

    test("a row opens its slot as a cell tap does: the recipe, the note, the empty slot", () => {
      const root = renderGrid('2026-10-15');
      press(root, 'Thursday dinner, Chicken tacos');
      expect(onSlot).toHaveBeenLastCalledWith('2026-10-15', 'dinner', expect.objectContaining({ kind: 'recipe', recipeId: tacos }));
      press(root, 'Thursday lunch, Leftovers');
      expect(onSlot).toHaveBeenLastCalledWith('2026-10-15', 'lunch', expect.objectContaining({ kind: 'leftovers' }));
      press(root, 'Thursday breakfast, empty');
      expect(onSlot).toHaveBeenLastCalledWith('2026-10-15', 'breakfast', null);
      expect(onSlot).toHaveBeenCalledTimes(3);
      expect(onToggleDay).not.toHaveBeenCalled();
    });

    test('a day label calls onToggleDay with its day; a closed day still opens its cells', () => {
      const root = renderGrid(null);
      expect(openDays(root)).toEqual([]);
      toggle(root, '2026-10-16');
      expect(onToggleDay).toHaveBeenCalledWith('2026-10-16');
      press(root, 'Friday breakfast, Pancakes at Gran’s');
      expect(onSlot).toHaveBeenLastCalledWith('2026-10-16', 'breakfast', expect.objectContaining({ kind: 'note' }));
    });

    test('without onToggleDay (the plan modal) the labels are not buttons and no day opens', () => {
      act(() => {
        tree = create(
          <WeekGrid
            days={weekDays('2026-10-11')}
            plan={groupWeek(weekEntriesQuery(home, '2026-10-11').all())}
            today="2026-10-15"
            onSlot={onSlot}
            openDay="2026-10-15"
          />,
        );
      });
      expect(openDays(tree!)).toEqual([]);
      expect(tree!.root.findAll((n) => /^day-label-/.test(n.props.testID ?? ''))).toHaveLength(0);
      expect(flat(slot(tree!, '2026-10-15', 'dinner').props.style).minHeight).toBe(104);
    });
  });
});

describe('several recipes in a slot', () => {
  const NAMES = ['Mexican rice', 'Guacamole', 'Salsa', 'Black beans', 'Slaw', 'Churros'];
  let sides: string[];
  const photos = (node: ReactTestInstance) => node.findAll((n) => n.type === ('ExpoImage' as never));
  const tileColour = (recipeId: string) => AisleColors.light[recipeHue(recipeId)].soft;
  const nameTexts = (node: ReactTestInstance) =>
    node.findAll((n) => n.type === ('Text' as never) && n.props.numberOfLines !== undefined);
  const SEVEN = ['Chicken tacos', ...NAMES];

  beforeEach(() => {
    sides = NAMES.map((name) => createRecipe(name, home));
    db.update(recipes).set({ imageUrl: 'https://example.com/rice.jpg' }).where(eq(recipes.id, sides[0])).run();
    // Friday dinner: two recipes. Saturday lunch: seven.
    addRecipeToSlot(home, '2026-10-16', 'dinner', tacos);
    addRecipeToSlot(home, '2026-10-16', 'dinner', sides[0]);
    for (const id of [tacos, ...sides]) addRecipeToSlot(home, '2026-10-17', 'lunch', id);
  });

  afterEach(() => {
    act(() => void i18n.changeLanguage('en'));
  });

  describe('Split photo (the default)', () => {
    test('two recipes: the 4:3 strip split into two pieces, then the names one line each', () => {
      const root = render();
      const cell = slot(root, '2026-10-16', 'dinner');
      expect(cell.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-photo')).toHaveLength(0);
      const strip = cell.find((n) => n.type === ('View' as never) && n.props.testID === 'plan-split');
      expect(flat(strip.props.style)).toMatchObject({
        width: '100%',
        aspectRatio: 4 / 3,
        borderRadius: Rounded.sm,
        overflow: 'hidden',
        flexDirection: 'row',
        gap: Spacing.xxs,
      });
      const pieces = strip.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-split-piece');
      expect(pieces.map((p) => flat(p.props.style).backgroundColor)).toEqual([tileColour(tacos), tileColour(sides[0])]);
      expect(pieces.map((p) => flat(p.props.style).flex)).toEqual([1, 1]);
      // Each piece covers its photo; tacos has none, so only its tile colour shows.
      expect(photos(pieces[0])).toHaveLength(0);
      expect(photos(pieces[1]).map((i) => i.props)).toEqual([
        expect.objectContaining({ source: 'https://example.com/rice.jpg', contentFit: 'cover' }),
      ]);
      expect(cell.findAll((n) => n.props.testID === 'plan-split-more')).toHaveLength(0);
      const names = nameTexts(cell);
      expect(names.map((n) => n.props.children)).toEqual(['Chicken tacos', 'Mexican rice']);
      names.forEach((n) => {
        expect(n.props.numberOfLines).toBe(1);
        expect(flat(n.props.style)).toMatchObject({ fontSize: Typography.caption.fontSize, color: Palette.light.ink });
      });
      expect(cell.props.accessibilityLabel).toBe('Friday dinner, Chicken tacos, Mexican rice');
    });

    test('seven recipes: three pieces and names, a surfaceMuted "+4" piece and a "+4 more" line', () => {
      const root = render();
      const cell = slot(root, '2026-10-17', 'lunch');
      const pieces = cell.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-split-piece');
      expect(pieces.map((p) => flat(p.props.style).backgroundColor)).toEqual([tacos, sides[0], sides[1]].map(tileColour));
      const more = cell.find((n) => n.type === ('View' as never) && n.props.testID === 'plan-split-more');
      expect(flat(more.props.style)).toMatchObject({ backgroundColor: Palette.light.surfaceMuted, flex: 1 });
      const moreText = more.find((n) => n.type === ('Text' as never));
      expect(moreText.props.children).toBe('+4');
      expect(flat(moreText.props.style)).toMatchObject({ fontSize: Typography.caption.fontSize, color: Palette.light.ink });
      const names = nameTexts(cell);
      expect(names.map((n) => n.props.children)).toEqual(['Chicken tacos', 'Mexican rice', 'Guacamole', '+4 more']);
      expect(flat(names[3].props.style).color).toBe(Palette.light.inkSecondary);
      // VoiceOver names all seven, whatever the cell shows.
      expect(cell.props.accessibilityLabel).toBe(`Saturday lunch, ${SEVEN.join(', ')}`);
    });

    test('four recipes show "+1"; in Spanish the line reads "+1 más"', () => {
      for (const id of [tacos, sides[0], sides[1], sides[2]]) addRecipeToSlot(home, '2026-10-18', 'dinner', id);
      act(() => void i18n.changeLanguage('es'));
      const root = render();
      press(root, 'Semana siguiente');
      const cell = slot(root, '2026-10-18', 'dinner');
      expect(texts(cell)).toEqual(['+1', 'Chicken tacos', 'Mexican rice', 'Guacamole', '+1 más']);
    });

    test('a past day greys every name', () => {
      addRecipeToSlot(home, '2026-10-13', 'dinner', tacos);
      addRecipeToSlot(home, '2026-10-13', 'dinner', sides[1]);
      const root = render();
      const names = nameTexts(slot(root, '2026-10-13', 'dinner'));
      expect(names.map((n) => flat(n.props.style).color)).toEqual([Palette.light.inkSecondary, Palette.light.inkSecondary]);
    });
  });

  describe('Stacked', () => {
    beforeEach(() => setPlanCellStyle('stacked'));

    test('two recipes: a full-width 40 pt strip over each name, a border hairline and spacing.xs between them', () => {
      const root = render();
      const cell = slot(root, '2026-10-16', 'dinner');
      expect(byTestID(root, 'plan-split')).toHaveLength(0);
      const items = cell.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-stack-item');
      expect(items).toHaveLength(2);
      expect(flat(items[0].props.style)).toMatchObject({ borderTopWidth: 0, paddingTop: 0 });
      expect(flat(items[1].props.style)).toMatchObject({
        borderTopWidth: expect.any(Number),
        borderTopColor: Palette.light.border,
        paddingTop: Spacing.xs,
      });
      expect(flat(items[1].props.style).borderTopWidth).toBeGreaterThan(0);
      const strips = items.map((item) => item.find((n) => n.type === ('View' as never) && n.props.testID === 'plan-stack-photo'));
      strips.forEach((strip) =>
        expect(flat(strip.props.style)).toMatchObject({ width: '100%', height: 40, borderRadius: Rounded.sm, overflow: 'hidden' }),
      );
      expect(strips.map((s) => flat(s.props.style).backgroundColor)).toEqual([tileColour(tacos), tileColour(sides[0])]);
      expect(photos(strips[1]).map((i) => i.props.source)).toEqual(['https://example.com/rice.jpg']);
      const names = nameTexts(cell);
      expect(names.map((n) => n.props.children)).toEqual(['Chicken tacos', 'Mexican rice']);
      names.forEach((n) => {
        expect(n.props.numberOfLines).toBe(2);
        expect(flat(n.props.style).fontSize).toBe(Typography.caption.fontSize);
      });
      expect(cell.props.accessibilityLabel).toBe('Friday dinner, Chicken tacos, Mexican rice');
    });

    test('seven recipes: all seven, in order, with no "+4"', () => {
      const root = render();
      const cell = slot(root, '2026-10-17', 'lunch');
      expect(cell.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-stack-item')).toHaveLength(7);
      expect(texts(cell)).toEqual(SEVEN);
      expect(byTestID(root, 'plan-split-more')).toHaveLength(0);
      expect(cell.props.accessibilityLabel).toBe(`Saturday lunch, ${SEVEN.join(', ')}`);
    });

    test('a one-recipe cell is drawn as before', () => {
      const root = render();
      const cell = slot(root, '2026-10-12', 'dinner');
      expect(cell.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-photo')).toHaveLength(1);
      expect(cell.findAll((n) => n.type === ('View' as never) && n.props.testID === 'plan-stack-item')).toHaveLength(0);
      expect(texts(cell)).toEqual(['Soup']);
    });

    test('in the plan modal (no day opens) too', () => {
      act(() => {
        tree = create(
          <WeekGrid days={weekDays('2026-10-11')} plan={groupWeek(weekEntriesQuery(home, '2026-10-11').all())} today="2026-10-15" />,
        );
      });
      expect(texts(slot(tree!, '2026-10-17', 'lunch'))).toEqual(SEVEN);
    });
  });

  test('switching the setting redraws the open grid', () => {
    const root = render();
    expect(byTestID(root, 'plan-split')).toHaveLength(2);
    act(() => setPlanCellStyle('stacked'));
    expect(byTestID(root, 'plan-split')).toHaveLength(0);
    expect(byTestID(root, 'plan-stack-item')).toHaveLength(9);
    act(() => setPlanCellStyle('split'));
    expect(byTestID(root, 'plan-split')).toHaveLength(2);
    expect(byTestID(root, 'plan-stack-item')).toHaveLength(0);
  });

  test.each(['split', 'stacked'] as const)('the open day lists all seven, a row each with photo, name and time (%s)', (style) => {
    setPlanCellStyle(style);
    db.update(recipes).set({ totalMinutes: 90 }).where(eq(recipes.id, sides[1])).run();
    const root = render();
    act(() =>
      root.root
        .find((n) => n.props.testID === 'day-label-2026-10-17' && typeof n.props.onPress === 'function' && typeof n.type !== 'string')
        .props.onPress(),
    );
    const block = slot(root, '2026-10-17', 'lunch');
    // The meal's name once, then every recipe in order.
    expect(texts(block)).toEqual(['Lunch', 'Chicken tacos', '35 min', 'Mexican rice', 'Guacamole', '1 hr 30 min', ...NAMES.slice(2)]);
    const rows = block.findAll((n) => n.type === ('View' as never) && n.props.testID === 'open-row-recipe');
    expect(rows).toHaveLength(7);
    rows.forEach((row) =>
      expect(flat(row.find((n) => n.type === ('View' as never) && n.props.testID === 'plan-photo').props.style)).toMatchObject({
        width: 76,
        aspectRatio: 4 / 3,
        borderRadius: Rounded.sm,
      }),
    );
    expect(byTestID(root, 'plan-split')).toHaveLength(style === 'split' ? 1 : 0); // Friday's closed cell
    expect(block.props.accessibilityLabel).toBe(`Saturday lunch, ${SEVEN.join(', ')}`);
  });

  test("tapping a several-recipe cell or open block calls onSlot with the slot's first entry", () => {
    const onSlot = jest.fn();
    act(() => {
      tree = create(
        <WeekGrid
          days={weekDays('2026-10-11')}
          plan={groupWeek(weekEntriesQuery(home, '2026-10-11').all())}
          today="2026-10-15"
          onSlot={onSlot}
          openDay="2026-10-17"
          onToggleDay={() => {}}
        />,
      );
    });
    press(tree!, 'Friday dinner, Chicken tacos, Mexican rice');
    expect(onSlot).toHaveBeenLastCalledWith('2026-10-16', 'dinner', expect.objectContaining({ recipeId: tacos }));
    press(tree!, `Saturday lunch, ${SEVEN.join(', ')}`);
    expect(onSlot).toHaveBeenLastCalledWith('2026-10-17', 'lunch', expect.objectContaining({ recipeId: tacos }));
  });
});

describe('the view toggle', () => {
  const segments = (root: ReactTestRenderer) =>
    one(root, 'plan-view-toggle').findAll(
      (n) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function' && typeof n.type !== 'string',
    );

  test('"View: Grid" by default, each segment with its selected state', () => {
    const root = render();
    expect(one(root, 'plan-view-toggle').props.accessibilityLabel).toBe('View: Grid');
    expect(segments(root).map((s) => [s.props.accessibilityLabel, s.props.accessibilityState.selected])).toEqual([
      ['Agenda', false],
      ['Grid', true],
    ]);
    expect(getDeviceSetting(PLAN_VIEW_KEY, null)).toBeNull();
  });

  test('Agenda writes plan.view and shows the agenda, kept on the next visit', () => {
    let root = render();
    act(() => segments(root)[0].props.onPress());
    expect(getDeviceSetting(PLAN_VIEW_KEY, null)).toBe('agenda');
    expect(byTestID(root, 'week-agenda')).toHaveLength(1);
    expect(byTestID(root, 'week-grid')).toHaveLength(0);
    expect(one(root, 'plan-view-toggle').props.accessibilityLabel).toBe('View: Agenda');

    root = remount();
    expect(byTestID(root, 'week-agenda')).toHaveLength(1);
    act(() => segments(root)[1].props.onPress());
    expect(getDeviceSetting(PLAN_VIEW_KEY, null)).toBe('grid');
    expect(byTestID(root, 'week-grid')).toHaveLength(1);
  });
});

describe('the agenda', () => {
  beforeEach(() => setDeviceSetting(PLAN_VIEW_KEY, 'agenda'));

  test("shows the week's recipes with their time, notes in italic and + Add on empty slots", () => {
    const root = render();
    expect(texts(slot(root, '2026-10-15', 'dinner'))).toEqual(['D', 'Chicken tacos', '35 min']);
    expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Chicken tacos');
    expect(texts(slot(root, '2026-10-15', 'lunch'))).toEqual(['L', 'Leftovers']);
    const note = slot(root, '2026-10-16', 'breakfast').findAll((n) => n.type === ('Text' as never))[1];
    expect(flat(note.props.style)).toMatchObject({ fontStyle: 'italic', color: Palette.light.inkSecondary });
    const add = slot(root, '2026-10-16', 'lunch').findAll((n) => n.type === ('Text' as never))[1];
    expect(add.props.children).toBe('+ Add lunch');
    expect(flat(add.props.style).color).toBe(Palette.light.primary);
    expect(label(root, '2026-10-16', 'lunch')).toBe('Friday lunch, empty');
  });

  test("today's card has a primary outline; the others don't", () => {
    const root = render();
    expect(flat(one(root, 'agenda-day-2026-10-15').props.style).borderColor).toBe(Palette.light.primary);
    expect(flat(one(root, 'agenda-day-2026-10-16').props.style).borderColor).toBe('transparent');
  });

  test('in the current week the days before today fold into "Earlier this week · Sun – Wed", unfolded for the session', () => {
    let root = render();
    expect(texts(one(root, 'earlier-row'))).toEqual(['Earlier this week · Sun – Wed']);
    expect(agendaDays(root)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);

    expect(one(root, 'earlier-row').props.accessibilityState).toEqual({ expanded: false });
    unfold(root);
    expect(byTestID(root, 'earlier-row')).toHaveLength(0);
    expect(agendaDays(root)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);

    // Leaving and coming back keeps them open.
    root = remount();
    expect(agendaDays(root)).toHaveLength(7);
  });

  test('past days unfolded: names in inkSecondary, "—" with no Add on empty slots', () => {
    const root = render();
    unfold(root);
    const soupName = slot(root, '2026-10-12', 'dinner').findAll((n) => n.type === ('Text' as never))[1];
    expect(soupName.props.children).toBe('Soup');
    expect(flat(soupName.props.style).color).toBe(Palette.light.inkSecondary);
    const pastEmpty = slot(root, '2026-10-13', 'lunch').findAll((n) => n.type === ('Text' as never))[1];
    expect(pastEmpty.props.children).toBe('—');
    expect(flat(pastEmpty.props.style).color).toBe(Palette.light.inkSecondary);
    expect(texts(root.root).filter((text) => text.startsWith('+ Add'))).toHaveLength(
      // Thursday breakfast; Friday lunch and dinner; Saturday breakfast and lunch.
      5,
    );
  });

  test('"· Sun" alone on Monday, and no Earlier row on Sunday', () => {
    setNow(new Date(2026, 9, 12, 9, 0));
    let root = render();
    expect(texts(one(root, 'earlier-row'))).toEqual(['Earlier this week · Sun']);
    expect(agendaDays(root)).toHaveLength(6);

    setNow(new Date(2026, 9, 11, 9, 0));
    root = remount();
    expect(byTestID(root, 'earlier-row')).toHaveLength(0);
    expect(agendaDays(root)).toHaveLength(7);
  });

  test('other weeks show all seven days', () => {
    const root = render();
    press(root, 'Next week');
    expect(byTestID(root, 'earlier-row')).toHaveLength(0);
    expect(agendaDays(root)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
    expect(texts(slot(root, '2026-10-19', 'dinner'))).toEqual(['D', 'Soup']);

    press(root, 'Previous week');
    press(root, 'Previous week');
    expect(byTestID(root, 'earlier-row')).toHaveLength(0);
    expect(agendaDays(root)[0]).toBe('2026-10-04');
    // A past week: every empty slot reads "—".
    expect(texts(root.root).filter((text) => text.startsWith('+ Add'))).toHaveLength(0);
  });
});

describe('the week arrows and This week', () => {
  test('This week shows only while another week does, and goes back to it', () => {
    const root = render();
    expect(root.root.findAll((n) => n.props.accessibilityLabel === 'This week' && typeof n.props.onPress === 'function')).toHaveLength(0);

    press(root, 'Next week');
    expect(weekLabel(root).props.children).toBe('Oct 18 – 24');
    expect(label(root, '2026-10-19', 'dinner')).toBe('Monday dinner, Soup');
    press(root, 'Next week');
    press(root, 'Next week');
    expect(weekLabel(root).props.children).toBe('Nov 1 – 7');
    expect(weekLabel(root).props.accessibilityLabel).toBe('Week of November 1');

    press(root, 'This week');
    expect(weekLabel(root).props.children).toBe('Oct 11 – 17');
    expect(root.root.findAll((n) => n.props.accessibilityLabel === 'This week' && typeof n.props.onPress === 'function')).toHaveLength(0);

    press(root, 'Previous week');
    expect(weekLabel(root).props.children).toBe('Oct 4 – 10');
    expect(button(root, 'This week')).toBeDefined();
  });
});

describe('the household menu', () => {
  const menus = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('SwiftMenu' as never));
  const toggles = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === ('SwiftToggle' as never));

  test('none with one household', () => {
    expect(menus(render())).toHaveLength(0);
  });

  describe('with several households', () => {
    beforeEach(() => {
      // Older, so it's first in the menu: the fallback is the current list's household, not the first.
      db.insert(households).values({ id: 'cabin', name: 'Cabin', createdAt: new Date(2020, 0, 1) }).run();
      setSlot('cabin', '2026-10-15', 'dinner', { kind: 'note', note: 'Campfire chili' });
    });

    test("starts the toolbar, falling back to the current list's household", () => {
      const root = render();
      const [menu] = menus(root);
      expect(menu.props.modifiers).toEqual([{ accessibilityLabel: 'Household: Personal' }]);
      // First in the toolbar.
      expect(one(root, 'week-toolbar').findAll((n) => n.type === ('SwiftMenu' as never) || n.props.accessibilityLabel === 'Previous week')[0]).toBe(menu);
      expect(toggles(root).map((t) => [t.props.label, t.props.isOn])).toEqual([
        ['Cabin', false],
        ['Personal', true],
      ]);
      expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Chicken tacos');
    });

    test("picking a household writes plan.householdId and shows its week", () => {
      let root = render();
      act(() => toggles(root)[0].props.onIsOnChange(true));
      expect(getDeviceSetting(PLAN_HOUSEHOLD_KEY, null)).toBe('cabin');
      expect(menus(root)[0].props.modifiers).toEqual([{ accessibilityLabel: 'Household: Cabin' }]);
      expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Campfire chili');

      root = remount();
      expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Campfire chili');
    });

    test("a picked household that's gone falls back to the current list's", () => {
      setDeviceSetting(PLAN_HOUSEHOLD_KEY, 'left-long-ago');
      const root = render();
      expect(menus(root)[0].props.modifiers).toEqual([{ accessibilityLabel: 'Household: Personal' }]);
      expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Chicken tacos');
    });
  });
});
