// Settings > Meal plan > Grid cells (spec 4.16): how the plan grid draws a slot holding two or more recipes on this device.
import { useSyncExternalStore } from 'react';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

export const PLAN_CELL_STYLE_KEY = 'plan.cellStyle';

/**
 * `split`: board B (`docs/design/plan-slot-recipes/`), the cell's 4:3 strip split into a piece per recipe over the
 * names. `stacked`: board A, every recipe's 40 pt strip over its name, one under another.
 */
export const PLAN_CELL_STYLES = ['split', 'stacked'] as const;
export type PlanCellStyle = (typeof PLAN_CELL_STYLES)[number];

/** A saved value as a style: `split` for anything else, never-set included. */
export function readPlanCellStyle(value: unknown): PlanCellStyle {
  return PLAN_CELL_STYLES.find((style) => style === value) ?? 'split';
}

const listeners = new Set<() => void>();

export function getPlanCellStyle(): PlanCellStyle {
  return readPlanCellStyle(getDeviceSetting<unknown>(PLAN_CELL_STYLE_KEY, null));
}

/** Saves the style; an open grid follows at once. */
export function setPlanCellStyle(style: PlanCellStyle): void {
  setDeviceSetting(PLAN_CELL_STYLE_KEY, style);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The device's grid cell style, kept current while it's changed. */
export function usePlanCellStyle(): PlanCellStyle {
  return useSyncExternalStore(subscribe, getPlanCellStyle);
}
