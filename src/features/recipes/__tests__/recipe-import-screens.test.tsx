// "Add recipe from link…" (spec 4.10), the Recipes tab (spec 4.5, board 05) and its imports card,
// rendered against the in-memory database with the import itself and the share queue stubbed.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, lists, recipeIngredients, recipes } from '@/db';
import { setStaple } from '@/features/households/staples';
import { addItemsBulk, listItemsQuery } from '@/features/lists/items';
import {
  createList,
  ensureStarterData,
  getDefaultListId,
  LAST_OPENED_LIST_KEY,
  setLastOpenedList,
  setListArchived,
} from '@/features/lists/lists';
import { takeRecipeAddResult } from '@/features/lists/recipe-add-result';
import { setFeatures } from '@/features/plans/features';
import { pressAddButton } from '@/features/tabs/add-button';
import { getDeviceSetting, setDeviceSetting, setPlanTab } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import { StatusBar } from 'expo-status-bar';

import { recipeHue } from '@/domain/aisle-color';

import ImportRecipeSheet from '@/app/import-recipe';
import { Card } from '@/components/card';
import { HeaderPill } from '@/components/header-pill';
import { IconTile } from '@/components/icon-tile';
import { Pill } from '@/components/pill';
import RecipeFilterSheet from '@/app/(tabs)/recipes/filter';
import RecipesScreen from '@/app/(tabs)/recipes/index';
import { emptyRecipeTags } from '@/shared/recipe-tags';

import type { ImportRecipeInput, ImportRecipePhotosInput, ImportRecipeResult, ImportRecipeSuccess } from '../import';
import { photosParam } from '../photo-import';
import { ImportsCard } from '../imports-card';
import { getRecipeFilters, setRecipeFilters } from '../recipe-filter-store';
import { noRecipeFilters, toggleRecipeFilter } from '../recipe-filters';
import {
  addRecipeIngredient,
  createRecipe,
  deleteRecipe,
  deleteRecipeIngredient,
  getRecipe,
  updateRecipe,
  updateRecipeTags,
} from '../recipes';
import { failedImportsQuery, recordFailedImport } from '../failed-imports';
import { IMPORT_ADD_TO_LIST_KEY } from '../save-choice';
import { setSavedRecipeResult, takeSavedRecipeResult } from '../saved-recipe-result';
import { EMPTY_SHARE_QUEUE_STATUS, setShareQueueStatus, type ShareQueueStatus } from '../share-queue-status';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
// A card's swipe as a host element, so a test can "swipe" by calling its callbacks; close() reports the card's recipe.
const mockCloseCard = jest.fn((_recipeId: string) => {});
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement, forwardRef, useImperativeHandle } = require('react');
  const Swipeable = forwardRef(function Swipeable(
    { children, ...props }: { children: { props: { href: { params: { id: string } } } } },
    ref: unknown,
  ) {
    const id = children.props.href.params.id;
    useImperativeHandle(ref, () => ({ close: () => mockCloseCard(id) }), [id]);
    return createElement('Swipeable', props, children);
  });
  return { __esModule: true, default: Swipeable };
});
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});
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
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
// The connection the import sheet sees when it opens (spec 4.10: offline stays inline).
let mockConnected = true;
jest.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: () => Promise.resolve({ isConnected: mockConnected, isInternetReachable: mockConnected }),
}));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/categories/categorization', () => ({ categorizePending: () => Promise.resolve() }));

