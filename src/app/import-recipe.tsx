import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { SettingsRow } from '@/components/settings-group';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { getAccount } from '@/features/auth/account';
import { householdsQuery } from '@/features/households/households';
import { openList } from '@/features/lists/current-list';
import { getDefaultListId, LAST_OPENED_LIST_KEY, listsWithCountsQuery } from '@/features/lists/lists';
import { setRecipeAddResult } from '@/features/lists/recipe-add-result';
import { notify } from '@/features/notifications/notifications';
import { importRecipe, type ImportRecipeSuccess } from '@/features/recipes/import';
import {
  importedNotification,
  importFailedNotification,
  savedNotification,
} from '@/features/recipes/import-notifications';
import { importErrorMessage, urlFromText } from '@/features/recipes/import-sheet';
import {
  defaultListIdIn,
  householdLists,
  IMPORT_ADD_TO_LIST_KEY,
  initialSaveChoice,
  NO_LISTS_IN_HOUSEHOLD,
  saveButtonTitle,
  type SheetEntry,
} from '@/features/recipes/save-choice';
import { setSavedRecipeResult } from '@/features/recipes/saved-recipe-result';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Add recipe from link…" (spec 4.10): a **Save to** household picker (hidden with one household) and
 * an **Also add ingredients to a list** switch that shows that household's list picker. From the
 * Recipes tab the household follows the default rule and the switch starts as last left on this
 * device; from a list's menu (`list`) it's that list's household with the switch on and that list
 * chosen. The clipboard is read only when Paste is tapped, so iOS shows no paste prompt on open. On
 * success the sheet closes: onto a list, the list shows "Added Chicken tikka masala · 12 items";
 * recipe-only, the Recipes tab (or the list it came from) shows "Saved Chicken tikka masala". Closed
 * while reading, the import carries on and its result comes as an in-app notification (spec 4.11); a
 * failed one's notification reopens the sheet with the same `household`, `add`, `to` (list) and `url`.
 */
