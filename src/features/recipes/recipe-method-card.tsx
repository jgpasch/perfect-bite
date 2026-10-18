import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import type { AisleHue } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { PagesCredit, RecipeCredit } from './recipe-credit';
import { recipeLinkParts } from './recipe-link';
import { stepLabel, stepUnit } from './recipe-view';

/** How far apart a step's lines sit, as a multiple of `body`'s size: roomier than a list row, for reading while cooking. */
const STEP_LINE_SPACING = 1.45;

/**
 * The recipe screen's Method card (board 14): the steps numbered in the recipe hue's soft circles,
 * selectable for copying, with Edit in the header, and the source credit under them when `sourceUrl` is a
 * link that opens. Without one, a photo import's `pageCount` original pages are credited instead ("From your
 * photos · View pages", board C), opening them (`onViewPages`). With no steps, "No steps yet." and Add steps
 * (board 15), and no credit.
 */
export function RecipeMethodCard({
  steps,
  hue,
  sourceUrl,
  pageCount = 0,
  onViewPages,
  onEdit,
}: {
  steps: readonly string[] | null;
  hue: AisleHue;
  /** The recipe's link, credited under the steps. */
  sourceUrl?: string | null;
  /** How many original pages the recipe keeps (`source_pages`), credited when there's no link. */
  pageCount?: number;
  onViewPages?: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const { colors, aisles, spacing, typography, sizes, rounded } = useTheme();
  const tint = aisles[hue];
  const list = steps ?? [];

  if (list.length === 0) {
    return (
      <Card>
        <SectionHeader title={t('recipes.method.title')} />
        <View style={[styles.empty, { gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }]}>
          <ThemedText variant="callout" color="inkSecondary">
            {t('recipes.method.noSteps')}
          </ThemedText>
          <Pill label={t('recipes.method.addSteps')} icon="plus" soft onPress={onEdit} />
        </View>
      </Card>
    );
  }

  return (
    <Card>
      <SectionHeader
        title={t('recipes.method.title')}
        count={list.length}
        countUnit={stepUnit()}
        trailing={
          <Button variant="plain" label={t('common.edit')} accessibilityLabel={t('recipes.method.editSteps')} onPress={onEdit} />
        }
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
      {recipeLinkParts(sourceUrl) ? (
        <RecipeCredit sourceUrl={sourceUrl} />
      ) : pageCount > 0 && onViewPages ? (
        <PagesCredit count={pageCount} onPress={onViewPages} />
      ) : null}
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
