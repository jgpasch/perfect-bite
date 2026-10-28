// The Cook view design trial setting (spec 4.5).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import {
  getCookViewStyle,
  readCookViewStyle,
  COOK_VIEW_STYLE_KEY,
  COOK_VIEW_STYLES,
  setCookViewStyle,
  useCookViewStyle,
  type CookViewStyle,
} from '../cook-style';

jest.mock('@/db/client', () => require('@/test/db'));

let tree: ReactTestRenderer | null = null;

beforeEach(() => resetDb());

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('readCookViewStyle', () => {
  test('keeps the two styles', () => {
    expect(COOK_VIEW_STYLES).toEqual(['cards', 'sheet']);
    expect(readCookViewStyle('cards')).toBe('cards');
    expect(readCookViewStyle('sheet')).toBe('sheet');
  });

  test('falls back to cards for anything else, never-set included', () => {
    expect(readCookViewStyle(null)).toBe('cards');
    expect(readCookViewStyle(undefined)).toBe('cards');
    expect(readCookViewStyle('')).toBe('cards');
    expect(readCookViewStyle('Sheet')).toBe('cards');
    // The retired timeline.
    expect(readCookViewStyle('timeline')).toBe('cards');
    expect(readCookViewStyle(1)).toBe('cards');
    expect(readCookViewStyle({ style: 'sheet' })).toBe('cards');
  });
});

describe('get and set', () => {
  test('cards until set; saved as cook.viewStyle; round-trips both styles', () => {
    expect(COOK_VIEW_STYLE_KEY).toBe('cook.viewStyle');
    expect(getDeviceSetting(COOK_VIEW_STYLE_KEY, null)).toBeNull();
    expect(getCookViewStyle()).toBe('cards');
    setCookViewStyle('sheet');
    expect(getDeviceSetting(COOK_VIEW_STYLE_KEY, null)).toBe('sheet');
    expect(getCookViewStyle()).toBe('sheet');
    setCookViewStyle('cards');
    expect(getDeviceSetting(COOK_VIEW_STYLE_KEY, null)).toBe('cards');
    expect(getCookViewStyle()).toBe('cards');
  });

  test('an unknown saved value reads as cards', () => {
    setDeviceSetting(COOK_VIEW_STYLE_KEY, 'magazine');
    expect(getCookViewStyle()).toBe('cards');
  });
});

describe('useCookViewStyle', () => {
  const seen: CookViewStyle[] = [];
  function Probe() {
    seen.push(useCookViewStyle());
    return null;
  }

  beforeEach(() => void (seen.length = 0));

  test('reads the saved style and follows a change at once', () => {
    setCookViewStyle('sheet');
    act(() => {
      tree = create(<Probe />);
    });
    expect(seen.at(-1)).toBe('sheet');
    act(() => setCookViewStyle('cards'));
    expect(seen.at(-1)).toBe('cards');
    act(() => setCookViewStyle('sheet'));
    expect(seen.at(-1)).toBe('sheet');
  });

  test('stops listening once unmounted', () => {
    act(() => {
      tree = create(<Probe />);
    });
    expect(seen).toEqual(['cards']);
    act(() => tree?.unmount());
    tree = null;
    const renders = seen.length;
    setCookViewStyle('sheet');
    expect(seen).toHaveLength(renders);
    expect(getCookViewStyle()).toBe('sheet');
  });
});
