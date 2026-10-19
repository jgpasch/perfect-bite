import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import type { AisleHue } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { stepTexts, type RecipeStepEntry } from '@/shared';

import { PagesCredit, RecipeCredit } from './recipe-credit';
import { recipeLinkParts } from './recipe-link';
import { methodBlocks, stepLabel, stepUnit, withPick } from './recipe-view';

/** How far apart a step's lines sit, as a multiple of `body`'s size: roomier than a list row, for reading while cooking. */
const STEP_LINE_SPACING = 1.45;

/**
 * The recipe screen's Method card (board 14; step sections, board A): the steps numbered in the recipe
 * hue's soft circles, selectable for copying, with Edit in the header, and the source credit under them
 * when `sourceUrl` is a link that opens. Section titles sit over their steps; a choice group shows its
 * label, a pill per option and only the picked option's steps, numbered and counted along that path.
 * Without a link, a photo import's `pageCount` original pages are credited instead ("From your photos ·
 * View pages", board C), opening them (`onViewPages`). With no steps, "No steps yet." and Add steps
 * (board 15), and no credit.
 */
export function RecipeMethodCard({
  steps,
  hue,
  picks: picksProp,
  onPick,
  sourceUrl,
  pageCount = 0,
  onViewPages,
  onEdit,
}: {
  /** `recipes.steps`, section headings and all. */
  steps: readonly RecipeStepEntry[] | null;
  hue: AisleHue;
  /** The option picked in each choice group, held by the screen so the switch's count follows; the card keeps its own without. */
  picks?: readonly number[];
  onPick?: (group: number, option: number) => void;
  /** The recipe's link, credited under the steps. */
  sourceUrl?: string | null;
  /** How many original pages the recipe keeps (`source_pages`), credited when there's no link. */
  pageCount?: number;
  onViewPages?: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const { colors, aisles, spacing, typography, sizes, rounded } = useTheme();
  const [ownPicks, setOwnPicks] = useState<readonly number[]>([]);
  const picks = picksProp ?? ownPicks;
  const pick = (group: number, option: number) => {
    if (onPick) onPick(group, option);
    else setOwnPicks((current) => withPick(current, group, option));
  };
  const tint = aisles[hue];
  const list = stepTexts(steps);

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

  const blocks = methodBlocks(steps, picks);
  const count = blocks.filter((b) => b.kind === 'step').length;

  return (
    <Card>
      <SectionHeader
        title={t('recipes.method.title')}
        count={count}
        countUnit={stepUnit()}
        trailing={
          <Button variant="plain" label={t('common.edit')} accessibilityLabel={t('recipes.method.editSteps')} onPress={onEdit} />
        }
      />
      {blocks.map((block, i) => {
        if (block.kind === 'title') {
          return (
            <ThemedText
              key={`title-${i}`}
              variant="sectionLabel"
              color="inkSecondary"
              accessibilityRole="header"
              style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxs }}>
              {block.title}
            </ThemedText>
          );
        }
        if (block.kind === 'group') {
          const label = t(block.first ? 'recipes.method.oneWay' : 'recipes.method.thenOneWay');
          return (
            <View
              key={`group-${block.group}`}
              style={{
                marginHorizontal: spacing.lg,
                marginTop: spacing.xs,
                paddingTop: spacing.md,
                paddingBottom: spacing.xxs,
                gap: spacing.sm,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.border,
              }}>
              <View style={[styles.groupLabel, { gap: spacing.sm }]}>
                <ThemedText variant="sectionLabel" color="inkSecondary">
                  {label}
                </ThemedText>
                <ThemedText variant="footnote" color="inkSecondary">
                  {t('recipes.method.ways', { count: block.options.length })}
                </ThemedText>
              </View>
              <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.pills, { gap: spacing.sm }]}>
                {block.options.map((option, o) => (
                  <Pill
                    key={o}
                    label={option}
                    selected={o === block.picked}
                    primary
                    muted
                    accessibilityRole="radio"
                    accessibilityState={{ checked: o === block.picked }}
                    onPress={() => pick(block.group, o)}
                  />
                ))}
              </View>
            </View>
          );
        }
        const step = list[block.index];
        return (
          <View
            key={`step-${block.index}`}
            accessible
            accessibilityLabel={stepLabel(block.number - 1, count, step)}
            style={[
              styles.step,
              {
                gap: spacing.md,
                paddingHorizontal: spacing.lg,
                paddingTop: spacing.md,
                paddingBottom: spacing.md + spacing.xxs,
                // A title or the pills right above take the hairline's place.
                borderTopWidth: block.lead ? 0 : StyleSheet.hairlineWidth,
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
                {block.number}
              </ThemedText>
            </View>
            <ThemedText
              variant="body"
              selectable
              style={[styles.text, { lineHeight: Math.round(typography.body.fontSize * STEP_LINE_SPACING) }]}>
              {step}
            </ThemedText>
          </View>
        );
      })}
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
  groupLabel: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
  pills: { flexDirection: 'row', flexWrap: 'wrap' },
  step: { flexDirection: 'row', alignItems: 'flex-start' },
  number: { alignItems: 'center', justifyContent: 'center' },
  digit: { fontWeight: '700' },
  text: { flex: 1 },
});
