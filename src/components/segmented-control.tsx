import { Pressable, StyleSheet, View } from 'react-native';

import { segmentColors } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

export type Segment<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
};

/** A `surfaceMuted` track with a white selected segment. Each segment is a tab with its selected state. */
export function SegmentedControl<T extends string>({ segments, value, onChange }: Props<T>) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.track,
        {
          marginHorizontal: spacing.lg,
          padding: sizes.segmentInset,
          borderRadius: rounded.md,
          backgroundColor: colors.surfaceMuted,
        },
      ]}>
      {segments.map((segment) => {
        const selected = segment.value === value;
        const look = segmentColors(selected);
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={segment.label}
            onPress={() => {
              if (!selected) onChange(segment.value);
            }}
            // The track's inset brings the 34 pt segment up to a 40 pt row; this covers the rest of 44.
            hitSlop={{ top: sizes.segmentInset + spacing.xxs, bottom: sizes.segmentInset + spacing.xxs }}
            style={({ pressed }) => [
              styles.segment,
              {
                minHeight: sizes.segment,
                paddingHorizontal: spacing.sm,
                borderRadius: rounded.segment,
                backgroundColor: look.fill ? colors[look.fill] : 'transparent',
                opacity: pressed && !selected ? opacity.pressed : 1,
              },
            ]}>
            <ThemedText variant="amount" color={look.text} style={selected ? styles.selected : undefined}>
              {segment.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', borderCurve: 'continuous' },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  selected: { fontWeight: '700' },
});
