import * as Haptics from 'expo-haptics';
import { useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { SwipeDirection, type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { itemNameColor, type CategoryColors } from '@/components/appearance';
import { CheckCircle } from '@/components/check-circle';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { matchParts } from '@/domain/text-match';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { displayItemName } from '@/shared';

import type { ItemView } from './items';
import { ALREADY_ON_LIST_LABEL, checkOffLabel, itemRowLabel, SORTING_LABEL, toggleActionLabel } from './list-view';

type Props = {
  item: ItemView;
  /** The card's ground, so the row covers the swipe action behind it. */
  background: string;
  /** Set while the toast for an add that merged into this item shows (spec 4.4): its aisle's soft tint. */
  tint?: string;
  /**
   * Unchecked rows: the item's aisle colours (`categoryColors`): a faint tint for the row, the check's ring and
   * the amount. Rows are then 2 pt apart in the card's ground instead of a hairline. Checked rows leave it out.
   */
  look?: CategoryColors;
  /**
   * Add mode: the item matches what's being typed (`isAlreadyOnList`). A `primarySoft` tint, the typed part of
   * the name in `onPrimarySoft`, and "already on list" in place of the amount.
   */
  alreadyOnList?: { typed: string };
  /** The first row in its card has no hairline above it. */
  first?: boolean;
  /** "Sorting…": waiting for an aisle. A dashed amber check and a "Sorting…" label. */
  sorting?: boolean;
  /** Overrides the item's total, e.g. one recipe's share in the By recipe view. */
  amountText?: string;
  /** A second line, e.g. "Also in Weeknight dal" (spec 4.6). */
  hint?: string;
  /** As added and By recipe (spec 4.6): the item's aisle, read by VoiceOver (the row's tint shows it). */
  aisle?: { name: string };
  /** Select mode (spec 4.5): defined while selecting; taps then toggle selection. */
  selected?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  /** Long-press (or the "Select" action) when not selecting: enter Select mode with this item (spec 4.5). */
  onSelect?: () => void;
};

/**
 * A list item in a card (spec 4.2): tap the check to check it off, tap the rest of the row to open its
 * details, long-press to start selecting with it, swipe right to check it off (or uncheck it) and left to
 * delete. While selecting, a tap
 * anywhere on the row selects it.
 */
export function ItemRow({
  item,
  background,
  tint,
  look,
  alreadyOnList,
  first,
  sorting = false,
  amountText = item.amountText,
  hint,
  aisle,
  selected,
  onToggle,
  onDelete,
  onEdit,
  onSelect,
}: Props) {
  const { colors, spacing, sizes, opacity } = useTheme();
  const { entering, exiting, layout } = useMotion();
  const swipeable = useRef<SwipeableMethods>(null);
  const selecting = selected !== undefined;
  const checked = item.checkedAt !== null;
  const on = selecting ? selected : checked;
  const name = displayItemName(item.displayName);
  const secondLine = [item.note, hint].filter(Boolean).join(' · ');
  const label = [
    itemRowLabel({ name, amountText, note: item.note, hint, aisle: aisle?.name }, sorting && !checked),
    alreadyOnList ? ALREADY_ON_LIST_LABEL : null,
  ]
    .filter(Boolean)
    .join(', ');
  const match = alreadyOnList ? matchParts(name, alreadyOnList.typed) : null;

  const rowStyle = [
    styles.row,
    {
      minHeight: sizes.cardRowMin,
      paddingLeft: spacing.lg,
      gap: spacing.md,
      backgroundColor: alreadyOnList ? colors.primarySoft : tint ?? look?.tint ?? background,
      borderTopWidth: first ? 0 : look ? spacing.xxs : StyleSheet.hairlineWidth,
      borderTopColor: look ? background : colors.border,
    },
  ];

  // Name, second line, amount: everything but the check.
  const content = (
    <>
      <View style={styles.text}>
        <ThemedText variant="body" color={itemNameColor(checked)} style={checked ? styles.checked : undefined}>
          {match ? (
            <>
              {match.before}
              <ThemedText variant="headline" color="onPrimarySoft">
                {match.match}
              </ThemedText>
              {match.after}
            </>
          ) : (
            name
          )}
        </ThemedText>
        {secondLine ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {secondLine}
          </ThemedText>
        ) : null}
      </View>
      {alreadyOnList ? (
        <ThemedText variant="amount" color="onPrimarySoft">
          {ALREADY_ON_LIST_LABEL}
        </ThemedText>
      ) : amountText ? (
        <ThemedText variant="amount" color="inkSecondary" style={look ? { color: look.text } : undefined}>
          {amountText}
        </ThemedText>
      ) : null}
      {sorting && !checked ? (
        <ThemedText variant="sectionLabel" color="pending">
          {SORTING_LABEL}
        </ThemedText>
      ) : null}
    </>
  );

  return (
    <Animated.View entering={entering} exiting={exiting} layout={layout}>
      <ReanimatedSwipeable
        enabled={!selecting}
        ref={swipeable}
        // Follows the finger, and only a swipe past half the row commits (the default threshold).
        friction={1}
        overshootLeft={false}
        overshootRight={false}
        onSwipeableOpen={(direction) => {
          if (direction === SwipeDirection.LEFT) return onDelete();
          swipeable.current?.close();
          onToggle();
        }}
        renderLeftActions={() => (
          <View style={[styles.action, styles.leading, { backgroundColor: colors.primary, paddingHorizontal: spacing.xl }]}>
            <Icon name={checked ? 'arrow.uturn.backward' : 'checkmark'} color="onPrimary" weight="bold" />
          </View>
        )}
        renderRightActions={() => (
          <View style={[styles.action, styles.trailing, { backgroundColor: colors.danger, paddingHorizontal: spacing.xl }]}>
            <Icon name="trash" color="onPrimary" />
          </View>
        )}>
        {selecting ? (
          <Pressable
            onPress={onToggle}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={label}
            accessibilityHint="Double-tap to select"
            style={({ pressed }) => [
              rowStyle,
              { paddingRight: spacing.lg, paddingVertical: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
            ]}>
            <CheckCircle checked={on} pending={sorting} ring={look?.ring} />
            <View style={[styles.body, { gap: spacing.md }]}>{content}</View>
          </Pressable>
        ) : (
          <View style={rowStyle}>
            <CheckCircle checked={checked} pending={sorting} ring={look?.ring} onPress={onToggle} accessibilityLabel={checkOffLabel(name)} />
            <Pressable
              onPress={onEdit}
              onLongPress={
                onSelect
                  ? () => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      onSelect();
                    }
                  : undefined
              }
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint="Opens details"
              accessibilityActions={[
                { name: 'edit', label: 'Edit' },
                { name: 'delete', label: 'Delete' },
                { name: 'toggle', label: toggleActionLabel(checked) },
                ...(onSelect ? [{ name: 'select', label: 'Select' }] : []),
              ]}
              onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === 'edit') onEdit();
                if (nativeEvent.actionName === 'delete') onDelete();
                if (nativeEvent.actionName === 'toggle') onToggle();
                if (nativeEvent.actionName === 'select') onSelect?.();
              }}
              style={({ pressed }) => [
                styles.body,
                {
                  alignSelf: 'stretch',
                  minHeight: sizes.cardRowMin,
                  paddingRight: spacing.lg,
                  paddingVertical: spacing.sm,
                  gap: spacing.md,
                  opacity: pressed ? opacity.pressed : 1,
                },
              ]}>
              {content}
            </Pressable>
          </View>
        )}
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
  checked: { textDecorationLine: 'line-through' },
  action: { flex: 1, justifyContent: 'center' },
  leading: { alignItems: 'flex-start' },
  trailing: { alignItems: 'flex-end' },
});
