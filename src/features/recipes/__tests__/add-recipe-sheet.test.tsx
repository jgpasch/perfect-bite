// The Add recipe sheet (spec 4.5): name a blank recipe or, with `recipe_import` (spec 4.12), hand a
// link to the import sheet. Rendered against the in-memory database with navigation stubbed.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { households, recipes } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { setFeatures, type Feature } from '@/features/plans/features';
import { db, resetDb } from '@/test/db';

import AddRecipeSheet from '@/app/add-recipe';

import { NAME_IS_LINK_FOOTNOTE } from '../add-recipe';
import { getRecipe } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));

const mockHasUrl = jest.fn<() => Promise<boolean>>();
const mockClipboard = jest.fn<() => Promise<string>>();
jest.mock('expo-clipboard', () => ({ hasUrlAsync: () => mockHasUrl(), getStringAsync: () => mockClipboard() }));

const mockParams: Record<string, string | undefined> = {};
const mockPush = jest.fn();
const mockReplace = jest.fn();
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
    Stack: { Toolbar },
    router: {
      push: (...args: unknown[]) => mockPush(...args),
      replace: (...args: unknown[]) => mockReplace(...args),
      back: () => mockBack(),
    },
    useLocalSearchParams: () => mockParams,
  };
});
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

const PLUS: Feature[] = ['categorize', 'recipe_import'];
const STANDARD: Feature[] = ['categorize'];
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData('user-1');
  for (const k of Object.keys(mockParams)) delete mockParams[k];
  for (const fn of [mockPush, mockReplace, mockBack]) fn.mockClear();
  mockHasUrl.mockReset().mockResolvedValue(false);
  mockClipboard.mockReset();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  setFeatures(STANDARD);
});

