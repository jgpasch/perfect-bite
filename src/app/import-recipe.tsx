import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { getAccount } from '@/features/auth/account';
import { openList } from '@/features/lists/current-list';
import { groupListsByHousehold } from '@/features/lists/list-view';
import { getLaunchListId, listsWithCountsQuery } from '@/features/lists/lists';
import { setRecipeAddResult } from '@/features/lists/recipe-add-result';
import { notify } from '@/features/notifications/notifications';
import { importRecipe } from '@/features/recipes/import';
import { importedNotification, importFailedNotification } from '@/features/recipes/import-notifications';
import { importErrorMessage, urlFromText } from '@/features/recipes/import-sheet';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Add recipe from link…" (spec 4.10). From a list's menu (`list`) it imports into that list; from the
 * Recipes tab it asks for the list first, defaulting to the last opened one, then the default list. The
 * clipboard is read only when Paste is tapped, so iOS shows no paste prompt on open. On success the
 * sheet closes and the list shows "Added Chicken tikka masala · 12 items" with Undo and View recipe.
 * Closed while reading, the import carries on and its result comes as an in-app notification (spec 4.11);
 * a failed one's notification reopens the sheet with `to` (that list, picker still shown) and `url`.
 */
export default function ImportRecipeSheet() {
  const { list: fromList, to, url: retryUrl } = useLocalSearchParams<{ list?: string; to?: string; url?: string }>();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const userId = getAccount()?.userId ?? null;

  // A sheet is short-lived: read once rather than live.
  const [lists] = useState(() =>
    listsWithCountsQuery()
      .all()
      .filter((l) => l.archivedAt === null),
  );
  const [listId, setListId] = useState(
    () =>
      lists.find((l) => l.id === (fromList ?? to))?.id ?? (userId ? getLaunchListId(userId) : null) ?? lists[0]?.id ?? null,
  );
  const [text, setText] = useState(retryUrl ?? '');
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

  const paste = async () => {
    const pasted = await Clipboard.getStringAsync();
    if (!pasted) return;
    setText(urlFromText(pasted) ?? pasted.trim());
    setError(null);
  };

  const submit = async () => {
    if (!listId || working) return;
    const url = urlFromText(text);
    if (!url) {
      setError(importErrorMessage({ ok: false, error: 'failed', reason: 'invalid_url' }));
      return;
    }
    setError(null);
    setWorking(true);
    const result = await importRecipe({ url, listId });
    if (!result.ok) {
      if (open.current) {
        setWorking(false);
        setError(importErrorMessage(result));
      } else {
        notify({
          ...importFailedNotification(result, url),
          onPress: () => router.push({ pathname: '/import-recipe', params: { to: listId, url } }),
        });
      }
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
      const listName = lists.find((l) => l.id === result.listId)?.name ?? 'your list';
      notify({
        ...importedNotification(result, listName),
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

  if (!listId) return <Screen />;

  const groups = groupListsByHousehold(lists);

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

        {fromList
          ? null
          : groups.map((group) => (
              <View key={group.householdId} style={{ gap: spacing.sm }}>
                <Label>{groups.length > 1 ? `To · ${group.name}` : 'To'}</Label>
                <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
                  {group.lists.map((l) => (
                    <Pill key={l.id} label={l.name} selected={l.id === listId} disabled={working} onPress={() => setListId(l.id)} />
                  ))}
                </View>
              </View>
            ))}

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
          label={working ? 'Reading recipe…' : 'Add recipe'}
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
