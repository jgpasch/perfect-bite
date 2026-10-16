import { Pressable, StyleSheet, View } from 'react-native';

import { hueHeaderBand } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { MealHues } from '@/constants/theme';
import { recipeTimeLabel } from '@/features/recipes/recipe-view';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { unfoldEarlierDays, useUnfoldedWeek } from './earlier-fold-store';
import type { PlanEntry, WeekPlan } from './queries';
import { type Day, type Meal, MEALS, weekStart } from './week';
import {
  addSlotLabel,
  dayName,
  dayOfMonth,
  earlierDays,
  earlierLabel,
  entryText,
  isPastDay,
  slotAccessibilityLabel,
} from './week-view';

/**
 * The week as an agenda (spec 4.16, board 1 A): a card per day, the day on the left, then a line per meal.
 * Today's card has a `primary` outline. In the current week the days before today fold into one "Earlier this
 * week" row until it's tapped (for the app session). Read-only for now.
 */
export function WeekAgenda({ days, plan, today }: { days: readonly Day[]; plan: WeekPlan; today: Day }) {
  const t = useT();
  const { spacing, sizes, opacity } = useTheme();
  const unfoldedWeek = useUnfoldedWeek();
  const start = weekStart(days[0]);
  const earlier = earlierDays(start, today);
  const folded = earlier.length > 0 && unfoldedWeek !== start;
  const shown = folded ? days.filter((day) => !earlier.includes(day)) : days;
  return (
    <View testID="week-agenda" style={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}>
      {folded ? (
        <Pressable
          testID="earlier-row"
          accessibilityRole="button"
          accessibilityState={{ expanded: false }}
          accessibilityHint={t('mealPlan.earlierHint')}
          onPress={() => unfoldEarlierDays(start)}
          style={({ pressed }) => [
            styles.row,
            { minHeight: sizes.minTapTarget, gap: spacing.sm, paddingHorizontal: spacing.xs, opacity: pressed ? opacity.pressed : 1 },
          ]}>
          <ThemedText variant="callout" color="inkSecondary" style={styles.flex}>
            {earlierLabel(earlier)}
          </ThemedText>
          <Icon name="chevron.down" color="inkTertiary" size={sizes.iconSmall} weight="semibold" />
        </Pressable>
      ) : null}
      {shown.map((day) => (
        <DayCard key={day} day={day} plan={plan} today={day === today} past={isPastDay(day, today)} />
      ))}
    </View>
  );
}

function DayCard({ day, plan, today, past }: { day: Day; plan: WeekPlan; today: boolean; past: boolean }) {
  const { colors, spacing, sizes, rounded } = useTheme();
  const dayColor = today ? 'primary' : past ? 'inkSecondary' : 'ink';
  return (
    <View
      testID={`agenda-day-${day}`}
      style={[
        styles.row,
        styles.top,
        {
          gap: spacing.md,
          padding: spacing.md - sizes.focusRing,
          borderRadius: rounded.card,
          borderWidth: sizes.focusRing,
          borderColor: today ? colors.primary : 'transparent',
          backgroundColor: colors.surface,
        },
      ]}>
      <View style={[styles.center, { minWidth: sizes.planDayColumn }]}>
        <ThemedText variant="caption" color={dayColor}>
          {dayName(day, 'short')}
        </ThemedText>
        <ThemedText variant="title" color={dayColor}>
          {dayOfMonth(day)}
        </ThemedText>
      </View>
      <View style={[styles.flex, { gap: spacing.xs }]}>
        {MEALS.map((meal) => (
          <MealLine key={meal} day={day} meal={meal} entry={plan.slotEntries(day, meal)[0] ?? null} past={past} />
        ))}
      </View>
    </View>
  );
}

/** The meal's letter chip, then the recipe's name and total time, the note in italic, "+ Add lunch", or "—" before today. */
function MealLine({ day, meal, entry, past }: { day: Day; meal: Meal; entry: PlanEntry | null; past: boolean }) {
  const t = useT();
  const { scheme, spacing, sizes, rounded } = useTheme();
  const band = hueHeaderBand(MealHues[meal], scheme);
  const time = entry?.kind === 'recipe' ? recipeTimeLabel(entry.recipeTotalMinutes) : null;
  return (
    <View
      testID={`slot-${day}-${meal}`}
      accessible
      accessibilityLabel={slotAccessibilityLabel(day, meal, entry)}
      style={[styles.row, { minHeight: sizes.minTapTarget - spacing.sm, gap: spacing.sm }]}>
      <View
        style={[
          styles.center,
          { width: sizes.mealChip, height: sizes.mealChip, borderRadius: rounded.full, backgroundColor: band.ground },
        ]}>
        <ThemedText variant="caption" style={{ color: band.text }}>
          {t(`mealPlan.letters.${meal}`)}
        </ThemedText>
      </View>
      {entry === null ? (
        <ThemedText variant="callout" color={past ? 'inkSecondary' : 'primary'} style={styles.flex}>
          {past ? t('mealPlan.pastEmpty') : addSlotLabel(meal)}
        </ThemedText>
      ) : entry.kind === 'recipe' ? (
        <>
          <ThemedText variant="callout" color={past ? 'inkSecondary' : 'ink'} numberOfLines={2} style={styles.flex}>
            {entryText(entry)}
          </ThemedText>
          {time ? (
            <ThemedText variant="footnote" color="inkSecondary">
              {time}
            </ThemedText>
          ) : null}
        </>
      ) : (
        <ThemedText variant="callout" color="inkSecondary" numberOfLines={2} style={[styles.flex, styles.note]}>
          {entryText(entry)}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  top: { alignItems: 'flex-start' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  note: { fontStyle: 'italic' },
});
