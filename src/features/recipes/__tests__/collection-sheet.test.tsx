// Recipe collections, adding a recipe (boards C and F): the Add to collection sheet (rows, ticks applied on
// Done, Cancel, New collection… and its refused names) and the recipe screen's collections line.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, outbox, recipeCollectionRecipes, recipeCollections, recipes } from '@/db';
import { resetDb } from '@/test/db';

import AddToCollectionSheet from '@/app/recipe/[id]/collections';

import { applyCollectionTicks, createCollection, readHouseholdCollections, readRecipeCollections, setRecipeInCollection } from '../collections';
import { RecipeCollectionsRow } from '../recipe-collections-row';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});
const mockParams: Record<string, string | undefined> = {};
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    },
    { Button: host('ToolbarButton') },
  );
  return {
    Stack: { Screen: host('StackScreen'), Toolbar },
    router: { back: () => mockBack() },
    useLocalSearchParams: () => mockParams,
  };
});

const HOME = 'home';
const CABIN = 'cabin';
let tree: ReactTestRenderer | null = null;
let moms: string;
let kids: string;

const addRecipe = (id: string, name: string, householdId = HOME, extra: Partial<typeof recipes.$inferInsert> = {}) =>
  db.insert(recipes).values({ id, householdId, name, ...extra }).run();
const outboxCount = () => db.select().from(outbox).all().length;

beforeEach(() => {
  resetDb();
  db.insert(households).values([
    { id: HOME, name: 'Home' },
    { id: CABIN, name: 'Cabin' },
  ]).run();
  addRecipe('roast', 'Pot roast');
  addRecipe('tacos', 'Tacos', HOME, { imageUrl: 'https://example.com/tacos.jpg' });
  addRecipe('soup', 'Soup');
  addRecipe('stew', 'Stew', CABIN);
  moms = createCollection(HOME, "Mom's cookbook");
  kids = createCollection(HOME, 'Kid favorites');
  createCollection(CABIN, 'Cabin meals');
  setRecipeInCollection('tacos', moms, true);
  setRecipeInCollection('soup', moms, true);
  setRecipeInCollection('roast', kids, true);
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = 'roast';
  mockBack.mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
  });
  return tree!;
}

/** Every host Text's full string (nested Text included), outermost only, in order. */
const texts = (root: ReactTestRenderer) => {
  const out: string[] = [];
  const flat = (node: unknown): string =>
    typeof node === 'string' ? node : node && typeof node === 'object' ? ((node as { children?: unknown[] }).children ?? []).map(flat).join('') : '';
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type: string; children?: unknown[] };
    if (n.type === 'Text') {
      const s = flat(n);
      if (s) out.push(s);
      return;
    }
    n.children?.forEach(walk);
  };
  walk(root.toJSON());
  return out;
};
const byType = (root: ReactTestRenderer | ReactTestInstance, type: string) =>
  ('root' in root ? root.root : root).findAll((n) => n.type === type);
const pressable = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const line = (root: ReactTestRenderer) => root.root.findAll((n) => n.props.testID === 'recipe-collections-line');
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
/** The sheet's collection rows as "label: checked". */
const rows = (root: ReactTestRenderer) =>
  root.root
    .findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'checkbox' && typeof n.props.style === 'function')
    .map((n) => `${n.props.accessibilityLabel}: ${n.props.accessibilityState.checked}`);
const toolbarButton = (root: ReactTestRenderer, title: string) => byType(root, 'ToolbarButton').find((n) => n.props.children === title)!;
const done = (root: ReactTestRenderer) => act(() => toolbarButton(root, 'Done').props.onPress());
const cancel = (root: ReactTestRenderer) => act(() => toolbarButton(root, 'Cancel').props.onPress());
const collectionNames = (recipeId: string) => readRecipeCollections(recipeId).map((c) => c.name);

/** Spies on the name prompt; `submit` presses its Create with `name`. */
function namePrompt() {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const submit = (name: string) =>
    act(() => {
      const buttons = prompt.mock.calls.at(-1)![2] as AlertButton[];
      (buttons.find((b) => b.text === 'Create')!.onPress as (text: string) => void)(name);
    });
  return { prompt, alert, submit };
}

