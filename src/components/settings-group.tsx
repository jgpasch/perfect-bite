import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { ThemedText } from '@/components/themed-text';
import type { ColorToken } from '@/constants/theme';
import type { AisleHue } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';

/** A label ("Shopping", "Members") over a card of rows (board 10). */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View>
      <ThemedText
        variant="sectionLabel"
        color="inkSecondary"
        accessibilityRole="header"
        style={{ paddingTop: spacing.lg, paddingBottom: spacing.sm, paddingHorizontal: spacing.xxl }}>
        {title}
      </ThemedText>
      <Card>{children}</Card>
    </View>
  );
}

type RowProps = {
  label: string;
  /** A second line under the label (`footnote`, `inkSecondary`), e.g. who sent an invite. */
  detail?: string;
  /** What VoiceOver reads instead of the label, value and detail, e.g. to include a badge. */
  accessibilityLabel?: string;
  /** Shown on the right in `inkSecondary`. */
  value?: string;
  /** A 32 pt tinted icon tile before the label. */
  icon?: { name: IconName; hue: AisleHue };
  /** Shown after the value, e.g. a badge or an actions button. */
  trailing?: ReactNode;
  /** The label's colour, e.g. `danger` for Leave household. */
  labelColor?: ColorToken;
  /** Makes the row a button with a chevron (unless `chevron` is false). */
  onPress?: () => void;
  chevron?: boolean;
  /** A choice in a picker: ticked when true (no chevron). */
  selected?: boolean;
  /** The last row in its card has no hairline under it. */
  last?: boolean;
};

/** A row in a settings card: optional icon tile, the label, then a value, trailing content and a chevron. */
export function SettingsRow({
  label,
  detail,
  accessibilityLabel,
  value,
  icon,
  trailing,
  labelColor = 'ink',
  onPress,
  chevron = true,
  selected,
  last,
}: RowProps) {
  const choice = selected !== undefined;
  const { colors, spacing, sizes, opacity } = useTheme();
  const content = (
    <>
      {icon ? <IconTile hue={icon.hue} name={icon.name} size={sizes.settingsIcon} /> : null}
      {detail ? (
        <View style={styles.label}>
          <ThemedText variant="body" color={labelColor}>
            {label}
          </ThemedText>
          <ThemedText variant="footnote" color="inkSecondary">
            {detail}
          </ThemedText>
        </View>
      ) : (
        <ThemedText variant="body" color={labelColor} style={styles.label}>
          {label}
        </ThemedText>
      )}
      {value ? (
        <ThemedText variant="amount" color="inkSecondary" style={styles.value}>
          {value}
        </ThemedText>
      ) : null}
      {trailing}
      {selected ? <Icon name="checkmark" color="primary" size={sizes.iconSmall} weight="semibold" /> : null}
      {onPress && chevron && !choice ?<Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} weight="semibold" /> : null}
    </>
  );
  const rowStyle = [
    styles.row,
    {
      minHeight: sizes.cardRowMin,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      gap: spacing.md,
      borderBottomColor: colors.border,
      borderBottomWidth: last ? 0 : 1,
    },
  ];
  const a11yLabel = accessibilityLabel ?? [label, detail, value].filter(Boolean).join(', ');
  if (!onPress) {
    return (
      <View accessible={!trailing} accessibilityLabel={trailing ? undefined : a11yLabel} style={rowStyle}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={choice ? { selected } : undefined}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, { opacity: pressed ? opacity.pressed : 1 }]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { flex: 1 },
  value: { flexShrink: 1, textAlign: 'right' },
});
