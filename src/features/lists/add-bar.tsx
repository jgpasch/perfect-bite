import { useMemo, useState } from 'react';
import { ActionSheetIOS, Pressable, StyleSheet, View } from 'react-native';

import { AddBar } from '@/components/add-bar';
import { ThemedText } from '@/components/themed-text';
import { aisleColor, shortAisleName } from '@/domain/aisle-color';
import { matchParts } from '@/domain/text-match';
import { getAccount } from '@/features/auth/account';
import { ingredientAisles } from '@/features/categories/categories';
import { useTheme } from '@/hooks/use-theme';
import { parseQuantity } from '@/shared';

import { applySuggestion, getSuggestions, suggestionCaption, type Suggestion } from './suggestions';
import { hideFromSuggestions } from './usage';

type Props = {
  householdId: string;
  /** Adds the text; return keeps the keyboard up for the next one (spec 4.2). */
  onAdd: (text: string) => void;
  placeholder: string;
  accessibilityLabel: string;
};

/**
 * The persistent add bar at the bottom of a list or recipe, with the autocomplete panel above it
 * (board 03). Put it last in a KeyboardAvoidingView.
 */
export function ItemAddBar({ householdId, onAdd, placeholder, accessibilityLabel }: Props) {
  const { colors, spacing, rounded, shadows, scheme } = useTheme();
  const [text, setText] = useState('');
  // Bumped after "Remove from suggestions" so the panel is read again.
  const [hiddenCount, setHiddenCount] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenCount only forces a re-read
  const suggestions = useMemo(() => getSuggestions(householdId, text), [householdId, text, hiddenCount]);
  const aisles = useMemo(
    () =>
      ingredientAisles(
        getAccount()?.userId ?? null,
        suggestions.map((s) => s.key),
      ),
    [suggestions],
  );
  const typed = parseQuantity(text).name;

  // Spec 4.2: only household history can be removed; catalog-only suggestions have no menu.
  const suggestionMenu = (s: Suggestion) => {
    if (s.source !== 'history') return;
    ActionSheetIOS.showActionSheetWithOptions(
      { title: s.displayName, options: ['Remove from suggestions', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index !== 0) return;
        hideFromSuggestions(householdId, s.key);
        setHiddenCount((n) => n + 1);
      },
    );
  };

  const add = (value: string) => {
    if (!value.trim()) return;
    onAdd(value);
    setText('');
  };

  return (
    <AddBar
      value={text}
      onChangeText={setText}
      onSubmit={() => add(text)}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      accessory={
        suggestions.length > 0 ? (
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
              {suggestionCaption(suggestions)}
            </ThemedText>
            {suggestions.map((s, i) => (
              <SuggestionRow
                key={s.key}
                suggestion={s}
                typed={typed}
                aisle={aisles.get(s.key) ?? null}
                first={i === 0}
                onPress={() => add(applySuggestion(text, s))}
                onLongPress={s.source === 'history' ? () => suggestionMenu(s) : undefined}
              />
            ))}
          </View>
        ) : null
      }
    />
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
  aisle: { slug: string | null; name: string } | null;
  first: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const parts = matchParts(suggestion.displayName, typed);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Add ${suggestion.displayName}${aisle ? `, ${aisle.name}` : ''}`}
      accessibilityHint={onLongPress ? 'Long press to remove from suggestions' : undefined}
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // No overflow: hidden, which would clip the shadow; the rows have no fill to spill over the corners.
  panel: { borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center' },
  name: { flex: 1 },
});
