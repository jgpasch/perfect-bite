import type { BottomTabBarProps } from 'expo-router/tabs';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = BottomTabBarProps & {
  /** The round + on the right: adds on the tab that's showing. */
  onAdd: () => void;
  addLabel: string;
};

/**
 * The app's tab bar (spec 4.1): a floating pill of the tabs on the left and a round `primary` + on the right,
 * on the screen's ground. A tab's icon comes from its `tabBarIcon`, its label from `title`; a tab with
 * `href: null` is left out.
 */
export function TabBar({ state, descriptors, navigation, onAdd, addLabel }: Props) {
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={addLabel}
        testID="tab-add"
        onPress={onAdd}
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
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center' },
  tabs: { flex: 1, flexDirection: 'row', alignItems: 'stretch', borderCurve: 'continuous' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  badge: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  add: { alignItems: 'center', justifyContent: 'center' },
});
