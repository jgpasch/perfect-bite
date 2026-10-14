// The list add bar (spec 4.2): type and add, autocomplete chips from household history and the catalog,
// recipe chips that add a whole recipe, and "Remove from suggestions" on history chips.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, lists } from '@/db';
import { addRecipeIngredient, createRecipe } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';

import { ItemAddBar } from '../add-bar';
import { addItem, clearChecked, setItemChecked, undoAdd, type AddItemResult } from '../items';
import { ensureStarterData, getDefaultListId } from '../lists';
import { SuggestionChips } from '../suggestion-chips';
import type { SuggestionChip } from '../suggestions';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// Live queries read once per render from the test database.
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));

const USER = 'user-1';
let listId: string;
let householdId: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  householdId = db.select().from(lists).all()[0].householdId;
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

const hosts = (pred: (n: ReactTestInstance) => boolean) =>
  tree!.root.findAll((n) => typeof n.type === 'string' && pred(n));
const byLabel = (label: string) => {
  const found = hosts((n) => n.props.accessibilityLabel === label);
  expect(found).toHaveLength(1);
  return found[0];
};
const pressable = (label: string) =>
  tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props);
const input = () => hosts((n) => n.type === ('TextInput' as never))[0];
const type = (value: string) => act(() => input().props.onChangeText(value));
const chipLabels = () =>
  hosts((n) => n.props.accessibilityRole === 'button' && /^Add (recipe )?\S/.test(n.props.accessibilityLabel ?? ''))
    .map((n) => n.props.accessibilityLabel as string)
    .filter((l) => l !== 'Add');

