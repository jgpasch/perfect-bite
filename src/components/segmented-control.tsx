import { Pressable, StyleSheet, View } from 'react-native';

import { segmentColors } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

export type Segment<T extends string> = {
  value: T;
  label: string;
  /** What VoiceOver reads instead of the label, e.g. "Method, 6 steps" for "Method · 6". */
  accessibilityLabel?: string;
  /** What VoiceOver reads after the label, e.g. what the segment shows. */
  hint?: string;
};

type Props<T extends string> = {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Colours for a coloured ground, e.g. the list screen's green header (`listHeaderColors().segments`). */
  look?: { track: string; text: string; selected: string; selectedText: string };
  /** What VoiceOver calls the whole control, e.g. "Plan grid style". */
  accessibilityLabel?: string;
};

/** A track with a filled selected segment. Each segment is a tab with its selected state. */
export function SegmentedControl<T extends string>({ segments, value, onChange, look: custom, accessibilityLabel }: Props<T>) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.track,
        {
          marginHorizontal: spacing.lg,
          padding: sizes.segmentInset,
          borderRadius: rounded.md,
          backgroundColor: custom?.track ?? colors.surfaceMuted,
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
            accessibilityLabel={segment.accessibilityLabel ?? segment.label}
            accessibilityHint={segment.hint}
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
                backgroundColor: custom ? (selected ? custom.selected : 'transparent') : look.fill ? colors[look.fill] : 'transparent',
                opacity: pressed && !selected ? opacity.pressed : 1,
              },
            ]}>
            <ThemedText
              variant="amount"
              color={look.text}
              style={[
                styles.label,
                selected ? styles.selected : undefined, custom ? { color: selected ? custom.selectedText : custom.text } : undefined]}>
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
  // A label longer than its segment wraps, centred, and the segment grows.
  label: { textAlign: 'center' },
  selected: { fontWeight: '700' },
});