describe('Add to collection sheet', () => {
  test("shows the title, the recipe's name, its household's collections A–Z with counts and ticks, then New collection… and the footnote", () => {
    const root = render(<AddToCollectionSheet />);
    expect(texts(root)).toEqual([
      'Add to collection',
      'Pot roast',
      'Kid favorites',
      '1 recipe',
      "Mom's cookbook",
      '2 recipes',
      'New collection…',
      'Collections are shared with everyone in the household.',
    ]);
    expect(rows(root)).toEqual(['Kid favorites, 1 recipe: true', "Mom's cookbook, 2 recipes: false"]);
    expect(byType(root, 'ToolbarButton').map((n) => n.props.children)).toEqual(['Cancel', 'Done']);
  });

  test("a cover shows its recipes' photos or aisle tiles, then empty cells up to four", () => {
    const root = render(<AddToCollectionSheet />);
    const [kidsCover, momsCover] = root.root.findAll((n) => n.type === ('View' as never) && n.props.testID === 'collection-cover');
    expect(byType(kidsCover, 'View').filter((n) => n.props.testID === 'collection-cover-cell')).toHaveLength(1);
    expect(byType(kidsCover, 'View').filter((n) => n.props.testID === 'collection-cover-empty')).toHaveLength(3);
    expect(byType(kidsCover, 'ExpoImage')).toHaveLength(0);
    // Soup and Tacos, A–Z: only Tacos has a photo.
    expect(byType(momsCover, 'View').filter((n) => n.props.testID === 'collection-cover-cell')).toHaveLength(2);
    expect(byType(momsCover, 'ExpoImage').map((n) => n.props.source)).toEqual(['https://example.com/tacos.jpg']);
  });

  test('ticking a collection puts the recipe in it on Done, and closes', () => {
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, "Mom's cookbook, 2 recipes"));
    expect(rows(root)).toEqual(['Kid favorites, 1 recipe: true', "Mom's cookbook, 2 recipes: true"]);
    // Nothing is written until Done.
    expect(collectionNames('roast')).toEqual(['Kid favorites']);
    done(root);
    expect(collectionNames('roast')).toEqual(['Kid favorites', "Mom's cookbook"]);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('unticking a collection takes the recipe out of it on Done', () => {
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, 'Kid favorites, 1 recipe'));
    expect(rows(root)[0]).toBe('Kid favorites, 1 recipe: false');
    done(root);
    expect(collectionNames('roast')).toEqual([]);
    expect(readHouseholdCollections(HOME).find((c) => c.id === kids)?.recipeCount).toBe(0);
  });

  test('Cancel drops the ticks and closes', () => {
    const before = outboxCount();
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, "Mom's cookbook, 2 recipes"));
    press(pressable(root, 'Kid favorites, 1 recipe'));
    cancel(root);
    expect(collectionNames('roast')).toEqual(['Kid favorites']);
    expect(outboxCount()).toBe(before);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('ticking and unticking again writes nothing on Done', () => {
    const before = outboxCount();
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, "Mom's cookbook, 2 recipes"));
    press(pressable(root, "Mom's cookbook, 2 recipes"));
    done(root);
    expect(outboxCount()).toBe(before);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('New collection… creates the named collection at once, ticked, and Done puts the recipe in it', () => {
    const { prompt, alert, submit } = namePrompt();
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, 'New collection…'));
    expect(prompt.mock.calls[0][0]).toBe('New collection');
    expect((prompt.mock.calls[0][2] as AlertButton[]).map((b) => b.text)).toEqual(['Cancel', 'Create']);
    submit('  Thanksgiving ');
    expect(readHouseholdCollections(HOME).map((c) => c.name)).toEqual(['Kid favorites', "Mom's cookbook", 'Thanksgiving']);
    expect(rows(root)).toEqual([
      'Kid favorites, 1 recipe: true',
      "Mom's cookbook, 2 recipes: false",
      'Thanksgiving, 0 recipes: true',
    ]);
    expect(alert).not.toHaveBeenCalled();
    done(root);
    expect(collectionNames('roast')).toEqual(['Kid favorites', 'Thanksgiving']);
  });

  test("Cancel after New collection… keeps the collection but doesn't put the recipe in it", () => {
    const { submit } = namePrompt();
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, 'New collection…'));
    submit('Thanksgiving');
    cancel(root);
    expect(readHouseholdCollections(HOME).find((c) => c.name === 'Thanksgiving')?.recipeCount).toBe(0);
    expect(collectionNames('roast')).toEqual(['Kid favorites']);
  });

  test('a name already used (ignoring case and accents) shows why and creates nothing', () => {
    const { alert, submit } = namePrompt();
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, 'New collection…'));
    submit("Mom's cookbook");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe("There's already a collection called Mom's cookbook.");
    submit('KID FAVORÍTES');
    expect(alert.mock.calls[1][0]).toBe("There's already a collection called KID FAVORÍTES.");
    expect(db.select().from(recipeCollections).all()).toHaveLength(3);
    expect(rows(root)).toHaveLength(2);
  });

  test("another household's collection name is free", () => {
    const { alert, submit } = namePrompt();
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, 'New collection…'));
    submit('Cabin meals');
    expect(alert).not.toHaveBeenCalled();
    expect(rows(root)).toContain('Cabin meals, 0 recipes: true');
  });

  test('a blank name is dropped quietly; a name over 40 characters shows the limit', () => {
    const { alert, submit } = namePrompt();
    const root = render(<AddToCollectionSheet />);
    press(pressable(root, 'New collection…'));
    submit('   ');
    expect(alert).not.toHaveBeenCalled();
    submit('x'.repeat(41));
    expect(alert.mock.calls[0][0]).toBe('Use 40 characters or fewer.');
    expect(rows(root)).toHaveLength(2);
  });

  test('with no collections in the household, only New collection… and the footnote', () => {
    mockParams.id = 'stew';
    db.delete(recipeCollectionRecipes).run();
    db.delete(recipeCollections).run();
    const root = render(<AddToCollectionSheet />);
    expect(texts(root)).toEqual(['Add to collection', 'Stew', 'New collection…', 'Collections are shared with everyone in the household.']);
    expect(rows(root)).toEqual([]);
  });

  test('a missing recipe renders an empty sheet', () => {
    mockParams.id = 'nope';
    const root = render(<AddToCollectionSheet />);
    expect(texts(root)).toEqual([]);
  });
});

