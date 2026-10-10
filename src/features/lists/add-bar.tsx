import { useMemo, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AddBar } from '@/components/add-bar';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { aisleColor, shortAisleName } from '@/domain/aisle-color';
import { matchParts } from '@/domain/text-match';
import { getAccount } from '@/features/auth/account';
import { ingredientAisles } from '@/features/categories/categories';
import { useTheme } from '@/hooks/use-theme';
import { parseQuantity } from '@/shared';

import {
  applySuggestion,
  getRecentItems,
  getSuggestions,
  suggestionCaption,
  type RecentItem,
  type Suggestion,
} from './suggestions';
import { hideFromSuggestions } from './usage';

type Props = {
  householdId: string;
  /** On a list, focusing the empty bar shows "RECENTLY USED", leaving out what's already on this list. */
  listId?: string;
  /** Adds the text; return keeps the keyboard up for the next one (spec 4.2). */
  onAdd: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
};

type Aisle = { slug: string | null; name: string } | null;

/** "RECENTLY USED" shows about this many rows before it scrolls; the half row hints that it does. */
const RECENT_VISIBLE_ROWS = 4.5;

/**
 * The persistent add bar at the bottom of a list or recipe, with the autocomplete panel above it
 * (board 03). Put it last in a KeyboardAvoidingView.
 */
export function ItemAddBar({ householdId, listId, onAdd, placeholder, accessibilityLabel }: Props) {
  const { sizes } = useTheme();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  // Bumped after "Remove from suggestions" and after adding a recent item, so the panel is read again.
  const [version, setVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
  const suggestions = useMemo(() => getSuggestions(householdId, text), [householdId, text, version]);
  const showRecent = listId !== undefined && focused && !text.trim();
  const recent = useMemo(
    () => (showRecent ? getRecentItems(householdId, listId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
    [showRecent, householdId, listId, version],
  );
  const aisles = useMemo(
    () =>
      ingredientAisles(getAccount()?.userId ?? null, [...suggestions.map((s) => s.key), ...recent.map((r) => r.key)]),
    [suggestions, recent],
  );
  const typed = parseQuantity(text).name;

  // Spec 4.2: only household history can be removed; catalog-only suggestions have no menu.
  const removeMenu = ({ key, displayName }: { key: string; displayName: string }) => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: displayName, options: ['Remove from suggestions', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index !== 0) return;
        hideFromSuggestions(householdId, key);
        setVersion((n) => n + 1);
      },
    );
  };

  const add = (value: string) => {
    if (!value.trim()) return;
    onAdd(value);
    setText('');
  };

  // Adds it exactly as typing its text and pressing Return would; the panel stays open without that row.
  const addRecent = (item: RecentItem) => {
    add(item.text);
    setVersion((n) => n + 1);
  };

  let accessory: ReactNode = null;
  if (suggestions.length > 0) {
    accessory = (
      <Panel caption={suggestionCaption(suggestions)}>
        {suggestions.map((s, i) => (
          <SuggestionRow
            key={s.key}
            suggestion={s}
            typed={typed}
            aisle={aisles.get(s.key) ?? null}
            first={i === 0}
            onPress={() => add(applySuggestion(text, s))}
            onLongPress={s.source === 'history' ? () => removeMenu(s) : undefined}
          />
        ))}
      </Panel>
    );
  } else if (recent.length > 0) {
    accessory = (
      <Panel caption="RECENTLY USED">
        <ScrollView
          style={{ maxHeight: sizes.cardRowMin * RECENT_VISIBLE_ROWS }}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator>
          {recent.map((r, i) => (
            <RecentRow
              key={r.key}
              item={r}
              aisle={aisles.get(r.key) ?? null}
              first={i === 0}
              onPress={() => addRecent(r)}
              onLongPress={() => removeMenu(r)}
            />
          ))}
        </ScrollView>
      </Panel>
    );
  }

  return (
    <AddBar
      value={text}
      onChangeText={setText}
      onSubmit={() => add(text)}
      onFocusChange={setFocused}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      accessory={accessory}
    />
  );
}

/** The `surface` card above the add bar, with its caption. */
function Panel({ caption, children }: { caption: string; children: ReactNode }) {
  const { colors, spacing, rounded, shadows, scheme } = useTheme();
  return (
    <View
      style={[
        styles.panel,
        scheme === 'light' ? { ...shadows.soft, shadowColor: colors.ink } : null,
        {
          backgroundColor: colors.surface,
          borderRadius: rounded.card,
          paddingVertical: spacing.xs + spacing.xxs,
          marginBottom: spacing.md,
        },
      ]}>
      <ThemedText
        variant="caption"
        color="inkSecondary"
        accessibilityRole="header"
        style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs }}>
        {caption}
      </ThemedText>
      {children}
    </View>
  );
}

/** A pressable panel row: aisle dot, then `children`. */
function PanelRow({
  aisle,
  first,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  onLongPress,
  children,
}: {
  aisle: Aisle;
  first: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  onLongPress?: () => void;
  children: ReactNode;
}) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          gap: spacing.md,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <View
        style={{
          width: sizes.dot,
          height: sizes.dot,
          borderRadius: rounded.full,
          backgroundColor: aisles[aisleColor(aisle?.slug)].dot,
        }}
      />
      {children}
    </Pressable>
  );
}

function SuggestionRow({
  suggestion,
  typed,
  aisle,
  first,
  onPress,
  onLongPress,
}: {
  suggestion: Suggestion;
  typed: string;
  aisle: Aisle;
  first: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const parts = matchParts(suggestion.displayName, typed);
  return (
    <PanelRow
      aisle={aisle}
      first={first}
      accessibilityLabel={`Add ${suggestion.displayName}${aisle ? `, ${aisle.name}` : ''}`}
      accessibilityHint={onLongPress ? 'Long press to remove from suggestions' : undefined}
      onPress={onPress}
      onLongPress={onLongPress}>
      <ThemedText variant="body" style={styles.name} numberOfLines={1}>
        {parts ? (
          <>
            {parts.before}
            <ThemedText variant="headline">{parts.match}</ThemedText>
            {parts.after}
          </>
        ) : (
          suggestion.displayName
        )}
      </ThemedText>
      {aisle ? (
        <ThemedText variant="footnote" color="inkSecondary">
          {shortAisleName(aisle.name)}
        </ThemedText>
      ) : null}
    </PanelRow>
  );
}

/** A "RECENTLY USED" row: aisle dot, the text it adds, and a + (the whole row is the button). */
function RecentRow({
  item,
  aisle,
  first,
  onPress,
  onLongPress,
}: {
  item: RecentItem;
  aisle: Aisle;
  first: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  return (
    <PanelRow
      aisle={aisle}
      first={first}
      accessibilityLabel={`Add ${item.displayName}`}
      accessibilityHint="Long press to remove from suggestions"
      onPress={onPress}
      onLongPress={onLongPress}>
      <ThemedText variant="body" style={styles.name} numberOfLines={1}>
        {item.text}
      </ThemedText>
      <Icon name="plus" color="primary" weight="semibold" />
    </PanelRow>
  );
}

const styles = StyleSheet.create({
  // No overflow: hidden, which would clip the shadow; the rows have no fill to spill over the corners.
  panel: { borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center' },
  name: { flex: 1 },
});
