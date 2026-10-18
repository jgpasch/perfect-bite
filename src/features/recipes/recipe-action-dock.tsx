import type { ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton, SurfaceButton } from '@/components/button';
import { withAlpha } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

type Props = {
  /** The recipe hue's `strong`, for the Cook and Plan glyphs. */
  tint: string;
  addDisabled: boolean;
  onAddToList: () => void;
  /** Cook shows only when set (a recipe with steps). */
  onCook?: () => void;
  onPlan: () => void;
  /** The dock's height with its bottom gap, so the scroll view's content can end above it. */
  onHeight: (height: number) => void;
  /** Toasts, floating above the dock. */
  children?: ReactNode;
};

/**
 * The recipe screen's actions (spec 4.5, 4.16), floating at the bottom like the tab bar: a `surface` pill with a
 * hairline `controlBorder` edge, `shadows.soft` in light mode, 16 pt from the sides and above the bottom safe area.
 * **Add to a list** takes the room, then the compact Cook (with steps) and Plan. A short fade to `background` sits
 * above it so rows slide under it; toasts float above that. Put it last over the scroll view: it's absolute.
 */
export function RecipeActionDock({ tint, addDisabled, onAddToList, onCook, onPlan, onHeight, children }: Props) {
  const t = useT();
  const { colors, spacing, rounded, shadows, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const floating = scheme === 'light' ? { ...shadows.soft, shadowColor: colors.ink } : null;

  return (
    <View pointerEvents="box-none" style={styles.overlay}>
      {children}
      <View
        pointerEvents="none"
        testID="recipe-dock-fade"
        style={{
          height: spacing.xl,
          experimental_backgroundImage: `linear-gradient(to bottom, ${withAlpha(colors.background, 0)}, ${colors.background})`,
        }}
      />
      <View
        onLayout={(e: LayoutChangeEvent) => onHeight(e.nativeEvent.layout.height)}
        style={{
          paddingHorizontal: spacing.lg,
          paddingBottom: Math.max(insets.bottom, spacing.lg),
          backgroundColor: colors.background,
        }}>
        <View
          testID="recipe-dock"
          style={[
            styles.dock,
            floating,
            {
              padding: spacing.sm,
              gap: spacing.sm,
              borderRadius: rounded.full,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.controlBorder,
              backgroundColor: colors.surface,
            },
          ]}>
          <View style={styles.grow}>
            <PrimaryButton label={t('recipes.screen.addToAList')} icon="cart" disabled={addDisabled} onPress={onAddToList} />
          </View>
          {onCook ? (
            <SurfaceButton
              layout="stacked"
              label={t('recipes.screen.cook')}
              accessibilityLabel={t('recipes.screen.startCooking')}
              icon="flame"
              iconTint={tint}
              onPress={onCook}
            />
          ) : null}
          <SurfaceButton layout="stacked" label={t('recipes.screen.plan')} icon="calendar" iconTint={tint} onPress={onPlan} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  // The buttons stretch to the tallest, so a wrapped label grows the whole dock rather than clipping.
  dock: { flexDirection: 'row', alignItems: 'stretch', borderCurve: 'continuous' },
  grow: { flex: 1, justifyContent: 'center' },
});