const mockImport = jest.fn<(input: ImportRecipeInput) => Promise<ImportRecipeResult>>();
const mockPhotoImport = jest.fn<(input: ImportRecipePhotosInput) => Promise<ImportRecipeResult>>();
jest.mock('@/features/recipes/import', () => ({
  ...(jest.requireActual('@/features/recipes/import') as object),
  importRecipe: (input: ImportRecipeInput) => mockImport(input),
  importRecipeFromPhotos: (input: ImportRecipePhotosInput) => mockPhotoImport(input),
}));
const mockClipboard = jest.fn<() => Promise<string>>();
jest.mock('expo-clipboard', () => ({ getStringAsync: () => mockClipboard() }));
const mockOpenLink = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('@/features/recipes/recipe-link', () => ({
  ...(jest.requireActual('@/features/recipes/recipe-link') as object),
  openRecipeLink: (url: string) => mockOpenLink(url),
}));
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
    Stack: { Screen: () => null, Toolbar, SearchBar: host('SearchBar') },
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      back: () => mockBack(),
      navigate: (...args: unknown[]) => mockNavigate(...args),
    },
    // Focus is mount: subscribe on mount, unsubscribe on unmount.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => mockParams,
    usePathname: () => '/recipes',
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
  // The Recipes header without All recipes | This week.
  setPlanTab(true);
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  for (const fn of [mockPush, mockBack, mockNavigate, mockNotify, mockRemoveShare, mockOpenLink, mockCloseCard]) fn.mockClear();
  mockImport.mockReset();
  mockPhotoImport.mockReset();
  mockClipboard.mockReset();
  mockConnected = true;
  setShareQueueStatus(EMPTY_SHARE_QUEUE_STATUS);
  setFeatures(['categorize', 'recipe_import']);
  takeRecipeAddResult(groceries);
  takeSavedRecipeResult();
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
  created: true,
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

  const toggle = (root: ReactTestRenderer) =>
    root.root.find(
      (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Also add ingredients to a list' && 'onValueChange' in n.props,
    );
  const setSwitch = (root: ReactTestRenderer, on: boolean) => act(() => toggle(root).props.onValueChange(on));
  const personal = () => db.select().from(households).all().find((h) => h.name === 'Personal')!.id;
  const remembered = () =>getDeviceSetting<boolean | null>(IMPORT_ADD_TO_LIST_KEY, null);
  const addLake = () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    return createList('Cabin', 'lake');
  };

  test('with no households it renders nothing', () => {
    resetDb();
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).toEqual([]);
  });

  test('a household with no lists can still save the recipe; the switch is off and disabled', async () => {
    db.update(lists).set({ archivedAt: new Date() }).run();
    setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, true);
    mockImport.mockResolvedValue(success({ listId: null, added: 0 }));
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).toContain('This household has no lists');
    expect(toggle(root).props.value).toBe(false);
    expect(toggle(root).props.disabled).toBe(true);
    expect(toggle(root).props.accessibilityHint).toBe('This household has no lists');
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Save recipe'));
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/tikka', householdId: personal() });
  });

  test('from the Recipes tab the switch starts off: no list picker, "Save recipe"', () => {
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Add recipe from link', 'Also add ingredients to a list', 'Link']));
    // One household: no household picker.
    expect(texts(root)).not.toContain('Save to');
    expect(texts(root)).not.toContain('List');
    expect(toggle(root).props.value).toBe(false);
    expect(toggle(root).props.disabled).toBe(false);
    expect(toggle(root).props.accessibilityHint).toBe("Adds the recipe's ingredients to the chosen list");
    expect(selectedPills(root)).toEqual([]);
    expect(byLabel(root, 'Save recipe')).toBeDefined();
  });

  test('turning the switch on shows the lists, starting on the last opened one, and names it on the button', () => {
    const party = createList('Party');
    setLastOpenedList(party);
    const root = render(<ImportRecipeSheet />);
    setSwitch(root, true);
    expect(texts(root)).toContain('List');
    expect(selectedPills(root)).toEqual(['Party']);
    expect(byLabel(root, 'Save & add to Party')).toBeDefined();
    press(byLabel(root, listName(groceries)));
    expect(selectedPills(root)).toEqual([listName(groceries)]);
    expect(byLabel(root, `Save & add to ${listName(groceries)}`)).toBeDefined();
    setSwitch(root, false);
    expect(selectedPills(root)).toEqual([]);
    expect(byLabel(root, 'Save recipe')).toBeDefined();
  });

  test('the Recipes tab remembers the switch on this device', () => {
    expect(remembered()).toBeNull();
    const first = render(<ImportRecipeSheet />);
    setSwitch(first, true);
    expect(remembered()).toBe(true);
    act(() => first.unmount());
    const second = render(<ImportRecipeSheet />);
    expect(toggle(second).props.value).toBe(true);
    setSwitch(second, false);
    expect(remembered()).toBe(false);
  });

  test('with several households: Save to defaults to the last opened list\'s household; changing it resets the list', () => {
    const cabin = addLake();
    const dock = createList('Dock', 'lake');
    setLastOpenedList(dock);
    setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, true);
    const root = render(<ImportRecipeSheet />);
    expect(texts(root)).toContain('Save to');
    expect(selectedPills(root)).toEqual(['Lake house', 'Dock']);
    // Only that household's lists.
    expect(allByLabel(root, listName(groceries))).toHaveLength(0);
    press(byLabel(root, 'Personal'));
    expect(selectedPills(root)).toEqual(['Personal', listName(groceries)]);
    expect(allByLabel(root, 'Cabin')).toHaveLength(0);
    // Back to Lake house: its default by the same rule, the last opened list.
    press(byLabel(root, 'Lake house'));
    expect(selectedPills(root)).toEqual(['Lake house', 'Dock']);
    expect(cabin).toBeTruthy();
  });

  test("from a list's menu: that list's household, the switch on with that list chosen", () => {
    const cabin = addLake();
    setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, false);
    mockParams.list = cabin;
    const root = render(<ImportRecipeSheet />);
    expect(toggle(root).props.value).toBe(true);
    expect(selectedPills(root)).toEqual(['Lake house', 'Cabin']);
    expect(byLabel(root, 'Save & add to Cabin')).toBeDefined();
    // Turning it off here isn't remembered for the Recipes tab.
    setSwitch(root, false);
    expect(byLabel(root, 'Save recipe')).toBeDefined();
    expect(remembered()).toBe(false);
    setSwitch(root, true);
    expect(remembered()).toBe(false);
  });

  test('Save is disabled until there is text', () => {
    const root = render(<ImportRecipeSheet />);
    expect(byLabel(root, 'Save recipe').props.disabled).toBe(true);
    type(root, 'https://example.com/tikka');
    expect(byLabel(root, 'Save recipe').props.disabled).toBe(false);
  });

  test('text that is not a link shows the error without importing; typing clears it', async () => {
    const root = render(<ImportRecipeSheet />);
    type(root, 'chicken tikka');
    await pressAsync(byLabel(root, 'Save recipe'));
    expect(mockImport).not.toHaveBeenCalled();
    expect(texts(root)).toContain("That doesn't look like a link");
    // The sheet stays open and nothing is posted.
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    type(root, 'https://example.com');
    expect(texts(root)).not.toContain("That doesn't look like a link");
  });

  test('offline: "You\'re offline" inline with the sheet open, nothing imported or posted; typing clears it', async () => {
    mockConnected = false;
    const root = render(<ImportRecipeSheet />);
    await act(async () => {});
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Save recipe'));
    expect(texts(root)).toContain("You're offline");
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(byLabel(root, 'Save recipe').props.disabled).toBe(false);
    type(root, 'https://example.com/tikka2');
    expect(texts(root)).not.toContain("You're offline");
  });

  test('an invalid link while offline says it isn\'t a link', async () => {
    mockConnected = false;
    const root = render(<ImportRecipeSheet />);
    await act(async () => {});
    type(root, 'chicken tikka');
    await pressAsync(byLabel(root, 'Save recipe'));
    expect(texts(root)).toContain("That doesn't look like a link");
    expect(texts(root)).not.toContain("You're offline");
    expect(mockNotify).not.toHaveBeenCalled();
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

  test('Save closes the sheet at once and posts "Importing your recipe"; the button has no reading state', async () => {
    const party = createList('Party');
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportRecipeSheet />);
    setSwitch(root, true);
    press(byLabel(root, 'Party'));
    type(root, 'https://example.com/tikka');
    act(() => {
      void byLabel(root, 'Save & add to Party').props.onPress();
    });
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/tikka', listId: party });
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const importing = mockNotify.mock.calls[0][0] as { id: string; onPress?: unknown };
    expect(importing).toEqual({
      id: importing.id,
      kind: 'recipeImport',
      icon: 'fork.knife',
      hue: recipeHue(importing.id),
      tone: 'success',
      title: 'Importing your recipe',
      body: "We'll let you know when it's ready.",
    });
    expect(importing.id).toMatch(/^recipe-import-[0-9a-f-]{36}$/);
    // No tap action beyond dismissing.
    expect(importing.onPress).toBeUndefined();
    // Nothing on the sheet says it's reading.
    expect(allByLabel(root, 'Reading recipe…')).toHaveLength(0);
    expect(texts(root).some((s) => s.startsWith('You can close this'))).toBe(false);
    expect(field(root).props.editable).toBeUndefined();
    // A second submit before the sheet goes does nothing.
    await act(async () => {
      await field(root).props.onSubmitEditing();
    });
    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(success({ listId: party })));
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  test('success replaces the Importing notification with "Recipe added"; tapping it opens the list with its toast', async () => {
    const party = createList('Party');
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportRecipeSheet />);
    setSwitch(root, true);
    press(byLabel(root, 'Party'));
    type(root, 'https://example.com/tikka');
    act(() => {
      void byLabel(root, 'Save & add to Party').props.onPress();
    });
    const id = (mockNotify.mock.calls[0][0] as { id: string }).id;
    const result = success({ listId: party });
    await act(async () => pending.resolve(result));
    // Nothing happens on its own: the sheet closed once and no list opened.
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(takeRecipeAddResult(party)).toBeNull();
    const notification = mockNotify.mock.calls[1][0] as { id: string; title: string; body: string; hint: string; onPress: () => void };
    expect(notification).toMatchObject({
      id,
      kind: 'recipeImport',
      tone: 'success',
      title: 'Recipe added',
      body: 'Added Chicken tikka masala · 12 items to Party',
      emphasis: 'Chicken tikka masala',
      hint: 'Opens Party',
    });
    notification.onPress();
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
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

  test('each import has its own notification id', async () => {
    mockImport.mockResolvedValue(success());
    const first = render(<ImportRecipeSheet />);
    type(first, 'https://example.com/tikka');
    await pressAsync(byLabel(first, 'Save recipe'));
    act(() => first.unmount());
    const second = render(<ImportRecipeSheet />);
    type(second, 'https://example.com/tikka');
    await pressAsync(byLabel(second, 'Save recipe'));
    const ids = mockNotify.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  test("from a list's menu, success comes as the notification too", async () => {
    mockParams.list = groceries;
    mockImport.mockResolvedValue(success());
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, `Save & add to ${listName(groceries)}`));
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/tikka', listId: groceries });
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(takeRecipeAddResult(groceries)).toBeNull();
    expect(mockNotify.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['Importing your recipe', 'Recipe added']);
  });

  test('switch off from the Recipes tab: imports recipe-only, leaves lists alone, and says "Recipe saved"', async () => {
    setLastOpenedList(groceries);
    const result = success({ listId: null, added: 0 });
    mockImport.mockResolvedValue(result);
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Save recipe'));
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/tikka', householdId: personal() });
    expect(mockBack).toHaveBeenCalledTimes(1);
    // No list opened, no list toast and no Recipes tab toast.
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(takeRecipeAddResult(groceries)).toBeNull();
    expect(takeSavedRecipeResult()).toBeNull();
    const [importing, saved] = mockNotify.mock.calls.map((c) => c[0] as { id: string; title: string; body: string; onPress: () => void });
    expect(saved).toMatchObject({ id: importing.id, title: 'Recipe saved', body: `Saved Chicken tikka masala to Personal` });
    saved.onPress();
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: 'recipe-1' } });
  });

  test("switch off from a list's menu: recipe-only into that list's household, and \"Recipe saved\"", async () => {
    const cabin = addLake();
    mockParams.list = cabin;
    mockImport.mockResolvedValue(success({ listId: null, added: 0, created: false }));
    const root = render(<ImportRecipeSheet />);
    setSwitch(root, false);
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Save recipe'));
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/tikka', householdId: 'lake' });
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(takeSavedRecipeResult()).toBeNull();
    expect(takeRecipeAddResult(cabin)).toBeNull();
    expect(mockNotify.mock.calls[1][0]).toMatchObject({ title: 'Recipe saved', body: 'Saved Chicken tikka masala to Lake house' });
  });

  test('a list from another household, after switching household, imports onto that list', async () => {
    const cabin = addLake();
    setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, true);
    mockImport.mockResolvedValue(success({ listId: cabin }));
    const root = render(<ImportRecipeSheet />);
    press(byLabel(root, 'Lake house'));
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Save & add to Cabin'));
    expect(mockImport).toHaveBeenCalledWith({ url: 'https://example.com/tikka', listId: cabin });
  });

  test.each([
    [{ ok: false, error: 'not_a_recipe' } as const, "That page doesn't look like a recipe"],
    [{ ok: false, error: 'offline' } as const, "You're offline"],
    [{ ok: false, error: 'not_entitled' } as const, "Recipe import isn't included in your plan."],
    [{ ok: false, error: 'failed', reason: 'fetch_failed' } as const, "Couldn't reach that site"],
    [{ ok: false, error: 'blocked' } as const, 'This site blocked the import. Open it in Safari and tap Share → The Perfect Bite.'],
    [{ ok: false, error: 'rate_limited' } as const, 'Try again in a minute'],
  ])('a server failure replaces the Importing notification with its reason; nothing inline (%o)', async (result, message) => {
    mockImport.mockResolvedValue(result);
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    await pressAsync(byLabel(root, 'Save recipe'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(texts(root)).not.toContain(message);
    expect(takeSavedRecipeResult()).toBeNull();
    expect(mockNotify).toHaveBeenCalledTimes(2);
    const [importing, failed] = mockNotify.mock.calls.map((c) => c[0] as { id: string });
    expect(failed).toMatchObject({
      id: importing.id,
      kind: 'recipeImport',
      tone: 'warning',
      hue: 'rose',
      icon: 'exclamationmark.triangle.fill',
      title: "Couldn't import recipe",
      body: message,
      hint: 'Opens the link again to try once more',
    });
  });

  test('a failure that lands after the Importing banner went still comes, with the same id', async () => {
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    act(() => {
      void byLabel(root, 'Save recipe').props.onPress();
    });
    // The sheet is gone by the time the answer comes.
    act(() => root.unmount());
    tree = null;
    await act(async () => pending.resolve({ ok: false, error: 'blocked' }));
    expect(mockNotify).toHaveBeenCalledTimes(2);
    const [importing, notification] = mockNotify.mock.calls.map((c) => c[0] as { id: string; title: string; onPress: () => void });
    expect(notification.id).toBe(importing.id);
    expect(notification.title).toBe("Couldn't import recipe");
    notification.onPress();
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/import-recipe',
      params: { household: personal(), add: '0', url: 'https://example.com/tikka' },
    });
  });

  test('a failure with the switch on reopens onto the same household and list', async () => {
    const cabin = addLake();
    mockParams.list = cabin;
    const pending = deferred<ImportRecipeResult>();
    mockImport.mockReturnValue(pending.promise);
    const root = render(<ImportRecipeSheet />);
    type(root, 'https://example.com/tikka');
    act(() => {
      void byLabel(root, 'Save & add to Cabin').props.onPress();
    });
    act(() => root.unmount());
    tree = null;
    await act(async () => pending.resolve({ ok: false, error: 'not_a_recipe' }));
    (mockNotify.mock.calls[1][0] as { onPress: () => void }).onPress();
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/import-recipe',
      params: { household: 'lake', add: '1', to: cabin, url: 'https://example.com/tikka' },
    });
  });

  test('reopened from that notification: the link, household, switch and list are as they were', () => {
    addLake();
    const dock = createList('Dock', 'lake');
    // The Recipes tab's remembered state doesn't apply to a retry.
    setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, false);
    Object.assign(mockParams, { household: 'lake', add: '1', to: dock, url: 'https://example.com/tikka' });
    const root = render(<ImportRecipeSheet />);
    expect(field(root).props.value).toBe('https://example.com/tikka');
    expect(toggle(root).props.value).toBe(true);
    expect(selectedPills(root)).toEqual(['Lake house', 'Dock']);
    expect(byLabel(root, 'Save & add to Dock')).toBeDefined();
  });

  test('reopened recipe-only into a household that is gone: the default household, switch still off', () => {
    setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, true);
    Object.assign(mockParams, { household: 'gone', add: '0', url: 'https://example.com/tikka' });
    const root = render(<ImportRecipeSheet />);
    expect(toggle(root).props.value).toBe(false);
    expect(byLabel(root, 'Save recipe')).toBeDefined();
  });

  test('Cancel closes the sheet', () => {
    const root = render(<ImportRecipeSheet />);
    act(() => byType(root, 'ToolbarButton').find((n) => n.props.children === 'Cancel')!.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  describe('with photos (spec 4.10)', () => {
    const PAGES = ['file:///cache/page-1.jpg', 'file:///cache/page-2.jpg'];
    const pages = (root: ReactTestRenderer) => root.root.findAll((n) => n.props.testID === 'import-page' && typeof n.type === 'string');

    beforeEach(() => {
      mockParams.photos = photosParam(PAGES);
    });

    test('the pages as thumbnails in order, in place of the link field; Save is ready at once', () => {
      const root = render(<ImportRecipeSheet />);
      expect(texts(root)).toEqual(expect.arrayContaining(['Add recipe from photo', 'Pages']));
      expect(texts(root)).not.toContain('Add recipe from link');
      expect(root.root.findAll((n) => String(n.type) === 'TextInput')).toEqual([]);
      expect(byLabel(root, 'Paste')).toBeUndefined();
      expect(pages(root).map((n) => n.props.accessibilityLabel)).toEqual(['Page 1 of 2', 'Page 2 of 2']);
      expect(byType(root, 'ExpoImage').map((n) => n.props.source)).toEqual(PAGES);
      expect(byLabel(root, 'Save recipe').props.disabled).toBe(false);
      expect(byLabel(root, 'Save recipe').props.icon).toBe('camera');
    });

    test('a photos param that is not one to three pages falls back to the link sheet', () => {
      mockParams.photos = photosParam(['a', 'b', 'c', 'd']);
      const root = render(<ImportRecipeSheet />);
      expect(texts(root)).toContain('Add recipe from link');
      expect(pages(root)).toEqual([]);
    });

    test('switch on: Save closes at once with Importing, then "Recipe added" opens the list with its toast', async () => {
      const result = success();
      const pending = deferred<ImportRecipeResult>();
      mockPhotoImport.mockReturnValue(pending.promise);
      const root = render(<ImportRecipeSheet />);
      setSwitch(root, true);
      press(byLabel(root, listName(groceries)));
      act(() => {
        void byLabel(root, `Save & add to ${listName(groceries)}`).props.onPress();
      });
      expect(mockPhotoImport).toHaveBeenCalledWith({ listId: groceries, photoUris: PAGES });
      expect(mockImport).not.toHaveBeenCalled();
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledTimes(1);
      const importing = mockNotify.mock.calls[0][0] as { id: string };
      expect(importing).toMatchObject({ title: 'Importing your recipe', icon: 'fork.knife', hue: recipeHue(importing.id) });
      act(() => root.unmount());
      tree = null;
      await act(async () => pending.resolve(result));
      expect(mockNavigate).not.toHaveBeenCalled();
      const notification = mockNotify.mock.calls[1][0] as { id: string; title: string; body: string; onPress: () => void };
      expect(notification.id).toBe(importing.id);
      expect(notification.title).toBe('Recipe added');
      expect(notification.body).toBe(`Added Chicken tikka masala · 12 items to ${listName(groceries)}`);
      notification.onPress();
      expect(mockNavigate).toHaveBeenCalledWith('/lists');
      expect(takeRecipeAddResult(groceries)).toMatchObject({ kind: 'imported', recipeName: 'Chicken tikka masala', count: 12, undo: result.undo });
    });

    test('switch off: recipe-only into the household, "Recipe saved"', async () => {
      mockPhotoImport.mockResolvedValue(success({ listId: null, added: 0 }));
      const root = render(<ImportRecipeSheet />);
      await pressAsync(byLabel(root, 'Save recipe'));
      expect(mockPhotoImport).toHaveBeenCalledWith({ householdId: personal(), photoUris: PAGES });
      expect(takeSavedRecipeResult()).toBeNull();
      expect(mockNotify.mock.calls.map((c) => (c[0] as { title: string }).title)).toEqual(['Importing your recipe', 'Recipe saved']);
    });

    test('no "Reading recipe…" or "You can close this…" on the photo sheet', () => {
      mockPhotoImport.mockReturnValue(deferred<ImportRecipeResult>().promise);
      const root = render(<ImportRecipeSheet />);
      act(() => {
        void byLabel(root, 'Save recipe').props.onPress();
      });
      expect(allByLabel(root, 'Reading recipe…')).toHaveLength(0);
      expect(byLabel(root, 'Save recipe').props.icon).toBe('camera');
      expect(texts(root).some((s) => s.startsWith('You can close this'))).toBe(false);
    });

    test('offline: "You\'re offline" inline, nothing imported or posted', async () => {
      mockConnected = false;
      const root = render(<ImportRecipeSheet />);
      await act(async () => {});
      await pressAsync(byLabel(root, 'Save recipe'));
      expect(texts(root)).toContain("You're offline");
      expect(pages(root)).toHaveLength(2);
      expect(mockPhotoImport).not.toHaveBeenCalled();
      expect(mockBack).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    test.each([
      [{ ok: false, error: 'not_a_recipe' } as const, "That photo doesn't look like a recipe"],
      [{ ok: false, error: 'rate_limited' } as const, 'Try again in a minute'],
      [{ ok: false, error: 'not_entitled' } as const, "Photo import isn't in your plan"],
      [{ ok: false, error: 'offline' } as const, "You're offline"],
    ])("a failed photo import replaces Importing with the photo sheet's reason (%o)", async (result, message) => {
      mockPhotoImport.mockResolvedValue(result);
      const root = render(<ImportRecipeSheet />);
      await pressAsync(byLabel(root, 'Save recipe'));
      expect(texts(root)).not.toContain(message);
      expect(mockBack).toHaveBeenCalledTimes(1);
      const [importing, failed] = mockNotify.mock.calls.map((c) => c[0] as { id: string });
      expect(failed).toMatchObject({ id: importing.id, title: "Couldn't import recipe", body: message, tone: 'warning' });
    });

    test('a failure says why for a photo and opens Add recipe', async () => {
      const pending = deferred<ImportRecipeResult>();
      mockPhotoImport.mockReturnValue(pending.promise);
      const root = render(<ImportRecipeSheet />);
      act(() => {
        void byLabel(root, 'Save recipe').props.onPress();
      });
      act(() => root.unmount());
      tree = null;
      await act(async () => pending.resolve({ ok: false, error: 'not_a_recipe' }));
      expect(mockNotify).toHaveBeenCalledTimes(2);
      const id = (mockNotify.mock.calls[0][0] as { id: string }).id;
      const notification = mockNotify.mock.calls[1][0] as { id: string; title: string; body: string; hint: string; onPress: () => void };
      expect(notification).toMatchObject({
        id,
        title: "Couldn't import recipe",
        body: "That photo doesn't look like a recipe",
        hint: 'Opens Add recipe to try again',
      });
      notification.onPress();
      expect(mockPush).toHaveBeenCalledWith('/add-recipe');
    });
  });
});

describe('RecipesScreen', () => {
  /** Each recipe row's VoiceOver label, in order. */
  const cards = (root: ReactTestRenderer) =>
    byType(root, 'Link').map((l) => l.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string);
  const headers = (root: ReactTestRenderer) =>
    root.root.findAll((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'header').map((n) => n.props.children as string);

  test('empty: "No recipes yet." with New recipe, which opens the Add recipe sheet', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipesScreen />);
    expect(texts(root)).toContain('No recipes yet.');
    press(byLabel(root, 'New recipe'));
    expect(mockPush.mock.calls).toEqual([['/add-recipe']]);
    expect(prompt).not.toHaveBeenCalled();
  });

  test("the tab bar's + opens the sheet too, not a prompt", () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    render(<RecipesScreen />);
    act(() => pressAddButton());
    expect(mockPush.mock.calls).toEqual([['/add-recipe']]);
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a row per recipe in its household’s card, with its meal and time and the list it is on', () => {
    const tacos = createRecipe('Tacos');
    addRecipeIngredient(tacos, '8 tortillas');
    addRecipeIngredient(tacos, 'salsa');
    updateRecipeTags(tacos, { ...emptyRecipeTags(), meal: ['dinner'] }, 35);
    createRecipe('Soup');
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    db.insert(recipes).values({ id: 'chili', householdId: 'lake', name: 'Campfire chili', totalMinutes: 80 }).run();
    addItemsBulk(groceries, [{ text: 'tortillas', source: 'recipe', recipeId: tacos }], USER);
    const name = db.select().from(lists).all().find((l) => l.id === groceries)!.name;

    const root = render(<RecipesScreen />);
    expect(texts(root)).not.toContain('No recipes yet.');
    // Two households: each card has its household's name above it.
    expect([...headers(root)].sort()).toEqual(['Lake house', 'Personal', 'Recipes']);
    expect(texts(root)).toEqual(expect.arrayContaining(['Tacos', 'Dinner · 35 min', `On ${name}`, 'Soup', 'Campfire chili', '1 hr 20 min']));
    // The ingredient count is gone.
    expect(texts(root)).not.toContain('2 ingredients');
    expect(cards(root).sort()).toEqual(['Campfire chili, 1 hr 20 min', 'Soup', `Tacos, Dinner, 35 min, on ${name}`]);
    const links = byType(root, 'Link').map((l) => l.props.href.params.id);
    expect(links).toEqual(expect.arrayContaining([tacos, 'chili']));
    // Recipes in each household share one card.
    expect(root.root.findAll((n) => n.type === Card)).toHaveLength(2);
  });

  test('one household: no household name above its card, and every row in one card', () => {
    createRecipe('Tacos');
    createRecipe('Soup');
    const root = render(<RecipesScreen />);
    expect(headers(root)).toEqual(['Recipes']);
    expect(texts(root)).not.toContain('Personal');
    const [card] = root.root.findAll((n) => n.type === Card);
    expect(card.findAll((n) => String(n.type) === 'Link')).toHaveLength(2);
  });

  test('the meta line: the first meal in facet order, the time, either alone, or nothing', () => {
    const both = createRecipe('Pancakes');
    updateRecipeTags(both, { ...emptyRecipeTags(), meal: ['dinner', 'breakfast'] }, 60);
    const mealOnly = createRecipe('Salad');
    updateRecipeTags(mealOnly, { ...emptyRecipeTags(), meal: ['side'], cuisine: ['mexican'] }, null);
    const timeOnly = createRecipe('Stew');
    updateRecipeTags(timeOnly, { ...emptyRecipeTags(), cuisine: ['indian'] }, 125);
    createRecipe('Toast');
    const root = render(<RecipesScreen />);
    const rowTexts = (recipe: string) =>
      byType(root, 'Link')
        .find((l) => l.props.href.params.id === recipe)!
        .findAll((n) => String(n.type) === 'Text' && typeof n.props.children === 'string')
        .map((n) => n.props.children as string);
    expect(rowTexts(both)).toEqual(['Pancakes', 'Breakfast · 1 hr']);
    expect(rowTexts(mealOnly)).toEqual(['Salad', 'Side']);
    expect(rowTexts(timeOnly)).toEqual(['Stew', '2 hr 5 min']);
    expect(cards(root)).toContain('Toast');
  });

  test('a row: a 48 pt tile, the name on one line', () => {
    createRecipe('A very long recipe name that would need two lines on a phone');
    const root = render(<RecipesScreen />);
    const [link] = byType(root, 'Link');
    expect(link.find((n) => n.type === IconTile).props.size).toBe(48);
    const title = link.find((n) => String(n.type) === 'Text' && n.props.children === 'A very long recipe name that would need two lines on a phone');
    expect(title.props.numberOfLines).toBe(1);
  });

  test('the green header: "Recipes", search, "N recipes" and Filters; light status bar', () => {
    createRecipe('Tacos');
    createRecipe('Soup');
    const root = render(<RecipesScreen />);
    expect(texts(root).slice(0, 3)).toEqual(['Recipes', '2 recipes', 'Filters']);
    const field = root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Search recipes');
    expect(field.props.placeholder).toBe('Search 2 recipes');
    expect(root.root.findAll((n) => n.type === StatusBar).map((n) => n.props.style)).toEqual(['light']);
  });

  test('without recipes: the header has only the title, no search or Filters', () => {
    const root = render(<RecipesScreen />);
    expect(headers(root)).toEqual(['Recipes']);
    expect(root.root.findAll((n) => String(n.type) === 'TextInput')).toHaveLength(0);
    expect(texts(root)).not.toContain('0 recipes');
    expect(texts(root)).not.toContain('Filters');
  });

  test("a card shows the recipe's photo in its tile, else the icon tile; a failed photo falls back (board 18)", () => {
    const householdId = getRecipe(createRecipe('Soup'))!.householdId;
    db.insert(recipes).values({ id: 'tacos', householdId, name: 'Tacos', imageUrl: 'https://example.com/tacos.jpg' }).run();
    const root = render(<RecipesScreen />);
    const cardOf = (name: string) =>
      root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && n.props.accessibilityLabel?.startsWith(name));
    const photos = (name: string) => cardOf(name).findAll((n) => String(n.type) === 'ExpoImage');
    const iconTiles = (name: string) => cardOf(name).findAll((n) => n.type === IconTile);

    const [photo] = photos('Tacos');
    expect([photo.props.source, photo.props.contentFit, photo.props.cachePolicy]).toEqual(['https://example.com/tacos.jpg', 'cover', 'disk']);
    // The icon tile underneath is the placeholder while it loads.
    expect(iconTiles('Tacos')).toHaveLength(1);
    expect(photos('Soup')).toHaveLength(0);
    expect(iconTiles('Soup')).toHaveLength(1);

    act(() => photo.props.onError({ error: '404' }));
    expect(photos('Tacos')).toHaveLength(0);
    expect(iconTiles('Tacos')).toHaveLength(1);
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

  describe("a card's swipe to delete (spec 4.5)", () => {
    const swipeOf = (root: ReactTestRenderer, recipeId: string) =>
      byType(root, 'Swipeable').find((s) => s.props.children.props.href.params.id === recipeId)!;
    /** The Delete revealed behind the card, as its swipe renders it. */
    const deleteAction = (root: ReactTestRenderer, recipeId: string) =>
      swipeOf(root, recipeId).props.renderRightActions({ value: 0 }, { value: 0 }) as React.ReactElement<{
        onPress: () => void;
        onFull: (full: boolean) => void;
        fullAt: number;
      }>;
    const alertButton = (alert: jest.SpiedFunction<typeof Alert.alert>, text: string) =>
      (alert.mock.calls[0][2] as AlertButton[]).find((b) => b.text === text)!;

    test('only left: the trash action is on the right, nothing on the left', () => {
      const tacos = createRecipe('Tacos');
      const root = render(<RecipesScreen />);
      const swipe = swipeOf(root, tacos);
      expect(swipe.props.renderLeftActions).toBeUndefined();
      expect(swipe.props.overshootLeft).toBe(false);
      expect(swipe.props.friction).toBe(1);
      // Not measured yet: no swipe counts as full.
      expect(deleteAction(root, tacos).props.fullAt).toBe(Infinity);
    });

    test('tapping Delete asks first, with the same alert as the menu', () => {
      const tacos = createRecipe('Tacos');
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<RecipesScreen />);
      act(() => deleteAction(root, tacos).props.onPress());
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0].slice(0, 2)).toEqual(['Delete “Tacos”?', 'Items already on your lists stay there.']);
      expect((alert.mock.calls[0][2] as AlertButton[]).map((b) => [b.text, b.style])).toEqual([
        ['Cancel', 'cancel'],
        ['Delete', 'destructive'],
      ]);
      expect(getRecipe(tacos)).toBeDefined();
    });

    test('Cancel deletes nothing and closes the card', () => {
      const tacos = createRecipe('Tacos');
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<RecipesScreen />);
      act(() => swipeOf(root, tacos).props.onSwipeableWillOpen('left'));
      act(() => deleteAction(root, tacos).props.onPress());
      act(() => alertButton(alert, 'Cancel').onPress!());
      expect(getRecipe(tacos)).toBeDefined();
      expect(mockCloseCard.mock.calls).toEqual([[tacos]]);
      expect(cards(root)).toHaveLength(1);
    });

    test('confirming deletes that recipe and leaves the others', () => {
      const tacos = createRecipe('Tacos');
      const soup = createRecipe('Soup');
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<RecipesScreen />);
      act(() => deleteAction(root, tacos).props.onPress());
      act(() => alertButton(alert, 'Delete').onPress!());
      expect(getRecipe(tacos)).toBeUndefined();
      expect(getRecipe(soup)).toBeDefined();
    });

    test('a short swipe only shows Delete; a full one asks at once', () => {
      const tacos = createRecipe('Tacos');
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<RecipesScreen />);
      act(() => swipeOf(root, tacos).props.onSwipeableWillOpen('left'));
      expect(alert).not.toHaveBeenCalled();

      act(() => deleteAction(root, tacos).props.onFull(true));
      act(() => swipeOf(root, tacos).props.onSwipeableWillOpen('left'));
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][0]).toBe('Delete “Tacos”?');
      expect(getRecipe(tacos)).toBeDefined();

      // Dragged back short of full before letting go: no alert.
      act(() => deleteAction(root, tacos).props.onFull(false));
      act(() => swipeOf(root, tacos).props.onSwipeableWillOpen('left'));
      expect(alert).toHaveBeenCalledTimes(1);
    });

    test('a full swipe is past most of the card once it is measured', () => {
      const tacos = createRecipe('Tacos');
      const root = render(<RecipesScreen />);
      const measured = swipeOf(root, tacos).find((n) => typeof n.props.onLayout === 'function');
      act(() => measured.props.onLayout({ nativeEvent: { layout: { width: 350, height: 80, x: 0, y: 0 } } }));
      expect(deleteAction(root, tacos).props.fullAt).toBe(210);
    });

    test('one card open at a time: opening another closes the first; reopening the same closes nothing', () => {
      const tacos = createRecipe('Tacos');
      const soup = createRecipe('Soup');
      const root = render(<RecipesScreen />);
      act(() => swipeOf(root, tacos).props.onSwipeableWillOpen('left'));
      act(() => swipeOf(root, tacos).props.onSwipeableWillOpen('left'));
      expect(mockCloseCard).not.toHaveBeenCalled();
      act(() => swipeOf(root, soup).props.onSwipeableWillOpen('left'));
      expect(mockCloseCard.mock.calls).toEqual([[tacos]]);
    });

    test('scrolling closes the open card; with none open, or once it closed, nothing', () => {
      const tacos = createRecipe('Tacos');
      const root = render(<RecipesScreen />);
      const scroll = () => act(() => root.root.find((n) => typeof n.props.onScrollBeginDrag === 'function').props.onScrollBeginDrag());
      scroll();
      expect(mockCloseCard).not.toHaveBeenCalled();
      act(() => swipeOf(root, tacos).props.onSwipeableWillOpen('left'));
      scroll();
      expect(mockCloseCard.mock.calls).toEqual([[tacos]]);
      act(() => swipeOf(root, tacos).props.onSwipeableClose('left'));
      scroll();
      expect(mockCloseCard).toHaveBeenCalledTimes(1);
    });

    test("VoiceOver: the card's Delete action asks first, and confirming deletes", () => {
      const tacos = createRecipe('Tacos');
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<RecipesScreen />);
      const card = root.root.find(
        (n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && n.props.accessibilityLabel?.startsWith('Tacos'),
      );
      expect(card.props.accessibilityActions).toEqual([{ name: 'delete', label: 'Delete' }]);
      act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
      expect(alert).not.toHaveBeenCalled();
      act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } }));
      expect(alert.mock.calls[0][0]).toBe('Delete “Tacos”?');
      expect(getRecipe(tacos)).toBeDefined();
      act(() => alertButton(alert, 'Delete').onPress!());
      expect(getRecipe(tacos)).toBeUndefined();
    });
  });

  describe("a card's Visit recipe on web", () => {
    const menuOf = (root: ReactTestRenderer, recipeId: string) => {
      const card = byType(root, 'Link').find((l) => l.props.href.params.id === recipeId)!;
      return card.findAll((n) => n.type === ('LinkMenuAction' as never));
    };
    const titles = (root: ReactTestRenderer, recipeId: string) => menuOf(root, recipeId).map((a) => a.props.title);

    test('no link: Rename and Delete only', () => {
      const tacos = createRecipe('Tacos');
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
    });

    test('plain text in the link field: no Visit', () => {
      const tacos = createRecipe('Tacos');
      updateRecipe(tacos, { name: 'Tacos', notes: '', sourceUrl: 'from the back of the box' });
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
    });

    test('a link: Visit after Plan…, with the Safari symbol, and it opens the link', () => {
      const tacos = createRecipe('Tacos');
      const soup = createRecipe('Soup');
      updateRecipe(tacos, { name: 'Tacos', notes: '', sourceUrl: 'https://www.example.com/tacos#step-2' });
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Plan…', 'Visit recipe on web', 'Favorite', 'Want to try', 'Rename', 'Delete']);
      // Only the card with a link has it.
      expect(titles(root, soup)).toEqual(['Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
      const visit = menuOf(root, tacos)[1];
      expect(visit.props.icon).toBe('safari');
      expect(visit.props.destructive).toBeUndefined();
      act(() => visit.props.onPress());
      expect(mockOpenLink).toHaveBeenCalledTimes(1);
      expect(mockOpenLink).toHaveBeenCalledWith('https://www.example.com/tacos#step-2');
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe("a card's Add to a list", () => {
    const menuOf = (root: ReactTestRenderer, recipeId: string) => {
      const card = byType(root, 'Link').find((l) => l.props.href.params.id === recipeId)!;
      return card.findAll((n) => n.type === ('LinkMenuAction' as never));
    };
    const titles = (root: ReactTestRenderer, recipeId: string) => menuOf(root, recipeId).map((a) => a.props.title);

    test('no ingredients: no Add to a list', () => {
      const tacos = createRecipe('Tacos');
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
    });

    // The current list (Groceries) is in the recipe's household, so its quick add comes first.
    test('with ingredients: Add to a list after the quick add, with the cart symbol', () => {
      const tacos = createRecipe('Tacos');
      addRecipeIngredient(tacos, '8 tortillas');
      const soup = createRecipe('Soup');
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Add to Groceries', 'Add to a list', 'Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
      // Only the recipe with ingredients has it.
      expect(titles(root, soup)).toEqual(['Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
      const add = menuOf(root, tacos)[1];
      expect(add.props.icon).toBe('cart');
      expect(add.props.destructive).toBeUndefined();
    });

    test('with ingredients and a link: Add to Groceries, Add to a list, Plan…, Visit recipe on web, …, Rename, Delete', () => {
      const tacos = createRecipe('Tacos');
      addRecipeIngredient(tacos, 'salsa');
      updateRecipe(tacos, { name: 'Tacos', notes: '', sourceUrl: 'https://example.com/tacos' });
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Add to Groceries', 'Add to a list', 'Plan…', 'Visit recipe on web', 'Favorite', 'Want to try', 'Rename', 'Delete']);
    });

    test("choosing it pushes the add-to-list sheet with the recipe's id, and nothing else", () => {
      const tacos = createRecipe('Tacos');
      addRecipeIngredient(tacos, '8 tortillas');
      updateRecipe(tacos, { name: 'Tacos', notes: '', sourceUrl: 'https://example.com/tacos' });
      const root = render(<RecipesScreen />);
      act(() => menuOf(root, tacos)[1].props.onPress());
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/add-to-list', params: { id: tacos } });
      expect(mockOpenLink).not.toHaveBeenCalled();
    });

    test('a removed ingredient does not count: with none left, no Add to a list', () => {
      const tacos = createRecipe('Tacos');
      const ingredient = addRecipeIngredient(tacos, 'salsa')!;
      deleteRecipeIngredient(ingredient.id);
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
    });
  });

  describe("a card's Plan… (spec 4.16)", () => {
    const menuOf = (root: ReactTestRenderer, recipeId: string) => {
      const card = byType(root, 'Link').find((l) => l.props.href.params.id === recipeId)!;
      return card.findAll((n) => n.type === ('LinkMenuAction' as never));
    };

    test('after the Add items, with the calendar symbol, on every card', () => {
      const tacos = createRecipe('Tacos');
      addRecipeIngredient(tacos, '8 tortillas');
      const soup = createRecipe('Soup');
      const root = render(<RecipesScreen />);
      const plan = menuOf(root, tacos)[2];
      expect(plan.props).toMatchObject({ title: 'Plan…', icon: 'calendar' });
      expect(plan.props.destructive).toBeUndefined();
      expect(menuOf(root, soup)[0].props.title).toBe('Plan…');
    });

    test("choosing it pushes the plan modal with the recipe's id, and nothing else", () => {
      const tacos = createRecipe('Tacos');
      const root = render(<RecipesScreen />);
      act(() => menuOf(root, tacos)[0].props.onPress());
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/plan-recipe', params: { recipeId: tacos } });
      expect(mockOpenLink).not.toHaveBeenCalled();
    });
  });

  describe("a card's Add to <current list>", () => {
    const menuOf = (root: ReactTestRenderer, recipeId: string) => {
      const card = byType(root, 'Link').find((l) => l.props.href.params.id === recipeId)!;
      return card.findAll((n) => n.type === ('LinkMenuAction' as never));
    };
    const titles = (root: ReactTestRenderer, recipeId: string) => menuOf(root, recipeId).map((a) => a.props.title);
    const quickAdd = (root: ReactTestRenderer, recipeId: string, title = 'Add to Groceries') =>
      act(() => menuOf(root, recipeId).find((a) => a.props.title === title)!.props.onPress());
    const onList = (listId: string) =>
      listItemsQuery(listId)
        .all()
        .map((i) => i.ingredientName)
        .sort();
    const tacosWith = (...ingredients: string[]) => {
      const tacos = createRecipe('Tacos');
      for (const i of ingredients) addRecipeIngredient(tacos, i);
      return tacos;
    };

    test('first in the menu, with cart.badge.plus, naming the current list', () => {
      const tacos = tacosWith('8 tortillas');
      const root = render(<RecipesScreen />);
      const [quick] = menuOf(root, tacos);
      expect(quick.props.title).toBe('Add to Groceries');
      expect(quick.props.icon).toBe('cart.badge.plus');
      expect(quick.props.destructive).toBeUndefined();
    });

    test('names the list last opened on this device, not the default', () => {
      const party = createList('Party');
      setLastOpenedList(party);
      const tacos = tacosWith('8 tortillas');
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)[0]).toBe('Add to Party');
    });

    test('left out with no current list (every list archived)', () => {
      const tacos = tacosWith('8 tortillas');
      setListArchived(groceries, true);
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Add to a list', 'Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
    });

    test('left out when the current list was archived (falls back to an open one in the household)', () => {
      const party = createList('Party');
      setLastOpenedList(party);
      setListArchived(party, true);
      const tacos = tacosWith('8 tortillas');
      const root = render(<RecipesScreen />);
      // Party is archived, so the current list is Groceries again.
      expect(titles(root, tacos)[0]).toBe('Add to Groceries');
    });

    test("left out when the current list is another household's", () => {
      db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
      const cabin = createList('Cabin', 'lake');
      setLastOpenedList(cabin);
      const tacos = tacosWith('8 tortillas');
      db.insert(recipes).values({ id: 'chili', householdId: 'lake', name: 'Campfire chili' }).run();
      addRecipeIngredient('chili', 'beans');
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Add to a list', 'Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
      // The Lake house recipe does get it.
      expect(titles(root, 'chili')[0]).toBe('Add to Cabin');
    });

    test('left out with no ingredients', () => {
      const tacos = createRecipe('Tacos');
      const root = render(<RecipesScreen />);
      expect(titles(root, tacos)).toEqual(['Plan…', 'Favorite', 'Want to try', 'Rename', 'Delete']);
    });

    test('adds every ingredient at 1× and stays here, with "Added Tacos to Groceries · 2 items"', () => {
      const tacos = tacosWith('8 tortillas', '1 jar salsa');
      const root = render(<RecipesScreen />);
      quickAdd(root, tacos);
      expect(onList(groceries)).toEqual(['salsa', 'tortilla']);
      const tortillas = listItemsQuery(groceries).all().find((i) => i.ingredientName === 'tortilla')!;
      expect(tortillas.quantity).toBe(8);
      expect(texts(root)).toContain('Added Tacos to Groceries · 2 items');
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(allByA11y(root, 'Undo')).toHaveLength(1);
      expect(allByA11y(root, 'Open list')).toHaveLength(1);
      const highlighted = root.root.findAll((n) => typeof n.type !== 'string' && n.props.highlighted === true);
      expect(highlighted.map((n) => n.props.recipe.id)).toEqual([tacos]);
    });

    test('skips the household\'s staples and says so on a second line', () => {
      const tacos = tacosWith('8 tortillas', 'salt', 'pepper');
      setStaple(getRecipe(tacos)!.householdId, 'salt', true, USER);
      setStaple(getRecipe(tacos)!.householdId, 'pepper', true, USER);
      const root = render(<RecipesScreen />);
      quickAdd(root, tacos);
      expect(onList(groceries)).toEqual(['tortilla']);
      expect(texts(root)).toContain('Added Tacos to Groceries · 1 item\nSkipped salt, pepper');
    });

    test('every ingredient a staple: nothing added, "You always have everything in Tacos", no Undo', () => {
      const tacos = tacosWith('salt');
      setStaple(getRecipe(tacos)!.householdId, 'salt', true, USER);
      const root = render(<RecipesScreen />);
      quickAdd(root, tacos);
      expect(onList(groceries)).toEqual([]);
      expect(texts(root)).toContain('You always have everything in Tacos');
      expect(allByA11y(root, 'Undo')).toHaveLength(0);
      expect(allByA11y(root, 'Open list')).toHaveLength(1);
    });

    test('Undo takes the whole add back and closes the toast', () => {
      const tacos = tacosWith('8 tortillas', 'salsa');
      const root = render(<RecipesScreen />);
      quickAdd(root, tacos);
      press(byA11y(root, 'Undo'));
      expect(onList(groceries)).toEqual([]);
      expect(texts(root).join(' ')).not.toContain('Added Tacos');
    });

    test('Open list shows the List tab on the list it added to', () => {
      const party = createList('Party');
      setLastOpenedList(party);
      const tacos = tacosWith('8 tortillas');
      const root = render(<RecipesScreen />);
      quickAdd(root, tacos, 'Add to Party');
      expect(onList(party)).toEqual(['tortilla']);
      expect(onList(groceries)).toEqual([]);
      press(byA11y(root, 'Open list'));
      expect(mockNavigate).toHaveBeenCalledWith('/lists');
      expect(currentList()).toBe(party);
      expect(texts(root).join(' ')).not.toContain('Added Tacos');
    });
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

  test('a recipe-only share: "Saved …" with Undo and View recipe, its card outlined', () => {
    const tacos = createRecipe('Tacos');
    const undo = jest.fn();
    const root = render(<RecipesScreen />);
    act(() =>
      mockShareListener!([success({ recipeId: tacos, recipeName: 'Tacos', listId: null, created: true, added: 0, undo })]),
    );
    expect(texts(root).join(' ')).toContain('Saved Tacos');
    expect(texts(root).join(' ')).not.toContain('items');
    expect(allByA11y(root, 'Open list')).toHaveLength(0);
    const highlighted = root.root.findAll((n) => typeof n.type !== 'string' && n.props.highlighted === true);
    expect(highlighted.map((n) => n.props.recipe.id)).toEqual([tacos]);

    press(byA11y(root, 'View recipe'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: tacos } });
    expect(allByA11y(root, 'Undo')).toHaveLength(0);

    act(() =>
      mockShareListener!([success({ recipeId: tacos, recipeName: 'Tacos', listId: null, created: true, added: 0, undo })]),
    );
    press(byA11y(root, 'Undo'));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  test('a recipe-only share that reused a recipe: "already in your recipes", no Undo', () => {
    const tacos = createRecipe('Tacos');
    const root = render(<RecipesScreen />);
    act(() => mockShareListener!([success({ recipeId: tacos, recipeName: 'Tacos', listId: null, created: false, added: 0 })]));
    expect(texts(root).join(' ')).toContain('Tacos is already in your recipes');
    expect(allByA11y(root, 'Undo')).toHaveLength(0);
    expect(allByA11y(root, 'View recipe')).toHaveLength(1);
  });

  test('a recipe saved from the import sheet shows on return: "Saved …", Undo, View recipe, card outlined', () => {
    const tacos = createRecipe('Tacos');
    const undo = jest.fn();
    setSavedRecipeResult({ recipeId: tacos, recipeName: 'Tacos', created: true, undo });
    const root = render(<RecipesScreen />);
    expect(texts(root).join(' ')).toContain('Saved Tacos');
    const highlighted = root.root.findAll((n) => typeof n.type !== 'string' && n.props.highlighted === true);
    expect(highlighted.map((n) => n.props.recipe.id)).toEqual([tacos]);
    // Taken once: it's gone for the next focus.
    expect(takeSavedRecipeResult()).toBeNull();
    press(byA11y(root, 'Undo'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(texts(root).join(' ')).not.toContain('Saved Tacos');
  });

  test('a reused recipe saved from the sheet while the tab shows: "already in your recipes", no Undo', () => {
    const tacos = createRecipe('Tacos');
    const root = render(<RecipesScreen />);
    act(() => setSavedRecipeResult({ recipeId: tacos, recipeName: 'Tacos', created: false, undo: jest.fn() }));
    expect(texts(root).join(' ')).toContain('Tacos is already in your recipes');
    expect(allByA11y(root, 'Undo')).toHaveLength(0);
    press(byA11y(root, 'View recipe'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: tacos } });
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

describe('RecipesScreen search', () => {
  const searchFields = (root: ReactTestRenderer) =>
    root.root.findAll((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Search recipes');
  const searchBar = (root: ReactTestRenderer) => searchFields(root)[0];
  const search = (root: ReactTestRenderer, text: string) => act(() => searchBar(root).props.onChangeText(text));
  const headers = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'header')
      .map((n) => n.props.children as string);
  const cardLabels = (root: ReactTestRenderer) =>
    byType(root, 'Link').map((l) => l.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string);

  let tacos: string;
  let soup: string;
  beforeEach(() => {
    tacos = createRecipe('Weeknight tacos');
    addRecipeIngredient(tacos, '8 tortillas');
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    soup = createRecipe('Crème soup');
    addRecipeIngredient(soup, 'leeks');
    addRecipeIngredient(soup, '1 jalapeño');
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    db.insert(recipes).values({ id: 'chili', householdId: 'lake', name: 'Campfire chili' }).run();
  });

  test('a search field on the header with the recipe count, and none without recipes', () => {
    const root = render(<RecipesScreen />);
    expect(searchBar(root).props.placeholder).toBe('Search 3 recipes');
    expect(searchBar(root).props.value).toBe('');
    act(() => tree!.unmount());
    resetDb();
    ensureStarterData(USER);
    const empty = render(<RecipesScreen />);
    expect(searchFields(empty)).toHaveLength(0);
  });

  test('matches names; households with no matches are hidden', () => {
    const root = render(<RecipesScreen />);
    search(root, 'taco');
    expect(searchBar(root).props.value).toBe('taco');
    expect(cardLabels(root)).toEqual(['Weeknight tacos']);
    expect(headers(root)).toEqual(['Recipes', 'Personal']);
    expect(texts(root)).toContain('Weeknight tacos');
    expect(texts(root)).not.toContain('Campfire chili');

    search(root, 'chili');
    expect(headers(root)).toEqual(['Recipes', 'Lake house']);
    expect(cardLabels(root)).toEqual(['Campfire chili']);
  });

  test('an ingredient-only match shows "Has" with the ingredient in 700, in place of the meta line', () => {
    updateRecipeTags(tacos, { ...emptyRecipeTags(), meal: ['dinner'] }, 20);
    const root = render(<RecipesScreen />);
    expect(texts(root)).toContain('Dinner · 20 min');
    search(root, 'THIGH');
    expect(cardLabels(root)).toEqual(['Weeknight tacos, has chicken thighs']);
    expect(texts(root)).toContain('Has chicken thighs');
    expect(texts(root)).not.toContain('Dinner · 20 min');
    const bold = root.root.findAll(
      (n) => String(n.type) === 'Text' && n.props.children === 'chicken thighs' && JSON.stringify(n.props.style).includes('"fontWeight":"700"'),
    );
    expect(bold).toHaveLength(1);
  });

  test('a name match shows the meta line even when an ingredient matches too', () => {
    const tortillaSoup = createRecipe('Tortilla soup');
    addRecipeIngredient(tortillaSoup, 'tortillas');
    updateRecipeTags(tortillaSoup, { ...emptyRecipeTags(), meal: ['lunch'] }, 45);
    const root = render(<RecipesScreen />);
    search(root, 'tortilla');
    expect(cardLabels(root).sort()).toEqual(['Tortilla soup, Lunch, 45 min', 'Weeknight tacos, has tortillas']);
    expect(texts(root)).toContain('Lunch · 45 min');
  });

  test('ignores case and accents', () => {
    const root = render(<RecipesScreen />);
    search(root, 'CREME');
    expect(cardLabels(root)).toEqual(['Crème soup']);
    search(root, 'Jalapeno');
    expect(cardLabels(root)).toEqual(['Crème soup, has jalapeño']);
  });

  test('no results: "No recipes match"; clearing the search shows every recipe again', () => {
    const root = render(<RecipesScreen />);
    expect(texts(root)).not.toContain('No recipes match');
    search(root, 'lasagne');
    expect(cardLabels(root)).toEqual([]);
    expect(headers(root)).toEqual(['Recipes']);
    expect(texts(root)).toContain('No recipes match');
    expect(texts(root)).not.toContain('No recipes yet.');

    press(byA11y(root, 'Clear search'));
    expect(searchBar(root).props.value).toBe('');
    expect(texts(root)).not.toContain('No recipes match');
    expect(cardLabels(root)).toHaveLength(3);
    // Nothing to clear: no clear button.
    expect(allByA11y(root, 'Clear search')).toHaveLength(0);
  });

  test("a deleted recipe or ingredient doesn't match", () => {
    const leeks = db.select().from(recipeIngredients).all().find((i) => i.displayName === 'leeks')!;
    deleteRecipeIngredient(leeks.id);
    const root = render(<RecipesScreen />);
    search(root, 'leek');
    expect(texts(root)).toContain('No recipes match');

    act(() => deleteRecipe(tacos));
    search(root, 'tortilla');
    expect(cardLabels(root)).toEqual([]);
    expect(texts(root)).toContain('No recipes match');
  });

  test('the imports card stays at the top while searching', () => {
    recordFailedImport({ url: 'https://example.com/a', title: 'Pho', reason: 'not_a_recipe' });
    const root = render(<RecipesScreen />);
    search(root, 'lasagne');
    expect(root.root.findAll((n) => n.type === ImportsCard)).toHaveLength(1);
    const all = texts(root);
    expect(all.indexOf("Couldn't import 1 recipe")).toBeLessThan(all.indexOf('No recipes match'));
  });
});

describe('RecipesScreen filters', () => {
  const searchBar = (root: ReactTestRenderer) =>
    root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Search recipes');
  const search = (root: ReactTestRenderer, text: string) => act(() => searchBar(root).props.onChangeText(text));
  const cardNames = (root: ReactTestRenderer) =>
    byType(root, 'Link').map((l) => (l.findAll((n) => n.props.accessibilityRole === 'button')[0].props.accessibilityLabel as string).split(',')[0]);
  /** The Filters pill, on the green header. */
  const filtersPill = (root: ReactTestRenderer) => root.root.findByType(HeaderPill);
  const chipLabels = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => typeof n.type !== 'string' && /^Remove .* filter$/.test(n.props.accessibilityLabel ?? '') && n.props.onPress)
      .map((n) => n.props.accessibilityLabel as string);
  /** The sheet's toggle pills, as "Facet heading" → labels. */
  const sheetGroups = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => String(n.type) === 'Text' && n.props.accessibilityRole === 'header')
      .map((n) => n.props.children as string);
  const toggle = (root: ReactTestRenderer, label: string) =>
    press(root.root.find((n) => typeof n.type !== 'string' && n.props.label === label && n.props.accessibilityRole === 'togglebutton'));
  const cta = (root: ReactTestRenderer) =>
    root.root.find((n) => typeof n.type !== 'string' && /^Show \d+ recipes?$/.test(n.props.label ?? '') && n.props.onPress);

  beforeEach(() => {
    setRecipeFilters(noRecipeFilters());
    const tacos = createRecipe('Tacos');
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    updateRecipeTags(tacos, { ...emptyRecipeTags(), meal: ['dinner'], cuisine: ['mexican'], protein: ['chicken'] }, 25);
    const pancakes = createRecipe('Pancakes');
    updateRecipeTags(pancakes, { ...emptyRecipeTags(), meal: ['breakfast'] }, 40);
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    db.insert(recipes)
      .values({ id: 'curry', householdId: 'lake', name: 'Curry', tags: { ...emptyRecipeTags(), meal: ['dinner'], cuisine: ['indian'] }, totalMinutes: 90 })
      .run();
    createRecipe('Grandma soup');
  });
  afterEach(() => setRecipeFilters(noRecipeFilters()));

  test('the Filters pill opens the sheet with the search text', () => {
    const root = render(<RecipesScreen />);
    expect(filtersPill(root).props.label).toBe('Filters');
    expect(filtersPill(root).props.accessibilityLabel).toBe('Filters');
    expect(filtersPill(root).props.selected).toBe(false);
    search(root, 'taco');
    press(filtersPill(root));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipes/filter', params: { q: 'taco' } });
  });

  test('active filter chips sit under the header, after the search field and Filters; none without filters', () => {
    const root = render(<RecipesScreen />);
    expect(chipLabels(root)).toEqual([]);
    act(() => setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner')));
    expect(chipLabels(root)).toEqual(['Remove Dinner filter']);
    const all = texts(root);
    expect(all.indexOf('Filters · 1')).toBeLessThan(all.indexOf('Dinner'));
    expect(all.indexOf('Dinner')).toBeLessThan(all.indexOf('Tacos'));
  });

  test('no Filters pill without recipes', () => {
    resetDb();
    ensureStarterData(USER);
    const root = render(<RecipesScreen />);
    expect(root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityHint === 'Opens the filters.')).toHaveLength(0);
  });

  test('OR within a facet, AND across facets; the pill counts and chips show', () => {
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner'));
    const root = render(<RecipesScreen />);
    expect(cardNames(root).sort()).toEqual(['Curry', 'Tacos']);
    expect(filtersPill(root).props.label).toBe('Filters · 1');
    expect(filtersPill(root).props.accessibilityLabel).toBe('Filters, 1 active');
    expect(filtersPill(root).props.selected).toBe(true);
    // On the header only: the chips under it have no second Filters pill.
    expect(root.root.findAll((n) => n.type === Pill && /^Filters/.test(n.props.label))).toHaveLength(0);

    act(() => setRecipeFilters(toggleRecipeFilter(getRecipeFilters(), 'meal', 'breakfast')));
    expect(cardNames(root).sort()).toEqual(['Curry', 'Pancakes', 'Tacos']);
    act(() => setRecipeFilters(toggleRecipeFilter(getRecipeFilters(), 'cuisine', 'indian')));
    expect(cardNames(root)).toEqual(['Curry']);
    expect(chipLabels(root)).toEqual(['Remove Breakfast filter', 'Remove Dinner filter', 'Remove Indian filter']);
    expect(texts(root)).toEqual(expect.arrayContaining(['Filters · 3', 'Breakfast', 'Dinner', 'Indian']));
  });

  test('time buckets filter by total time', () => {
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'time', 'under-60'));
    const root = render(<RecipesScreen />);
    expect(cardNames(root)).toEqual(['Pancakes']);
    expect(chipLabels(root)).toEqual(['Remove Under 1 hour filter']);
  });

  test('filters AND with the search', () => {
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner'));
    const root = render(<RecipesScreen />);
    search(root, 'thigh');
    expect(cardNames(root)).toEqual(['Tacos']);
    expect(texts(root)).toContain('Has chicken thighs');
    search(root, 'pancake');
    expect(cardNames(root)).toEqual([]);
  });

  test('tapping a chip removes only its value', () => {
    setRecipeFilters(toggleRecipeFilter(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner'), 'cuisine', 'indian'));
    const root = render(<RecipesScreen />);
    expect(cardNames(root)).toEqual(['Curry']);
    press(byA11y(root, 'Remove Indian filter'));
    expect(chipLabels(root)).toEqual(['Remove Dinner filter']);
    expect(cardNames(root).sort()).toEqual(['Curry', 'Tacos']);
    expect(getRecipeFilters().tags.meal).toEqual(['dinner']);
    expect(getRecipeFilters().tags.cuisine).toEqual([]);
  });

  test('untagged recipes hidden by filters get a footer that shows only them, with an Untagged chip', () => {
    const root = render(<RecipesScreen />);
    expect(texts(root).some((t) => t.includes('without tags'))).toBe(false);
    act(() => setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'breakfast')));
    const footer = root.root.find(
      (n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button' && n.props.accessibilityHint === 'Clears the filters and shows only recipes without tags.',
    );
    expect(texts(root)).toContain("1 recipe without tags isn't shown");

    press(footer);
    expect(cardNames(root)).toEqual(['Grandma soup']);
    expect(chipLabels(root)).toEqual(['Remove Untagged filter']);
    expect(texts(root)).not.toContain("1 recipe without tags isn't shown");
    expect(filtersPill(root).props.label).toBe('Filters · 1');

    press(byA11y(root, 'Remove Untagged filter'));
    expect(cardNames(root)).toHaveLength(4);
    expect(chipLabels(root)).toEqual([]);
  });

  test('the untagged footer counts only recipes the search found', () => {
    createRecipe('Plain soup');
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner'));
    const root = render(<RecipesScreen />);
    expect(texts(root)).toContain("2 recipes without tags aren't shown");
    search(root, 'plain');
    expect(texts(root)).toContain("1 recipe without tags isn't shown");
    search(root, 'curry');
    expect(texts(root).some((t) => t.includes('without tags'))).toBe(false);
  });

  test('no match: "No recipes match" with Clear filters, which clears them', () => {
    setRecipeFilters(toggleRecipeFilter(toggleRecipeFilter(noRecipeFilters(), 'meal', 'breakfast'), 'cuisine', 'indian'));
    const root = render(<RecipesScreen />);
    expect(cardNames(root)).toEqual([]);
    expect(texts(root)).toContain('No recipes match');
    press(byLabel(root, 'Clear filters'));
    expect(getRecipeFilters()).toEqual(noRecipeFilters());
    expect(cardNames(root)).toHaveLength(4);
    expect(texts(root)).not.toContain('No recipes match');
  });

  test('searching alone with no match has no Clear filters button', () => {
    const root = render(<RecipesScreen />);
    search(root, 'lasagne');
    expect(texts(root)).toContain('No recipes match');
    expect(allByLabel(root, 'Clear filters')).toHaveLength(0);
  });

  test('filters are kept across the tab unmounting (the app session)', () => {
    setRecipeFilters(toggleRecipeFilter(noRecipeFilters(), 'meal', 'dinner'));
    render(<RecipesScreen />);
    act(() => tree!.unmount());
    const again = render(<RecipesScreen />);
    expect(chipLabels(again)).toEqual(['Remove Dinner filter']);
    expect(cardNames(again).sort()).toEqual(['Curry', 'Tacos']);
  });

  describe('the sheet', () => {
    test('shows only values some recipe has, in facet order, then Time; untagged-only facets are hidden', () => {
      const root = render(<RecipeFilterSheet />);
      expect(sheetGroups(root)).toEqual(['Meal', 'Cuisine', 'Protein', 'Time']);
      const toggles = root.root
        .findAll((n) => n.type === Pill && n.props.accessibilityRole === 'togglebutton')
        .map((n) => n.props.label as string);
      expect(toggles).toEqual(['Breakfast', 'Dinner', 'Mexican', 'Indian', 'Chicken', 'Under 30 min', 'Under 1 hour', 'Over 1 hour']);
      expect(cta(root).props.label).toBe('Show 4 recipes');
    });

    test('the count updates live and pills are toggle buttons with their state', () => {
      const root = render(<RecipeFilterSheet />);
      toggle(root, 'Dinner');
      expect(cta(root).props.label).toBe('Show 2 recipes');
      const dinner = root.root.find((n) => typeof n.type !== 'string' && n.props.label === 'Dinner' && n.props.accessibilityRole === 'togglebutton');
      expect(dinner.props.accessibilityState).toEqual({ checked: true });
      toggle(root, 'Mexican');
      expect(cta(root).props.label).toBe('Show 1 recipe');
      toggle(root, 'Over 1 hour');
      expect(cta(root).props.label).toBe('Show 0 recipes');
      toggle(root, 'Over 1 hour');
      toggle(root, 'Mexican');
      toggle(root, 'Breakfast');
      expect(cta(root).props.label).toBe('Show 3 recipes');
      expect(getRecipeFilters().tags.meal).toEqual(['dinner', 'breakfast']);
    });

    test('the count includes the search text it was opened with', () => {
      mockParams.q = 'soup';
      const root = render(<RecipeFilterSheet />);
      expect(cta(root).props.label).toBe('Show 1 recipe');
      toggle(root, 'Dinner');
      expect(cta(root).props.label).toBe('Show 0 recipes');
    });

    test('Show N recipes closes the sheet and keeps the filters', () => {
      const root = render(<RecipeFilterSheet />);
      toggle(root, 'Breakfast');
      press(cta(root));
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(getRecipeFilters().tags.meal).toEqual(['breakfast']);
    });

    test('Clear empties the filters; it is disabled with none', () => {
      const root = render(<RecipeFilterSheet />);
      const clear = () => root.root.find((n) => String(n.type) === 'ToolbarButton' && n.props.accessibilityLabel === 'Clear filters');
      expect(clear().props.disabled).toBe(true);
      toggle(root, 'Dinner');
      toggle(root, 'Under 30 min');
      expect(clear().props.disabled).toBe(false);
      act(() => clear().props.onPress());
      expect(getRecipeFilters()).toEqual(noRecipeFilters());
      expect(cta(root).props.label).toBe('Show 4 recipes');
      expect(mockBack).not.toHaveBeenCalled();
    });

    test('with no tagged recipes it says so', () => {
      resetDb();
      ensureStarterData(USER);
      createRecipe('Grandma soup');
      const root = render(<RecipeFilterSheet />);
      expect(sheetGroups(root)).toEqual([]);
      expect(texts(root)).toEqual(['No recipes have tags yet.', 'Show 1 recipe']);
    });
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