async function render(features: Feature[]): Promise<ReactTestRenderer> {
  setFeatures(features);
  await act(async () => {
    tree = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AddRecipeSheet />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

const allRecipes = () => db.select().from(recipes).all();
const field = (root: ReactTestRenderer, label: string) =>
  root.root.find((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === label);
const maybeField = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => n.type === ('TextInput' as never) && n.props.accessibilityLabel === label)[0];
/** The composite button with this label, or undefined. */
const button = (root: ReactTestRenderer, label: string) =>
  root.root.findAll((n) => typeof n.type !== 'string' && n.props.label === label && typeof n.props.onPress === 'function')[0];
const type = (input: ReactTestInstance, text: string) => act(() => input.props.onChangeText(text));
const press = (n: ReactTestInstance) => act(() => n.props.onPress());
const texts = (root: ReactTestRenderer) =>
  root.root.findAll((n) => n.type === ('Text' as never)).map((n) => [n.props.children].flat().join(''));

describe('the sheet', () => {
  test('titled "Add recipe", with a "New recipe" group and Cancel', async () => {
    const root = await render(STANDARD);
    expect(texts(root)).toEqual(expect.arrayContaining(['Add recipe', 'New recipe']));
    expect(root.root.findAll((n) => n.type === ('ToolbarButton' as never)).map((n) => n.props.children)).toEqual(['Cancel']);
    expect(field(root, 'Recipe name').props.placeholder).toBe('Recipe name');
    expect(field(root, 'Recipe name').props.autoFocus).toBe(true);
  });

  test('Cancel closes it and makes nothing', async () => {
    const root = await render(PLUS);
    type(field(root, 'Recipe name'), 'Tacos');
    press(root.root.find((n) => n.type === ('ToolbarButton' as never) && n.props.children === 'Cancel'));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(allRecipes()).toEqual([]);
  });
});

describe('New recipe', () => {
  test('Create is disabled while the name is empty or blank', async () => {
    const root = await render(STANDARD);
    expect(button(root, 'Create').props.disabled).toBe(true);
    type(field(root, 'Recipe name'), '   ');
    expect(button(root, 'Create').props.disabled).toBe(true);
    // Return with nothing typed makes nothing.
    act(() => field(root, 'Recipe name').props.onSubmitEditing());
    expect(allRecipes()).toEqual([]);
  });

  test('Create makes a blank recipe in the household and opens it', async () => {
    const root = await render(STANDARD);
    type(field(root, 'Recipe name'), '  Tacos ');
    expect(button(root, 'Create').props.disabled).toBe(false);
    press(button(root, 'Create'));
    const [made] = allRecipes();
    expect(made.name).toBe('Tacos');
    // The user's (first) household, as the old name prompt did; blank, with no link.
    expect(made.householdId).toBe(db.select().from(households).get()!.id);
    expect(getRecipe(made.id)).toMatchObject({ name: 'Tacos', sourceUrl: null });
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls).toEqual([[{ pathname: '/recipe/[id]', params: { id: made.id } }]]);
  });

  test('Return in the name field creates too', async () => {
    const root = await render(PLUS);
    type(field(root, 'Recipe name'), 'Soup');
    act(() => field(root, 'Recipe name').props.onSubmitEditing());
    expect(allRecipes().map((r) => r.name)).toEqual(['Soup']);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe('a link in the name field', () => {
  const LINK = 'https://smittenkitchen.com/2008/09/moms-apple-cake';

  test('with import: the button reads Import recipe and hands the link to the import sheet', async () => {
    const root = await render(PLUS);
    type(field(root, 'Recipe name'), LINK);
    expect(button(root, 'Create')).toBeUndefined();
    press(button(root, 'Import recipe'));
    expect(mockReplace.mock.calls).toEqual([[{ pathname: '/import-recipe', params: { url: LINK } }]]);
    expect(allRecipes()).toEqual([]);
    expect(texts(root)).not.toContain(NAME_IS_LINK_FOOTNOTE);
  });

  test('with import, Return imports it too, adding https:// to a bare link', async () => {
    const root = await render(PLUS);
    type(field(root, 'Recipe name'), 'nytimes.com/recipes/1');
    act(() => field(root, 'Recipe name').props.onSubmitEditing());
    expect(mockReplace.mock.calls).toEqual([[{ pathname: '/import-recipe', params: { url: 'https://nytimes.com/recipes/1' } }]]);
    expect(allRecipes()).toEqual([]);
  });

  test('without import: refused, Create disabled, with the footnote', async () => {
    const root = await render(STANDARD);
    type(field(root, 'Recipe name'), LINK);
    expect(button(root, 'Create').props.disabled).toBe(true);
    expect(button(root, 'Import recipe')).toBeUndefined();
    expect(texts(root)).toContain(NAME_IS_LINK_FOOTNOTE);
    act(() => field(root, 'Recipe name').props.onSubmitEditing());
    expect(allRecipes()).toEqual([]);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    // Typing a name instead clears it.
    type(field(root, 'Recipe name'), 'Apple cake');
    expect(texts(root)).not.toContain(NAME_IS_LINK_FOOTNOTE);
    expect(button(root, 'Create').props.disabled).toBe(false);
  });
});

describe('Import from a link', () => {
  test('hidden without recipe_import', async () => {
    const root = await render(STANDARD);
    expect(texts(root)).not.toContain('Or import from a link');
    expect(maybeField(root, 'Recipe link')).toBeUndefined();
    expect(button(root, 'Import')).toBeUndefined();
    expect(button(root, 'Paste')).toBeUndefined();
    // The clipboard isn't even asked.
    expect(mockHasUrl).not.toHaveBeenCalled();
  });

  test('with it: the group, a "https://" field and Import, disabled while empty', async () => {
    const root = await render(PLUS);
    expect(texts(root)).toContain('Or import from a link');
    expect(field(root, 'Recipe link').props.placeholder).toBe('https://');
    expect(button(root, 'Import').props.disabled).toBe(true);
    type(field(root, 'Recipe link'), '  ');
    expect(button(root, 'Import').props.disabled).toBe(true);
  });

  test('Import passes the URL to the import flow', async () => {
    const root = await render(PLUS);
    type(field(root, 'Recipe link'), ' https://example.com/cake ');
    press(button(root, 'Import'));
    expect(mockReplace.mock.calls).toEqual([[{ pathname: '/import-recipe', params: { url: 'https://example.com/cake' } }]]);
    expect(allRecipes()).toEqual([]);
  });

  test('Return in the link field imports, taking the URL out of shared text', async () => {
    const root = await render(PLUS);
    type(field(root, 'Recipe link'), 'Try this! https://example.com/cake.');
    act(() => field(root, 'Recipe link').props.onSubmitEditing());
    expect(mockReplace.mock.calls).toEqual([[{ pathname: '/import-recipe', params: { url: 'https://example.com/cake' } }]]);
  });

  test('no Paste when the clipboard holds no link', async () => {
    const root = await render(PLUS);
    expect(mockHasUrl).toHaveBeenCalledTimes(1);
    expect(button(root, 'Paste')).toBeUndefined();
  });

  test('a clipboard check that fails just leaves Paste off', async () => {
    mockHasUrl.mockRejectedValue(new Error('unavailable'));
    const root = await render(PLUS);
    expect(button(root, 'Paste')).toBeUndefined();
  });

  test('Paste shows with a link on the clipboard and fills the field', async () => {
    mockHasUrl.mockResolvedValue(true);
    mockClipboard.mockResolvedValue('Look: https://example.com/cake');
    const root = await render(PLUS);
    // Read only when tapped.
    expect(mockClipboard).not.toHaveBeenCalled();
    await act(async () => {
      await button(root, 'Paste').props.onPress();
    });
    expect(field(root, 'Recipe link').props.value).toBe('https://example.com/cake');
    expect(button(root, 'Import').props.disabled).toBe(false);
  });

  test('focus=link starts in the link field', async () => {
    mockParams.focus = 'link';
    const root = await render(PLUS);
    expect(field(root, 'Recipe link').props.autoFocus).toBe(true);
    expect(field(root, 'Recipe name').props.autoFocus).toBe(false);
  });

  test('focus=link without import starts in the name field', async () => {
    mockParams.focus = 'link';
    const root = await render(STANDARD);
    expect(field(root, 'Recipe name').props.autoFocus).toBe(true);
  });
});
