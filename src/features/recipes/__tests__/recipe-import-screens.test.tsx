// "Add recipe from link…" (spec 4.10), the Recipes tab (spec 4.5, board 05) and its imports card,
// rendered against the in-memory database with the import itself and the share queue stubbed.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, lists, recipes } from '@/db';
import { addItemsBulk } from '@/features/lists/items';
import {
  createList,
  ensureStarterData,
  getDefaultListId,
  LAST_OPENED_LIST_KEY,
  setLastOpenedList,
} from '@/features/lists/lists';
import { takeRecipeAddResult } from '@/features/lists/recipe-add-result';
import { setFeatures } from '@/features/plans/features';
import { getDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import ImportRecipeSheet from '@/app/import-recipe';
import RecipesScreen from '@/app/(tabs)/recipes/index';

import type { ImportRecipeInput, ImportRecipeResult, ImportRecipeSuccess } from '../import';
import { ImportsCard } from '../imports-card';
import { addRecipeIngredient, createRecipe, getRecipe } from '../recipes';
import { failedImportsQuery, recordFailedImport } from '../failed-imports';
import { EMPTY_SHARE_QUEUE_STATUS, setShareQueueStatus, type ShareQueueStatus } from '../share-queue-status';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
  };
});
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({ categorizePending: () => Promise.resolve() }));

const mockImport = jest.fn<(input: ImportRecipeInput) => Promise<ImportRecipeResult>>();
jest.mock('@/features/recipes/import', () => ({
  ...(jest.requireActual('@/features/recipes/import') as object),
  importRecipe: (input: ImportRecipeInput) => mockImport(input),
}));
const mockClipboard = jest.fn<() => Promise<string>>();
jest.mock('expo-clipboard', () => ({ getStringAsync: () => mockClipboard() }));
const mockNotify = jest.fn();
jest.mock('@/features/notifications/notifications', () => ({ notify: (n: unknown) => mockNotify(n) }));

// The share queue lives in the App Group; the tab only subscribes to its imports and removes shares.
let mockShareListener: ((imported: ImportRecipeSuccess[]) => void) | null = null;
const mockRemoveShare = jest.fn();
jest.mock('@/features/recipes/share-drain', () => ({
  onShareImports: (listener: (imported: ImportRecipeSuccess[]) => void) => {
    mockShareListener = listener;
    return () => {
      mockShareListener = null;
    };
  },
  removeQueuedShare: (...args: unknown[]) => mockRemoveShare(...args),
}));

const mockParams: Record<string, string | undefined> = {};
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment, useEffect } = require('react');
  const passThrough = () =>
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    };
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(passThrough(), { Button: host('ToolbarButton') });
  const Link = Object.assign(host('Link'), {
    Trigger: passThrough(),
    Menu: passThrough(),
    MenuAction: host('LinkMenuAction'),
  });
  return {
    Link,
    Stack: { Screen: () => null, Toolbar },
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      back: () => mockBack(),
      navigate: (...args: unknown[]) => mockNavigate(...args),
    },
    // Focus is mount: subscribe on mount, unsubscribe on unmount.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const USER = 'user-1';
/** The list the List tab shows next: the one last opened on this device (spec 4.1). */
const currentList = () => getDeviceSetting<string | null>(LAST_OPENED_LIST_KEY, null);
let tree: ReactTestRenderer | null = null;
let groceries: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  for (const fn of [mockPush, mockBack, mockNavigate, mockNotify, mockRemoveShare]) fn.mockClear();
  mockImport.mockReset();
  mockClipboard.mockReset();
  setShareQueueStatus(EMPTY_SHARE_QUEUE_STATUS);
  setFeatures(['categorize', 'recipe_import']);
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
const byType = (root: ReactTestRenderer, type: string) => root.root.findAll((n) => n.type === type);
const allByLabel = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === label && typeof n.props.onPress === 'function');
const byLabel = (root: ReactTestRenderer, label: string) => allByLabel(root, label)[0];
const allByA11y = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const byA11y = (root: ReactTestRenderer, label: string) => allByA11y(root, label)[0];
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const pressAsync = async (n: ReactTestInstance) => {
  await act(async () => {
    await n.props.onPress();
  });
};