export default function ImportRecipeSheet() {
  const params = useLocalSearchParams<{ list?: string; household?: string; add?: string; to?: string; url?: string }>();
  const fromList = params.list;
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const userId = getAccount()?.userId ?? null;

  // A sheet is short-lived: read once rather than live.
  const [choices] = useState(() => ({
    lastOpenedListId: getDeviceSetting<string | null>(LAST_OPENED_LIST_KEY, null),
    defaultListId: userId ? getDefaultListId(userId) : null,
    lists: listsWithCountsQuery()
      .all()
      .filter((l) => l.archivedAt === null),
    households: householdsQuery().all(),
  }));
  const [entry] = useState<SheetEntry>(() =>
    fromList
      ? { from: 'list', listId: fromList }
      : params.add !== undefined
        ? { from: 'retry', householdId: params.household ?? null, addToList: params.add === '1', listId: params.to ?? null }
        : { from: 'recipes', rememberedAddToList: getDeviceSetting(IMPORT_ADD_TO_LIST_KEY, false) },
  );
  const [choice, setChoice] = useState(() => initialSaveChoice(choices, entry));
  const [text, setText] = useState(params.url ?? '');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Closed while reading: the import still lands, and says so with a notification instead.
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );

  const { householdId, listId } = choice;
  const lists = householdLists(choices.lists, householdId);
  // The switch can't be on in a household with no lists: that saves the recipe only.
  const addToList = choice.addToList && listId !== null;
  const listName = lists.find((l) => l.id === listId)?.name ?? null;
  const householdName = choices.households.find((h) => h.id === householdId)?.name ?? 'your recipes';

  // Changing household resets the list to that household's default.
  const chooseHousehold = (id: string) => setChoice((c) => ({ ...c, householdId: id, listId: defaultListIdIn(choices, id) }));
  const toggleAddToList = (on: boolean) => {
    setChoice((c) => ({ ...c, addToList: on }));
    // From a list's menu it starts on because of the list; only the Recipes tab's choice is remembered.
    if (entry.from !== 'list') setDeviceSetting(IMPORT_ADD_TO_LIST_KEY, on);
  };

  const paste = async () => {
    const pasted = await Clipboard.getStringAsync();
    if (!pasted) return;
    setText(urlFromText(pasted) ?? pasted.trim());
    setError(null);
  };

  // Recipe-only: the toast shows where the user is (the list it came from, else the Recipes tab).
  const savedRecipeOnly = (result: ImportRecipeSuccess) => {
    const saved = { recipeId: result.recipeId, recipeName: result.recipeName, created: result.created, undo: result.undo };
    if (!open.current) {
      notify({
        ...savedNotification(result, householdName),
        onPress: () => router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } }),
      });
      return;
    }
    if (fromList) setRecipeAddResult({ kind: 'saved', listId: fromList, ...saved });
    else setSavedRecipeResult(saved);
    router.back();
  };

  const submit = async () => {
    if (!householdId || working) return;
    const url = urlFromText(text);
    if (!url) {
      setError(importErrorMessage({ ok: false, error: 'failed', reason: 'invalid_url' }));
      return;
    }
    setError(null);
    setWorking(true);
    const result = addToList && listId ? await importRecipe({ url, listId }) : await importRecipe({ url, householdId });
    if (!result.ok) {
      if (open.current) {
        setWorking(false);
        setError(importErrorMessage(result));
      } else {
        // Reopens with the same choices: household, switch, list and link.
        const retry = { household: householdId, add: addToList ? '1' : '0', ...(addToList && listId ? { to: listId } : {}), url };
        notify({
          ...importFailedNotification(result, url),
          onPress: () => router.push({ pathname: '/import-recipe', params: retry }),
        });
      }
      return;
    }
    if (result.listId === null) {
      savedRecipeOnly(result);
      return;
    }
    const added = {
      kind: 'imported',
      listId: result.listId,
      recipeId: result.recipeId,
      recipeName: result.recipeName,
      count: result.added,
      undo: result.undo,
    } as const;
    if (!open.current) {
      const name = choices.lists.find((l) => l.id === result.listId)?.name ?? 'your list';
      notify({
        ...importedNotification(result, name),
        // Its toast (Undo, View recipe) shows on the list, which may be the one showing already.
        onPress: () => {
          setRecipeAddResult(added);
          openList(result.listId);
        },
      });
      return;
    }
    setRecipeAddResult(added);
    router.back();
    // From that list's menu, the list is underneath already.
    if (result.listId !== fromList) openList(result.listId);
  };

  if (!householdId) return <Screen />;

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
        <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          Add recipe from link
        </ThemedText>

        {choices.households.length > 1 ? (
          <View style={{ gap: spacing.sm }}>
            <Label>Save to</Label>
            <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
              {choices.households.map((h) => (
                <Pill
                  key={h.id}
                  label={h.name}
                  selected={h.id === householdId}
                  disabled={working}
                  onPress={() => chooseHousehold(h.id)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Card>
          <SettingsRow
            label="Also add ingredients to a list"
            detail={lists.length === 0 ? NO_LISTS_IN_HOUSEHOLD : undefined}
            last
            trailing={
              <Switch
                value={addToList}
                onValueChange={toggleAddToList}
                disabled={working || lists.length === 0}
                trackColor={{ true: colors.primary }}
                accessibilityLabel="Also add ingredients to a list"
                accessibilityHint={lists.length === 0 ? NO_LISTS_IN_HOUSEHOLD : "Adds the recipe's ingredients to the chosen list"}
              />
            }
          />
        </Card>

        {addToList ? (
          <View style={{ gap: spacing.sm }}>
            <Label>List</Label>
            <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
              {lists.map((l) => (
                <Pill
                  key={l.id}
                  label={l.name}
                  selected={l.id === listId}
                  disabled={working}
                  onPress={() => setChoice((c) => ({ ...c, listId: l.id }))}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Label>Link</Label>
        <Card>
          <View style={[styles.row, { paddingLeft: spacing.lg, paddingRight: spacing.sm, gap: spacing.sm }]}>
            <TextField
              value={text}
              onChangeText={(value) => (setText(value), setError(null))}
              placeholder="https://"
              accessibilityLabel="Recipe link"
              keyboardType="url"
              textContentType="URL"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              editable={!working}
              onSubmitEditing={submit}
              style={[styles.flex, { borderWidth: 0, backgroundColor: colors.surface, paddingLeft: 0 }]}
            />
            <Button label="Paste" variant="plain" disabled={working} onPress={paste} />
          </View>
        </Card>

        {working ? (
          <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
            You can close this. We&apos;ll let you know when it&apos;s ready.
          </ThemedText>
        ) : null}

        {error ? (
          <ThemedText
            variant="footnote"
            color="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
            {error}
          </ThemedText>
        ) : null}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: Math.max(insets.bottom, spacing.lg),
          backgroundColor: colors.background,
        }}>
        <PrimaryButton
          label={working ? 'Reading recipe…' : saveButtonTitle(addToList, listName)}
          icon={working ? undefined : 'link'}
          disabled={working || text.trim() === ''}
          onPress={submit}
        />
      </View>
    </Screen>
  );
}

function Label({ children }: { children: string }) {
  const { spacing } = useTheme();
  return (
    <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
      {children}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
});
