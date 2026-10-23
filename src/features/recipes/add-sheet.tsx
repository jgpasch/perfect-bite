// Pieces of the sheets that add recipes to a list: Add to a list (spec 4.5) and Shop this week (spec 4.16).
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { ActionSheetIOS, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckCircle } from '@/components/check-circle';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** The sheet's scrolling content with its CTA pinned to the bottom. */
export function SheetLayout({ cta, children }: { cta: ReactNode; children: ReactNode }) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
        {children}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: Math.max(insets.bottom, spacing.lg),
          backgroundColor: colors.background,
        }}>
        {cta}
      </View>
    </Screen>
  );
}

export function SheetLabel({ children }: { children: string }) {
  const { spacing } = useTheme();
  return (
    <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
      {children}
    </ThemedText>
  );
}

/**
 * A row in "Untick what you have": a round check, the name (with an "Always have" tag for a staple), and the scaled
 * amount. Off rows are muted. With `onToggleStaple`, long-press (light haptic) or VoiceOver's Always have / Don't
 * always have action marks or unmarks it (spec 4.5 Marking from a recipe).
 */
export function IngredientChoice({
  label,
  amount,
  staple,
  on,
  onPress,
  onToggleStaple,
}: {
  label: string;
  amount: string;
  staple: boolean;
  on: boolean;
  onPress: () => void;
  onToggleStaple?: () => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  // Off rows use `inkSecondary`, not `inkTertiary`: tertiary is too light for text (DESIGN.md).
  const ink = on ? 'ink' : 'inkSecondary';
  const alwaysHave = t('item.alwaysHave');
  const stapleAction = t(staple ? 'recipes.screen.unmarkAlwaysHave' : 'recipes.screen.markAlwaysHave');
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={[label, staple ? alwaysHave : null, amount || null].filter(Boolean).join(', ')}
      accessibilityActions={onToggleStaple ? [{ name: 'alwaysHave', label: stapleAction }] : undefined}
      onAccessibilityAction={
        onToggleStaple
          ? ({ nativeEvent }) => {
              if (nativeEvent.actionName === 'alwaysHave') onToggleStaple();
            }
          : undefined
      }
      onPress={onPress}
      onLongPress={
        onToggleStaple
          ? () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              ActionSheetIOS.showActionSheetWithOptions(
                { title: label, options: [stapleAction, t('common.cancel')], cancelButtonIndex: 1 },
                (index) => {
                  if (index === 0) onToggleStaple();
                },
              );
            }
          : undefined
      }
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          gap: spacing.md,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <CheckCircle checked={on} />
      <ThemedText variant="body" color={ink} style={styles.flex}>
        {label}
        {staple ? (
          <ThemedText variant="amount" color="inkSecondary">
            {`  ${alwaysHave}`}
          </ThemedText>
        ) : null}
      </ThemedText>
      {amount ? (
        <ThemedText variant="amount" color="inkSecondary">
          {amount}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

/** A set with `value` added or taken out. */
export function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
