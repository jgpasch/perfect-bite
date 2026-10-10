import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { sectionHeaderLabel } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  title: string;
  /** The aisle's `dot` colour, from `aisles[aisleColor(slug)].dot`. */
  dotColor?: string;
  /** Shown in place of the dot, e.g. a recipe's icon well. */
  leading?: ReactNode;
  /** The count on the right. */
  count?: number;
  /** Shown after the count, e.g. a recipe's actions button. */
  trailing?: ReactNode;
  /** What VoiceOver reads instead of the title, e.g. for the Sorting… section. */
  accessibilityLabel?: string;
};

/** A card's section header: aisle dot, the name in the display face, and the count on the right. */
export function SectionHeader({ title, dotColor, leading, count, trailing, accessibilityLabel }: Props) {
  const { spacing, sizes, rounded } = useTheme();
  return (
    <View
      style={[
        styles.row,
        { gap: spacing.sm, paddingTop: spacing.md + spacing.xxs, paddingBottom: spacing.xs + spacing.xxs, paddingHorizontal: spacing.lg },
      ]}>
      {leading ??
        (dotColor ? (
          <View style={{ width: sizes.dot, height: sizes.dot, borderRadius: rounded.full, backgroundColor: dotColor }} />
        ) : null)}
      <ThemedText
        variant="sectionTitle"
        accessibilityRole="header"
        accessibilityLabel={sectionHeaderLabel(accessibilityLabel ?? title, count)}
        style={styles.title}>
        {title}
      </ThemedText>
      {count !== undefined ? (
        <ThemedText
          variant="footnote"
          color="inkSecondary"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.count}>
          {count}
        </ThemedText>
      ) : null}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1 },
  count: { fontWeight: '600' },
});