describe('applyCollectionTicks', () => {
  test('adds the newly ticked, removes the unticked, and leaves the rest', () => {
    const third = createCollection(HOME, 'Weeknight dinners');
    setRecipeInCollection('roast', third, true);
    applyCollectionTicks('roast', new Set([kids, third]), new Set([third, moms]));
    expect(collectionNames('roast')).toEqual(["Mom's cookbook", 'Weeknight dinners']);
  });

  test('the same ticks: no write', () => {
    const before = outboxCount();
    applyCollectionTicks('roast', new Set([kids]), new Set([kids]));
    expect(outboxCount()).toBe(before);
  });
});

describe('RecipeCollectionsRow', () => {
  test('in none, nothing', () => {
    const root = render(<RecipeCollectionsRow recipeId="soup" onEdit={() => {}} />);
    setRecipeInCollection('soup', moms, false);
    act(() => root.update(<SafeAreaProvider initialMetrics={METRICS}><RecipeCollectionsRow recipeId="soup" onEdit={() => {}} /></SafeAreaProvider>));
    expect(line(root)).toHaveLength(0);
  });

  test('the names A–Z joined with " · ", one truncated line, a glyph and a chevron, as one button', () => {
    setRecipeInCollection('tacos', kids, true);
    const onEdit = jest.fn();
    const root = render(<RecipeCollectionsRow recipeId="tacos" onEdit={onEdit} />);
    expect(texts(root)).toEqual(["Kid favorites · Mom's cookbook"]);
    const text = root.root.find((n) => n.type === ('Text' as never));
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('tail');
    expect(byType(root, 'Icon').map((n) => [n.props.name, n.props.color])).toEqual([
      ['rectangle.stack', 'inkSecondary'],
      ['chevron.right', 'inkSecondary'],
    ]);
    const button = pressable(root, "Collections: Kid favorites, Mom's cookbook");
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe('Changes collections');
    press(button);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test('a deleted collection is left out', () => {
    db.update(recipeCollections).set({ deletedAt: new Date() }).run();
    const root = render(<RecipeCollectionsRow recipeId="tacos" onEdit={() => {}} />);
    expect(line(root)).toHaveLength(0);
  });
});
