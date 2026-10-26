import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, PrimaryButton, SoftDangerButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { SettingsRow } from '@/components/settings-group';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { getAccount } from '@/features/auth/account';
import { householdsQuery } from '@/features/households/households';
import { getDefaultListId, LAST_OPENED_LIST_KEY, listsWithCountsQuery } from '@/features/lists/lists';
import { notify } from '@/features/notifications/notifications';
import {
  dismissFailedImport,
  failedImportBanner,
  failedImportEntry,
  failedImportPageUris,
  failedImportRetryOn,
  getFailedImport,
  tryAgainOnLabel,
  updateFailedPhotoImport,
} from '@/features/recipes/failed-imports';
import { importRecipe, importRecipeFromPhotos } from '@/features/recipes/import';
import { importFailedNotification, importingNotification, importNotificationId } from '@/features/recipes/import-notifications';
import { useFeature } from '@/features/plans/features';
import { householdImportNote, importErrorMessage, urlFromText } from '@/features/recipes/import-sheet';
import { collectImportPhotos, photosFromParam } from '@/features/recipes/photo-import';
import { askForAnother, cameraDenied, chooseSource } from '@/features/recipes/photo-import-prompts';
import { photoImportFailure, postImportResult, retryFailedPhotoImport } from '@/features/recipes/photo-import-retry';
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
import { MAX_PHOTO_IMPORT_IMAGES } from '@/shared/schemas/recipe-photo-import';

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
 * a link, showing their thumbnails where the link field would be, with a note that the pages are
 * kept with the recipe; a failed photo import's notification opens its review sheet.
 *
 * With `failed` (a failed photo import's id: its notification, or tapping its pages on the imports
 * card), it's that import's review sheet (spec 4.10 board D): a `dangerSoft` banner saying when and
 * why it failed, its kept pages (or `photos`, from Use other photos) each with a remove button
 * while there's more than one and an Add page tile under three, "Kept on this phone for 30 days…",
 * the pickers set to where it was going, **Try again** (disabled as "Try again Nov 1" over the
 * monthly limit) and **Dismiss and delete photos**. Try again saves the pages and target to the row
 * first, so another failure keeps the edits; closing the sheet any other way leaves it as it was.
 */
