import { Button as SwiftButton, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
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
  /** The one-time + hint's text while it's up (spec 4.1), pointing at +. It takes no touches. */
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

  return (
    <View
      style={[
        styles.bar,
        {
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: Math.max(insets.bottom, spacing.lg),
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
      {addHint ? <AddHint text={addHint} /> : null}
    </View>
  );
}

const CARET = 12;

/** The + hint: a card just above the bar, its caret pointing down at the middle of +. Only fades. */
function AddHint({ text }: { text: string }) {
  const { colors, spacing, sizes, rounded, shadows, scheme } = useTheme();
  const floating = scheme === 'light' ? { ...shadows.floating, shadowColor: colors.ink } : null;
  return (
    <Animated.View
      entering={FadeIn}
      exiting={FadeOut}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      testID="tab-add-hint"
      style={[
        styles.hint,
        floating,
        {
          right: spacing.lg,
          maxWidth: sizes.tabBar * 4,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderRadius: rounded.card,
          backgroundColor: colors.surface,
        },
      ]}>
      {/* Under the text, so the text draws over its top corner. */}
      <View
        style={[
          styles.caret,
          { right: sizes.tabBar / 2 - CARET / 2, bottom: -CARET / 2, width: CARET, height: CARET, backgroundColor: colors.surface },
        ]}
      />
      <ThemedText variant="footnote">{text}</ThemedText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center' },
  tabs: { flex: 1, flexDirection: 'row', alignItems: 'stretch', borderCurve: 'continuous' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  badge: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  add: { alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', bottom: '100%', borderCurve: 'continuous' },
  caret: { position: 'absolute', transform: [{ rotate: '45deg' }] },
});
