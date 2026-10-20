import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Animated, { LinearTransition, useReducedMotion } from 'react-native-reanimated';

import { hueHeaderBand } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { MealHues, Motion, PLAN_PHOTO_ASPECT } from '@/constants/theme';
import { recipeHue } from '@/domain/aisle-color';
import { useRecipePhoto } from '@/features/recipes/recipe-photo-source';
import { recipeTimeLabel } from '@/features/recipes/recipe-view';
import { useTheme } from '@/hooks/use-theme';
import { i18n } from '@/i18n';

import type { PlanEntry, WeekPlan } from './queries';
import { type Day, type Meal, MEALS } from './week';
import { dayName, dayOfMonth, dayToggleLabel, entryText, isPastDay, mealLabel, slotAccessibilityLabel } from './week-view';

/** Past this text size the grid's columns keep a readable width and the grid scrolls sideways. */
export const GRID_SCROLL_FONT_SCALE = 1.3;

/**
 * The week as a grid (spec 4.16, `docs/design/plan-grid/` boards B and D): days Sunday to Saturday down the
 * side, Breakfast, Lunch and Dinner across under headers in their meal hues. Today's day label is a
 * `primary` pill; past days are quieter and their empty slots have no +. Tapping a slot calls `onSlot` with
 * what it shows. The plan modal marks the slots it placed its recipe in (`placed`), highlights the recipe's
 * meals' headers and adds a VoiceOver hint per cell (`slotHint`).
 *
 * With `onToggleDay` (the week screen), a day's label is a button that opens the day (`openDay`) into one
 * card across the three meals, or closes it; without it (the plan modal) the days only show their cells.
 */
