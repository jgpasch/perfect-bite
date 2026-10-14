// The recipe screen and its "Add to a list" sheet (spec 4.5, boards 06 and 07), rendered against the
// in-memory database: ingredients, edit/delete/undo, the menu, and choosing list, servings and ingredients.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { eq } from 'drizzle-orm';

import { Button } from '@/components/button';
import { Pill } from '@/components/pill';
import { Stepper } from '@/components/stepper';
import { db, households, lists, outbox, recipes } from '@/db';
import { isStaple, setStaple } from '@/features/households/staples';
import { resolveCurrentListId } from '@/features/lists/current-list';
import { groupItems, listItemsQuery } from '@/features/lists/items';
import { createList, ensureStarterData, getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import { startAdjust, takeRecipeAddResult } from '@/features/lists/recipe-add-result';
import { DEFAULT_FEATURES, setFeatures } from '@/features/plans/features';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';
import { insertRow } from '@/sync/mutate';
import { resetDb } from '@/test/db';

import AddRecipeToListSheet from '@/app/recipe/[id]/add-to-list';
import RecipeScreen from '@/app/recipe/[id]/index';
import RecipeTagsSheet from '@/app/recipe/[id]/tags';

import { addRecipeToList, addWholeRecipeToList, buildRecipeAdds } from '../add-to-list';
import { RecipeIngredientRow } from '../recipe-ingredient-row';
import { IMPORT_TAGS_NOTE, RecipeTagRow } from '../recipe-tag-row';
import { NOTHING_SUGGESTED_NOTE, SUGGESTED_NOTE, type SuggestTagsResult } from '../suggest-tags';
import {
  addRecipeIngredient,
  createRecipe,
  getRecipe,
  recipeIngredientsQuery,
  updateRecipe,
  updateRecipeServings,
} from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
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
// The swipe: a host element whose `onSwipeableOpen` the test calls, as a full swipe would.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ children, onSwipeableOpen, renderRightActions }: Record<string, any>) =>
      createElement('Swipeable', { onSwipeableOpen, renderRightActions }, children),
  };
});
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
const mockCategorize = jest.fn((_names?: readonly string[]) => Promise.resolve());
jest.mock('@/features/categories/categorization', () => ({
  categorizePending: (names?: readonly string[]) => mockCategorize(names),
}));
// The add bar is its own component; the screen only hands it `onAdd`.
jest.mock('@/features/lists/add-bar', () => {
  const { createElement } = require('react');
  return { ItemAddBar: (props: object) => createElement('ItemAddBar', props) };
});

const mockParams: Record<string, string | undefined> = {};
const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const passThrough = () =>
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    };
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(passThrough(), {
    Button: host('ToolbarButton'),
    Menu: host('ToolbarMenu'),
    MenuAction: host('ToolbarMenuAction'),
  });
  return {
    Stack: { Screen: () => null, Toolbar },
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      navigate: (...args: unknown[]) => mockNavigate(...args),
      back: () => mockBack(),
    },
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
// SwiftUI views as host elements, so the link's context menu items can be found and pressed.
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Host: host('SwiftHost'),
    RNHostView: host('RNHostView'),
    Button: host('SwiftButton'),
    ContextMenu: Object.assign(host('SwiftContextMenu'), {
      Items: host('SwiftContextMenuItems'),
      Trigger: host('SwiftContextMenuTrigger'),
    }),
  };
});
const mockOpenURL = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('expo-linking', () => ({ openURL: (url: string) => mockOpenURL(url) }));
const mockCopy = jest.fn((_text: string) => Promise.resolve(true));
jest.mock('expo-clipboard', () => ({ setStringAsync: (text: string) => mockCopy(text) }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));
// The server call; the messages and notes stay real.
const mockSuggest = jest.fn((_recipeId: string): Promise<SuggestTagsResult> => new Promise(() => {}));
jest.mock('@/features/recipes/suggest-tags', () => ({
  ...jest.requireActual<object>('@/features/recipes/suggest-tags'),
  suggestRecipeTags: (recipeId: string) => mockSuggest(recipeId),
}));