describe('ItemAddBar', () => {
  function renderBar(over: Partial<Parameters<typeof ItemAddBar>[0]> = {}) {
    const props = {
      householdId,
      onAdd: jest.fn(),
      onTextChange: jest.fn(),
      onFocusChange: jest.fn(),
      placeholder: 'Add an item',
      accessibilityLabel: 'Add to list',
      ...over,
    };
    act(() => {
      tree = create(<ItemAddBar {...props} />);
    });
    return props;
  }

  test('the Add button is disabled until something is typed', () => {
    renderBar();
    expect(byLabel('Add').props.accessibilityState).toEqual({ disabled: true });
    type('milk');
    expect(byLabel('Add').props.accessibilityState).toEqual({ disabled: false });
  });

  test('Add sends the text, reports the change and clears the field', () => {
    const props = renderBar();
    type('2 lbs chicken');
    expect(props.onTextChange).toHaveBeenLastCalledWith('2 lbs chicken');
    act(() => byLabel('Add').props.onClick());
    expect(props.onAdd).toHaveBeenCalledWith('2 lbs chicken');
    expect(input().props.value).toBe('');
    expect(props.onTextChange).toHaveBeenLastCalledWith('');
  });

  test('Return adds too; on blank text it adds nothing', () => {
    const props = renderBar();
    type('eggs');
    act(() => input().props.onSubmitEditing());
    expect(props.onAdd).toHaveBeenCalledWith('eggs');
    type('   ');
    act(() => input().props.onSubmitEditing());
    expect(props.onAdd).toHaveBeenCalledTimes(1);
  });

  test('focus changes are passed on (the list screen\'s add mode)', () => {
    const props = renderBar();
    act(() => input().props.onFocus());
    expect(props.onFocusChange).toHaveBeenLastCalledWith(true);
    act(() => input().props.onBlur());
    expect(props.onFocusChange).toHaveBeenLastCalledWith(false);
  });

  test('no chips while the field is empty', () => {
    addItem(listId, 'milk', USER);
    renderBar();
    expect(hosts((n) => n.props.accessibilityLabel === 'Suggestions')).toHaveLength(0);
  });

  test('household history is suggested; tapping a chip adds it with the typed amount', () => {
    addItem(listId, 'oat milk', USER);
    const props = renderBar();
    type('2 oat');
    expect(chipLabels()).toContain('Add Oat milk');
    act(() => byLabel('Add Oat milk').props.onClick());
    expect(props.onAdd).toHaveBeenCalledWith('2 oat milk');
    expect(input().props.value).toBe('');
  });

  test('the catalog fills in when history has little; catalog chips have no remove menu', () => {
    seedCatalog();
    renderBar();
    type('bana');
    expect(chipLabels()).toContain('Add Bananas');
    expect(pressable('Add Bananas').props.onLongPress).toBeUndefined();
  });

  test('long-pressing a history chip offers Remove from suggestions, which hides it', () => {
    addItem(listId, 'oat milk', USER);
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
      expect(options.options).toEqual(['Remove from suggestions', 'Cancel']);
      expect(options.title).toBe('Oat milk');
      callback(0);
    });
    renderBar();
    type('oat');
    expect(byLabel('Add Oat milk').props.accessibilityHint).toBe('Long press to remove from suggestions');
    act(() => pressable('Add Oat milk').props.onLongPress());
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(chipLabels()).not.toContain('Add Oat milk');
  });

  test('cancelling the remove menu keeps the chip', () => {
    addItem(listId, 'oat milk', USER);
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
    renderBar();
    type('oat');
    act(() => pressable('Add Oat milk').props.onLongPress());
    expect(chipLabels()).toContain('Add Oat milk');
  });

  test('with onAddRecipe, matching recipes come first and tapping one adds the recipe', () => {
    const recipeId = createRecipe('Tacos', householdId);
    addRecipeIngredient(recipeId, 'tortillas');
    addRecipeIngredient(recipeId, 'limes');
    addItem(listId, 'tahini', USER);
    const onAddRecipe = jest.fn();
    const props = renderBar({ onAddRecipe });
    type('ta');
    const labels = chipLabels();
    expect(labels[0]).toBe('Add recipe Tacos, 2 items');
    expect(labels).toContain('Add Tahini');
    act(() => byLabel('Add recipe Tacos, 2 items').props.onClick());
    expect(onAddRecipe).toHaveBeenCalledWith({ id: recipeId, name: 'Tacos', ingredientCount: 2 });
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(input().props.value).toBe('');
  });

  test('without onAddRecipe, recipes are not offered', () => {
    createRecipe('Tacos', householdId);
    renderBar();
    type('ta');
    expect(chipLabels().filter((l) => l.startsWith('Add recipe'))).toEqual([]);
  });

  describe('usual items (spec 4.2)', () => {
    // Bought twice each, all checked off and cleared: usual, and none on the list.
    function buyTwice(...names: string[]) {
      for (const name of [...names, ...names]) setItemChecked(addItem(listId, name, USER)!.itemId, true, USER);
      clearChecked(listId);
    }
    const focus = () => act(() => input().props.onFocus());
    const blur = () => act(() => input().props.onBlur());
    const rowLabels = () =>
      hosts((n) => n.props.accessibilityLabel === 'Usual items' || n.props.accessibilityLabel === 'Suggestions').map(
        (n) => n.props.accessibilityLabel as string,
      );
    // The list screen's add: Combine and Undo as 4.4 (the screen's toast plays the Undo here).
    const added: AddItemResult[] = [];
    const listAdd = jest.fn((text: string) => {
      const result = addItem(listId, text, USER);
      if (result) added.push(result);
    });
    let props: Parameters<typeof ItemAddBar>[0];
    const renderListBar = () => (props = renderBar({ listId, onAdd: listAdd }));
    // A live query re-runs on a change; here a re-render reads it again.
    const rerender = () => act(() => tree!.update(<ItemAddBar {...props} />));

    beforeEach(() => {
      added.length = 0;
      listAdd.mockClear();
    });

    test('focusing the empty field shows the usual items, most used lately first', () => {
      buyTwice('milk', 'bananas', 'eggs');
      // A third use puts eggs first; bananas were used after milk (or at once, and then by name).
      setItemChecked(addItem(listId, 'eggs', USER)!.itemId, true, USER);
      clearChecked(listId);
      renderListBar();
      expect(rowLabels()).toEqual([]);
      focus();
      expect(rowLabels()).toEqual(['Usual items']);
      expect(chipLabels()).toEqual(['Add Eggs', 'Add Bananas', 'Add Milk']);
    });

    test('no row without focus, and none once the keyboard hides', () => {
      buyTwice('milk');
      renderListBar();
      expect(chipLabels()).toEqual([]);
      focus();
      expect(chipLabels()).toEqual(['Add Milk']);
      blur();
      expect(rowLabels()).toEqual([]);
    });

    test('tapping a usual chip adds its name with no amount, keeps the field, and the chip leaves the row', () => {
      buyTwice('milk', 'eggs');
      renderListBar();
      focus();
      expect(chipLabels()).toEqual(['Add Eggs', 'Add Milk']);
      act(() => byLabel('Add Milk').props.onClick());
      expect(listAdd).toHaveBeenCalledWith('milk');
      expect(input().props.value).toBe('');
      expect(chipLabels()).toEqual(['Add Eggs']);
    });

    test('Undo of that add brings the chip back', () => {
      buyTwice('milk', 'eggs');
      renderListBar();
      focus();
      act(() => byLabel('Add Milk').props.onClick());
      expect(chipLabels()).toEqual(['Add Eggs']);
      undoAdd(added[0]);
      rerender();
      // Undo takes back the use but not its time, so milk may now come first.
      expect(chipLabels().sort()).toEqual(['Add Eggs', 'Add Milk']);
    });

    test('an item added elsewhere (a sync) drops its chip on the next read', () => {
      buyTwice('milk', 'eggs');
      renderListBar();
      focus();
      addItem(listId, 'eggs', 'user-2');
      rerender();
      expect(chipLabels()).toEqual(['Add Milk']);
    });

    test('typing switches to autocomplete; clearing the text brings the usual chips back', () => {
      buyTwice('oat milk', 'milk');
      renderListBar();
      focus();
      expect(rowLabels()).toEqual(['Usual items']);
      type('oat');
      expect(rowLabels()).toEqual(['Suggestions']);
      expect(chipLabels()).toEqual(['Add Oat milk']);
      type('  ');
      expect(rowLabels()).toEqual(['Usual items']);
      expect(chipLabels()).toEqual(['Add Milk', 'Add Oat milk']);
    });

    test('long press offers Remove from suggestions, which hides the chip', () => {
      buyTwice('milk', 'eggs');
      jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
        expect(options.options).toEqual(['Remove from suggestions', 'Cancel']);
        expect(options.title).toBe('Milk');
        callback(0);
      });
      renderListBar();
      focus();
      expect(byLabel('Add Milk').props.accessibilityHint).toBe('Long press to remove from suggestions');
      act(() => pressable('Add Milk').props.onLongPress());
      expect(chipLabels()).toEqual(['Add Eggs']);
    });

    test('a one-off is not usual; with nothing usual there is no row', () => {
      setItemChecked(addItem(listId, 'saffron', USER)!.itemId, true, USER);
      renderListBar();
      focus();
      expect(rowLabels()).toEqual([]);
    });

    test("without a listId (the recipe screen's bar), the empty field shows nothing", () => {
      buyTwice('milk', 'eggs');
      renderBar();
      focus();
      expect(rowLabels()).toEqual([]);
      expect(chipLabels()).toEqual([]);
    });
  });
});

