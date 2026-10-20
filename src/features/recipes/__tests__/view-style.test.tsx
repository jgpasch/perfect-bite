// The Recipe view design trial setting (spec 4.5).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import {
  getRecipeViewStyle,
  readRecipeViewStyle,
  RECIPE_VIEW_STYLE_KEY,
  RECIPE_VIEW_STYLES,
  setRecipeViewStyle,
  useRecipeViewStyle,
  type RecipeViewStyle,
} from '../view-style';

jest.mock('@/db/client', () => require('@/test/db'));

let tree: ReactTestRenderer | null = null;

beforeEach(() => resetDb());

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('readRecipeViewStyle', () => {
  test('keeps the two styles', () => {
    expect(RECIPE_VIEW_STYLES).toEqual(['standard', 'indexCard']);
    expect(readRecipeViewStyle('standard')).toBe('standard');
    expect(readRecipeViewStyle('indexCard')).toBe('indexCard');
  });

  test('falls back to standard for anything else, never-set included', () => {
    expect(readRecipeViewStyle(null)).toBe('standard');
    expect(readRecipeViewStyle(undefined)).toBe('standard');
    expect(readRecipeViewStyle('')).toBe('standard');
    expect(readRecipeViewStyle('index-card')).toBe('standard');
    expect(readRecipeViewStyle('IndexCard')).toBe('standard');
    expect(readRecipeViewStyle('compact')).toBe('standard');
    expect(readRecipeViewStyle(1)).toBe('standard');
    expect(readRecipeViewStyle({ style: 'indexCard' })).toBe('standard');
  });
});

describe('get and set', () => {
  test('standard until set; saved as recipe.viewStyle; round-trips both styles', () => {
    expect(RECIPE_VIEW_STYLE_KEY).toBe('recipe.viewStyle');
    expect(getDeviceSetting(RECIPE_VIEW_STYLE_KEY, null)).toBeNull();
    expect(getRecipeViewStyle()).toBe('standard');
    setRecipeViewStyle('indexCard');
    expect(getDeviceSetting(RECIPE_VIEW_STYLE_KEY, null)).toBe('indexCard');
    expect(getRecipeViewStyle()).toBe('indexCard');
    setRecipeViewStyle('standard');
    expect(getDeviceSetting(RECIPE_VIEW_STYLE_KEY, null)).toBe('standard');
    expect(getRecipeViewStyle()).toBe('standard');
  });

  test('an unknown saved value reads as standard', () => {
    setDeviceSetting(RECIPE_VIEW_STYLE_KEY, 'magazine');
    expect(getRecipeViewStyle()).toBe('standard');
  });
});

describe('useRecipeViewStyle', () => {
  const seen: RecipeViewStyle[] = [];
  function Probe() {
    seen.push(useRecipeViewStyle());
    return null;
  }

  beforeEach(() => void (seen.length = 0));

  test('reads the saved style and follows a change at once', () => {
    setRecipeViewStyle('indexCard');
    act(() => {
      tree = create(<Probe />);
    });
    expect(seen.at(-1)).toBe('indexCard');
    act(() => setRecipeViewStyle('standard'));
    expect(seen.at(-1)).toBe('standard');
    act(() => setRecipeViewStyle('indexCard'));
    expect(seen.at(-1)).toBe('indexCard');
  });

  test('stops listening once unmounted', () => {
    act(() => {
      tree = create(<Probe />);
    });
    expect(seen).toEqual(['standard']);
    act(() => tree?.unmount());
    tree = null;
    const renders = seen.length;
    setRecipeViewStyle('indexCard');
    expect(seen).toHaveLength(renders);
    expect(getRecipeViewStyle()).toBe('indexCard');
  });
});