const USER = 'user-1';
let tree: ReactTestRenderer | null = null;
let groceries: string;
let tacos: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  tacos = createRecipe('Tacos');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  mockParams.id = tacos;
  mockPush.mockClear();
  mockNavigate.mockClear();
  mockBack.mockClear();
  mockCategorize.mockClear();
  mockOpenURL.mockClear();
  mockCopy.mockClear();
  mockSuggest.mockReset();
  mockSuggest.mockImplementation(() => new Promise(() => {}));
  setFeatures(DEFAULT_FEATURES);
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
/** The composite element with this `label` (Button, PrimaryButton, Pill). */
const byLabel = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.label === label && typeof n.props.onPress === 'function');
/** The first composite pressable with this accessibility label. */
const byA11y = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const queryA11y = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const linkField = (root: ReactTestRenderer) =>
  root.root.findAll((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Link to the recipe')[0];
const linkButton = (root: ReactTestRenderer) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'link' && typeof n.props.onPress === 'function')[0];
const menuAction = (root: ReactTestRenderer, title: string) =>
  byType(root, 'ToolbarMenuAction').find((n) => n.props.children === title)!;

const listRows = (listId: string) =>
  groupItems(listItemsQuery(listId).all()).unchecked.map((i) =>
    i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName,
  );

describe('RecipeScreen', () => {
  test('a missing recipe renders an empty screen', () => {
    mockParams.id = 'nope';
    const root = render(<RecipeScreen />);
    expect(texts(root)).toEqual([]);
    expect(byType(root, 'ItemAddBar')).toHaveLength(0);
  });

  test('no ingredients: the empty line, and Add to a list is disabled', () => {
    const root = render(<RecipeScreen />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Tacos', 'No ingredients yet. Add them below.']));
    expect(byLabel(root, 'Add to a list').props.disabled).toBe(true);
  });

  test('lists the ingredients with amounts in order, and Add to a list opens the sheet', () => {
    addRecipeIngredient(tacos, '1 lb ground beef');
    addRecipeIngredient(tacos, 'cilantro');
    const root = render(<RecipeScreen />);
    expect(texts(root)).not.toContain('No ingredients yet. Add them below.');
    const rows = root.root.findAll((n) => n.type === RecipeIngredientRow);
    expect(rows.map((r) => r.props.ingredient.displayName)).toEqual(['ground beef', 'cilantro']);
    expect(queryA11y(root, '1 lb Ground beef')).not.toHaveLength(0);
    const cta = byLabel(root, 'Add to a list');
    expect(cta.props.disabled).toBe(false);
    press(cta);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/add-to-list', params: { id: tacos } });
  });

  test('the add bar adds a parsed ingredient and categorizes its new name', () => {
    const root = render(<RecipeScreen />);
    const bar = byType(root, 'ItemAddBar')[0];
    expect(bar.props.placeholder).toBe('Add 2 cups flour…');
    expect(bar.props.householdId).toBe(getRecipe(tacos)!.householdId);
    // No list, so no usual-item chips when the field is empty (spec 4.2).
    expect(bar.props.listId).toBeUndefined();
    act(() => bar.props.onAdd('2 cups flour'));
    const [row] = recipeIngredientsQuery(tacos).all();
    expect([row.quantity, row.unit, row.ingredientName]).toEqual([2, 'cup', 'flour']);
    expect(mockCategorize).toHaveBeenCalledWith(['flour']);
  });

  test('tapping an ingredient prompts with its text and saves the edit', () => {
    addRecipeIngredient(tacos, '2 limes');
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    press(byA11y(root, '2 Limes'));
    expect(prompt).toHaveBeenCalledTimes(1);
    const [title, , onSubmit, , defaultValue] = prompt.mock.calls[0];
    expect(title).toBe('Edit ingredient');
    expect(defaultValue).toBe('2 limes');
    // Empty text is ignored.
    act(() => (onSubmit as (t: string) => void)('   '));
    expect(recipeIngredientsQuery(tacos).all()[0].quantity).toBe(2);
    act(() => (onSubmit as (t: string) => void)('3 limes'));
    expect(recipeIngredientsQuery(tacos).all()[0].quantity).toBe(3);
  });

  test('an edit that leaves no name shows the error', () => {
    addRecipeIngredient(tacos, '2 limes');
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    press(byA11y(root, '2 Limes'));
    act(() => (prompt.mock.calls[0][2] as (t: string) => void)('-'));
    expect(alert).toHaveBeenCalledWith('An ingredient needs a name');
  });

  test('swiping an ingredient away deletes it with an Undo toast that restores it', () => {
    addRecipeIngredient(tacos, '2 limes');
    addRecipeIngredient(tacos, 'cilantro');
    const root = render(<RecipeScreen />);
    act(() => byType(root, 'Swipeable')[0].props.onSwipeableOpen());
    expect(recipeIngredientsQuery(tacos).all().map((i) => i.displayName)).toEqual(['cilantro']);
    expect(texts(root)).toContain('Removed Limes');
    press(byA11y(root, 'Undo'));
    expect(recipeIngredientsQuery(tacos).all().map((i) => i.displayName)).toEqual(['limes', 'cilantro']);
    expect(texts(root)).not.toContain('Removed Limes');
  });

  test('the VoiceOver delete action deletes too', () => {
    addRecipeIngredient(tacos, '2 limes');
    const root = render(<RecipeScreen />);
    const row = byA11y(root, '2 Limes');
    act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    expect(recipeIngredientsQuery(tacos).all()).toHaveLength(1);
    act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } }));
    expect(recipeIngredientsQuery(tacos).all()).toHaveLength(0);
  });

  test('Rename in the menu prompts with the current name and saves it', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    act(() => menuAction(root, 'Rename').props.onPress());
    expect(prompt.mock.calls[0][0]).toBe('Rename recipe');
    expect(prompt.mock.calls[0][4]).toBe('Tacos');
    const save = (prompt.mock.calls[0][2] as AlertButton[]).find((b) => b.text === 'Save')!;
    act(() => (save.onPress as (name: string) => void)('Fish tacos'));
    expect(getRecipe(tacos)!.name).toBe('Fish tacos');
  });

  test('Delete recipe confirms, then deletes and goes back; Cancel keeps it', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    act(() => menuAction(root, 'Delete recipe').props.onPress());
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe('Delete “Tacos”?');
    expect(message).toBe('Items already on your lists stay there.');
    expect((buttons as AlertButton[]).map((b) => b.text)).toEqual(['Cancel', 'Delete']);
    expect(getRecipe(tacos)).toBeDefined();
    act(() => (buttons as AlertButton[])[1].onPress!());
    expect(getRecipe(tacos)).toBeUndefined();
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('editing the link and notes saves them when each field loses focus', () => {
    const root = render(<RecipeScreen />);
    const link = linkField(root)!;
    const notes = root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === 'Notes');
    act(() => link.props.onChangeText('https://example.com/tacos'));
    act(() => link.props.onEndEditing());
    act(() => notes.props.onChangeText('  Double the salsa  '));
    act(() => notes.props.onEndEditing());
    expect(getRecipe(tacos)).toMatchObject({ sourceUrl: 'https://example.com/tacos', notes: 'Double the salsa', name: 'Tacos' });
  });

  describe('the link', () => {
    const withLink = (url: string) => updateRecipe(tacos, { name: 'Tacos', notes: '', sourceUrl: url });
    const pencil = (root: ReactTestRenderer) => queryA11y(root, 'Edit link');
    const menuItem = (root: ReactTestRenderer, label: string) =>
      byType(root, 'SwiftButton').find((n) => n.props.label === label)!;

    test('no link: the empty field, no button or pencil', () => {
      const root = render(<RecipeScreen />);
      const field = linkField(root)!;
      expect(field.props.placeholder).toBe('Add a link to the recipe');
      expect(field.props.value).toBe('');
      expect(field.props.autoFocus).toBe(false);
      expect(linkButton(root)).toBeUndefined();
      expect(pencil(root)).toHaveLength(0);
    });

    test('a link shows host then path as a link button, with VoiceOver label, hint and actions', () => {
      withLink('https://www.seriouseats.com/the-best-tacos');
      const root = render(<RecipeScreen />);
      expect(linkField(root)).toBeUndefined();
      const link = linkButton(root)!;
      expect(link.props.accessibilityRole).toBe('link');
      expect(link.props.accessibilityLabel).toBe('Recipe link, seriouseats.com');
      expect(link.props.accessibilityHint).toBe('Opens the recipe in Safari');
      expect(link.props.accessibilityActions.map((a: { label: string }) => a.label)).toEqual([
        'Open',
        'Copy link',
        'Edit link',
        'Remove link',
      ]);
      expect(texts(root)).toContain('seriouseats.com/the-best-tacos');
      const line = link.findAll((n) => String(n.type) === 'Text')[0];
      expect([line.props.numberOfLines, line.props.ellipsizeMode]).toEqual([1, 'middle']);
      expect(pencil(root)).toHaveLength(1);
    });

    test('tapping the link opens Safari with the stored URL', () => {
      withLink('https://www.seriouseats.com/the-best-tacos?serves=4');
      const root = render(<RecipeScreen />);
      press(linkButton(root)!);
      expect(mockOpenURL).toHaveBeenCalledWith('https://www.seriouseats.com/the-best-tacos?serves=4');
    });

    test('the pencil switches to the focused field holding the full URL; ending editing saves', () => {
      withLink('https://example.com/tacos');
      const root = render(<RecipeScreen />);
      press(pencil(root)[0]);
      const field = linkField(root)!;
      expect(field.props.value).toBe('https://example.com/tacos');
      expect(field.props.autoFocus).toBe(true);
      expect(pencil(root)).toHaveLength(0);
      act(() => field.props.onChangeText('  example.com/fish-tacos '));
      act(() => field.props.onEndEditing());
      expect(getRecipe(tacos)!.sourceUrl).toBe('https://example.com/fish-tacos');
      expect(linkField(root)).toBeUndefined();
      expect(linkButton(root)!.props.accessibilityLabel).toBe('Recipe link, example.com');
      press(linkButton(root)!);
      expect(mockOpenURL).toHaveBeenCalledWith('https://example.com/fish-tacos');
    });

    test('typing into the empty field saves with https:// added and shows the button', () => {
      const root = render(<RecipeScreen />);
      const field = linkField(root)!;
      act(() => field.props.onFocus());
      act(() => field.props.onChangeText('seriouseats.com/tacos'));
      act(() => field.props.onEndEditing());
      expect(getRecipe(tacos)!.sourceUrl).toBe('https://seriouseats.com/tacos');
      expect(linkButton(root)!.props.accessibilityLabel).toBe('Recipe link, seriouseats.com');
    });

    test('clearing the field removes the link', () => {
      withLink('https://example.com/tacos');
      const root = render(<RecipeScreen />);
      press(pencil(root)[0]);
      act(() => linkField(root)!.props.onChangeText('   '));
      act(() => linkField(root)!.props.onEndEditing());
      expect(getRecipe(tacos)!.sourceUrl).toBeNull();
      expect(linkField(root)!.props.value).toBe('');
      expect(pencil(root)).toHaveLength(0);
    });

    test('text that is not a link is kept as typed and shown as plain text; tapping it edits', () => {
      const root = render(<RecipeScreen />);
      act(() => linkField(root)!.props.onChangeText('  Grandma’s card  '));
      act(() => linkField(root)!.props.onEndEditing());
      expect(getRecipe(tacos)!.sourceUrl).toBe('Grandma’s card');
      expect(linkButton(root)).toBeUndefined();
      expect(byType(root, 'SwiftContextMenu')).toHaveLength(0);
      const plain = byA11y(root, 'Recipe link, Grandma’s card');
      expect(plain.props.accessibilityRole).toBe('button');
      expect(texts(root)).toContain('Grandma’s card');
      press(plain);
      expect(linkField(root)!.props.value).toBe('Grandma’s card');
      expect(mockOpenURL).not.toHaveBeenCalled();
    });

    test('the context menu: Open, Copy link, Edit link, and Remove link (destructive) in order', () => {
      withLink('https://example.com/tacos');
      const root = render(<RecipeScreen />);
      expect(byType(root, 'SwiftButton').map((n) => [n.props.label, n.props.role])).toEqual([
        ['Open', undefined],
        ['Copy link', undefined],
        ['Edit link', undefined],
        ['Remove link', 'destructive'],
      ]);
      act(() => menuItem(root, 'Open').props.onPress());
      expect(mockOpenURL).toHaveBeenCalledWith('https://example.com/tacos');
      act(() => menuItem(root, 'Copy link').props.onPress());
      expect(mockCopy).toHaveBeenCalledWith('https://example.com/tacos');
      act(() => menuItem(root, 'Edit link').props.onPress());
      expect(linkField(root)!.props.value).toBe('https://example.com/tacos');
    });

    test('Remove link clears it with no confirm', () => {
      withLink('https://example.com/tacos');
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<RecipeScreen />);
      act(() => menuItem(root, 'Remove link').props.onPress());
      expect(alert).not.toHaveBeenCalled();
      expect(getRecipe(tacos)!.sourceUrl).toBeNull();
      expect(linkButton(root)).toBeUndefined();
      expect(linkField(root)!.props.value).toBe('');
    });

    test('the VoiceOver actions do the same as the menu', () => {
      withLink('https://example.com/tacos');
      const root = render(<RecipeScreen />);
      const act11y = (name: string) =>
        act(() => linkButton(root)!.props.onAccessibilityAction({ nativeEvent: { actionName: name } }));
      act11y('open');
      expect(mockOpenURL).toHaveBeenCalledWith('https://example.com/tacos');
      act11y('copy');
      expect(mockCopy).toHaveBeenCalledWith('https://example.com/tacos');
      act11y('remove');
      expect(getRecipe(tacos)!.sourceUrl).toBeNull();
    });
  });
});