describe('SuggestionChips', () => {
  const chips: SuggestionChip[] = [
    { kind: 'recipe', key: 'recipe-r1', recipe: { id: 'r1', name: 'Chili', ingredientCount: 1 } },
    { kind: 'item', key: 'chives', label: 'Chives', text: '2 chives', removable: true },
    { kind: 'item', key: 'chickpeas', label: 'Chickpeas', text: 'chickpeas', removable: false },
  ];

  function renderChips() {
    const handlers = { onPressItem: jest.fn(), onPressRecipe: jest.fn(), onRemove: jest.fn() };
    act(() => {
      tree = create(<SuggestionChips chips={chips} typed="chi" {...handlers} />);
    });
    return handlers;
  }

  test('a chip per suggestion, in order, with the recipe read as one', () => {
    renderChips();
    expect(chipLabels()).toEqual(['Add recipe Chili, 1 item', 'Add Chives', 'Add Chickpeas']);
  });

  test('the typed part of each name is set apart', () => {
    renderChips();
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('"Chi"');
    expect(json).toContain('"ves"');
  });

  test('taps go to the item or recipe handler; long press removes only removable chips', () => {
    const h = renderChips();
    act(() => byLabel('Add recipe Chili, 1 item').props.onClick());
    expect(h.onPressRecipe).toHaveBeenCalledWith(chips[0]);
    act(() => byLabel('Add Chives').props.onClick());
    expect(h.onPressItem).toHaveBeenCalledWith(chips[1]);
    act(() => pressable('Add Chives').props.onLongPress());
    expect(h.onRemove).toHaveBeenCalledWith(chips[1]);
    expect(pressable('Add Chickpeas').props.onLongPress).toBeUndefined();
    expect(byLabel('Add Chickpeas').props.accessibilityHint).toBeUndefined();
  });
});