/** A promise and the function that resolves it, for imports still reading. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const success = (over: Partial<ImportRecipeSuccess> = {}): ImportRecipeSuccess => ({
  ok: true,
  recipeId: 'recipe-1',
  recipeName: 'Chicken tikka masala',
  listId: groceries,
  added: 12,
  combined: 0,
  undo: jest.fn(),
  ...over,
});

describe('ImportRecipeSheet', () => {
  const field = (root: ReactTestRenderer) =>
    root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Recipe link');
  const type = (root: ReactTestRenderer, text: string) => act(() => field(root).props.onChangeText(text));
  const selectedPills = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.selected === true && !!n.props.label).map((n) => n.props.label);
  const listName = (id: string) => db.select().from(lists).all().find((l) => l.id === id)!.name;

  test('with no lists it renders nothing', () => {
    db.update(lists).set({ archivedAt: new Date() }).run();
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).toEqual([]);
  });

  test('from the Recipes tab it asks for the list, starting on the last opened one', () => {
    const party = createList('Party');
    setLastOpenedList(party);
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Add recipe from link', 'To', 'Link']));
    expect(selectedPills(root)).toEqual(['Party']);
    press(byLabel(root, listName(groceries)));
    expect(selectedPills(root)).toEqual([listName(groceries)]);
  });

  test('with several households, each gets its own "To ·" group', () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    createList('Cabin', 'lake');
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).toEqual(expect.arrayContaining(['To · Lake house']));
    expect(texts(root).filter((t) => t.startsWith('To · '))).toHaveLength(2);
  });

  test("from a list's menu there's no list picker", () => {
    mockParams.list = groceries;
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).not.toContain('To');
    expect(selectedPills(root)).toEqual([]);
  });

  test('Add recipe is disabled until there is text', () => {
    const root = render(<ImportRecipeSheet />);
    expect(byLabel(root, 'Add recipe').props.disabled).toBe(true);
    type(root, 'https://example.com/tikka');
    expect(byLabel(root, 'Add recipe').props.disabled).toBe(false);
  });

  test('text that is not a link shows the error without importing; typing clears it', async () => {
    const root = render(<ImportRecipeSheet />);
    type(root, 'chicken tikka');
    await pressAsync(byLabel(root, 'Add recipe'));
    expect(mockImport).not.toHaveBeenCalled();
    expect(texts(root)).toContain("That doesn't look like a link");
    type(root, 'https://example.com');
    expect(texts(root)).not.toContain("That doesn't look like a link");
  });

  test('Paste fills the field with the link in the clipboard', async () => {
    mockClipboard.mockResolvedValue('Look at this https://example.com/tikka so good');
    const root = render(<ImportRecipeSheet />);
    await pressAsync(byLabel(root, 'Paste'));
    expect(field(root).props.value).toBe('https://example.com/tikka');
  });

  test('Paste with an empty clipboard leaves the field alone', async () => {
    mockClipboard.mockResolvedValue('');
    const root = render(<ImportRecipeSheet />);
    type(root, 'abc');
    await pressAsync(byLabel(root, 'Paste'));
    expect(field(root).props.value).toBe('abc');
  });

  test('while reading it says so and disables everything; success closes and opens the list', async () => {
    const party = createList('Party');
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportRecipeSheet />);
    press(byLabel(root, 'Party'));
    type(root, 'https://example.com/tikka');
    act(() => {
      void byLabel(root, 'Add recipe').props.onPress();
    });
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/tikka', listId: party });
    expect(texts(root)).toContain("You can close this. We'll let you know when it's ready.");
    expect(byLabel(root, 'Reading recipe…').props.disabled).toBe(true);
    expect(byLabel(root, 'Paste').props.disabled).toBe(true);
    expect(field(root).props.editable).toBe(false);
    expect(byLabel(root, 'Party').props.disabled).toBe(true);
    // A second submit while reading does nothing.
    await act(async () => {
      await field(root).props.onSubmitEditing();
    });
    expect(mockImport).toHaveBeenCalledTimes(1);

    const result = success({ listId: party });
    await act(async () => pending.resolve(result));
    expect(mockBack).toHaveBeenCalledTimes(1);
    // The List tab shows that list.
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    expect(mockPush).not.toHaveBeenCalled();
    expect(currentList()).toBe(party);
    expect(takeRecipeAddResult(party)).toEqual({
      kind: 'imported',
      listId: party,
      recipeId: 'recipe-1',
      recipeName: 'Chicken tikka masala',
      count: 12,
      undo: result.undo,
    });
  });

  test("from a list's menu, success only closes: the list is underneath", async () => {
    mockParams.list = groceries;
    mockImport.mockResolvedValue(success());
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Add recipe'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test.each([
    [{ ok: false, error: 'not_a_recipe' } as const, "That page doesn't look like a recipe"],
    [{ ok: false, error: 'offline' } as const, "You're offline"],
    [{ ok: false, error: 'not_entitled' } as const, "Recipe import isn't included in your plan."],
    [{ ok: false, error: 'failed', reason: 'fetch_failed' } as const, "Couldn't reach that site"],
  ])('a failed import keeps the sheet open with its reason (%o)', async (result, message) => {
    mockImport.mockResolvedValue(result);
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Add recipe'));
    expect(texts(root)).toContain(message);
    expect(byLabel(root, 'Add recipe').props.disabled).toBe(false);
    expect(mockBack).not.toHaveBeenCalled();
  });

  test('closed while reading, success comes as a notification that opens the list with its toast', async () => {
    // Another list is current; the notification makes the import's list current.
    setLastOpenedList(createList('Party'));
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    act(() => {
      void byLabel(root, 'Add recipe').props.onPress();
    });
    act(() => root.unmount());
    tree = null;
    await act(async () => pending.resolve(success()));
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const notification = mockNotify.mock.calls[0][0] as { title: string; body: string; onPress: () => void };
    expect(notification.title).toBe('Recipe added');
    expect(notification.body).toBe(`Added Chicken tikka masala · 12 items to ${listName(groceries)}`);
    expect(takeRecipeAddResult(groceries)).toBeNull();
    notification.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    expect(currentList()).toBe(groceries);
    expect(takeRecipeAddResult(groceries)).toMatchObject({ kind: 'imported', recipeName: 'Chicken tikka masala' });
  });

  test('closed while reading, a failure comes as a notification that reopens the sheet', async () => {
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    act(() => {
      void byLabel(root, 'Add recipe').props.onPress();
    });
    act(() => root.unmount());
    tree = null;
    await act(async () => pending.resolve({ ok: false, error: 'blocked' }));
    const notification = mockNotify.mock.calls[0][0] as { title: string; onPress: () => void };
    expect(notification.title).toBe("Couldn't import recipe");
    notification.onPress();
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/import-recipe',
      params: { to: groceries, url: 'https://example.com/tikka' },
    });
  });

  test('reopened from that notification, the link is filled and the list chosen, picker still shown', () => {
    const party = createList('Party');
    mockParams.to = party;
    mockParams.url = 'https://example.com/tikka';
    const root = render(<ImportRecipeSheet />);
    expect(field(root).props.value).toBe('https://example.com/tikka');
    expect(selectedPills(root)).toEqual(['Party']);
    expect(texts(root)).toContain('To');
  });

  test('Cancel closes the sheet', () => {
    const root = render(<ImportRecipeSheet />);
    act(() => byType(root, 'ToolbarButton').find((n) => n.props.children === 'Cancel')!.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

describe('RecipesScreen', () => {
  const cards = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && /ingredient/.test(n.props.accessibilityLabel ?? ''))
      .map((n) => n.props.accessibilityLabel as string)
      .filter((l, i, all) => all.indexOf(l) === i);

  test('empty: "No recipes yet." with New recipe, which creates one and opens it', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipesScreen />);
    expect(texts(root)).toContain('No recipes yet.');
    press(byLabel(root, 'New recipe'));
    const create = (prompt.mock.calls[0][2] as AlertButton[]).find((b) => b.text === 'Create')!;
    // A blank name creates nothing.
    act(() => (create.onPress as (n: string) => void)('  '));
    expect(mockPush).not.toHaveBeenCalled();
    act(() => (create.onPress as (n: string) => void)('Tacos'));
    const [[route]] = mockPush.mock.calls as [[{ pathname: string; params: { id: string } }]];
    expect(route.pathname).toBe('/recipe/[id]');
    expect(getRecipe(route.params.id)!.name).toBe('Tacos');
  });

  test('the toolbar New recipe prompts too', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipesScreen />);
    act(() => byType(root, 'ToolbarButton').find((n) => n.props.accessibilityLabel === 'New recipe')!.props.onPress());
    expect(prompt.mock.calls[0][0]).toBe('New recipe');
  });

  test('a card per recipe under its household, with its count and the list it is on', () => {
    const tacos = createRecipe('Tacos');
    addRecipeIngredient(tacos, '8 tortillas');
    addRecipeIngredient(tacos, 'salsa');
    createRecipe('Soup');
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    db.insert(recipes).values({ id: 'chili', householdId: 'lake', name: 'Campfire chili' }).run();
    addItemsBulk(groceries, [{ text: 'tortillas', source: 'recipe', recipeId: tacos }], USER);
    const name = db.select().from(lists).all().find((l) => l.id === groceries)!.name;

    const root = render(<RecipesScreen />);
    expect(texts(root)).not.toContain('No recipes yet.');
    const headers = root.root
      .findAll((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'header')
      .map((n) => n.props.children);
    expect([...headers].sort()).toEqual(['Lake house', 'Personal']);
    expect(texts(root)).toEqual(expect.arrayContaining(['Tacos', '2 ingredients', `On ${name}`, 'Soup', 'Campfire chili']));
    expect(cards(root).length).toBe(3);
    const links = byType(root, 'Link').map((l) => l.props.href.params.id);
    expect(links).toEqual(expect.arrayContaining([tacos, 'chili']));
  });

  test("a card's menu renames and deletes (after confirming)", () => {
    const tacos = createRecipe('Tacos');
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<RecipesScreen />);
    const action = (title: string) => byType(root, 'LinkMenuAction').find((n) => n.props.title === title)!;

    act(() => action('Rename').props.onPress());
    expect(prompt.mock.calls[0].slice(0, 1)).toEqual(['Rename recipe']);
    expect(prompt.mock.calls[0][4]).toBe('Tacos');

    act(() => action('Delete').props.onPress());
    const [title, , buttons] = alert.mock.calls[0];
    expect(title).toBe('Delete “Tacos”?');
    act(() => (buttons as AlertButton[]).find((b) => b.text === 'Delete')!.onPress!());
    expect(getRecipe(tacos)).toBeUndefined();
  });

  test('a recipe shared while the tab shows: a toast with Undo and Open list, its card outlined', () => {
    const tacos = createRecipe('Tacos');
    const undo = jest.fn();
    setLastOpenedList(createList('Party'));
    const root = render(<RecipesScreen />);
    expect(mockShareListener).not.toBeNull();
    act(() => mockShareListener!([success({ recipeId: tacos, recipeName: 'Tacos', added: 3, undo })]));
    const name = db.select().from(lists).all().find((l) => l.id === groceries)!.name;
    expect(texts(root).join(' ')).toContain(`on ${name}`);
    const highlighted = root.root.findAll((n) => typeof n.type !== 'string' && n.props.highlighted === true);
    expect(highlighted.map((n) => n.props.recipe.id)).toEqual([tacos]);
    press(byA11y(root, 'Open list'));
    // The List tab, showing the list the recipe went to.
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    expect(mockPush).not.toHaveBeenCalled();
    expect(currentList()).toBe(groceries);
    expect(allByA11y(root, 'Undo')).toHaveLength(0);

    act(() => mockShareListener!([success({ recipeId: tacos, recipeName: 'Tacos', added: 3, undo })]));
    press(byA11y(root, 'Undo'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(allByA11y(root, 'Undo')).toHaveLength(0);
  });

  test('several shared at once: "Added 3 recipes" without actions', () => {
    const root = render(<RecipesScreen />);
    act(() => mockShareListener!([success(), success({ recipeId: 'r2' }), success({ recipeId: 'r3' })]));
    expect(texts(root)).toContain('Added 3 recipes');
    expect(allByA11y(root, 'Undo')).toHaveLength(0);
  });

  test('leaving the tab stops listening for shared imports', () => {
    render(<RecipesScreen />);
    expect(mockShareListener).not.toBeNull();
    act(() => tree!.unmount());
    tree = null;
    expect(mockShareListener).toBeNull();
  });

  test('failed imports show the imports card above the empty state', () => {
    recordFailedImport({ url: 'https://example.com/a', title: 'Pho', reason: 'not_a_recipe' });
    const root = render(<RecipesScreen />);
    expect(root.root.findAll((n) => n.type === ImportsCard)).toHaveLength(1);
    expect(texts(root)).toEqual(expect.arrayContaining(["Couldn't import 1 recipe", 'No recipes yet.']));
  });

  test('without imports there is no card', () => {
    const root = render(<RecipesScreen />);
    expect(root.root.findAll((n) => n.type === ImportsCard)).toHaveLength(0);
  });
});

describe('ImportsCard', () => {
  const share = (id: string, over: Partial<ShareQueueStatus['queued'][number]> = {}) => ({
    id,
    url: `https://www.example.com/${id}`,
    title: null,
    listName: 'Groceries',
    attempts: 0,
    ...over,
  });
  const failedRows = () => failedImportsQuery().all();
  const heading = (root: ReactTestRenderer) =>
    root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityState?.expanded !== undefined && !!n.props.onPress);

  test('nothing to show: renders nothing', () => {
    const root = render(<ImportsCard failed={[]} queue={EMPTY_SHARE_QUEUE_STATUS} />);
    expect(texts(root)).toEqual([]);
  });

  test('waiting shares: the heading, then a row each with Remove when opened', () => {
    const queue: ShareQueueStatus = { queued: [share('a', { title: 'Pho', attempts: 2 }), share('b')], importing: null, waitReason: 'offline' };
    const root = render(<ImportsCard failed={[]} queue={queue} />);
    expect(texts(root)).toEqual(['2 recipes waiting', "You're offline. They'll import when you're back."]);
    expect(heading(root).props.accessibilityState).toEqual({ expanded: false });
    press(heading(root));
    expect(heading(root).props.accessibilityState).toEqual({ expanded: true });
    expect(texts(root)).toEqual(
      expect.arrayContaining(['Pho', 'example.com · to Groceries · tried twice', 'example.com', 'example.com · to Groceries']),
    );
    // One group only: no group labels.
    expect(texts(root)).not.toContain('Waiting');
    press(byA11y(root, 'Remove Pho'));
    expect(mockRemoveShare).toHaveBeenCalledWith('a', USER);
    press(heading(root));
    expect(texts(root)).not.toContain('Pho');
  });

  test('the share importing now shows a spinner instead of Remove', () => {
    const queue: ShareQueueStatus = {
      queued: [share('a', { title: 'Pho' }), share('b')],
      importing: { id: 'a', position: 1, total: 2 },
      waitReason: null,
    };
    const root = render(<ImportsCard failed={[]} queue={queue} />);
    expect(texts(root)).toEqual(['Importing 1 of 2…', 'Pho · to Groceries']);
    press(heading(root));
    expect(root.root.findAll((n) => n.props.accessibilityLabel === 'Importing Pho')).not.toHaveLength(0);
    expect(allByLabel(root, 'Remove')).toHaveLength(1);
  });

  test('failed and waiting together: grouped under "Couldn\'t import" and "Waiting"', () => {
    recordFailedImport({ url: 'https://example.com/x', title: 'Pho', reason: 'blocked' });
    const queue: ShareQueueStatus = { queued: [share('b')], importing: null, waitReason: null };
    const root = render(<ImportsCard failed={failedRows()} queue={queue} />);
    expect(texts(root)[0]).toBe("Couldn't import 1 recipe");
    press(heading(root));
    expect(texts(root)).toEqual(expect.arrayContaining(["Couldn't import", 'Waiting', 'Pho', 'The site blocked the import']));
  });

  test('Dismiss removes a failed import', () => {
    recordFailedImport({ url: 'https://example.com/x', title: 'Pho', reason: 'failed' });
    const root = render(<ImportsCard failed={failedRows()} queue={EMPTY_SHARE_QUEUE_STATUS} />);
    press(heading(root));
    expect(texts(root)).not.toContain("Couldn't import");
    press(byLabel(root, 'Dismiss'));
    expect(failedRows()).toEqual([]);
  });

  test('Try again imports into the default list; while trying it says so', async () => {
    recordFailedImport({ url: 'https://example.com/x', title: 'Pho', reason: 'offline' });
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportsCard failed={failedRows()} queue={EMPTY_SHARE_QUEUE_STATUS} />);
    press(heading(root));
    act(() => {
      void byLabel(root, 'Try again').props.onPress();
    });
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/x', listId: groceries });
    const trying = byLabel(root, 'Trying…');
    expect(trying.props.disabled).toBe(true);
    await act(async () => pending.resolve(success()));
    expect(failedRows()).toEqual([]);
  });

  test('Try again failing again updates the reason and re-enables it', async () => {
    recordFailedImport({ url: 'https://example.com/x', title: 'Pho', reason: 'offline' });
    mockImport.mockResolvedValue({ ok: false, error: 'not_a_recipe' });
    const root = render(<ImportsCard failed={failedRows()} queue={EMPTY_SHARE_QUEUE_STATUS} />);
    press(heading(root));
    await pressAsync(byLabel(root, 'Try again'));
    expect(failedRows()[0].reason).toBe('not_a_recipe');
    expect(byLabel(root, 'Try again').props.disabled).toBe(false);
  });
});