/** Sets the recipe's tag columns directly, as an import (or a pull) would leave them. */
const setTags = (fields: { tags: RecipeTags | null; tagsEdited?: boolean; totalMinutes?: number | null }) =>
  db
    .update(recipes)
    .set({ tags: fields.tags, tagsEdited: fields.tagsEdited ?? false, totalMinutes: fields.totalMinutes ?? null })
    .where(eq(recipes.id, tacos))
    .run();
const outboxRecipeUpdates = () =>
  db
    .select()
    .from(outbox)
    .all()
    .map((r) => r.mutation)
    // An insert sends every column, `household_id` included; an update only what changed.
    .filter((m) => m.table === 'recipes' && m.id === tacos && !('household_id' in m.fields));

describe('RecipeScreen servings', () => {
  const stepper = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === Stepper);
  // Presses the stepper's − or + button.
  const step = (root: ReactTestRenderer, label: 'More' | 'Fewer') =>
    press(stepper(root)[0].find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function'));
  /** What VoiceOver reads for each ingredient row: its amount as shown, then its name. */
  const amounts = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => n.type === RecipeIngredientRow)
      .map((r) => r.find((n) => typeof n.type !== 'string' && n.props.accessibilityHint === 'Double-tap to edit').props.accessibilityLabel as string);
  const servingsPrompt = () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    return {
      prompt,
      submit: (text: string) => act(() => (prompt.mock.calls[prompt.mock.calls.length - 1][2] as (t: string) => void)(text)),
    };
  };

  test('without servings: a dashed Add servings pill and no stepper', () => {
    addRecipeIngredient(tacos, '2 limes');
    const root = render(<RecipeScreen />);
    const pill = byLabel(root, 'Add servings');
    expect(pill.type).toBe(Pill);
    expect(pill.props.dashed).toBe(true);
    expect(pill.props.icon).toBe('person.2');
    expect(texts(root)).not.toContain('Serves 4');
    expect(stepper(root)).toHaveLength(0);
    expect(queryA11y(root, 'Reset')).toHaveLength(0);
  });

  test('with servings: "Serves 4" in the band and a stepper at the base, amounts as written', () => {
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    addRecipeIngredient(tacos, '1 can chipotle');
    updateRecipeServings(tacos, 4);
    const root = render(<RecipeScreen />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Serves 4', 'For 4']));
    expect(queryA11y(root, 'Add servings')).toHaveLength(0);
    expect(byA11y(root, 'Serves 4').props.accessibilityHint).toBe('Edits the servings');
    const [s] = stepper(root);
    expect([s.props.value, s.props.min, s.props.max, s.props.accessibilityLabel]).toEqual([4, 1, 100, 'Servings']);
    expect(amounts(root)).toEqual(['2 lb Chicken thighs', '1 can Chipotle']);
    expect(queryA11y(root, 'Reset')).toHaveLength(0);
  });

  test('stepping scales the amounts shown, and Reset goes back to the base', () => {
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    addRecipeIngredient(tacos, '1 can chipotle');
    addRecipeIngredient(tacos, '1 tsp cumin');
    addRecipeIngredient(tacos, 'cilantro');
    updateRecipeServings(tacos, 4);
    const root = render(<RecipeScreen />);
    step(root, 'More');
    step(root, 'More');
    expect(texts(root)).toContain('For 6');
    expect(amounts(root)).toEqual(['3 lb Chicken thighs', '1½ can Chipotle', '1½ tsp Cumin', 'Cilantro']);
    expect(texts(root)).toEqual(expect.arrayContaining(['3 lb', '1½ can', '1½ tsp']));
    // Only what's shown: the recipe's own amounts are unchanged.
    expect(recipeIngredientsQuery(tacos).all().map((i) => i.quantity)).toEqual([2, 1, 1, null]);
    const reset = byLabel(root, 'Reset');
    expect(reset.type).toBe(Button);
    expect(reset.props.variant).toBe('plain');
    press(reset);
    expect(texts(root)).toContain('For 4');
    expect(amounts(root)).toEqual(['2 lb Chicken thighs', '1 can Chipotle', '1 tsp Cumin', 'Cilantro']);
    expect(queryA11y(root, 'Reset')).toHaveLength(0);
  });

  test('fewer than the base scales down', () => {
    addRecipeIngredient(tacos, '1 cup rice');
    updateRecipeServings(tacos, 4);
    const root = render(<RecipeScreen />);
    step(root, 'Fewer');
    step(root, 'Fewer');
    expect(amounts(root)).toEqual(['½ cup Rice']);
    expect(queryA11y(root, 'Reset')).toHaveLength(1);
  });

  test('editing a scaled ingredient prompts with its own amount', () => {
    addRecipeIngredient(tacos, '2 limes');
    updateRecipeServings(tacos, 2);
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    step(root, 'More');
    press(byA11y(root, '3 Limes'));
    expect(prompt.mock.calls[0][4]).toBe('2 limes');
  });

  test('the stepper starts at the base again when the screen is opened again', () => {
    addRecipeIngredient(tacos, '2 limes');
    updateRecipeServings(tacos, 2);
    let root = render(<RecipeScreen />);
    step(root, 'More');
    expect(texts(root)).toContain('For 3');
    act(() => root.unmount());
    root = render(<RecipeScreen />);
    expect(texts(root)).toContain('For 2');
    expect(amounts(root)).toEqual(['2 Limes']);
  });

  test('Add servings prompts for a number and saves it', () => {
    const { prompt, submit } = servingsPrompt();
    const root = render(<RecipeScreen />);
    press(byLabel(root, 'Add servings'));
    const [title, message, , type, defaultValue, keyboard] = prompt.mock.calls[0];
    expect([title, message, type, defaultValue, keyboard]).toEqual([
      'Servings',
      'How many people it serves, 1 to 100. Leave it empty to remove.',
      'plain-text',
      '',
      'number-pad',
    ]);
    submit(' 6 ');
    expect(getRecipe(tacos)!.servings).toBe(6);
    // The live query re-renders on the write in the app; the mock reads on render.
    act(() => root.update(<SafeAreaProvider initialMetrics={METRICS}><RecipeScreen /></SafeAreaProvider>));
    expect(texts(root)).toEqual(expect.arrayContaining(['Serves 6', 'For 6']));
    expect(queryA11y(root, 'Add servings')).toHaveLength(0);
  });

  test('saving servings goes through the outbox', () => {
    const { submit } = servingsPrompt();
    const root = render(<RecipeScreen />);
    press(byLabel(root, 'Add servings'));
    submit('3');
    expect(outboxRecipeUpdates().at(-1)?.fields).toEqual(expect.objectContaining({ servings: 3 }));
  });

  test('tapping "Serves 4" edits it: a new number saves and the stepper starts at it', () => {
    addRecipeIngredient(tacos, '2 limes');
    updateRecipeServings(tacos, 4);
    const { prompt, submit } = servingsPrompt();
    const root = render(<RecipeScreen />);
    step(root, 'More');
    press(byA11y(root, 'Serves 4'));
    expect(prompt.mock.calls[0][4]).toBe('4');
    submit('8');
    expect(getRecipe(tacos)!.servings).toBe(8);
    expect(texts(root)).toEqual(expect.arrayContaining(['Serves 8', 'For 8']));
    expect(amounts(root)).toEqual(['2 Limes']);
    expect(queryA11y(root, 'Reset')).toHaveLength(0);
  });

  test('clearing the prompt removes the servings and the stepper', () => {
    addRecipeIngredient(tacos, '2 limes');
    updateRecipeServings(tacos, 4);
    const { submit } = servingsPrompt();
    const root = render(<RecipeScreen />);
    step(root, 'More');
    press(byA11y(root, 'Serves 4'));
    submit('  ');
    expect(getRecipe(tacos)!.servings).toBeNull();
    expect(stepper(root)).toHaveLength(0);
    expect(queryA11y(root, 'Add servings')).toHaveLength(1);
    expect(amounts(root)).toEqual(['2 Limes']);
  });

  test.each(['0', '101', '2.5', 'four'])('"%s" shows the error and saves nothing', (text) => {
    updateRecipeServings(tacos, 4);
    const { submit } = servingsPrompt();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<RecipeScreen />);
    press(byA11y(root, 'Serves 4'));
    submit(text);
    expect(alert).toHaveBeenCalledWith('Servings must be a whole number from 1 to 100');
    expect(getRecipe(tacos)!.servings).toBe(4);
  });
});

