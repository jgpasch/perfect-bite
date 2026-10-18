import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
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
import { importRecipe, importRecipeFromPhotos } from '@/features/recipes/import';
import {
  importedNotification,
  importFailedNotification,
  importingNotification,
  importNotificationId,
  photoImportFailedNotification,
  savedNotification,
} from '@/features/recipes/import-notifications';
import { importErrorMessage, urlFromText } from '@/features/recipes/import-sheet';
import { photosFromParam } from '@/features/recipes/photo-import';
import {
  defaultListIdIn,
  householdLists,
  IMPORT_ADD_TO_LIST_KEY,
  initialSaveChoice,
  NO_LISTS_IN_HOUSEHOLD,
  saveButtonTitle,
  type SheetEntry,
} from '@/features/recipes/save-choice';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * "Add recipe from link…" (spec 4.10): a **Save to** household picker (hidden with one household) and
 * an **Also add ingredients to a list** switch that shows that household's list picker. From the
 * Recipes tab the household follows the default rule and the switch starts as last left on this
 * device; from a list's menu (`list`) it's that list's household with the switch on and that list
 * chosen. The clipboard is read only when Paste is tapped, so iOS shows no paste prompt on open. Save
 * keeps a link that isn't one, or being offline, inline with the sheet open; otherwise it starts the
 * import, closes the sheet and posts "Importing your recipe" (spec 4.11). The result replaces that
 * notification: "Recipe added" (tapping opens the list with its toast), "Recipe saved" (opens the
 * recipe) or "Couldn't import recipe", which reopens the sheet with the same `household`, `add`, `to`
 * (list) and `url`. With `photos` (from Add recipe's From photo…), it imports those pages instead of
 * a link, showing their thumbnails where the link field would be; a failed photo import's
 * notification opens Add recipe, since the photos go with the sheet.
 */
export default function ImportRecipeSheet() {
  const params = useLocalSearchParams<{
    list?: string;
    household?: string;
    add?: string;
    to?: string;
    url?: string;
    photos?: string;
  }>();
  const fromList = params.list;
  const [photos] = useState(() => photosFromParam(params.photos));
  const t = useT();
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
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();
  // Save starts one import; a second tap before the sheet goes does nothing.
  const started = useRef(false);

  const { householdId, listId } = choice;
  const lists = householdLists(choices.lists, householdId);
  // The switch can't be on in a household with no lists: that saves the recipe only.
  const addToList = choice.addToList && listId !== null;
  const listName = lists.find((l) => l.id === listId)?.name ?? null;
  const householdName = choices.households.find((h) => h.id === householdId)?.name ?? t('recipes.import.yourRecipes');

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

  const submit = async () => {
    if (!householdId || started.current) return;
    // What fails at once stays inline, with the sheet open.
    const url = photos ? null : urlFromText(text);
    if (!photos && !url) {
      setError(importErrorMessage({ ok: false, error: 'failed', reason: 'invalid_url' }));
      return;
    }
    if (!online) {
      setError(importErrorMessage({ ok: false, error: 'offline' }));
      return;
    }
    started.current = true;
    const id = importNotificationId();
    const target = addToList && listId ? { listId } : { householdId };
    const importing = photos
      ? importRecipeFromPhotos({ ...target, photoUris: photos })
      : importRecipe({ ...target, url: url! });
    router.back();
    notify(importingNotification(id));
    const result = await importing;
    // The result replaces the Importing banner if it's still up, and queues after it otherwise.
    if (!result.ok) {
      if (photos) {
        notify({ ...photoImportFailedNotification(result), id, onPress: () => router.push('/add-recipe') });
      } else {
        // Reopens with the same choices: household, switch, list and link.
        const link = url!;
        const retry = { household: householdId, add: addToList ? '1' : '0', ...(addToList && listId ? { to: listId } : {}), url: link };
        notify({
          ...importFailedNotification(result, link),
          id,
          onPress: () => router.push({ pathname: '/import-recipe', params: retry }),
        });
      }
      return;
    }
    const addedTo = result.listId;
    if (addedTo === null) {
      notify({
        ...savedNotification(result, householdName),
        id,
        onPress: () => router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } }),
      });
      return;
    }
    const name = choices.lists.find((l) => l.id === addedTo)?.name ?? t('recipes.import.yourList');
    notify({
      ...importedNotification(result, name),
      id,
      // Its toast (Undo, View recipe) shows on the list, which may be the one showing already.
      onPress: () => {
        setRecipeAddResult({
          kind: 'imported',
          listId: addedTo,
          recipeId: result.recipeId,
          recipeName: result.recipeName,
          count: result.added,
          undo: result.undo,
        });
        openList(addedTo);
      },
    });
  };

  if (!householdId) return <Screen />;

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
        <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          {t(photos ? 'recipes.import.photoTitle' : 'recipes.import.title')}
        </ThemedText>

        {choices.households.length > 1 ? (
          <View style={{ gap: spacing.sm }}>
            <Label>{t('recipes.import.saveTo')}</Label>
            <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
              {choices.households.map((h) => (
                <Pill
                  key={h.id}
                  label={h.name}
                  selected={h.id === householdId}
                  onPress={() => chooseHousehold(h.id)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Card>
          <SettingsRow
            label={t('recipes.import.alsoAdd')}
            detail={lists.length === 0 ? NO_LISTS_IN_HOUSEHOLD : undefined}
            last
            trailing={
              <Switch
                value={addToList}
                onValueChange={toggleAddToList}
                disabled={lists.length === 0}
                trackColor={{ true: colors.primary }}
                accessibilityLabel={t('recipes.import.alsoAdd')}
                accessibilityHint={lists.length === 0 ? NO_LISTS_IN_HOUSEHOLD : t('recipes.import.alsoAddHint')}
              />
            }
          />
        </Card>

        {addToList ? (
          <View style={{ gap: spacing.sm }}>
            <Label>{t('recipes.import.list')}</Label>
            <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
              {lists.map((l) => (
                <Pill
                  key={l.id}
                  label={l.name}
                  selected={l.id === listId}
                  onPress={() => setChoice((c) => ({ ...c, listId: l.id }))}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Label>{t(photos ? 'recipes.import.pages' : 'recipes.import.link')}</Label>
        {photos ? (
          <PageThumbnails uris={photos} />
        ) : (
          <Card>
            <View style={[styles.row, { paddingLeft: spacing.lg, paddingRight: spacing.sm, gap: spacing.sm }]}>
              <TextField
                value={text}
                onChangeText={(value) => (setText(value), setError(null))}
                placeholder={t('recipes.add.linkPlaceholder')}
                accessibilityLabel={t('recipes.add.link')}
                keyboardType="url"
                textContentType="URL"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={submit}
                style={[styles.flex, { borderWidth: 0, backgroundColor: colors.surface, paddingLeft: 0 }]}
              />
              <Button label={t('recipes.add.paste')} variant="plain" onPress={paste} />
            </View>
          </Card>
        )}

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
          label={saveButtonTitle(addToList, listName)}
          icon={photos ? 'camera' : 'link'}
          disabled={!photos && text.trim() === ''}
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

/** The pages to import, in order, as 3:4 thumbnails. VoiceOver: "Page 1 of 2". */
function PageThumbnails({ uris }: { uris: string[] }) {
  const t = useT();
  const { colors, spacing, sizes, rounded } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
      {uris.map((uri, i) => (
        <View
          key={uri}
          testID="import-page"
          accessible
          accessibilityRole="image"
          accessibilityLabel={t('recipes.import.page', { index: i + 1, count: uris.length })}
          style={[
            styles.page,
            { width: sizes.importPageThumb, borderRadius: rounded.md, backgroundColor: colors.surfaceMuted },
          ]}>
          <Image source={uri} contentFit="cover" accessible={false} style={StyleSheet.absoluteFill} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { aspectRatio: 3 / 4, overflow: 'hidden', borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
});
