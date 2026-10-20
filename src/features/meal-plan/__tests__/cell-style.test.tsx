// The Grid cells setting (spec 4.16).
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import {
  getPlanCellStyle,
  PLAN_CELL_STYLE_KEY,
  PLAN_CELL_STYLES,
  readPlanCellStyle,
  setPlanCellStyle,
  usePlanCellStyle,
  type PlanCellStyle,
} from '../cell-style';

jest.mock('@/db/client', () => require('@/test/db'));

let tree: ReactTestRenderer | null = null;

beforeEach(() => resetDb());

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('readPlanCellStyle', () => {
  test('keeps the two styles, split first', () => {
    expect(PLAN_CELL_STYLES).toEqual(['split', 'stacked']);
    expect(readPlanCellStyle('split')).toBe('split');
    expect(readPlanCellStyle('stacked')).toBe('stacked');
  });

  test('falls back to split for anything else, never-set included', () => {
    expect(readPlanCellStyle(null)).toBe('split');
    expect(readPlanCellStyle(undefined)).toBe('split');
    expect(readPlanCellStyle('')).toBe('split');
    expect(readPlanCellStyle('Stacked')).toBe('split');
    expect(readPlanCellStyle('stacked ')).toBe('split');
    // The retired Plan grid trial's values.
    expect(readPlanCellStyle('expand')).toBe('split');
    expect(readPlanCellStyle('compact')).toBe('split');
    expect(readPlanCellStyle(1)).toBe('split');
    expect(readPlanCellStyle(['stacked'])).toBe('split');
    expect(readPlanCellStyle({ style: 'stacked' })).toBe('split');
  });
});

describe('get and set', () => {
  test('split until set; saved as plan.cellStyle; round-trips both styles', () => {
    expect(PLAN_CELL_STYLE_KEY).toBe('plan.cellStyle');
    expect(getDeviceSetting(PLAN_CELL_STYLE_KEY, null)).toBeNull();
    expect(getPlanCellStyle()).toBe('split');
    setPlanCellStyle('stacked');
    expect(getDeviceSetting(PLAN_CELL_STYLE_KEY, null)).toBe('stacked');
    expect(getPlanCellStyle()).toBe('stacked');
    setPlanCellStyle('split');
    expect(getDeviceSetting(PLAN_CELL_STYLE_KEY, null)).toBe('split');
    expect(getPlanCellStyle()).toBe('split');
  });

  test('an unknown saved value reads as split', () => {
    setDeviceSetting(PLAN_CELL_STYLE_KEY, 'mosaic');
    expect(getPlanCellStyle()).toBe('split');
  });

  test('a saved plan.gridStyle is ignored', () => {
    setDeviceSetting('plan.gridStyle', 'stacked');
    expect(getPlanCellStyle()).toBe('split');
  });
});

describe('usePlanCellStyle', () => {
  const seen: PlanCellStyle[] = [];
  function Probe() {
    seen.push(usePlanCellStyle());
    return null;
  }

  beforeEach(() => void (seen.length = 0));

  test('reads the saved style and follows a change at once', () => {
    setPlanCellStyle('stacked');
    act(() => {
      tree = create(<Probe />);
    });
    expect(seen.at(-1)).toBe('stacked');
    act(() => setPlanCellStyle('split'));
    expect(seen.at(-1)).toBe('split');
    act(() => setPlanCellStyle('stacked'));
    expect(seen.at(-1)).toBe('stacked');
  });

  test('stops listening once unmounted', () => {
    act(() => {
      tree = create(<Probe />);
    });
    expect(seen).toEqual(['split']);
    act(() => tree?.unmount());
    tree = null;
    const renders = seen.length;
    setPlanCellStyle('stacked');
    expect(seen).toHaveLength(renders);
    expect(getPlanCellStyle()).toBe('stacked');
  });
});