describe('RecipeScreen tags', () => {
  /** The tag pills' VoiceOver labels in order, then the dashed pill's. */
  const tagRow = (root: ReactTestRenderer) =>
    root.root
      .findAll(
        (n) =>
          // The pressables themselves, not the Pill around the dashed one.
          typeof n.type !== 'string' &&
          n.type !== Pill &&
          typeof n.props.onPress === 'function' &&
          (/^(Meal|Cuisine|Protein|Diet|Method|Time): /.test(n.props.accessibilityLabel ?? '') ||
            ['Edit tags', 'Add tags'].includes(n.props.accessibilityLabel)),
      )
      .map((n) => n.props.accessibilityLabel);

  test('a new, untagged recipe shows only the dashed Add tags pill and no note', () => {
    const root = render(<RecipeScreen />);
    expect(tagRow(root)).toEqual(['Add tags']);
    expect(byLabel(root, 'Add tags').props.dashed).toBe(true);
    expect(texts(root)).not.toContain(IMPORT_TAGS_NOTE);
  });

  test('imported tags: facet over value in facet order, then the time, then + Tags, and the note', () => {
    setTags({ tags: { ...emptyRecipeTags(), protein: ['beef'], meal: ['dinner'], cuisine: ['mexican', 'brunchy'] }, totalMinutes: 75 });
    const root = render(<RecipeScreen />);
    expect(tagRow(root)).toEqual(['Meal: Dinner', 'Cuisine: Mexican', 'Protein: Beef', 'Time: Over 1 hour', 'Edit tags']);
    expect(byLabel(root, '+ Tags').props.dashed).toBe(true);
    expect(texts(root)).toEqual(
      expect.arrayContaining(['Meal', 'Dinner', 'Cuisine', 'Mexican', 'Protein', 'Beef', 'Time', 'Over 1 hour', IMPORT_TAGS_NOTE]),
    );
    expect(texts(root)).not.toContain('brunchy');
  });

  test('the note goes once a person has edited the tags', () => {
    setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner'] }, tagsEdited: true });
    const root = render(<RecipeScreen />);
    expect(tagRow(root)).toEqual(['Meal: Dinner', 'Edit tags']);
    expect(texts(root)).not.toContain(IMPORT_TAGS_NOTE);
  });

  test('an import that found no tags or time shows Add tags and no note', () => {
    setTags({ tags: emptyRecipeTags() });
    const root = render(<RecipeScreen />);
    expect(tagRow(root)).toEqual(['Add tags']);
    expect(texts(root)).not.toContain(IMPORT_TAGS_NOTE);
  });

  test('any pill opens the Tags sheet', () => {
    setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner'] }, totalMinutes: 20 });
    const root = render(<RecipeScreen />);
    for (const label of ['Meal: Dinner', 'Time: Under 30 min', 'Edit tags']) press(byA11y(root, label));
    expect(mockPush).toHaveBeenCalledTimes(3);
    for (const call of mockPush.mock.calls) expect(call[0]).toEqual({ pathname: '/recipe/[id]/tags', params: { id: tacos } });
  });

  describe('Suggest tags pill', () => {
    const suggestPills = (root: ReactTestRenderer) =>
      root.root.findAll((n) => n.type === Pill && n.props.label === 'Suggest tags');

    test('an untagged recipe with ingredients and the feature: a dashed sparkles pill after Add tags', () => {
      setFeatures(['categorize', 'recipe_tags']);
      addRecipeIngredient(tacos, '1 lb ground beef');
      const root = render(<RecipeScreen />);
      const [suggest] = suggestPills(root);
      expect(suggest.props).toMatchObject({ dashed: true, icon: 'sparkles', accessibilityHint: 'Opens the tags, with AI suggestions.' });
      const labels = root.root
        .find((n) => n.type === RecipeTagRow)
        .findAll((n) => n.type === Pill && n.props.dashed)
        .map((n) => n.props.label);
      expect(labels).toEqual(['Add tags', 'Suggest tags']);
      press(suggest);
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]/tags', params: { id: tacos, suggest: '1' } });
      expect(mockSuggest).not.toHaveBeenCalled();
    });

    test('an import that found nothing counts as untagged', () => {
      setFeatures(['recipe_tags']);
      setTags({ tags: emptyRecipeTags() });
      addRecipeIngredient(tacos, 'cilantro');
      expect(suggestPills(render(<RecipeScreen />))).toHaveLength(1);
    });

    test('not for a tagged recipe, one with only a time, one without ingredients, or without the feature', () => {
      setFeatures(['recipe_tags']);
      addRecipeIngredient(tacos, 'cilantro');
      setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner'] } });
      expect(suggestPills(render(<RecipeScreen />))).toHaveLength(0);
      act(() => tree?.unmount());

      setTags({ tags: null, totalMinutes: 20 });
      expect(suggestPills(render(<RecipeScreen />))).toHaveLength(0);
      act(() => tree?.unmount());

      setTags({ tags: null });
      setFeatures(['categorize']);
      expect(suggestPills(render(<RecipeScreen />))).toHaveLength(0);
      act(() => tree?.unmount());

      setFeatures(['recipe_tags']);
      const bare = createRecipe('Toast');
      mockParams.id = bare;
      expect(suggestPills(render(<RecipeScreen />))).toHaveLength(0);
    });

    test('the pill goes when the plan loses the feature', () => {
      setFeatures(['recipe_tags']);
      addRecipeIngredient(tacos, 'cilantro');
      const root = render(<RecipeScreen />);
      expect(suggestPills(root)).toHaveLength(1);
      act(() => setFeatures(['categorize']));
      expect(suggestPills(root)).toHaveLength(0);
    });
  });
});

