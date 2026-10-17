import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

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
 * quieter and their empty slots have no +. Tapping a slot calls `onSlot` with what it shows. The plan
 * modal marks the slots it placed its recipe in (`placed`), highlights the recipe's meals' headers and adds
 * a VoiceOver hint per cell (`slotHint`).
 */
export function WeekGrid({
  days,
  plan,
  today,
  onSlot,
  placed,
  highlightMeals,
  slotHint,
}: {
  days: readonly Day[];
  plan: WeekPlan;
  today: Day;
  onSlot?: (day: Day, meal: Meal, entry: PlanEntry | null) => void;
  placed?: (day: Day, meal: Meal) => boolean;
  highlightMeals?: readonly Meal[];
  slotHint?: (day: Day, meal: Meal, entry: PlanEntry | null) => string;
}) {
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
          const highlighted = highlightMeals?.includes(meal) ?? false;
          return (
            <View
              key={meal}
              testID={highlighted ? `meal-header-${meal}-highlighted` : `meal-header-${meal}`}
              accessibilityRole="header"
              style={[
                column,
                styles.center,
                { backgroundColor: band.ground, borderRadius: rounded.sm, paddingVertical: spacing.xxs },
                // The recipe's meal tags, in the plan modal: outlined in the meal's hue.
                highlighted ? { borderWidth: sizes.checkBorder, borderColor: band.text } : null,
              ]}>
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
            {MEALS.map((meal) => {
              const entry = plan.slotEntries(day, meal)[0] ?? null;
              return (
                <View key={meal} style={column}>
                  <GridCell
                    day={day}
                    meal={meal}
                    entry={entry}
                    past={past}
                    placed={placed?.(day, meal) ?? false}
                    hint={slotHint?.(day, meal, entry)}
                    onPress={onSlot && (() => onSlot(day, meal, entry))}
                  />
                </View>
              );
            })}
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
 * dashed `controlBorder` outline with a + (a plain cell on past days). A slot the plan modal placed its
 * recipe in is `primarySoft` with a `primary` border.
 */
function GridCell({
  day,
  meal,
  entry,
  past,
  placed,
  hint,
  onPress,
}: {
  day: Day;
  meal: Meal;
  entry: PlanEntry | null;
  past: boolean;
  placed: boolean;
  hint?: string;
  onPress?: () => void;
}) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const cell = { minHeight: sizes.planCell, borderRadius: rounded.md, padding: spacing.xs + spacing.xxs };
  const look = placed
    ? { gap: spacing.xxs, backgroundColor: colors.primarySoft, borderWidth: sizes.checkBorder, borderColor: colors.primary }
    : !entry
      ? [styles.center, past ? null : { borderWidth: sizes.dashedBorder, borderStyle: 'dashed' as const, borderColor: colors.controlBorder }]
      : entry.kind === 'recipe'
        ? { gap: spacing.xxs, backgroundColor: colors.surface }
        : [styles.center, { backgroundColor: colors.surfaceMuted }];
  return (
    <Pressable
      testID={`slot-${day}-${meal}`}
      accessibilityRole="button"
      accessibilityLabel={slotAccessibilityLabel(day, meal, entry)}
      accessibilityHint={hint}
      accessibilityState={placed ? { selected: true } : undefined}
      onPress={onPress}
      style={({ pressed }) => [cell, look, { opacity: pressed ? opacity.pressed : 1 }]}>
      {!entry ? (
        past ? null : (
          <Icon name="plus" color="inkTertiary" size={sizes.iconSmall} weight="semibold" />
        )
      ) : entry.kind === 'recipe' ? (
        <>
          <RecipePhotoTile
            recipeId={entry.recipeId!}
            imageUrl={entry.recipeImageUrl}
            photoPath={entry.recipePhotoPath}
            size={sizes.planTile}
          />
          <ThemedText variant="caption" color={placed ? 'onPrimarySoft' : past ? 'inkSecondary' : 'ink'} numberOfLines={2}>
            {entryText(entry)}
          </ThemedText>
        </>
      ) : (
        <ThemedText variant="footnote" color="inkSecondary" numberOfLines={3} style={styles.note}>
          {entryText(entry)}
        </ThemedText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  note: { fontStyle: 'italic', textAlign: 'center' },
});
