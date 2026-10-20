import { useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { households } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { householdsQuery } from '@/features/households/households';
import { useCurrentListVersion } from '@/features/lists/current-list';
import { getLaunchListId, getList } from '@/features/lists/lists';
import {
  getPlanHouseholdId,
  getPlanView,
  setPlanHouseholdId,
  setPlanView,
  type PlanView,
} from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';

import { groupWeek, MEAL_PLAN_QUERY_TABLES, type PlanEntry, weekEntriesQuery } from './queries';
import { openShopSheet, shopDays, shopEntries } from './shop';
import { openSlot, type SlotToast } from './slot-actions';
import { addDays, type Day, type Meal, today as todayOf, weekDays, weekStart } from './week';
import { WeekAgenda } from './week-agenda';
import { WeekGrid } from './week-grid';
import { WeekToolbar } from './week-toolbar';
import { resolvePlanHousehold } from './week-view';

/**
 * The week screen (spec 4.16): the week toolbar over the week as a grid or an agenda, for the household
 * picked on this device. `header` places the toolbar (the Plan tab puts it on its green header);
 * without it the toolbar is the first row on the sheet. Tapping a slot opens the slot sheet or the filled
 * slot's menu; `onToast` shows Clear's toast on the screen around it.
 */
export function WeekPlan({
  header,
  onToast,
}: {
  header?: (toolbar: ReactNode) => ReactNode;
  onToast: (toast: SlotToast | null) => void;
}) {
  const { spacing } = useTheme();
  const today = todayOf();
  const thisWeek = weekStart(today);
  const [start, setStart] = useState(thisWeek);
  // The grid: the day that's open, today to begin with, kept across weeks and views while
  // the screen is mounted (a week without it shows every day closed).
  const [openDay, setOpenDay] = useState<Day | null>(today);
  const toggleDay = (day: Day) => setOpenDay((open) => (open === day ? null : day));
  const [view, setViewState] = useState<PlanView>(getPlanView);
  const setView = (next: PlanView) => {
    setViewState(next);
    setPlanView(next);
  };

  // Spec 4.16: the household picked on this device, else the current list's, else the first.
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households]);
  const [picked, setPicked] = useState(getPlanHouseholdId);
  const listVersion = useCurrentListVersion();
  const userId = getAccount()?.userId ?? null;
  const currentListHousehold = useMemo(() => {
    const listId = userId ? getLaunchListId(userId) : null;
    return listId ? (getList(listId)?.householdId ?? null) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `listVersion`: another screen picked a list
  }, [userId, listVersion, householdRows]);
  const householdId = resolvePlanHousehold(householdRows, picked, currentListHousehold);
  const pickHousehold = (id: string) => {
    setPicked(id);
    setPlanHouseholdId(id);
  };

  const { data: entries } = useLiveQueryOn(weekEntriesQuery(householdId ?? '', start), MEAL_PLAN_QUERY_TABLES, [
    householdId,
    start,
  ]);
  const plan = useMemo(() => groupWeek(entries), [entries]);
  const days = weekDays(start);
  // Shop this week: disabled for past weeks and when the days it covers have no recipes.
  const onShop =
    householdId && shopEntries(plan, shopDays(start, today)).length > 0
      ? () => openShopSheet(householdId, start, onToast)
      : undefined;
  const onSlot = householdId
    ? (day: Day, meal: Meal, entry: PlanEntry | null) => openSlot(householdId, day, meal, entry, onToast)
    : undefined;

  const toolbar = (
    <WeekToolbar
      onGreen={header !== undefined}
      households={householdRows}
      householdId={householdId}
      onHousehold={pickHousehold}
      start={start}
      isThisWeek={start === thisWeek}
      onWeek={(direction) => setStart(addDays(start, direction * 7))}
      onThisWeek={() => setStart(thisWeek)}
      onShop={onShop}
      view={view}
      onView={setView}
    />
  );
  return (
    <>
      {header ? header(toolbar) : <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>{toolbar}</View>}
      {view === 'grid' ? (
        <WeekGrid days={days} plan={plan} today={today} onSlot={onSlot} openDay={openDay} onToggleDay={toggleDay} />
      ) : (
        <WeekAgenda days={days} plan={plan} today={today} onSlot={onSlot} />
      )}
    </>
  );
}
