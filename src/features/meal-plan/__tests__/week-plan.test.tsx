// The Plan tab's week screen (spec 4.16): the toolbar, the grid and the agenda, rendered against the
// in-memory database on Thursday, October 15, 2026 (the week of Sunday, October 11).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, recipes } from '@/db';
import { AisleColors, Opacity, Palette, Rounded, Typography } from '@/constants/theme';
import { recipeHue } from '@/domain/aisle-color';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { createRecipe } from '@/features/recipes/recipes';
import {
  getDeviceSetting,
  PLAN_HOUSEHOLD_KEY,
  PLAN_VIEW_KEY,
  setDeviceSetting,
} from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import PlanScreen from '@/app/(tabs)/plan/index';

import { resetEarlierDays } from '../earlier-fold-store';
import { getPlanGridStyle, PLAN_GRID_STYLE_KEY, readPlanGridStyle, setPlanGridStyle } from '../grid-style';
import { WeekPlan } from '../week-plan';
import { setSlot } from '../write';

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
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: { View } };
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
  home = getList(getDefaultListId('user-1')!)!.householdId;
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
    expect(texts(slot(root, '2026-10-15', 'dinner'))).toEqual(['Chicken tacos']);
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
    const root = render();
    const pastRecipe = slot(root, '2026-10-12', 'dinner').find((n) => n.type === ('Text' as never));
    expect(flat(pastRecipe.props.style).color).toBe(Palette.light.inkSecondary);
    const todayRecipe = slot(root, '2026-10-15', 'dinner').find((n) => n.type === ('Text' as never));
    expect(flat(todayRecipe.props.style).color).toBe(Palette.light.ink);

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

describe('the grid style setting', () => {
  test('readPlanGridStyle keeps the three styles and falls back to compact', () => {
    expect(readPlanGridStyle('compact')).toBe('compact');
    expect(readPlanGridStyle('photo')).toBe('photo');
    expect(readPlanGridStyle('expand')).toBe('expand');
    expect(readPlanGridStyle(null)).toBe('compact');
    expect(readPlanGridStyle(undefined)).toBe('compact');
    expect(readPlanGridStyle('Photo')).toBe('compact');
    expect(readPlanGridStyle('grid')).toBe('compact');
    expect(readPlanGridStyle(1)).toBe('compact');
    expect(readPlanGridStyle({ style: 'photo' })).toBe('compact');
  });

  test('compact until set; saved as plan.gridStyle; an unknown saved value reads as compact', () => {
    expect(getPlanGridStyle()).toBe('compact');
    setPlanGridStyle('photo');
    expect(getDeviceSetting(PLAN_GRID_STYLE_KEY, null)).toBe('photo');
    expect(getPlanGridStyle()).toBe('photo');
    setDeviceSetting(PLAN_GRID_STYLE_KEY, 'mosaic');
    expect(getPlanGridStyle()).toBe('compact');
  });
});

