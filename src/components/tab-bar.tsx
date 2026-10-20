import { Button as SwiftButton, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Motion } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** An item in the + button's long-press menu. */
export type TabBarAddMenuItem = { key: string; label: string; icon: IconName; onPress: () => void };

type Props = BottomTabBarProps & {
  /** The round + on the right: adds an item to a list. */
  onAdd: () => void;
  addLabel: string;
  /** A long-press on +, as its menu opens (the haptic). */
  onAddLongPress: () => void;
  /** The + button's long-press menu: the other ways to add. */
  addMenu: readonly TabBarAddMenuItem[];
  /** VoiceOver's custom action on +, "More ways to add", and what it does. */
  addMoreLabel: string;
  onAddMore: () => void;
  /** The one-time + hint's pill text while it's up (spec 4.1), beside +. It takes no touches. */
  addHint?: string | null;
};

const MORE_ACTION = 'more';

/**
 * The app's tab bar (spec 4.1): a floating pill of the tabs on the left and a round `primary` + on the right,
 * on the screen's ground. A tab's icon comes from its `tabBarIcon`, its label from `title`; a tab with
 * `href: null` is left out. A long-press on + opens a native menu over it.
 */
export function TabBar({
  state,
  descriptors,
  navigation,
  onAdd,
  addLabel,
  onAddLongPress,
  addMenu,
  addMoreLabel,
  onAddMore,
  addHint,
}: Props) {
  const { colors, spacing, sizes, rounded, shadows, scheme, opacity } = useTheme();
  const insets = useSafeAreaInsets();
  const inset = spacing.xs + spacing.xxs;
  const floating = scheme === 'light' ? { ...shadows.soft, shadowColor: colors.ink } : null;
  const bottom = Math.max(insets.bottom, spacing.lg);

  return (
    <View
      style={[
        styles.bar,
        {
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: bottom,
          backgroundColor: colors.background,
        },
      ]}>
      <View
        accessibilityRole="tablist"
        style={[
          styles.tabs,
          floating,
          {
            minHeight: sizes.tabBar,
            padding: inset,
            borderRadius: rounded.full,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.controlBorder,
            backgroundColor: colors.surface,
          },
        ]}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          // `href: null` (the Plan tab while its setting is off) hides the tab this way.
          if (StyleSheet.flatten(options.tabBarItemStyle)?.display === 'none') return null;
          const focused = state.index === index;
          const label = options.title ?? route.name;
          const tint = focused ? colors.primary : colors.ink;
          const badge = options.tabBarBadge;
          const press = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={badge === undefined ? label : `${label}, ${badge}`}
              testID={`tab-${route.name}`}
              onPress={press}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={({ pressed }) => [
                styles.tab,
                {
                  minHeight: sizes.tabBar - inset * 2,
                  gap: spacing.xxs,
                  borderRadius: rounded.full,
                  backgroundColor: focused ? colors.surfaceMuted : undefined,
                  opacity: pressed ? opacity.pressed : 1,
                },
              ]}>
              <View>
                {options.tabBarIcon?.({ focused, color: tint, size: sizes.iconLarge })}
                {badge !== undefined ? (
                  <View
                    style={[
                      styles.badge,
                      {
                        top: -spacing.xs,
                        right: -spacing.md,
                        minWidth: spacing.lg + spacing.xxs,
                        paddingHorizontal: spacing.xs,
                        borderRadius: rounded.full,
                        backgroundColor: colors.danger,
                      },
                    ]}>
                    <ThemedText variant="caption" style={{ color: colors.onPrimary }}>
                      {String(badge)}
                    </ThemedText>
                  </View>
                ) : null}
              </View>
              <ThemedText variant="caption" numberOfLines={1} style={{ color: tint }}>
                {label}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
      {/* Over the tabs, under + so + stays bright. */}
      {addHint ? <AddHint text={addHint} menu={addMenu} bottom={bottom} /> : null}
      {/* A native context menu on long press, as the recipe link row's. */}
      <Host style={{ width: sizes.tabBar, height: sizes.tabBar }} colorScheme={scheme} seedColor={colors.primary}>
        <ContextMenu>
          <ContextMenu.Items>
            {addMenu.map((item) => (
              <SwiftButton key={item.key} label={item.label} systemImage={item.icon} onPress={item.onPress} />
            ))}
          </ContextMenu.Items>
          <ContextMenu.Trigger>
            <RNHostView>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={addLabel}
                accessibilityActions={[{ name: MORE_ACTION, label: addMoreLabel }]}
                onAccessibilityAction={({ nativeEvent }) => {
                  if (nativeEvent.actionName === MORE_ACTION) onAddMore();
                }}
                testID="tab-add"
                onPress={onAdd}
                onLongPress={onAddLongPress}
                style={({ pressed }) => [
                  styles.add,
                  floating,
                  {
                    width: sizes.tabBar,
                    height: sizes.tabBar,
                    borderRadius: rounded.full,
                    backgroundColor: colors.primary,
                    opacity: pressed ? opacity.pressed : 1,
                  },
                ]}>
                <Icon name="plus" color="onPrimary" size={sizes.iconLarge + spacing.xs} weight="semibold" />
              </Pressable>
            </RNHostView>
          </ContextMenu.Trigger>
        </ContextMenu>
      </Host>
    </View>
  );
}

