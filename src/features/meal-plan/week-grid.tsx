import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, type StyleProp, StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native';
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

import { type PlanCellStyle, usePlanCellStyle } from './cell-style';
import type { PlanEntry, WeekPlan } from './queries';
import { type Day, type Meal, MEALS } from './week';
import { dayName, dayOfMonth, dayToggleLabel, entryText, isPastDay, mealLabel, slotAccessibilityLabel } from './week-view';

/** Past this text size the grid's columns keep a readable width and the grid scrolls sideways. */
export const GRID_SCROLL_FONT_SCALE = 1.3;

/**
 * The week as a grid (spec 4.16, `docs/design/plan-grid/` boards B and D): days Sunday to Saturday down the
 * side, Breakfast, Lunch and Dinner across under headers in their meal hues. Today's day label is a
 * `primary` pill; past days are quieter and their empty slots have no +. A slot holding several recipes is
 * drawn as the Grid cells setting says (`usePlanCellStyle`). Tapping a slot calls `onSlot` with its first entry. The plan modal marks the slots it placed its recipe in (`placed`), highlights the recipe's
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
  const cellStyle = usePlanCellStyle();
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
            const entries = plan.slotEntries(day, meal);
            const entry = entries[0] ?? null;
            return (
              <View key={meal} style={column}>
                <GridCell
                  day={day}
                  meal={meal}
                  entries={entries}
                  cellStyle={cellStyle}
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

/** A Split photo cell shows this many recipes; past it, a "+4" piece and a "+4 more" line. */
const SPLIT_SHOWN = 3;

/**
 * A slot (board B), at least `planExpandCell` tall: a recipe's photo as a 4:3 strip across the top with its
 * name under it on up to two lines, a note in italic `inkSecondary` on `surfaceMuted`, or a dashed
 * `controlBorder` outline with a + (a plain cell on past days). A slot the plan modal placed its recipe in
 * is `primarySoft` with a `primary` border. Several recipes are drawn as `cellStyle` says
 * (`docs/design/plan-slot-recipes/` boards A and B); VoiceOver names every one.
 */
function GridCell({
  day,
  meal,
  entries,
  cellStyle,
  past,
  placed,
  hint,
  onPress,
}: {
  day: Day;
  meal: Meal;
  entries: readonly PlanEntry[];
  cellStyle: PlanCellStyle;
  past: boolean;
  placed: boolean;
  hint?: string;
  onPress?: () => void;
}) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const entry = entries[0] ?? null;
  const nameColor = placed ? 'onPrimarySoft' : past ? 'inkSecondary' : 'ink';
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
      accessibilityLabel={slotAccessibilityLabel(day, meal, entries)}
      accessibilityHint={hint}
      accessibilityState={placed ? { selected: true } : undefined}
      onPress={onPress}
      style={({ pressed }) => [cell, look, { opacity: pressed ? opacity.pressed : 1 }]}>
      {!entry ? (
        past ? null : (
          <Icon name="plus" color="inkTertiary" size={sizes.iconSmall} weight="semibold" />
        )
      ) : entry.kind === 'recipe' && entries.length > 1 ? (
        cellStyle === 'stacked' ? (
          <StackedRecipes entries={entries} nameColor={nameColor} />
        ) : (
          <SplitRecipes entries={entries} nameColor={nameColor} />
        )
      ) : entry.kind === 'recipe' ? (
        <>
          <PlanPhoto entry={entry} style={styles.strip} />
          <ThemedText variant="caption" color={nameColor} numberOfLines={2} style={{ paddingHorizontal: spacing.xxs }}>
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

type NameColor = 'onPrimarySoft' | 'inkSecondary' | 'ink';

/**
 * Split photo (board B): the 4:3 strip split side by side into a piece per recipe, `spacing.xxs` apart, then
 * the names one line each. Past three recipes, the first three, a `surfaceMuted` "+4" piece and "+4 more".
 */
function SplitRecipes({ entries, nameColor }: { entries: readonly PlanEntry[]; nameColor: NameColor }) {
  const { colors, spacing, rounded } = useTheme();
  const shown =entries.length > SPLIT_SHOWN ? entries.slice(0, SPLIT_SHOWN) : entries;
  const more = entries.length - shown.length;
  return (
    <>
      <View
        testID="plan-split"
        style={[styles.strip, styles.clip, styles.split, { aspectRatio: PLAN_PHOTO_ASPECT, borderRadius: rounded.sm, gap: spacing.xxs }]}>
        {shown.map((entry) => (
          <RecipeTile key={entry.id} testID="plan-split-piece" entry={entry} style={styles.flex} />
        ))}
        {more > 0 ? (
          <View testID="plan-split-more" style={[styles.flex, styles.center, { backgroundColor: colors.surfaceMuted }]}>
            <ThemedText variant="caption">{`+${more}`}</ThemedText>
          </View>
        ) : null}
      </View>
      <View style={{ paddingHorizontal: spacing.xxs }}>
        {shown.map((entry) => (
          <ThemedText key={entry.id} variant="caption" color={nameColor} numberOfLines={1}>
            {entryText(entry)}
          </ThemedText>
        ))}
        {more > 0 ? (
          <ThemedText variant="caption" color="inkSecondary" numberOfLines={1}>
            {i18n.t('mealPlan.moreRecipes', { count: more })}
          </ThemedText>
        ) : null}
      </View>
    </>
  );
}

/**
 * Stacked (board A): every recipe in order, each a full-width `planStackPhoto` strip over its name (two lines
 * at most), with a `border` hairline and `spacing.xs` between them. The cell, and its day, grows to fit.
 */
function StackedRecipes({ entries, nameColor }: { entries: readonly PlanEntry[]; nameColor: NameColor }) {
  const { colors, spacing, sizes, rounded } = useTheme();
  return entries.map((entry, index) => (
    <View
      key={entry.id}
      testID="plan-stack-item"
      style={{
        gap: spacing.xxs,
        paddingTop: index === 0 ? 0 : spacing.xs,
        borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
      }}>
      <RecipeTile testID="plan-stack-photo" entry={entry} style={{ width: '100%', height: sizes.planStackPhoto, borderRadius: rounded.sm }} />
      <ThemedText variant="caption" color={nameColor} numberOfLines={2} style={{ paddingHorizontal: spacing.xxs }}>
        {entryText(entry)}
      </ThemedText>
    </View>
  ));
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
        const entries = plan.slotEntries(day, meal);
        return (
          <OpenRow
            key={meal}
            day={day}
            meal={meal}
            entries={entries}
            past={past}
            first={index === 0}
            onPress={onSlot && (() => onSlot(day, meal, entries[0] ?? null))}
          />
        );
      })}
    </View>
  );
}

