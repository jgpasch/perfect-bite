import { Pressable, StyleSheet, View } from 'react-native';

import { pillLook } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { MealHues } from '@/constants/theme';
import { useLiveQueryOn } from '@/db/live-query';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { planBadges } from './plan-modal';
import { MEAL_PLAN_QUERY_TABLES, upcomingRecipeEntriesQuery } from './queries';
import { today as todayOf } from './week';

/**
 * The recipe screen's plan badges (spec 4.16): a pill per upcoming entry of the recipe in its meal's
 * `strong` hue, "Thu dinner" or "Oct 21 dinner", the first three then "+2". Each opens the plan modal
 * (`onOpen`). Nothing when the recipe isn't planned.
 */
export function PlanBadges({ recipeId, onOpen }: { recipeId: string; onOpen: () => void }) {
  const t = useT();
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const today = todayOf();
  const { data: entries } = useLiveQueryOn(upcomingRecipeEntriesQuery(recipeId, today), MEAL_PLAN_QUERY_TABLES, [recipeId, today]);
  const { badges, more } = planBadges(entries, today);
  if (badges.length === 0) return null;

  const pill = (key: string, label: string, accessibilityLabel: string, look: { fill: string; text: string }, icon: boolean) => (
    <Pressable
      key={key}
      testID={`plan-badge-${key}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={(sizes.minTapTarget - sizes.viewButton) / 2}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.pill,
        {
          minHeight: sizes.viewButton,
          paddingHorizontal: spacing.md,
          gap: spacing.xs,
          borderRadius: rounded.full,
          backgroundColor: look.fill,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      {icon ? <Icon name="calendar" tint={look.text} size={sizes.iconSmall} weight="semibold" /> : null}
      <ThemedText variant="amount" style={{ color: look.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );

  return (
    <View testID="plan-badges" style={[styles.row, { gap: spacing.sm }]}>
      {badges.map((b) =>
        pill(b.key, b.label, t('mealPlan.badgeLabel', { slot: b.label }), pillLook({ selected: true, hue: MealHues[b.meal] }, colors, aisles), true),
      )}
      {more > 0
        ? pill('more', t('mealPlan.badgeMore', { count: more }), t('mealPlan.badgeMoreLabel', { count: more }), pillLook({}, colors, aisles), false)
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