/** How far each ripple ring grows past +, as a scale of it. */
const RIPPLE_SCALE = 1.5;
/** Where the ring rests under Reduce Motion: a little out from +, as in the mock. */
const RING_REST_SCALE = 1.25;

/**
 * The + hint (spec 4.1): the screen and the tabs dim under a `scrim`, a ghost of the long-press menu shows
 * above +, a "Press and hold" pill sits to its left, and rings ripple out from +. + stays bright on top.
 * None of it takes touches. It fades in and out; under Reduce Motion the ring holds still.
 */
function AddHint({ text, menu, bottom }: { text: string; menu: readonly TabBarAddMenuItem[]; bottom: number }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const { height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const plus = { right: spacing.lg, bottom, width: sizes.tabBar, height: sizes.tabBar };
  return (
    <Animated.View entering={FadeIn} exiting={FadeOut} pointerEvents="none" style={[styles.hintLayer, { height }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: opacity.scrim }]} />
      {/* A ghost of the long-press menu, just above +. */}
      <View
        style={[
          styles.ghostMenu,
          {
            right: spacing.lg,
            bottom: bottom + sizes.tabBar + spacing.md,
            width: sizes.tabBar * 3.5,
            paddingVertical: spacing.xs,
            borderRadius: rounded.card,
            backgroundColor: colors.surface,
            opacity: opacity.disabled,
          },
        ]}>
        {menu.map((item) => (
          <View
            key={item.key}
            style={[styles.ghostRow, { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md }]}>
            <ThemedText variant="body" color="inkSecondary" numberOfLines={1} style={styles.ghostLabel}>
              {item.label}
            </ThemedText>
            <Icon name={item.icon} color="inkSecondary" size={sizes.iconLarge} />
          </View>
        ))}
      </View>
      <View style={[styles.ring, plus]}>
        {reduceMotion ? (
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: rounded.full,
                borderWidth: sizes.focusRing,
                borderColor: colors.primary,
                transform: [{ scale: RING_REST_SCALE }],
              },
            ]}
          />
        ) : (
          <>
            <RippleRing delay={0} />
            <RippleRing delay={Motion.addHintRippleMs / 2} />
          </>
        )}
      </View>
      {/* The pill, to the left of + and level with it. */}
      <View style={[styles.pillRow, { right: spacing.lg + sizes.tabBar + spacing.md, bottom, height: sizes.tabBar }]}>
        <View
          accessibilityLiveRegion="polite"
          testID="tab-add-hint"
          style={[
            styles.pill,
            {
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.xs + spacing.xxs,
              borderRadius: rounded.full,
              backgroundColor: colors.ink,
            },
          ]}>
          <ThemedText variant="amount" color="background" numberOfLines={1}>
            {text}
          </ThemedText>
        </View>
      </View>
    </Animated.View>
  );
}

/** One `primary` ring growing out from + and fading, over and over. */
function RippleRing({ delay }: { delay: number }) {
  const { colors, sizes, rounded } = useTheme();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: Motion.addHintRippleMs, easing: Easing.out(Easing.quad) }), -1),
    );
    return () => cancelAnimation(progress);
  }, [delay, progress]);
  const ripple = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ scale: 1 + (RIPPLE_SCALE - 1) * progress.value }],
  }));
  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        { borderRadius: rounded.full, borderWidth: sizes.focusRing, borderColor: colors.primary },
        ripple,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center' },
  tabs: { flex: 1, flexDirection: 'row', alignItems: 'stretch', borderCurve: 'continuous' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  badge: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  add: { alignItems: 'center', justifyContent: 'center' },
  hintLayer: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  ghostMenu: { position: 'absolute', borderCurve: 'continuous' },
  ghostRow: { flexDirection: 'row', alignItems: 'center' },
  ghostLabel: { flex: 1 },
  ring: { position: 'absolute' },
  pillRow: { position: 'absolute', justifyContent: 'center' },
  pill: { borderCurve: 'continuous' },
});