/**
 * A meal on an open day: the meal's name in its hue's `strong`, then a row per recipe, every one in order (a
 * 4:3 photo, the name on two lines and the total time); a note and "Note"; or a dashed photo-sized box with a
 * + and "Nothing planned" (no outline or + on past days). VoiceOver reads it as the cell it replaces.
 */
function OpenRow({
  day,
  meal,
  entries,
  past,
  first,
  onPress,
}: {
  day: Day;
  meal: Meal;
  entries: readonly PlanEntry[];
  past: boolean;
  first: boolean;
  onPress?: () => void;
}) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const entry = entries[0] ?? null;
  const recipe = entry?.kind === 'recipe';
  const title = entry ? entryText(entry) : i18n.t('mealPlan.nothingPlanned');
  const subline = !entry ? null : i18n.t('mealPlan.noteRow');
  const box = { width: sizes.planOpenPhoto, borderRadius: rounded.sm };
  const gap = spacing.sm + spacing.xxs;
  const mealName = (
    <ThemedText variant="caption" numberOfLines={1} style={{ color: aisles[MealHues[meal]].strong }}>
      {mealLabel(meal)}
    </ThemedText>
  );
  return (
    <Pressable
      testID={`slot-${day}-${meal}`}
      accessibilityRole="button"
      accessibilityLabel={slotAccessibilityLabel(day, meal, entries)}
      onPress={onPress}
      style={({ pressed }) => [
        recipe ? { gap: spacing.xs } : [styles.openRow, { gap }],
        {
          minHeight: sizes.planCell,
          padding: spacing.xs,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      {recipe ? (
        <>
          {mealName}
          {entries.map((item) => {
            const time = recipeTimeLabel(item.recipeTotalMinutes);
            return (
              <View key={item.id} testID="open-row-recipe" style={[styles.openRow, { gap }]}>
                <PlanPhoto entry={item} style={box} />
                <View style={[styles.flex, { gap: spacing.xxs }]}>
                  <ThemedText variant="headline" color={past ? 'inkSecondary' : 'ink'} numberOfLines={2}>
                    {entryText(item)}
                  </ThemedText>
                  {time ? (
                    <ThemedText variant="footnote" color="inkSecondary">
                      {time}
                    </ThemedText>
                  ) : null}
                </View>
              </View>
            );
          })}
        </>
      ) : (
        <>
          {!entry ? (
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
            {mealName}
            <ThemedText variant="headline" color={past ? 'inkSecondary' : 'ink'} numberOfLines={2}>
              {title}
            </ThemedText>
            {subline ? (
              <ThemedText variant="footnote" color="inkSecondary">
                {subline}
              </ThemedText>
            ) : null}
          </View>
        </>
      )}
    </Pressable>
  );
}

/** A recipe's photo in a 4:3 box (`rounded.sm`), over its tile colour, which shows until it loads or if it fails. */
function PlanPhoto({ entry, style }: { entry: PlanEntry; style: ViewStyle }) {
  const { rounded } = useTheme();
  return <RecipeTile testID="plan-photo" entry={entry} style={[{ aspectRatio: PLAN_PHOTO_ASPECT, borderRadius: rounded.sm }, style]} />;
}

/** A recipe's photo covering a box of `style`'s shape, over its tile colour. */
function RecipeTile({ testID, entry, style }: { testID: string; entry: PlanEntry; style: StyleProp<ViewStyle> }) {
  const { aisles } = useTheme();
  return (
    <View testID={testID} style={[styles.clip, { backgroundColor: aisles[recipeHue(entry.recipeId!)].soft }, style]}>
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
  // A Split photo cell's strip, a piece per recipe side by side.
  split: { flexDirection: 'row' },
  openRow: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  note: { fontStyle: 'italic', textAlign: 'center' },
});
