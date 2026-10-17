// Settings > Design trials > Plan grid (spec 4.16): how the week grid draws its cells on this device. It
// applies to the Plan tab's grid and the plan modal's; the agenda doesn't change.
import { useSyncExternalStore } from 'react';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

export const PLAN_GRID_STYLE_KEY = 'plan.gridStyle';

/** `compact`: a small tile over the name (board 1 C). `photo`: the photo fills the cell (board A). `expand`: boards B and D. */
export const PLAN_GRID_STYLES = ['compact', 'photo', 'expand'] as const;
export type PlanGridStyle = (typeof PLAN_GRID_STYLES)[number];

/** A saved value as a style: `compact` for anything else, never-set included. */
export function readPlanGridStyle(value: unknown): PlanGridStyle {
  return PLAN_GRID_STYLES.find((style) => style === value) ?? 'compact';
}

const listeners = new Set<() => void>();

export function getPlanGridStyle(): PlanGridStyle {
  return readPlanGridStyle(getDeviceSetting<unknown>(PLAN_GRID_STYLE_KEY, null));
}

/** Saves the style; every grid on screen follows at once. */
export function setPlanGridStyle(style: PlanGridStyle): void {
  setDeviceSetting(PLAN_GRID_STYLE_KEY, style);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The device's grid style, kept current while it's changed. */
export function usePlanGridStyle(): PlanGridStyle {
  return useSyncExternalStore(subscribe, getPlanGridStyle);
}
