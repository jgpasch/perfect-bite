import { useMemo, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Pressable, StyleSheet, View } from 'react-native';

import { AddBar } from '@/components/add-bar';
import { ThemedText } from '@/components/themed-text';
import { aisleColor, shortAisleName } from '@/domain/aisle-color';
import { matchParts } from '@/domain/text-match';
import { getAccount } from '@/features/auth/account';
import { ingredientAisles } from '@/features/categories/categories';
import { useTheme } from '@/hooks/use-theme';
import { displayItemName, parseQuantity } from '@/shared';

import {
  applySuggestion,
  getRecentItems,
  getRecentRecipes,
  getRecipeSuggestions,
  getSuggestions,
  suggestionCaption,
  suggestionChips,
  type RecipeSuggestion,
  type Suggestion,
} from './suggestions';
import { SuggestionChips } from './suggestion-chips';
import { hideFromSuggestions } from './usage';

type Props = {
  householdId: string;
  /**
   * On a list, suggestions are a chip row (`SuggestionChips`): recently used items while the field is empty,
   * leaving out what's already on this list, and the household's recipes too when `onAddRecipe` is set.
   */
  listId?: string;
  /** Adds the text; return keeps the keyboard up for the next one (spec 4.2). */
  onAdd: (text: string) => void;
  /** On a list, the household's recipes are offered too, and picking one calls this (spec 4.2). */
  onAddRecipe?: (recipe: RecipeSuggestion) => void;
  /** Called as the text changes, e.g. to highlight items already on the list. */
  onTextChange?: (text: string) => void;
  /** Called when the field gains or loses focus: the list screen's add mode. */
  onFocusChange?: (focused: boolean) => void;
  placeholder: string;
  accessibilityLabel: string;
};

type Aisle = { slug: string | null; name: string } | null;

/**
 * The persistent add bar at the bottom of a list or recipe, with its suggestions above it: a chip row on a
 * list, the autocomplete panel on a recipe (board 03). Put it last in a KeyboardAvoidingView.
 */
export function ItemAddBar({
  householdId,
  listId,
  onAdd,
  onAddRecipe,
  onTextChange,
  onFocusChange,
  placeholder,
  accessibilityLabel,
}: Props) {
  const [text, setTextState] = useState('');
  const [focused, setFocused] = useState(false);
  // Bumped after "Remove from suggestions" and after adding a recent item or a recipe, so suggestions are read again.
  const [version, setVersion] = useState(0);
  const setText = (value: string) => {
    setTextState(value);
    onTextChange?.(value);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
  const suggestions = useMemo(() => getSuggestions(householdId, text), [householdId, text, version]);
  const offerRecipes = listId !== undefined && onAddRecipe !== undefined;
  // Recipes get their own chips ahead of the item suggestions, so they never take an item's slot.
  const recipeMatches = useMemo(
    () => (offerRecipes ? getRecipeSuggestions(householdId, text) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
    [offerRecipes, householdId, text, version],
  );
  const showRecent = listId !== undefined && focused && !text.trim();
  const recent = useMemo(
    () => (showRecent ? getRecentItems(householdId, listId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
    [showRecent, householdId, listId, version],
  );
  const recentRecipes = useMemo(
    () => (showRecent && offerRecipes ? getRecentRecipes(householdId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
    [showRecent, offerRecipes, householdId, version],
  );
  // Panel rows show each suggestion's aisle; chips don't.
  const aisles = useMemo(
    () => (listId === undefined ? ingredientAisles(getAccount()?.userId ?? null, suggestions.map((s) => s.key)) : new Map()),
    [listId, suggestions],
  );
  const typed = parseQuantity(text).name;

  // Spec 4.2: only household history can be removed; catalog-only suggestions have no menu.
  const removeMenu = ({ key, displayName }: { key: string; displayName: string }) => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: displayItemName(displayName), options: ['Remove from suggestions', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
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
    // A recent item just added leaves the row; history and recipe times changed too.
    setVersion((n) => n + 1);
  };

  // Adds the whole recipe at 1× (spec 4.2). Return never does this: it always adds the text as an item.
  const addRecipe = (recipe: RecipeSuggestion) => {
    onAddRecipe?.(recipe);
    setText('');
    setVersion((n) => n + 1);
  };

  let accessory: ReactNode = null;
  if (listId !== undefined) {
    const chips = suggestionChips(text, { recipes: recipeMatches, suggestions, recentRecipes, recent });
    if (chips.length > 0) {
      accessory = (
        <SuggestionChips
          chips={chips}
          typed={text.trim() ? typed : ''}
          onPressItem={(chip) => add(chip.text)}
          onPressRecipe={(chip) => addRecipe(chip.recipe)}
          onRemove={(chip) => removeMenu({ key: chip.key, displayName: chip.label })}
        />
      );
    }
  } else if (suggestions.length > 0) {
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
  }

  return (
    <AddBar
      value={text}
      onChangeText={setText}
      onSubmit={() => add(text)}
      onFocusChange={(value) => (setFocused(value), onFocusChange?.(value))}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      accessory={accessory}
    />
  );
}

/** The `surface` card above the add bar, with its caption. */
function Panel({ caption, children }: { caption: string; children?: ReactNode }) {
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
  // Display only: tapping adds the stored name (`applySuggestion`), so saving never rewrites it.
  const name = displayItemName(suggestion.displayName);
  const parts = matchParts(name, typed);
  return (
    <PanelRow
      aisle={aisle}
      first={first}
      accessibilityLabel={`Add ${name}${aisle ? `, ${aisle.name}` : ''}`}
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
          name
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

const styles = StyleSheet.create({
  // No overflow: hidden, which would clip the shadow; the rows have no fill to spill over the corners.
  panel: { borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center' },
  name: { flex: 1 },
});
