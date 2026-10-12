import { Host, Menu, RNHostView, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import {
  LIST_VIEW_MODES,
  VIEW_BUTTON_HINT,
  viewButtonAccessibilityLabel,
  viewModeLabel,
  type ListViewMode,
} from '@/features/lists/list-view';
import { useTheme } from '@/hooks/use-theme';

/**
 * The list screen's view button (spec 4.6): a small white-wash pill on the green header reading the
 * current view, "As added ⌄", that opens a native menu of the views, the current one ticked.
 */
export function ViewMenuButton({ value, onChange }: { value: ListViewMode; onChange: (mode: ListViewMode) => void }) {
  const { colors, scheme, sizes, spacing, rounded } = useTheme();
  const look = listHeaderColors(colors).viewButton;
  // The pill is shorter than a tap target, so its face is padded to 44 pt and the padding taken back
  // from the layout, keeping the pill where it would sit.
  const inset = (sizes.minTapTarget - sizes.viewButton) / 2;
  return (
    <View style={[styles.start, { marginVertical: -inset }]}>
      <Host matchContents colorScheme={scheme} seedColor={colors.primary}>
        <Menu
          label={
            <RNHostView matchContents>
              <View style={[styles.start, { minHeight: sizes.minTapTarget, justifyContent: 'center' }]}>
                <View
                  style={[
                    styles.pill,
                    {
                      height: sizes.viewButton,
                      borderRadius: rounded.full,
                      paddingLeft: spacing.md,
                      paddingRight: spacing.md - spacing.xxs,
                      gap: spacing.xs,
                      backgroundColor: look.fill,
                    },
                  ]}>
                  <ThemedText variant="amount" style={{ color: look.text }}>
                    {viewModeLabel(value)}
                  </ThemedText>
                  <Icon name="chevron.down" tint={look.text} size={sizes.iconSmall} weight="semibold" />
                </View>
              </View>
            </RNHostView>
          }
          modifiers={[accessibilityLabel(viewButtonAccessibilityLabel(value)), accessibilityHint(VIEW_BUTTON_HINT)]}>
          {LIST_VIEW_MODES.map((mode) => (
            <Toggle
              key={mode.value}
              label={mode.label}
              systemImage={mode.icon}
              isOn={mode.value === value}
              onIsOnChange={() => onChange(mode.value)}
            />
          ))}
        </Menu>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  start: { alignSelf: 'flex-start' },
  pill: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
});
