import { useMemo, useState } from 'react';
import { ActionSheetIOS } from 'react-native';

import { AddBar } from '@/components/add-bar';
import { ingredientUsage, listItems } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { useT } from '@/i18n';
import { displayItemName, parseQuantity } from '@/shared';

import { openItemKeysQuery, usualItems } from './items';
import { getRecipeSuggestions, getSuggestions, suggestionChips, type RecipeSuggestion } from './suggestions';
import { SuggestionChips } from './suggestion-chips';
import { hideFromSuggestions } from './usage';

/** Watched for the usual items: the list's items, and the household's history as it syncs. */
const USUAL_QUERY_TABLES = [listItems, ingredientUsage];

type Props = {
  householdId: string;
  /** On a list, its id: the empty focused field then offers the household's usual items (spec 4.2). */
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

/**
 * The persistent add bar at the bottom of a list or recipe, with its suggestions: a chip row (`SuggestionChips`) docked
 * above the field while something matches, with the household's recipes too when `onAddRecipe` is set, and the usual
 * items while a list's field is focused and empty. Put it last in a KeyboardAvoidingView, so the row grows the bar
 * upward and the field stays put.
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
  const t = useT();
  const [text, setTextState] = useState('');
  const [focused, setFocused] = useState(false);
  // Bumped after "Remove from suggestions" and after adding an item or a recipe, so suggestions are read again.
  const [version, setVersion] = useState(0);
  // The list's open items, so the usual chips follow it: an Undo or a sync brings a chip back.
  const { data: openItems } = useLiveQueryOn(openItemKeysQuery(listId ?? ''), USUAL_QUERY_TABLES, [listId]);
  const showUsual = listId !== undefined && focused && !text.trim();
  const usual = useMemo(
    () => (showUsual && listId !== undefined ? usualItems(householdId, listId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version and openItems only force a re-read
    [showUsual, householdId, listId, version, openItems],
  );
  const setText = (value: string) => {
    setTextState(value);
    onTextChange?.(value);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
  const suggestions = useMemo(() => getSuggestions(householdId, text), [householdId, text, version]);
  const offerRecipes = onAddRecipe !== undefined;
  // Recipes get their own chips ahead of the item suggestions, so they never take an item's slot.
  const recipeMatches = useMemo(
    () => (offerRecipes ? getRecipeSuggestions(householdId, text) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
    [offerRecipes, householdId, text, version],
  );

  // Spec 4.2: only household history can be removed; catalog-only suggestions have no menu.
  const removeMenu = ({ key, displayName }: { key: string; displayName: string }) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: displayItemName(displayName),
        options: [t('addBar.removeFromSuggestions'), t('common.cancel')],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1,
      },
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
    // History and recipe times changed.
    setVersion((n) => n + 1);
  };

  // Adds the whole recipe at 1× (spec 4.2). Return never does this: it always adds the text as an item.
  const addRecipe = (recipe: RecipeSuggestion) => {
    onAddRecipe?.(recipe);
    setText('');
    setVersion((n) => n + 1);
  };

  const chips = suggestionChips(text, { recipes: recipeMatches, suggestions, usual });

  return (
    <AddBar
      value={text}
      onChangeText={setText}
      onSubmit={() => add(text)}
      onFocusChange={(value) => {
        setFocused(value);
        onFocusChange?.(value);
      }}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      accessory={
        chips.length === 0 ? null : (
          <SuggestionChips
            chips={chips}
            typed={parseQuantity(text).name}
            accessibilityLabel={text.trim() ? t('addBar.suggestions') : t('addBar.usualItems')}
            onPressItem={(chip) => add(chip.text)}
            onPressRecipe={(chip) => addRecipe(chip.recipe)}
            onRemove={(chip) => removeMenu({ key: chip.key, displayName: chip.label })}
          />
        )
      }
    />
  );
}
