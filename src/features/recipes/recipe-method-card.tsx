import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import type { AisleHue } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';

import { stepLabel } from './recipe-view';

/** How far apart a step's lines sit, as a multiple of `body`'s size: roomier than a list row, for reading while cooking. */
const STEP_LINE_SPACING = 1.45;
const STEP_UNIT = ['step', 'steps'] as const;

/**
 * The recipe screen's Method card (board 14): the steps numbered in the recipe hue's soft circles,
 * selectable for copying, with Edit in the header. With none, "No steps yet." and Add steps (board 15).
 */
export function RecipeMethodCard({
  steps,
  hue,
  onEdit,
}: {
  steps: readonly string[] | null;
  hue: AisleHue;
  onEdit: () => void;
}) {
  const { colors, aisles, spacing, typography, sizes, rounded } = useTheme();
  const tint = aisles[hue];
  const list = steps ?? [];

  if (list.length === 0) {
    return (
      <Card>
        <SectionHeader title="Method" />
        <View style={[styles.empty, { gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }]}>
          <ThemedText variant="callout" color="inkSecondary">
            No steps yet.
          </ThemedText>
          <Pill label="Add steps" icon="plus" soft onPress={onEdit} />
        </View>
      </Card>
    );
  }

  return (
    <Card>
      <SectionHeader
        title="Method"
        count={list.length}
        countUnit={STEP_UNIT}
        trailing={<Button variant="plain" label="Edit" accessibilityLabel="Edit steps" onPress={onEdit} />}
      />
      {list.map((step, index) => (
        <View
          key={index}
          accessible
          accessibilityLabel={stepLabel(index, list.length, step)}
          style={[
            styles.step,
            {
              gap: spacing.md,
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.md,
              paddingBottom: spacing.md + spacing.xxs,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
            },
          ]}>
          <View
            style={[
              styles.number,
              {
                width: sizes.stepNumber,
                height: sizes.stepNumber,
                borderRadius: rounded.full,
                backgroundColor: tint.soft,
                marginTop: (typography.body.fontSize * STEP_LINE_SPACING - sizes.stepNumber) / 2,
              },
            ]}>
            <ThemedText variant="amount" maxFontSizeMultiplier={1} style={[styles.digit, { color: tint.strong }]}>
              {index + 1}
            </ThemedText>
          </View>
          <ThemedText
            variant="body"
            selectable
            style={[styles.text, { lineHeight: Math.round(typography.body.fontSize * STEP_LINE_SPACING) }]}>
            {step}
          </ThemedText>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'flex-start' },
  step: { flexDirection: 'row', alignItems: 'flex-start' },
  number: { alignItems: 'center', justifyContent: 'center' },
  digit: { fontWeight: '700' },
  text: { flex: 1 },
});
