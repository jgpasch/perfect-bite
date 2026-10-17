import * as Haptics from 'expo-haptics';
import { useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { SwipeDirection, type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { itemNameColor, type CategoryColors } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { CheckCircle } from '@/components/check-circle';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { growIn, useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName } from '@/shared';

import type { ItemView } from './items';
import { ALREADY_ON_LIST_LABEL, alreadyOnListParts, checkOffLabel, itemRowLabel, SORTING_LABEL, toggleActionLabel } from './list-view';

type Props = {
  item: ItemView;
  /** The card's ground, so the row covers the swipe action behind it. */
  background: string;
  /** Set while the toast for an add that merged into this item shows (spec 4.4): its aisle's soft tint. */
  tint?: string;
  /**
   * Unchecked rows: the item's aisle colours (`categoryColors`): the row's ground, the check's ring and fill, and
   * the amount. The name is bolder, and a row tinted apart from its card (Colour bands) sits 2 pt below the one
   * before it in the card's ground instead of under a hairline. Checked rows leave it out.
   */
  look?: CategoryColors;
  /**
   * Add mode: the item matches what's being typed (`isAlreadyOnList`, with the typed key as `query`). A
   * `primarySoft` tint, the matched word(s) of the name in `onPrimarySoft`, and "already on list" in place of the
   * amount.
   */
  alreadyOnList?: { query: string };
  /** The first row in its card has no hairline above it. */
  first?: boolean;
  /** "Sorting…": waiting for an aisle. A dashed amber check and a "Sorting…" label. */
  sorting?: boolean;
  /** Overrides the item's total, e.g. one recipe's share in the By recipe view. */
  amountText?: string;
  /** A second line, e.g. "Also in Weeknight dal" (spec 4.6). */
  hint?: string;
  /**
   * Another member's add, since the list was last seen or while it shows (spec 4.1): a NEW badge after
   * the name, and "new" for VoiceOver. When it goes false the badge fades out over `motion.duration`
   * (at once under Reduce Motion).
   */
  isNew?: boolean;
  /**
   * Another member's add arrived while the list was on screen, new to the list to get (spec 4.1): the row
   * grows into place as it mounts, or just appears under Reduce Motion.
   */
  grow?: boolean;
  /** A NEW row's view, so the list can tell when it's first in sight; and each time it's laid out. */
  newRef?: (node: View | null) => void;
  onNewLayout?: () => void;
  /** As added and By recipe (spec 4.6): the item's aisle, read by VoiceOver (the row's tint shows it). */
  aisle?: { name: string };
  /** Select mode (spec 4.5): defined while selecting; taps then toggle selection. */
  selected?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  /** Long-press (or the "Select" action) when not selecting: enter Select mode with this item (spec 4.5). */
  onSelect?: () => void;
  /**
   * As added (spec 4.6): the row's long-press belongs to the drag around it (`ReorderableRows`), which
   * enters Select mode itself when let go without moving.
   */
  reorderable?: boolean;
  /** As added: VoiceOver's Move up / Move down, each with what it does. */
  moves?: RowMove[];
};

export type RowMove = { name: 'moveUp' | 'moveDown'; label: string; onPress: () => void };

// Holding a reorderable row still runs out a Pressable's long-press, so the tap that ends it isn't an open.
const noop = () => {};

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
  isNew = false,
  grow = false,
  newRef,
  onNewLayout,
  aisle,
  selected,
  onToggle,
  onDelete,
  onEdit,
  onSelect,
  reorderable = false,
  moves = [],
}: Props) {
  const { colors, spacing, sizes, opacity } = useTheme();
  const t = useT();
  const { entering, exiting, layout, reduceMotion } = useMotion();
  const swipeable = useRef<SwipeableMethods>(null);
  const selecting = selected !== undefined;
  const checked = item.checkedAt !== null;
  const on = selecting ? selected : checked;
  const name = displayItemName(item.displayName);
  const secondLine = [item.note, hint].filter(Boolean).join(' · ');
  const banded = look !== undefined && look.tint !== background;
  const label = [
    itemRowLabel(
      {
        name,
        news: isNew ? t('lists.news.rowLabel') : undefined,
        photo: item.photoPath ? t('lists.row.hasPhoto') : undefined,
        amountText,
        note: item.note,
        hint,
        aisle: aisle?.name,
      },
      sorting && !checked,
    ),
    alreadyOnList ? ALREADY_ON_LIST_LABEL : null,
  ]
    .filter(Boolean)
    .join(', ');
  const match = alreadyOnList ? alreadyOnListParts(name, alreadyOnList.query) : null;

  const rowStyle = [
    styles.row,
    {
      minHeight: sizes.cardRowMin,
      paddingLeft: spacing.lg,
      gap: spacing.md,
      backgroundColor: alreadyOnList ? colors.primarySoft : tint ?? look?.tint ?? background,
      borderTopWidth: first ? 0 : banded ? spacing.xxs : StyleSheet.hairlineWidth,
      borderTopColor: banded ? background : colors.border,
    },
  ];

  // Name, second line, amount: everything but the check.
  const content = (
    <>
      <View style={styles.text}>
        {/* Always a row, so a badge fading out stays beside the name. */}
        <View style={[styles.nameRow, { columnGap: spacing.sm }]}>
          <ThemedText
            variant={look && !checked ? 'itemName' : 'body'}
            color={itemNameColor(checked)}
            style={checked ? styles.checked : undefined}>
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
          {item.photoPath ? (
            // The item has a photo (spec 4.4): a small glyph before any NEW badge; the row's label says so.
            <View testID="photo-glyph" accessible={false}>
              <Icon name="photo" color="inkSecondary" size={sizes.iconSmall} weight="semibold" />
            </View>
          ) : null}
          {isNew ? (
            <Animated.View testID="new-badge" exiting={reduceMotion ? undefined : exiting}>
              <Badge label={t('lists.news.badge')} />
            </Animated.View>
          ) : null}
        </View>
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
    <Animated.View
      entering={grow && !reduceMotion ? growIn : entering}
      exiting={exiting}
      layout={layout}
      style={grow ? styles.clip : undefined}>
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
            ref={newRef}
            onLayout={onNewLayout}
            onPress={onToggle}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={label}
            accessibilityHint={t('lists.row.selectHint')}
            style={({ pressed }) => [
              rowStyle,
              { paddingRight: spacing.lg, paddingVertical: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
            ]}>
            <CheckCircle checked={on} pending={sorting} ring={look?.ring} fill={look?.checkFill} />
            <View style={[styles.body, { gap: spacing.md }]}>{content}</View>
          </Pressable>
        ) : (
          <View ref={newRef} onLayout={onNewLayout} style={rowStyle}>
            <CheckCircle checked={checked} pending={sorting} ring={look?.ring} fill={look?.checkFill} onPress={onToggle} accessibilityLabel={checkOffLabel(name)} />
            <Pressable
              onPress={onEdit}
              onLongPress={
                reorderable
                  ? noop
                  : onSelect
                  ? () => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      onSelect();
                    }
                  : undefined
              }
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={t('lists.row.opensDetails')}
              accessibilityActions={[
                { name: 'edit', label: t('common.edit') },
                { name: 'delete', label: t('common.delete') },
                { name: 'toggle', label: toggleActionLabel(checked) },
                ...(onSelect ? [{ name: 'select', label: t('common.select') }] : []),
                ...moves.map(({ name, label }) => ({ name, label })),
              ]}
              onAccessibilityAction={({ nativeEvent }) => {
                moves.find((m) => m.name === nativeEvent.actionName)?.onPress();
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
  clip: { overflow: 'hidden' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
  nameRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  checked: { textDecorationLine: 'line-through' },
  action: { flex: 1, justifyContent: 'center' },
  leading: { alignItems: 'flex-start' },
  trailing: { alignItems: 'flex-end' },
});