export default function ImportRecipeSheet() {
  const params = useLocalSearchParams<{
    list?: string;
    household?: string;
    add?: string;
    to?: string;
    url?: string;
    photos?: string;
    failed?: string;
  }>();
  const fromList = params.list;
  const t = useT();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const userId = getAccount()?.userId ?? null;
  // The failed photo import under review; gone (imported, dismissed, pruned) leaves an empty sheet that closes.
  const [failed] = useState(() => {
    const row = params.failed ? getFailedImport(params.failed) : undefined;
    return row?.kind === 'photo' ? row : null;
  });
  const missing = params.failed !== undefined && failed === null;
  const [photos, setPhotos] = useState(
    () => photosFromParam(params.photos) ?? (failed ? failedImportPageUris(failed) : null),
  );

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
    failed
      ? failedImportEntry(failed, userId)
      : fromList
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
  // The Save to household's plan (spec 4.12): without recipe import, Save is disabled with a note.
  const canImport = useFeature('recipe_import', householdId ?? '');
  const notEntitledNote = householdImportNote(canImport, householdName);

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

  // Over the monthly limit, the same pages wait for the reset (board E).
  const retryOn = failed ? failedImportRetryOn(failed) : null;

  useEffect(() => {
    if (missing) router.back();
  }, [missing]);

  const submit = async () => {
    if (!householdId || !canImport || started.current) return;
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
    if (failed && photos) {
      if (!userId || retryOn) return;
      // Saved first, so another failure keeps the edits.
      const saved = updateFailedPhotoImport(failed.id, { pages: photos, householdId, listId: addToList ? listId : null });
      if (!saved) {
        setError(importErrorMessage({ ok: false, error: 'failed' }, 'photo'));
        return;
      }
      started.current = true;
      router.back();
      await retryFailedPhotoImport(failed.id, userId);
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
    if (photos) {
      postImportResult(id, result, householdName, photoImportFailure);
      return;
    }
    // A failure reopens with the same choices: household, switch, list and link.
    const link = url!;
    const retry = { household: householdId, add: addToList ? '1' : '0', ...(addToList && listId ? { to: listId } : {}), url: link };
    postImportResult(id, result, householdName, (error) => ({
      ...importFailedNotification(error, link),
      onPress: () => router.push({ pathname: '/import-recipe', params: retry }),
    }));
  };

  const removePage = (index: number) => setPhotos((pages) => (pages && pages.length > 1 ? pages.filter((_, i) => i !== index) : pages));
  const addPage = () =>
    chooseSource(async (from) => {
      try {
        const room = MAX_PHOTO_IMPORT_IMAGES - (photos?.length ?? 0);
        const more = await collectImportPhotos(from, { askForAnother, onDenied: cameraDenied, limit: room });
        if (more) setPhotos((pages) => [...(pages ?? []), ...more].slice(0, MAX_PHOTO_IMPORT_IMAGES));
      } catch (e) {
        console.warn('[photo import] pick failed', e);
      }
    });
  const dismiss = () => {
    if (!failed) return;
    dismissFailedImport(failed.id);
    router.back();
  };

  if (!householdId || missing) return <Screen />;

  const pagesBlock = photos ? (
    <>
      {failed ? null : <Label>{t('recipes.import.pages')}</Label>}
      <PageThumbnails
        uris={photos}
        onRemove={failed ? removePage : undefined}
        onAdd={failed && photos.length < MAX_PHOTO_IMPORT_IMAGES ? addPage : undefined}
      />
      <PagesNote text={t(failed ? 'recipes.import.keptOnPhone' : 'recipes.import.pagesKept')} />
    </>
  ) : null;

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

        {failed ? (
          <>
            <FailedBanner text={failedImportBanner(failed)} />
            {pagesBlock}
          </>
        ) : null}

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

        {photos ? (
          failed ? null : pagesBlock
        ) : (
          <>
          <Label>{t('recipes.import.link')}</Label>
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
          </>
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
          gap: spacing.sm,
        }}>
        <PrimaryButton
          label={
            failed
              ? retryOn
                ? tryAgainOnLabel(retryOn)
                : addToList && listName
                  ? t('recipes.import.tryAgainAndAdd', { name: listName })
                  : t('recipes.import.tryAgain')
              : saveButtonTitle(addToList, listName)
          }
          icon={failed ? 'arrow.clockwise' : photos ? 'camera' : 'link'}
          disabled={!canImport || retryOn !== null || (!photos && text.trim() === '')}
          accessibilityHint={notEntitledNote ?? undefined}
          onPress={submit}
        />
        {notEntitledNote ? (
          <ThemedText variant="footnote" color="inkSecondary" style={styles.center}>
            {notEntitledNote}
          </ThemedText>
        ) : null}
        {failed ? <SoftDangerButton label={t('recipes.import.dismissAndDelete')} onPress={dismiss} /> : null}
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

/**
 * The pages to import, in order, as 3:4 thumbnails. VoiceOver: "Page 1 of 2". In the review sheet
 * (`onRemove`), each has a round remove button ("Remove page 1 of 2") while there's more than one,
 * and `onAdd` adds a dashed Add page tile.
 */
function PageThumbnails({ uris, onRemove, onAdd }: { uris: string[]; onRemove?: (index: number) => void; onAdd?: () => void }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const removable = onRemove && uris.length > 1;
  const removeSlop = (sizes.minTapTarget - sizes.removeButton) / 2;
  return (
    <View style={[styles.row, { gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: onRemove ? spacing.sm : 0 }]}>
      {uris.map((uri, i) => {
        const label = t('recipes.import.page', { index: i + 1, count: uris.length });
        return (
          <View key={uri} style={{ width: sizes.importPageThumb }}>
            <View
              testID="import-page"
              accessible
              accessibilityRole="image"
              accessibilityLabel={label}
              style={[styles.page, { borderRadius: rounded.md, backgroundColor: colors.surfaceMuted }]}>
              <Image source={uri} contentFit="cover" accessible={false} style={StyleSheet.absoluteFill} />
            </View>
            {removable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('recipes.import.removePage', { index: i + 1, count: uris.length })}
                hitSlop={removeSlop}
                onPress={() => onRemove(i)}
                style={({ pressed }) => [
                  styles.removePage,
                  {
                    top: -spacing.sm,
                    right: -spacing.sm,
                    width: sizes.removeButton,
                    height: sizes.removeButton,
                    borderRadius: sizes.removeButton / 2,
                    borderWidth: sizes.focusRing,
                    borderColor: colors.background,
                    backgroundColor: colors.ink,
                    opacity: pressed ? opacity.pressed : 1,
                  },
                ]}>
                <Icon name="xmark" tint={colors.background} size={sizes.iconSmall} weight="bold" />
              </Pressable>
            ) : null}
          </View>
        );
      })}
      {onAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('recipes.import.addPage')}
          onPress={onAdd}
          style={({ pressed }) => [
            styles.page,
            styles.addPage,
            {
              width: sizes.importPageThumb,
              gap: spacing.xs,
              borderRadius: rounded.md,
              borderWidth: sizes.focusRing,
              borderColor: colors.controlBorder,
              opacity: pressed ? opacity.pressed : 1,
            },
          ]}>
          <Icon name="plus" color="inkSecondary" />
          <ThemedText variant="caption" color="inkSecondary">
            {t('recipes.import.addPage')}
          </ThemedText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Under the thumbnails: the pages stay with the recipe, or (review sheet) on this phone for 30 days (spec 4.10). */
function PagesNote({ text }: { text: string }) {
  const { spacing, sizes } = useTheme();
  return (
    <View style={[styles.note, { gap: spacing.sm, paddingHorizontal: spacing.lg + spacing.xs }]}>
      <Icon name="doc.text" color="inkSecondary" size={sizes.iconSmall} style={{ marginTop: spacing.xxs }} />
      <ThemedText variant="footnote" color="inkSecondary" style={styles.flex}>
        {text}
      </ThemedText>
    </View>
  );
}

/** The review sheet's banner (board D): when it failed and why, in `danger` on `dangerSoft`. */
function FailedBanner({ text }: { text: string }) {
  const { colors, spacing, sizes, rounded } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="text"
      style={[
        styles.note,
        {
          gap: spacing.sm,
          marginHorizontal: spacing.lg,
          padding: spacing.md,
          borderRadius: rounded.md,
          backgroundColor: colors.dangerSoft,
        },
      ]}>
      <Icon name="exclamationmark.circle" color="danger" size={sizes.iconSmall} weight="semibold" style={{ marginTop: spacing.xxs }} />
      <ThemedText variant="callout" color="danger" style={styles.flex}>
        {text}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  addPage: { alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed' },
  center: { textAlign: 'center' },
  removePage: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  note: { flexDirection: 'row', alignItems: 'flex-start' },
  page: { aspectRatio: 3 / 4, overflow: 'hidden', borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
});