export function WeekGrid({
  days,
  plan,
  today,
  onSlot,
  placed,
  highlightMeals,
  slotHint,
  openDay,
  onToggleDay,
}: {
  days: readonly Day[];
  plan: WeekPlan;
  today: Day;
  onSlot?: (day: Day, meal: Meal, entry: PlanEntry | null) => void;
  placed?: (day: Day, meal: Meal) => boolean;
  highlightMeals?: readonly Meal[];
  slotHint?: (day: Day, meal: Meal, entry: PlanEntry | null) => string;
  openDay?: Day | null;
  onToggleDay?: (day: Day) => void;
}) {
  const { scheme, spacing, sizes, rounded } = useTheme();
  const scrolls = useWindowDimensions().fontScale > GRID_SCROLL_FONT_SCALE;
  const opens = onToggleDay !== undefined;
  // Columns share the width at the default sizes; at large ones they keep a width and the grid scrolls.
  const column = scrolls ? { width: sizes.planScrollColumn } : styles.flex;
  // An open day's card spans the three meal columns and the gaps between them.
  const span = scrolls ? { width: sizes.planScrollColumn * MEALS.length + spacing.xs * (MEALS.length - 1) } : styles.flex;
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
        const open = opens && openDay === day;
        const label = (
          <DayLabel
            day={day}
            today={day === today}
            past={past}
            open={open}
            onToggle={opens ? () => onToggleDay(day) : undefined}
          />
        );
        const slots = open ? (
          <OpenDay day={day} plan={plan} past={past} onSlot={onSlot} style={span} />
        ) : (
          MEALS.map((meal) => {
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
          })
        );
        return opens ? (
          <ExpandRow key={day} day={day}>
            {label}
            {slots}
          </ExpandRow>
        ) : (
          <View key={day} testID={`grid-day-${day}`} style={[styles.row, { gap: spacing.xs }]}>
            {label}
            {slots}
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

/**
 * A day's row on the week screen: its height animates over `motion.duration` as the day opens or closes,
 * and the rows below glide with it; under Reduce Motion it switches at once.
 */
function ExpandRow({ day, children }: { day: Day; children: ReactNode }) {
  const { spacing } = useTheme();
  const reduceMotion = useReducedMotion();
  return (
    <Animated.View
      testID={`grid-day-${day}`}
      layout={reduceMotion ? undefined : LinearTransition.duration(Motion.duration)}
      style={[styles.row, styles.clip, { gap: spacing.xs }]}>
      {children}
    </Animated.View>
  );
}

/**
 * "Thu" over "15"; today's in a `primary` pill, past days in `inkSecondary`. With `onToggle` (the week
 * screen) it's a button that opens or closes the day, VoiceOver "Friday 16, expanded", and an open day other
 * than today sits in a `surface` pill.
 */
function DayLabel({
  day,
  today,
  past,
  open,
  onToggle,
}: {
  day: Day;
  today: boolean;
  past: boolean;
  open: boolean;
  onToggle?: () => void;
}) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const color = today ? 'onPrimary' : past ? 'inkSecondary' : 'ink';
  const pill = (
    <View
      testID={today ? 'today-pill' : undefined}
      style={[
        styles.center,
        {
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          borderRadius: rounded.full,
          backgroundColor: today ? colors.primary : open ? colors.surface : 'transparent',
        },
      ]}>
      <ThemedText variant="caption" color={color}>
        {dayName(day, 'short')}
      </ThemedText>
      <ThemedText variant="headline" color={color}>
        {dayOfMonth(day)}
      </ThemedText>
    </View>
  );
  if (!onToggle) return <View style={[styles.center, { minWidth: sizes.planDayColumn }]}>{pill}</View>;
  return (
    <Pressable
      testID={`day-label-${day}`}
      accessibilityRole="button"
      accessibilityLabel={dayToggleLabel(day, open)}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.center,
        { minWidth: sizes.planDayColumn, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      {pill}
    </Pressable>
  );
}

/**
 * A slot (board B), at least `planExpandCell` tall: a recipe's photo as a 4:3 strip across the top with its
 * name under it on up to two lines, a note in italic `inkSecondary` on `surfaceMuted`, or a dashed
 * `controlBorder` outline with a + (a plain cell on past days). A slot the plan modal placed its recipe in
 * is `primarySoft` with a `primary` border.
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
  const cell = { minHeight: sizes.planExpandCell, borderRadius: rounded.md, padding: spacing.xs };
  const gap = spacing.xs;
  const look = placed
    ? [{ gap, backgroundColor: colors.primarySoft }, { borderWidth: sizes.checkBorder, borderColor: colors.primary }]
    : !entry
      ? [styles.center, past ? null : { borderWidth: sizes.dashedBorder, borderStyle: 'dashed' as const, borderColor: colors.controlBorder }]
      : entry.kind === 'recipe'
        ? { gap, backgroundColor: colors.surface }
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
          <PlanPhoto entry={entry} style={styles.strip} />
          <ThemedText
            variant="caption"
            color={placed ? 'onPrimarySoft' : past ? 'inkSecondary' : 'ink'}
            numberOfLines={2}
            style={{ paddingHorizontal: spacing.xxs }}>
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

/**
 * An open day (board D): one `surface` card across the three meals, a row per meal with
 * hairlines between. Tapping a row opens its slot as a cell tap does.
 */
function OpenDay({
  day,
  plan,
  past,
  onSlot,
  style,
}: {
  day: Day;
  plan: WeekPlan;
  past: boolean;
  onSlot?: (day: Day, meal: Meal, entry: PlanEntry | null) => void;
  style: ViewStyle;
}) {
  const { colors, spacing, rounded } = useTheme();
  return (
    <View
      testID={`open-day-${day}`}
      style={[style, styles.clip, { backgroundColor: colors.surface, borderRadius: rounded.md, padding: spacing.xs }]}>
      {MEALS.map((meal, index) => {
        const entry = plan.slotEntries(day, meal)[0] ?? null;
        return (
          <OpenRow
            key={meal}
            day={day}
            meal={meal}
            entry={entry}
            past={past}
            first={index === 0}
            onPress={onSlot && (() => onSlot(day, meal, entry))}
          />
        );
      })}
    </View>
  );
}

/**
 * A meal on an open day: a recipe's 4:3 photo, then the meal's name in its hue's `strong`, the recipe's name
 * (two lines) and its total time; a note and "Note"; or a dashed photo-sized box with a + and "Nothing
 * planned" (no outline or + on past days). VoiceOver reads it as the cell it replaces.
 */
function OpenRow({
  day,
  meal,
  entry,
  past,
  first,
  onPress,
}: {
  day: Day;
  meal: Meal;
  entry: PlanEntry | null;
  past: boolean;
  first: boolean;
  onPress?: () => void;
}) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const recipe = entry?.kind === 'recipe';
  const title = entry ? entryText(entry) : i18n.t('mealPlan.nothingPlanned');
  const subline = !entry ? null : recipe ? recipeTimeLabel(entry.recipeTotalMinutes) : i18n.t('mealPlan.noteRow');
  const box = { width: sizes.planOpenPhoto, borderRadius: rounded.sm };
  return (
    <Pressable
      testID={`slot-${day}-${meal}`}
      accessibilityRole="button"
      accessibilityLabel={slotAccessibilityLabel(day, meal, entry)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.openRow,
        {
          minHeight: sizes.planCell,
          gap: spacing.sm + spacing.xxs,
          padding: spacing.xs,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      {recipe ? (
        <PlanPhoto entry={entry} style={box} />
      ) : !entry ? (
        <View
          testID="open-row-empty-box"
          style={[
            styles.center,
            box,
            { aspectRatio: PLAN_PHOTO_ASPECT },
            past ? null : { borderWidth: sizes.dashedBorder, borderStyle: 'dashed', borderColor: colors.controlBorder },
          ]}>
          {past ? null : <Icon name="plus" color="inkTertiary" size={sizes.iconSmall} weight="semibold" />}
        </View>
      ) : null}
      <View style={[styles.flex, { gap: spacing.xxs }]}>
        <ThemedText variant="caption" numberOfLines={1} style={{ color: aisles[MealHues[meal]].strong }}>
          {mealLabel(meal)}
        </ThemedText>
        <ThemedText variant="headline" color={past ? 'inkSecondary' : 'ink'} numberOfLines={2}>
          {title}
        </ThemedText>
        {subline ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {subline}
          </ThemedText>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A recipe's photo in a 4:3 box (`rounded.sm`), over its tile colour, which shows until it loads or if it fails. */
function PlanPhoto({ entry, style }: { entry: PlanEntry; style: ViewStyle }) {
  const { aisles, rounded } = useTheme();
  return (
    <View
      testID="plan-photo"
      style={[
        styles.clip,
        { aspectRatio: PLAN_PHOTO_ASPECT, borderRadius: rounded.sm, backgroundColor: aisles[recipeHue(entry.recipeId!)].soft },
        style,
      ]}>
      <CoverPhoto entry={entry} />
    </View>
  );
}

/** The recipe's photo covering its box: the household's own, else the site's, through `useRecipePhoto`. */
function CoverPhoto({ entry }: { entry: PlanEntry }) {
  const { source, onError } = useRecipePhoto({ imageUrl: entry.recipeImageUrl, photoPath: entry.recipePhotoPath });
  return source !== null ? (
    <Image
      testID="recipe-photo"
      source={source}
      contentFit="cover"
      cachePolicy="disk"
      accessible={false}
      onError={onError}
      style={StyleSheet.absoluteFill}
    />
  ) : null;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  clip: { overflow: 'hidden', borderCurve: 'continuous' },
  // A recipe's photo across the top of its cell.
  strip: { width: '100%' },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  openRow: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  note: { fontStyle: 'italic', textAlign: 'center' },
});