describe('RecipeTagsSheet', () => {
  const pill = (root: ReactTestRenderer, label: string) =>
    root.root.find((n) => typeof n.type !== 'string' && n.props.label === label && n.props.accessibilityRole === 'togglebutton');
  const selected = (root: ReactTestRenderer) =>
    root.root
      .findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'togglebutton' && n.props.selected === true)
      .map((n) => n.props.label);
  const field = (root: ReactTestRenderer, label: string) =>
    root.root.find((n) => String(n.type) === 'TextInput' && n.props.accessibilityLabel === label);
  const toolbar = (root: ReactTestRenderer, title: string) =>
    byType(root, 'ToolbarButton').find((n) => n.props.children === title)!;

  test('a missing recipe renders an empty screen', () => {
    mockParams.id = 'nope';
    const root = render(<RecipeTagsSheet />);
    expect(texts(root)).toEqual([]);
  });

  test('a group per facet with toggle pills, then Total time; starts from the stored tags and time', () => {
    setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner'], protein: ['beef'] }, totalMinutes: 80 });
    const root = render(<RecipeTagsSheet />);
    const t = texts(root);
    expect(['Meal', 'Cuisine', 'Protein', 'Diet', 'Method', 'Total time'].map((h) => t.indexOf(h))).toEqual(
      [...['Meal', 'Cuisine', 'Protein', 'Diet', 'Method', 'Total time'].map((h) => t.indexOf(h))].sort((a, b) => a - b),
    );
    expect(t).toContain('Instant Pot');
    expect(selected(root)).toEqual(['Dinner', 'Beef']);
    expect(pill(root, 'Dinner').props.accessibilityState).toEqual({ checked: true });
    expect(pill(root, 'Lunch').props.accessibilityState).toEqual({ checked: false });
    expect(field(root, 'Hours').props.value).toBe('1');
    expect(field(root, 'Minutes').props.value).toBe('20');
  });

  test('a facet at its maximum disables its other pills and says why; deselecting frees them', () => {
    const root = render(<RecipeTagsSheet />);
    expect(texts(root)).not.toContain('Pick up to 2');
    press(pill(root, 'Dinner'));
    press(pill(root, 'Lunch'));
    expect(selected(root)).toEqual(['Lunch', 'Dinner']);
    expect(texts(root).filter((s) => s === 'Pick up to 2')).toHaveLength(1);
    expect(pill(root, 'Snack').props.disabled).toBe(true);
    expect(pill(root, 'Snack').props.accessibilityHint).toBe('Meal is full. Pick up to 2.');
    expect(pill(root, 'Dinner').props.disabled).toBe(false);
    expect(pill(root, 'Mexican').props.disabled).toBe(false);
    press(pill(root, 'Snack')); // ignored even if it fires
    expect(selected(root)).toEqual(['Lunch', 'Dinner']);
    press(pill(root, 'Lunch'));
    expect(pill(root, 'Snack').props.disabled).toBe(false);
    expect(pill(root, 'Snack').props.accessibilityHint).toBeUndefined();
    expect(texts(root)).not.toContain('Pick up to 2');
  });

  test('protein takes three', () => {
    const root = render(<RecipeTagsSheet />);
    for (const p of ['Chicken', 'Beef', 'Pork']) press(pill(root, p));
    expect(pill(root, 'Fish').props.disabled).toBe(true);
    expect(texts(root)).toContain('Pick up to 3');
  });

  test('Save writes the tags, the time and tagsEdited in one update, and closes', () => {
    setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner', 'brunchy'] }, totalMinutes: 30 });
    const root = render(<RecipeTagsSheet />);
    press(pill(root, 'Mexican'));
    press(pill(root, 'Dinner'));
    act(() => field(root, 'Hours').props.onChangeText('1'));
    act(() => field(root, 'Minutes').props.onChangeText('15'));
    act(() => toolbar(root, 'Save').props.onPress());
    const saved = { meal: ['brunchy'], cuisine: ['mexican'], protein: [], diet: [], method: [] };
    expect(getRecipe(tacos)).toMatchObject({ tags: saved, tagsEdited: true, totalMinutes: 75 });
    const updates = outboxRecipeUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].fields).toEqual(expect.objectContaining({ tags: saved, tags_edited: true, total_minutes: 75 }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('saving an untagged recipe with nothing picked tags it as empty', () => {
    const root = render(<RecipeTagsSheet />);
    act(() => toolbar(root, 'Save').props.onPress());
    expect(getRecipe(tacos)).toMatchObject({ tags: emptyRecipeTags(), tagsEdited: true, totalMinutes: null });
  });

  test('Clear empties the time, and Save removes it', () => {
    setTags({ tags: emptyRecipeTags(), totalMinutes: 45 });
    const root = render(<RecipeTagsSheet />);
    press(byA11y(root, 'Clear total time'));
    expect(field(root, 'Minutes').props.value).toBe('');
    expect(queryA11y(root, 'Clear total time')).toHaveLength(0);
    act(() => toolbar(root, 'Save').props.onPress());
    expect(getRecipe(tacos)!.totalMinutes).toBeNull();
  });

  test('a time over 48 hours disables Save and says so', () => {
    const root = render(<RecipeTagsSheet />);
    act(() => field(root, 'Hours').props.onChangeText('49'));
    expect(toolbar(root, 'Save').props.disabled).toBe(true);
    expect(texts(root)).toContain('Up to 48 hours');
    act(() => toolbar(root, 'Save').props.onPress());
    expect(getRecipe(tacos)!.tagsEdited).toBe(false);
    expect(mockBack).not.toHaveBeenCalled();
  });

  test('Cancel writes nothing', () => {
    setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner'] }, totalMinutes: 30 });
    const before = getRecipe(tacos);
    const root = render(<RecipeTagsSheet />);
    press(pill(root, 'Lunch'));
    act(() => field(root, 'Minutes').props.onChangeText('50'));
    act(() => toolbar(root, 'Cancel').props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(getRecipe(tacos)).toEqual(before);
    expect(outboxRecipeUpdates()).toHaveLength(0);
  });

  describe('Suggest tags', () => {
    let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
    beforeEach(() => {
      setFeatures(['categorize', 'recipe_tags']);
      addRecipeIngredient(tacos, '1 lb ground beef');
      announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
      announce.mockClear(); // React Native's preset already mocks it, so earlier tests' calls linger
    });

    const suggestButton = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === Button && n.props.icon === 'sparkles');
    /** A call that answers when the test says so. */
    const deferred = () => {
      let resolve!: (r: SuggestTagsResult) => void;
      mockSuggest.mockImplementation(() => new Promise<SuggestTagsResult>((r) => (resolve = r)));
      return (r: SuggestTagsResult) => act(async () => resolve(r));
    };
    const answer = (r: SuggestTagsResult) => mockSuggest.mockImplementation(() => Promise.resolve(r));
    const tap = (root: ReactTestRenderer) => act(async () => suggestButton(root)[0].props.onPress());

    test('without the feature there is no button', () => {
      setFeatures(['categorize']);
      const root = render(<RecipeTagsSheet />);
      expect(suggestButton(root)).toHaveLength(0);
      expect(texts(root)).not.toContain('Suggest tags');
    });

    test('with it, a secondary Suggest tags button above the first facet, with its VoiceOver hint', () => {
      const root = render(<RecipeTagsSheet />);
      const [button] = suggestButton(root);
      expect(button.props).toMatchObject({
        label: 'Suggest tags',
        accessibilityLabel: 'Suggest tags',
        accessibilityHint: 'Picks tags for this recipe with AI. Nothing is saved until you tap Save.',
        disabled: false,
        loading: false,
      });
      expect(button.props.variant).toBeUndefined(); // secondary is the default
      const t = texts(root);
      expect(t.indexOf('Suggest tags')).toBeLessThan(t.indexOf('Meal'));
    });

    test('while it runs: Suggesting…, disabled, with a spinner, and the pills still work', async () => {
      const resolve = deferred();
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      expect(mockSuggest).toHaveBeenCalledWith(tacos);
      const [button] = suggestButton(root);
      expect(button.props).toMatchObject({ label: 'Suggesting…', accessibilityLabel: 'Suggesting tags', disabled: true, loading: true });
      expect(root.root.findAll((n) => String(n.type) === 'ActivityIndicator')).toHaveLength(1);
      press(pill(root, 'Lunch'));
      expect(selected(root)).toEqual(['Lunch']);
      await resolve({ ok: true, tags: { ...emptyRecipeTags(), meal: ['dinner'] } });
      expect(suggestButton(root)[0].props).toMatchObject({ label: 'Suggest again', disabled: false, loading: false });
    });

    test('a suggestion replaces the picks, keeps unknown slugs, leaves the time, and writes nothing', async () => {
      setTags({ tags: { ...emptyRecipeTags(), meal: ['lunch', 'brunchy'], cuisine: ['thai'], diet: ['vegan'] }, totalMinutes: 50 });
      const before = getRecipe(tacos);
      answer({ ok: true, tags: { ...emptyRecipeTags(), meal: ['dinner'], cuisine: ['mexican'], protein: ['beef'] } });
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      expect(selected(root)).toEqual(['Dinner', 'Mexican', 'Beef']);
      expect(field(root, 'Minutes').props.value).toBe('50');
      expect(texts(root)).toContain(SUGGESTED_NOTE);
      const note = root.root.find((n) => typeof n.type !== 'string' && n.props.children === SUGGESTED_NOTE);
      expect(note.props).toMatchObject({ variant: 'footnote', color: 'inkSecondary' });
      expect(announce).toHaveBeenCalledWith('Tags suggested');
      expect(getRecipe(tacos)).toEqual(before);
      expect(outboxRecipeUpdates()).toHaveLength(0);

      // Save keeps the unknown slug it carried over.
      act(() => toolbar(root, 'Save').props.onPress());
      expect(getRecipe(tacos)!.tags).toEqual({ meal: ['dinner', 'brunchy'], cuisine: ['mexican'], protein: ['beef'], diet: [], method: [] });
    });

    test('nothing fit: the picks stay and it says so', async () => {
      setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner'] } });
      answer({ ok: true, tags: emptyRecipeTags() });
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      expect(selected(root)).toEqual(['Dinner']);
      expect(texts(root)).toContain(NOTHING_SUGGESTED_NOTE);
      expect(texts(root)).not.toContain(SUGGESTED_NOTE);
      expect(announce).toHaveBeenCalledWith(NOTHING_SUGGESTED_NOTE);
      expect(suggestButton(root)[0].props.label).toBe('Suggest again');
    });

    test('an error shows its message inline in danger, with no alert, and the button goes back', async () => {
      const alert = jest.spyOn(Alert, 'alert');
      setTags({ tags: { ...emptyRecipeTags(), meal: ['dinner'] } });
      answer({ ok: false, error: 'rate-limited' });
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      const message = "That's a lot of suggestions. Try again in a minute.";
      const line = root.root.find((n) => typeof n.type !== 'string' && n.props.children === message);
      expect(line.props).toMatchObject({ variant: 'footnote', color: 'danger' });
      expect(announce).toHaveBeenCalledWith(message);
      expect(alert).not.toHaveBeenCalled();
      expect(selected(root)).toEqual(['Dinner']);
      expect(suggestButton(root)[0].props).toMatchObject({ label: 'Suggest tags', disabled: false, loading: false });

      answer({ ok: false, error: 'offline' });
      await tap(root);
      expect(texts(root)).toContain("You're offline. Try again when you're connected.");
      expect(texts(root)).not.toContain(message);
    });

    test('Suggest again replaces the last suggestion', async () => {
      answer({ ok: true, tags: { ...emptyRecipeTags(), meal: ['dinner'] } });
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      answer({ ok: true, tags: { ...emptyRecipeTags(), meal: ['lunch'], method: ['grill'] } });
      await tap(root);
      expect(mockSuggest).toHaveBeenCalledTimes(2);
      expect(selected(root)).toEqual(['Lunch', 'Grill']);
    });

    test('Cancel after a suggestion writes nothing', async () => {
      setTags({ tags: { ...emptyRecipeTags(), meal: ['lunch'] }, totalMinutes: 30 });
      const before = getRecipe(tacos);
      answer({ ok: true, tags: { ...emptyRecipeTags(), meal: ['dinner'] } });
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      act(() => toolbar(root, 'Cancel').props.onPress());
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(getRecipe(tacos)).toEqual(before);
      expect(outboxRecipeUpdates()).toHaveLength(0);
    });

    test('Save writes the suggested tags with tagsEdited, so the import note never shows', async () => {
      setTags({ tags: { ...emptyRecipeTags(), meal: ['lunch'] }, totalMinutes: 30 });
      answer({ ok: true, tags: { ...emptyRecipeTags(), meal: ['dinner'], protein: ['beef'] } });
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      press(pill(root, 'Mexican'));
      act(() => toolbar(root, 'Save').props.onPress());
      const saved = { meal: ['dinner'], cuisine: ['mexican'], protein: ['beef'], diet: [], method: [] };
      expect(getRecipe(tacos)).toMatchObject({ tags: saved, tagsEdited: true, totalMinutes: 30 });
      const updates = outboxRecipeUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0].fields).toEqual(expect.objectContaining({ tags: saved, tags_edited: true, total_minutes: 30 }));
      act(() => tree?.unmount());
      expect(texts(render(<RecipeScreen />))).not.toContain(IMPORT_TAGS_NOTE);
    });

    test('Cancel during the call drops the answer and writes nothing', async () => {
      const before = getRecipe(tacos);
      const resolve = deferred();
      const root = render(<RecipeTagsSheet />);
      await tap(root);
      act(() => toolbar(root, 'Cancel').props.onPress());
      await resolve({ ok: true, tags: { ...emptyRecipeTags(), meal: ['dinner'] } });
      expect(selected(root)).toEqual([]);
      expect(texts(root)).not.toContain(SUGGESTED_NOTE);
      expect(announce).not.toHaveBeenCalled();
      expect(getRecipe(tacos)).toEqual(before);
      expect(outboxRecipeUpdates()).toHaveLength(0);
    });

    test('no ingredients: the button is disabled and says why, and nothing is called', async () => {
      const bare = createRecipe('Toast');
      mockParams.id = bare;
      mockParams.suggest = '1';
      const root = render(<RecipeTagsSheet />);
      expect(suggestButton(root)[0].props.disabled).toBe(true);
      const line = root.root.find(
        (n) => typeof n.type !== 'string' && n.props.children === "Add some ingredients first, so there's something to go on.",
      );
      expect(line.props).toMatchObject({ variant: 'footnote', color: 'inkSecondary' });
      expect(mockSuggest).not.toHaveBeenCalled();
    });

    test('suggest=1 starts the call as the sheet opens, once', async () => {
      mockParams.suggest = '1';
      const resolve = deferred();
      const root = render(<RecipeTagsSheet />);
      expect(mockSuggest).toHaveBeenCalledTimes(1);
      expect(mockSuggest).toHaveBeenCalledWith(tacos);
      expect(suggestButton(root)[0].props.label).toBe('Suggesting…');
      await resolve({ ok: true, tags: { ...emptyRecipeTags(), cuisine: ['mexican'] } });
      expect(selected(root)).toEqual(['Mexican']);
      press(pill(root, 'Lunch'));
      expect(mockSuggest).toHaveBeenCalledTimes(1);
    });

    test('without suggest=1, or without the feature, opening calls nothing', () => {
      render(<RecipeTagsSheet />);
      act(() => tree?.unmount());
      setFeatures(['categorize']);
      mockParams.suggest = '1';
      render(<RecipeTagsSheet />);
      expect(mockSuggest).not.toHaveBeenCalled();
    });
  });
});

