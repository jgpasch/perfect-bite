import { Host, Menu, RNHostView, Section, Toggle } from '@expo/ui/swift-ui';
import { accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { Pressable, StyleSheet, View } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { PlanView } from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { type Day, weekLabel } from './week';
import { weekAccessibilityLabel } from './week-view';

const VIEWS: readonly PlanView[] = ['agenda', 'grid'];
const VIEW_ICONS: Record<PlanView, IconName> = { agenda: 'list.bullet', grid: 'square.grid.3x3' };

/** The toolbar's colours: white on the green header, or ink on the sheet when it's the sheet's first row. */
function useToolbarLook(onGreen: boolean) {
  const { colors } = useTheme();
  const wash = listHeaderColors(colors).viewButton.fill;
  return onGreen
    ? { text: colors.onHeader, fill: wash, selectedFill: colors.onHeader, selectedText: colors.header }
    : { text: colors.ink, fill: colors.surfaceMuted, selectedFill: colors.surface, selectedText: colors.ink };
}

/**
 * The week toolbar (spec 4.16, board 4 Idea 1): with several households their menu first, then
 * ‹ Oct 11 – 17 ›, This week while another week shows, the cart (Shop this week) and the Agenda/Grid toggle.
 * Wraps onto a second line at large text sizes.
 */
export function WeekToolbar({
  onGreen,
  households,
  householdId,
  onHousehold,
  start,
  isThisWeek,
  onWeek,
  onThisWeek,
  onShop,
  view,
  onView,
}: {
  onGreen: boolean;
  households: readonly { id: string; name: string }[];
  householdId: string | null;
  onHousehold: (id: string) => void;
  start: Day;
  isThisWeek: boolean;
  onWeek: (direction: -1 | 1) => void;
  onThisWeek: () => void;
  /** The cart; until Shop this week, nothing. */
  onShop?: () => void;
  view: PlanView;
  onView: (view: PlanView) => void;
}) {
  const t = useT();
  const { spacing } = useTheme();
  const look = useToolbarLook(onGreen);
  const household = households.find((h) => h.id === householdId);
  return (
    <View testID="week-toolbar" style={[styles.row, { gap: spacing.sm }]}>
      {households.length > 1 && household ? (
        <HouseholdMenu households={households} current={household} onPick={onHousehold} onGreen={onGreen} />
      ) : null}
      <WeekArrows start={start} color={look.text} onWeek={onWeek} />
      {isThisWeek ? null : <ToolbarPill label={t('mealPlan.thisWeek')} onPress={onThisWeek} onGreen={onGreen} />}
      <View style={[styles.row, styles.end, { gap: spacing.sm }]}>
        <RoundButton icon="cart" label={t('mealPlan.shop')} color={look.text} onPress={onShop} />
        <ViewToggle value={view} onChange={onView} onGreen={onGreen} />
      </View>
    </View>
  );
}

/** ‹ Oct 11 – 17 ›: the week and its arrows (VoiceOver "Previous week", "Week of October 11", "Next week"). */
export function WeekArrows({ start, color, onWeek }: { start: Day; color: string; onWeek: (direction: -1 | 1) => void }) {
  const t = useT();
  return (
    <View style={styles.row}>
      <RoundButton icon="chevron.left" label={t('mealPlan.previousWeek')} color={color} onPress={() => onWeek(-1)} />
      <ThemedText variant="headline" accessibilityLabel={weekAccessibilityLabel(start)} style={{ color, flexShrink: 1 }}>
        {weekLabel(start)}
      </ThemedText>
      <RoundButton icon="chevron.right" label={t('mealPlan.nextWeek')} color={color} onPress={() => onWeek(1)} />
    </View>
  );
}

/** A bare glyph button with a 44 pt tap area. */
function RoundButton({ icon, label, color, onPress }: { icon: IconName; label: string; color: string; onPress?: () => void }) {
  const { sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.center,
        { minWidth: sizes.minTapTarget, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <Icon name={icon} tint={color} weight="semibold" />
    </Pressable>
  );
}

/** A 32 pt pill padded to a 44 pt tap area, like the Recipes tab's header pills. */
function ToolbarPill({ label, onPress, onGreen }: { label: string; onPress: () => void; onGreen: boolean }) {
  const { sizes, spacing, rounded, opacity } = useTheme();
  const look = useToolbarLook(onGreen);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={(sizes.minTapTarget - sizes.viewButton) / 2}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          minHeight: sizes.viewButton,
          borderRadius: rounded.full,
          paddingHorizontal: spacing.md,
          backgroundColor: look.fill,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="amount" style={{ color: look.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

/**
 * The household's name and a chevron, opening a native menu of the user's households, the current one
 * ticked. VoiceOver: "Household: Our place".
 */
function HouseholdMenu({
  households,
  current,
  onPick,
  onGreen,
}: {
  households: readonly { id: string; name: string }[];
  current: { id: string; name: string };
  onPick: (id: string) => void;
  onGreen: boolean;
}) {
  const t = useT();
  const { colors, scheme, sizes, spacing, rounded } = useTheme();
  const look = useToolbarLook(onGreen);
  const inset = (sizes.minTapTarget - sizes.viewButton) / 2;
  return (
    <View style={{ marginVertical: -inset }}>
      <Host matchContents colorScheme={scheme} seedColor={colors.primary}>
        <Menu
          label={
            <RNHostView matchContents>
              <View style={{ paddingVertical: inset }}>
                <View
                  style={[
                    styles.pill,
                    {
                      minHeight: sizes.viewButton,
                      borderRadius: rounded.full,
                      paddingLeft: spacing.md,
                      paddingRight: spacing.md - spacing.xxs,
                      gap: spacing.xs,
                      backgroundColor: look.fill,
                    },
                  ]}>
                  <ThemedText variant="amount" numberOfLines={1} style={{ color: look.text, flexShrink: 1 }}>
                    {current.name}
                  </ThemedText>
                  <Icon name="chevron.down" tint={look.text} size={sizes.iconSmall} weight="semibold" />
                </View>
              </View>
            </RNHostView>
          }
          modifiers={[accessibilityLabel(t('mealPlan.household', { name: current.name }))]}>
          <Section title={t('mealPlan.householdMenu')}>
            {households.map((household) => (
              <Toggle
                key={household.id}
                label={household.name}
                isOn={household.id === current.id}
                onIsOnChange={() => onPick(household.id)}
              />
            ))}
          </Section>
        </Menu>
      </Host>
    </View>
  );
}

/**
 * The Agenda/Grid toggle: two icon segments on a pill, the selected one filled. VoiceOver "View: Grid", each
 * segment with its selected state.
 */
function ViewToggle({ value, onChange, onGreen }: { value: PlanView; onChange: (view: PlanView) => void; onGreen: boolean }) {
  const t = useT();
  const { sizes, spacing, rounded, opacity } = useTheme();
  const look = useToolbarLook(onGreen);
  const segmentHeight = sizes.viewButton - spacing.xxs * 2;
  const slop = (sizes.minTapTarget - segmentHeight) / 2;
  return (
    <View
      testID="plan-view-toggle"
      accessibilityRole="tablist"
      accessibilityLabel={t('mealPlan.viewLabel', { view: t(`mealPlan.views.${value}`) })}
      style={[styles.pill, { padding: spacing.xxs, borderRadius: rounded.full, backgroundColor: look.fill }]}>
      {VIEWS.map((view) => {
        const selected = view === value;
        return (
          <Pressable
            key={view}
            accessibilityRole="tab"
            accessibilityLabel={t(`mealPlan.views.${view}`)}
            accessibilityState={{ selected }}
            hitSlop={{ top: slop, bottom: slop }}
            onPress={() => {
              if (!selected) onChange(view);
            }}
            style={({ pressed }) => [
              styles.center,
              {
                minWidth: sizes.minTapTarget,
                minHeight: segmentHeight,
                borderRadius: rounded.full,
                backgroundColor: selected ? look.selectedFill : 'transparent',
                opacity: pressed && !selected ? opacity.pressed : 1,
              },
            ]}>
            <Icon
              name={VIEW_ICONS[view]}
              tint={selected ? look.selectedText : look.text}
              size={sizes.iconSmall + spacing.xs}
              weight="semibold"
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  end: { marginLeft: 'auto' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 1, borderCurve: 'continuous' },
});