describe('the grid in the photo style', () => {
  const host = (root: ReactTestRenderer, day: string, meal: string) => flat(slot(root, day, meal).props.style);
  const photos = (node: ReactTestInstance) => node.findAll((n) => n.type === ('ExpoImage' as never));
  const band = (node: ReactTestInstance) => node.find((n) => n.type === ('View' as never) && n.props.testID === 'photo-band');
  const tileColour = (recipeId: string) => AisleColors.light[recipeHue(recipeId)].soft;

  beforeEach(() => setPlanGridStyle('photo'));

  test('a recipe without a photo: its tile colour fills the 84 pt cell, the name in white on the scrim band', () => {
    const root = render();
    const cell = slot(root, '2026-10-15', 'dinner');
    expect(host(root, '2026-10-15', 'dinner')).toMatchObject({
      minHeight: 84,
      padding: 0,
      overflow: 'hidden',
      justifyContent: 'flex-end',
      borderRadius: Rounded.md,
      backgroundColor: tileColour(tacos),
      opacity: 1,
    });
    expect(photos(cell)).toHaveLength(0);
    expect(flat(band(cell).props.style).backgroundColor).toBe('rgba(20, 28, 23, 0.66)');
    const name = band(cell).find((n) => n.type === ('Text' as never));
    expect(name.props.children).toBe('Chicken tacos');
    expect(name.props.numberOfLines).toBe(2);
    expect(flat(name.props.style)).toMatchObject({ color: '#FFFFFF', fontSize: Typography.caption.fontSize });
    // No small tile, as in the compact style.
    expect(cell.findAll((n) => n.props.testID === 'recipe-photo')).toHaveLength(0);
    expect(label(root, '2026-10-15', 'dinner')).toBe('Thursday dinner, Chicken tacos');
  });

  test("a site's photo fills the cell, covering it, over the tile colour", () => {
    db.update(recipes).set({ imageUrl: 'https://example.com/tacos.jpg' }).where(eq(recipes.id, tacos)).run();
    const root = render();
    const [image] = photos(slot(root, '2026-10-15', 'dinner'));
    expect(image.props).toMatchObject({ source: 'https://example.com/tacos.jpg', contentFit: 'cover', accessible: false });
    expect(flat(image.props.style)).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 });
    expect(host(root, '2026-10-15', 'dinner').backgroundColor).toBe(tileColour(tacos));
    expect(texts(band(slot(root, '2026-10-15', 'dinner')))).toEqual(['Chicken tacos']);
  });

  test("the household's own photo wins over the site's, loaded from Storage by its path", () => {
    db.update(recipes)
      .set({ imageUrl: 'https://example.com/tacos.jpg', photoPath: `${home}/tacos.jpg` })
      .where(eq(recipes.id, tacos))
      .run();
    const root = render();
    const [image] = photos(slot(root, '2026-10-15', 'dinner'));
    expect(image.props.source).toMatchObject({
      uri: expect.stringContaining(`/storage/v1/object/authenticated/recipe-photos/${home}/tacos.jpg`),
      cacheKey: `${home}/tacos.jpg`,
    });
  });

  test("a photo that fails to load leaves the tile colour and the name", () => {
    db.update(recipes).set({ imageUrl: 'https://example.com/gone.jpg' }).where(eq(recipes.id, tacos)).run();
    const root = render();
    act(() => photos(slot(root, '2026-10-15', 'dinner'))[0].props.onError({ error: 'HTTP 404' }));
    expect(photos(slot(root, '2026-10-15', 'dinner'))).toHaveLength(0);
    expect(host(root, '2026-10-15', 'dinner').backgroundColor).toBe(tileColour(tacos));
    expect(texts(band(slot(root, '2026-10-15', 'dinner')))).toEqual(['Chicken tacos']);
  });

  test("past days' recipes and notes at opacity.disabled; today's and later ones, and empty cells, at full", () => {
    setSlot(home, '2026-10-13', 'lunch', { kind: 'leftovers' });
    const root = render();
    expect(host(root, '2026-10-12', 'dinner').opacity).toBe(Opacity.disabled); // past recipe
    expect(host(root, '2026-10-13', 'lunch').opacity).toBe(Opacity.disabled); // past note
    expect(host(root, '2026-10-15', 'dinner').opacity).toBe(1); // today
    expect(host(root, '2026-10-16', 'breakfast').opacity).toBe(1); // a later note
    expect(host(root, '2026-10-14', 'lunch').opacity).toBe(1); // a past empty slot
    // Pressed, a past cell dims further from where it rests.
    const pressable = root.root.find(
      (n) => n.props.testID === 'slot-2026-10-12-dinner' && typeof n.type !== 'string' && typeof n.props.style === 'function',
    );
    const pressed = Object.assign({}, ...[pressable.props.style({ pressed: true })].flat(Infinity).filter(Boolean));
    expect(pressed.opacity).toBeCloseTo(Opacity.pressed * Opacity.disabled);
  });

  test('notes, empty cells and the today pill are as in the compact style, at the taller height', () => {
    const root = render();
    const note = slot(root, '2026-10-16', 'breakfast');
    expect(host(root, '2026-10-16', 'breakfast')).toMatchObject({ minHeight: 84, backgroundColor: Palette.light.surfaceMuted });
    expect(flat(note.find((n) => n.type === ('Text' as never)).props.style)).toMatchObject({
      fontStyle: 'italic',
      color: Palette.light.inkSecondary,
    });
    expect(host(root, '2026-10-16', 'lunch')).toMatchObject({ minHeight: 84, borderStyle: 'dashed', borderColor: Palette.light.controlBorder });
    expect(icons(slot(root, '2026-10-16', 'lunch')).map((i) => i.props.name)).toEqual(['plus']);
    expect(icons(slot(root, '2026-10-14', 'lunch'))).toHaveLength(0);
    expect(label(root, '2026-10-14', 'lunch')).toBe('Wednesday lunch, empty');
    expect(texts(one(root, 'today-pill'))).toEqual(['Thu', '15']);
    expect(root.root.findAll((n) => n.type === ('View' as never) && /^slot-/.test(n.props.testID ?? ''))).toHaveLength(21);
  });

  test('still scrolls sideways at large text sizes', () => {
    mockWindow.fontScale = 2;
    const root = render();
    expect(root.root.findAll((n) => n.props.testID === 'week-grid-scroll' && n.props.horizontal === true)).not.toHaveLength(0);
    expect(byTestID(root, 'photo-band').length).toBeGreaterThan(0);
  });

  test('the agenda is unchanged', () => {
    setDeviceSetting(PLAN_VIEW_KEY, 'agenda');
    const root = render();
    expect(byTestID(root, 'week-agenda')).toHaveLength(1);
    expect(byTestID(root, 'photo-band')).toHaveLength(0);
  });
});

describe('the grid in the compact and expand styles', () => {
  test.each(['compact', 'expand'] as const)('%s: the small tile over the name, at the compact height, past names greyed', (style) => {
    setPlanGridStyle(style);
    const root = render();
    expect(byTestID(root, 'photo-band')).toHaveLength(0);
    expect(flat(slot(root, '2026-10-15', 'dinner').props.style)).toMatchObject({ minHeight: 64, backgroundColor: Palette.light.surface, opacity: 1 });
    expect(flat(slot(root, '2026-10-12', 'dinner').props.style).opacity).toBe(1);
    expect(texts(slot(root, '2026-10-15', 'dinner'))).toEqual(['Chicken tacos']);
  });

  test('a grid on screen follows a change of style at once', () => {
    const root = render();
    expect(byTestID(root, 'photo-band')).toHaveLength(0);
    act(() => setPlanGridStyle('photo'));
    expect(byTestID(root, 'photo-band').length).toBeGreaterThan(0);
    expect(flat(slot(root, '2026-10-15', 'dinner').props.style).minHeight).toBe(84);
    act(() => setPlanGridStyle('compact'));
    expect(byTestID(root, 'photo-band')).toHaveLength(0);
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