describe('RecipeIngredientRow', () => {
  test('shows the name, note and amount, and labels them together', () => {
    const id = addRecipeIngredient(tacos, '1 cup salsa')!.id;
    const ingredient = { ...recipeIngredientsQuery(tacos).all().find((i) => i.id === id)!, note: 'verde' };
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const root = render(<RecipeIngredientRow ingredient={ingredient} dotColor="#f00" onEdit={onEdit} onDelete={onDelete} />);
    expect(texts(root)).toEqual(['Salsa', 'verde', '1 cup']);
    const row = byA11y(root, '1 cup Salsa verde');
    press(row);
    expect(onEdit).toHaveBeenCalledTimes(1);
    act(() => byType(root, 'Swipeable')[0].props.onSwipeableOpen());
    expect(onDelete).toHaveBeenCalledTimes(1);
    // Swiping reveals the delete action behind the row.
    expect(byType(root, 'Swipeable')[0].props.renderRightActions()).toBeTruthy();
  });

  test('without an amount it shows the name alone', () => {
    addRecipeIngredient(tacos, 'cilantro');
    const [ingredient] = recipeIngredientsQuery(tacos).all();
    const root = render(<RecipeIngredientRow ingredient={ingredient} dotColor="#f00" onEdit={() => {}} onDelete={() => {}} />);
    expect(texts(root)).toEqual(['Cilantro']);
    expect(queryA11y(root, 'Cilantro')).toHaveLength(1);
  });
});

