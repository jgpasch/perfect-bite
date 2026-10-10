import { Pressable, StyleSheet, View } from 'react-native';

import { checkAppearance, checkState } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  checked: boolean;
  /** "Sorting…": the item is waiting for an aisle. Shows a dashed amber ring. */
  pending?: boolean;
  /**
   * Makes the check its own checkbox, with a 44 pt hit area. Leave it out when the whole row is the tap target: the
   * row then carries `accessibilityRole="checkbox"` and the checked state, and the check is decorative.
   */
  onPress?: () => void;
  accessibilityLabel?: string;
};

/** The 24 pt round check. */
export function CheckCircle({ checked, pending, onPress, accessibilityLabel }: Props) {
  const { colors, aisles, sizes, rounded, opacity } = useTheme();
  const look = checkAppearance(checkState(checked, pending), colors, aisles);

  const circle = (
    <View
      style={[
        styles.circle,
        {
          width: sizes.check,
          height: sizes.check,
          borderRadius: rounded.full,
          borderWidth: sizes.checkBorder,
          borderColor: look.border,
          borderStyle: look.borderStyle,
          backgroundColor: look.fill,
        },
      ]}>
      {look.tick ? <Icon name="checkmark" color={look.tick} weight="bold" size={sizes.iconSmall} /> : null}
    </View>
  );

  if (!onPress) {
    return (
      <View accessible={false} importantForAccessibility="no-hide-descendants">
        {circle}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={accessibilityLabel}
      // Grown to 44 pt with hit slop, so the circle and the row's layout stay as drawn.
      hitSlop={(sizes.minTapTarget - sizes.check) / 2}
      style={({ pressed }) => ({ opacity: pressed ? opacity.pressed : 1 })}>
      {circle}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
});
