import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { hueHeaderBand } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { MealHues } from '@/constants/theme';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { useTheme } from '@/hooks/use-theme';

import type { PlanEntry, WeekPlan } from './queries';
import { type Day, type Meal, MEALS } from './week';
import { dayName, dayOfMonth, entryText, isPastDay, mealLabel, slotAccessibilityLabel } from './week-view';

/** Past this text size the grid's columns keep a readable width and the grid scrolls sideways. */
export const GRID_SCROLL_FONT_SCALE = 1.3;

/**
 * The week as a grid (spec 4.16, board 1 C): days Sunday to Saturday down the side, Breakfast, Lunch and
 * Dinner across under headers in their meal hues. Today's day label is a `primary` pill; past days are
 * quieter and their empty slots have no +. Read-only for now.
 */
export function WeekGrid({ days, plan, today }: { days: readonly Day[]; plan: WeekPlan; today: Day }) {
  const { scheme, spacing, sizes, rounded } = useTheme();
  const scrolls = useWindowDimensions().fontScale > GRID_SCROLL_FONT_SCALE;
  // Columns share the width at the default sizes; at large ones they keep a width and the grid scrolls.
  const column = scrolls ? { width: sizes.planScrollColumn } : styles.flex;
  const grid = (
    <View testID="week-grid" style={{ gap: spacing.xs, paddingHorizontal: spacing.lg }}>
      <View style={[styles.row, { gap: spacing.xs }]}>
        <View style={{ minWidth: sizes.planDayColumn }} />
        {MEALS.map((meal) => {
          const band = hueHeaderBand(MealHues[meal], scheme);
          return (
            <View
              key={meal}
              accessibilityRole="header"
              style={[column, styles.center, { backgroundColor: band.ground, borderRadius: rounded.sm, paddingVertical: spacing.xxs }]}>
              <ThemedText variant="caption" numberOfLines={1} style={{ color: band.text }}>
                {mealLabel(meal)}
              </ThemedText>
            </View>
          );
        })}
      </View>
      {days.map((day) => {
        const past = isPastDay(day, today);
        return (
          <View key={day} testID={`grid-day-${day}`} style={[styles.row, { gap: spacing.xs }]}>
            <DayLabel day={day} today={day === today} past={past} />
            {MEALS.map((meal) => (
              <View key={meal} style={column}>
                <GridCell day={day} meal={meal} entry={plan.slotEntries(day, meal)[0] ?? null} past={past} />
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
  return scrolls ? (
    <ScrollView testID="week-grid-scroll" horizontal showsHorizontalScrollIndicator={false}>
      {grid}
    </ScrollView>
  ) : (
    grid
  );
}

/** "Thu" over "15"; today's in a `primary` pill, past days in `inkSecondary`. */
function DayLabel({ day, today, past }: { day: Day; today: boolean; past: boolean }) {
  const { colors, spacing, sizes, rounded } = useTheme();
  const color = today ? 'onPrimary' : past ? 'inkSecondary' : 'ink';
  return (
    <View style={[styles.center, { minWidth: sizes.planDayColumn }]}>
      <View
        testID={today ? 'today-pill' : undefined}
        style={[
          styles.center,
          {
            paddingHorizontal: spacing.sm,
            paddingVertical: spacing.xs,
            borderRadius: rounded.full,
            backgroundColor: today ? colors.primary : 'transparent',
          },
        ]}>
        <ThemedText variant="caption" color={color}>
          {dayName(day, 'short')}
        </ThemedText>
        <ThemedText variant="headline" color={color}>
          {dayOfMonth(day)}
        </ThemedText>
      </View>
    </View>
  );
}

/**
 * A slot: a recipe's tile and name on up to two lines, a note in italic `inkSecondary` on `surfaceMuted`, or a
 * dashed `controlBorder` outline with a + (a plain cell on past days).
 */
function GridCell({ day, meal, entry, past }: { day: Day; meal: Meal; entry: PlanEntry | null; past: boolean }) {
  const { colors, spacing, sizes, rounded } = useTheme();
  const cell = { minHeight: sizes.planCell, borderRadius: rounded.md, padding: spacing.xs + spacing.xxs };
  const label = slotAccessibilityLabel(day, meal, entry);
  const testID = `slot-${day}-${meal}`;
  if (!entry) {
    return (
      <View
        testID={testID}
        accessible
        accessibilityLabel={label}
        style={[
          styles.center,
          cell,
          past
            ? null
            : { borderWidth: sizes.dashedBorder, borderStyle: 'dashed', borderColor: colors.controlBorder },
        ]}>
        {past ? null : <Icon name="plus" color="inkTertiary" size={sizes.iconSmall} weight="semibold" />}
      </View>
    );
  }
  if (entry.kind === 'recipe') {
    return (
      <View testID={testID} accessible accessibilityLabel={label} style={[cell, { gap: spacing.xxs, backgroundColor: colors.surface }]}>
        <RecipePhotoTile recipeId={entry.recipeId!} imageUrl={entry.recipeImageUrl} size={sizes.planTile} />
        <ThemedText variant="caption" color={past ? 'inkSecondary' : 'ink'} numberOfLines={2}>
          {entryText(entry)}
        </ThemedText>
      </View>
    );
  }
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={label}
      style={[cell, styles.center, { backgroundColor: colors.surfaceMuted }]}>
      <ThemedText variant="footnote" color="inkSecondary" numberOfLines={3} style={styles.note}>
        {entryText(entry)}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  note: { fontStyle: 'italic', textAlign: 'center' },
});