describe('AddRecipeToListSheet', () => {
  beforeEach(() => {
    for (const text of ['1 lb ground beef', '8 tortillas', 'cilantro']) addRecipeIngredient(tacos, text);
  });

  const checkboxes = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'checkbox' && !!n.props.onPress);
  const selectedPills = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type !== 'string' && n.props.selected === true && !!n.props.label).map((n) => n.props.label);

  test('a missing recipe renders an empty screen', () => {
    mockParams.id = 'nope';
    const root = render(<AddRecipeToListSheet />);
    expect(texts(root)).toEqual([]);
  });

  test('starts on the default list at 1×, every ingredient ticked', () => {
    const root = render(<AddRecipeToListSheet />);
    expect(texts(root)).toEqual(expect.arrayContaining(['Add Tacos', 'To', 'Servings', 'Untick what you have', '3 of 3']));
    const groceriesName = db.select().from(lists).all().find((l) => l.id === groceries)!.name;
    expect(selectedPills(root)).toEqual([groceriesName, '1×']);
    expect(checkboxes(root).map((c) => [c.props.accessibilityLabel, c.props.accessibilityState.checked])).toEqual([
      ['Ground beef, 1 lb', true],
      ['Tortillas, 8', true],
      ['Cilantro', true],
    ]);
    expect(byLabel(root, `Add 3 to ${groceriesName}`).props.disabled).toBe(false);
  });

  test('servings scale the amounts; unticking drops an ingredient from the add', () => {
    const root = render(<AddRecipeToListSheet />);
    press(byLabel(root, '2×'));
    expect(checkboxes(root).map((c) => c.props.accessibilityLabel)).toEqual(['Ground beef, 2 lb', 'Tortillas, 16', 'Cilantro']);
    press(checkboxes(root)[2]);
    expect(texts(root)).toContain('2 of 3');
    expect(checkboxes(root)[2].props.accessibilityState.checked).toBe(false);
    const add = root.root.find((n) => typeof n.type !== 'string' && /^Add 2 to /.test(n.props.label ?? ''));
    press(add);
    expect(listRows(groceries)).toEqual(['2 lb ground beef', '16 tortillas']);
  });

  test('unticking everything disables the add', () => {
    const root = render(<AddRecipeToListSheet />);
    for (const c of checkboxes(root)) press(c);
    const add = root.root.find((n) => typeof n.type !== 'string' && n.props.label === 'Nothing selected' && n.props.onPress);
    expect(add.props.disabled).toBe(true);
    press(checkboxes(root)[1]);
    expect(texts(root)).toContain('1 of 3');
  });

  test('adding to another list hands the toast its result, closes, and shows that list on the List tab', () => {
    const party = createList('Party');
    const root = render(<AddRecipeToListSheet />);
    press(byLabel(root, 'Party'));
    expect(selectedPills(root)).toContain('Party');
    press(byLabel(root, 'Add 3 to Party'));
    expect(listRows(party)).toEqual(['1 lb ground beef', '8 tortillas', 'cilantro']);
    expect(listRows(groceries)).toEqual([]);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    expect(mockPush).not.toHaveBeenCalled();
    expect(resolveCurrentListId(listsWithCountsQuery().all(), USER)).toBe(party);
    expect(takeRecipeAddResult(party)).toMatchObject({ kind: 'toList', recipeId: tacos, recipeName: 'Tacos', count: 3 });
    expect(mockCategorize).toHaveBeenCalled();
  });

  test('opened from a list, it preselects that list and only goes back', () => {
    const party = createList('Party');
    mockParams.list = party;
    const root = render(<AddRecipeToListSheet />);
    expect(selectedPills(root)).toContain('Party');
    press(byLabel(root, 'Add 3 to Party'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('archived lists are not offered', () => {
    const old = createList('Old');
    db.update(lists).set({ archivedAt: new Date() }).where(eq(lists.id, old)).run();
    const root = render(<AddRecipeToListSheet />);
    expect(root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'Old')).toHaveLength(0);
  });

  test("only lists in the recipe's household are offered, even when the Siri default is elsewhere", () => {
    insertRow(db, households, { id: 'h-cabin', name: 'Cabin' });
    const cabinGroceries = createList('Groceries', 'h-cabin');
    db.update(lists).set({ position: 0 }).where(eq(lists.id, cabinGroceries)).run();
    const cabinTacos = createRecipe('Cabin tacos', 'h-cabin');
    addRecipeIngredient(cabinTacos, 'salsa');
    mockParams.id = cabinTacos;
    const root = render(<AddRecipeToListSheet />);
    const pills = root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === 'Groceries' && !!n.props.onPress);
    expect(pills).toHaveLength(1);
    expect(selectedPills(root)).toEqual(['Groceries', '1×']);
    press(byLabel(root, 'Add 1 to Groceries'));
    expect(listRows(cabinGroceries)).toEqual(['salsa']);
    expect(listRows(groceries)).toEqual([]);
  });

  test('from Adjust, the add replaces the earlier one', () => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    const first = addRecipeToList(groceries, buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), 1), USER);
    expect(listRows(groceries)).toEqual(['1 lb ground beef', '8 tortillas', 'cilantro']);
    mockParams.list = groceries;
    mockParams.adjust = startAdjust({ listId: groceries, recipeId: tacos, results: first.results });
    const root = render(<AddRecipeToListSheet />);
    press(byLabel(root, '2×'));
    press(root.root.find((n) => typeof n.type !== 'string' && /^Add 3 to /.test(n.props.label ?? '') && n.props.onPress));
    expect(listRows(groceries)).toEqual(['2 lb ground beef', '16 tortillas', 'cilantro']);
  });

  describe('Always have', () => {
    const household = () => getRecipe(tacos)!.householdId;
    const choices = (root: ReactTestRenderer) =>
      checkboxes(root).map((c) => [c.props.accessibilityLabel, c.props.accessibilityState.checked]);
    /** The "Always have" tags drawn, with their colour. */
    const tags = (root: ReactTestRenderer) =>
      root.root
        .findAll((n) => typeof n.type !== 'string' && n.props.children === '  Always have')
        .map((n) => n.props.color);

    test('staples start unticked and tagged, in inkSecondary; the count follows the ticks', () => {
      setStaple(household(), 'cilantro', true, USER);
      const root = render(<AddRecipeToListSheet />);
      expect(choices(root)).toEqual([
        ['Ground beef, 1 lb', true],
        ['Tortillas, 8', true],
        ['Cilantro, Always have', false],
      ]);
      expect(tags(root)).toEqual(['inkSecondary']);
      expect(texts(root)).toEqual(expect.arrayContaining(['2 of 3', 'Cilantro  Always have']));
      const groceriesName = db.select().from(lists).all().find((l) => l.id === groceries)!.name;
      expect(byLabel(root, `Add 2 to ${groceriesName}`).props.disabled).toBe(false);
    });

    test("ticking a staple adds it this time and doesn't change the staple", () => {
      setStaple(household(), 'cilantro', true, USER);
      const root = render(<AddRecipeToListSheet />);
      press(checkboxes(root)[2]);
      expect(texts(root)).toContain('3 of 3');
      // Still tagged: it's still a staple.
      expect(tags(root)).toEqual(['inkSecondary']);
      press(root.root.find((n) => typeof n.type !== 'string' && /^Add 3 to /.test(n.props.label ?? '') && n.props.onPress));
      expect(listRows(groceries)).toEqual(['1 lb ground beef', '8 tortillas', 'cilantro']);
      expect(isStaple(household(), 'cilantro')).toBe(true);
    });

    test('rows have no long-press to mark or unmark', () => {
      const root = render(<AddRecipeToListSheet />);
      expect(checkboxes(root).map((c) => c.props.onLongPress)).toEqual([undefined, undefined, undefined]);
    });

    test("another household's staples, or an unmarked one, start ticked with no tag", () => {
      insertRow(db, households, { id: 'h-cabin', name: 'Cabin' });
      setStaple('h-cabin', 'cilantro', true, USER);
      const tortillas = recipeIngredientsQuery(tacos).all()[1].ingredientName;
      setStaple(household(), tortillas, true, USER);
      setStaple(household(), tortillas, false, USER);
      const root = render(<AddRecipeToListSheet />);
      expect(choices(root).map(([, checked]) => checked)).toEqual([true, true, true]);
      expect(tags(root)).toEqual([]);
    });

    test('from Adjust after an all-staples add, the same starting ticks, and the add puts on what is ticked', () => {
      for (const i of recipeIngredientsQuery(tacos).all()) setStaple(household(), i.ingredientName, true, USER);
      const first = addWholeRecipeToList(groceries, tacos, USER)!;
      expect(first.count).toBe(0);
      mockParams.list = groceries;
      mockParams.adjust = startAdjust({ listId: groceries, recipeId: tacos, results: first.results });
      const root = render(<AddRecipeToListSheet />);
      expect(choices(root).map(([, checked]) => checked)).toEqual([false, false, false]);
      expect(texts(root)).toContain('0 of 3');
      press(checkboxes(root)[1]);
      press(byLabel(root, 'Add 1 to ' + db.select().from(lists).all().find((l) => l.id === groceries)!.name));
      expect(listRows(groceries)).toEqual(['8 tortillas']);
    });
  });

  test('Cancel goes back without adding', () => {
    const root = render(<AddRecipeToListSheet />);
    const cancel = byType(root, 'ToolbarButton').find((n) => n.props.children === 'Cancel')!;
    act(() => cancel.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(listRows(groceries)).toEqual([]);
  });
});
