import { useMemo, useState } from 'react';
import { ActionSheetIOS } from 'react-native';

import { AddBar } from '@/components/add-bar';
import { displayItemName, parseQuantity } from '@/shared';

import { getRecipeSuggestions, getSuggestions, suggestionChips, type RecipeSuggestion } from './suggestions';
import { SuggestionChips } from './suggestion-chips';
import { hideFromSuggestions } from './usage';

type Props = {
  householdId: string;
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
 * The persistent add bar at the bottom of a list or recipe, with its suggestions: a chip row (`SuggestionChips`) on
 * top of the keyboard once the field has text (iOS's QuickType bar until then), with the household's recipes too
 * when `onAddRecipe` is set. Put it last in a KeyboardAvoidingView.
 */
export function ItemAddBar({
  householdId,
  onAdd,
  onAddRecipe,
  onTextChange,
  onFocusChange,
  placeholder,
  accessibilityLabel,
}: Props) {
  const [text, setTextState] = useState('');
  // Bumped after "Remove from suggestions" and after adding an item or a recipe, so suggestions are read again.
  const [version, setVersion] = useState(0);
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
    // History and recipe times changed.
    setVersion((n) => n + 1);
  };

  // Adds the whole recipe at 1× (spec 4.2). Return never does this: it always adds the text as an item.
  const addRecipe = (recipe: RecipeSuggestion) => {
    onAddRecipe?.(recipe);
    setText('');
    setVersion((n) => n + 1);
  };

  return (
    <AddBar
      value={text}
      onChangeText={setText}
      onSubmit={() => add(text)}
      onFocusChange={onFocusChange}
      placeholder={placeholder}
      accessibilityLabel={accessibilityLabel}
      // Stays while there's text, even with no chips, so the row and the field don't jump while typing.
      keyboardRow={
        <SuggestionChips
          chips={suggestionChips(text, { recipes: recipeMatches, suggestions })}
          typed={parseQuantity(text).name}
          onPressItem={(chip) => add(chip.text)}
          onPressRecipe={(chip) => addRecipe(chip.recipe)}
          onRemove={(chip) => removeMenu({ key: chip.key, displayName: chip.label })}
        />
      }
    />
  );
}
