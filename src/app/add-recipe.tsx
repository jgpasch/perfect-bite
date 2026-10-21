import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { useAnyHouseholdFeature } from '@/features/plans/features';
import { NAME_IS_LINK_FOOTNOTE, nameAction } from '@/features/recipes/add-recipe';
import { urlFromText } from '@/features/recipes/import-sheet';
import { collectImportPhotos, photosParam } from '@/features/recipes/photo-import';
import { askForAnother, cameraDenied, chooseSource } from '@/features/recipes/photo-import-prompts';
import type { PhotoSource } from '@/features/recipes/photo-upload';
import { createRecipe } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * "Add recipe" (spec 4.5, boards B1 and B2), the Recipes tab's one way to add: one field and one
 * button. A name makes a blank recipe and opens it. With `recipe_import` (spec 4.12) the field also
 * takes a link: the button reads **Import recipe** and hands it to the import sheet (spec 4.10), which
 * replaces this one; without import a link is refused. With import, a **Paste link** chip sits above
 * the field only while the clipboard holds a link; asking that shows no paste prompt, only reading it
 * (on tap) does. With import too, an "or" divider and **From photo…** pick up to three
 * pages (Take photo or Choose from library) and hand them to the import sheet the same way.
 */
export default function AddRecipeSheet() {
  const t = useT();
  const { colors, spacing, sizes } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // Any of the user's households (spec 4.12); the import sheet checks the one it saves to.
  const canImport = useAnyHouseholdFeature('recipe_import');
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState('');
  const [clipboardHasLink, setClipboardHasLink] = useState(false);
  const action = nameAction(name, canImport);

  useEffect(() => {
    if (!canImport) return;
    let live = true;
    Clipboard.hasUrlAsync().then(
      (has) => live && setClipboardHasLink(has),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [canImport]);

  const submit = () => {
    if (action.kind === 'create') {
      const id = createRecipe(action.name);
      router.back();
      router.push({ pathname: '/recipe/[id]', params: { id } });
    } else if (action.kind === 'import') {
      router.replace({ pathname: '/import-recipe', params: { url: action.url } });
    }
  };

  const pasteLink = async () => {
    const pasted = await Clipboard.getStringAsync();
    if (!pasted) return;
    setName(urlFromText(pasted) ?? pasted.trim());
    setClipboardHasLink(false);
  };

  const importPhotos = async (from: PhotoSource) => {
    if (picking) return;
    setPicking(true);
    try {
      const photos = await collectImportPhotos(from, { askForAnother, onDenied: cameraDenied });
      if (photos) router.replace({ pathname: '/import-recipe', params: { photos: photosParam(photos) } });
    } catch (e) {
      console.warn('[photo import] pick failed', e);
    } finally {
      setPicking(false);
    }
  };
  const fromPhoto = () => chooseSource((from) => void importPhotos(from));

  const inset = { paddingHorizontal: spacing.lg + spacing.xs };
  const isLink = action.kind === 'import';
  const hairline = [styles.flex, { height: StyleSheet.hairlineWidth, backgroundColor: colors.border }];

  return (
    // Sized by its content (detent `fitToContents`), so no flex. A plain View isn't inset like a
    // ScrollView, so it clears the sheet's transparent header (the Cancel toolbar) by hand.
    <View
      collapsable={false}
      style={{
        backgroundColor: colors.background,
        gap: spacing.md,
        paddingTop: headerHeight + spacing.xs,
        paddingBottom: Math.max(insets.bottom, spacing.lg),
      }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ThemedText variant="sheetTitle" accessibilityRole="header" style={inset}>
        {t('recipes.add.title')}
      </ThemedText>

      <View style={{ gap: spacing.sm }}>
        {canImport && clipboardHasLink ? (
          <View style={[styles.start, { paddingHorizontal: spacing.lg }]}>
            <Pill testID="paste-link" label={t('recipes.add.pasteLink')} icon="doc.on.clipboard" soft onPress={pasteLink} />
          </View>
        ) : null}
        <Card>
          <View style={[styles.row, { paddingHorizontal: spacing.lg, gap: spacing.sm }]}>
            {isLink ? <Icon testID="link-glyph" name="link" color="inkSecondary" size={sizes.iconSmall} /> : null}
            <TextField
              value={name}
              onChangeText={setName}
              placeholder={t(canImport ? 'recipes.add.nameOrLink' : 'recipes.add.name')}
              accessibilityLabel={t(canImport ? 'recipes.add.nameOrLinkLabel' : 'recipes.add.name')}
              autoCapitalize={isLink ? 'none' : 'words'}
              autoCorrect={!isLink}
              autoFocus
              returnKeyType={isLink ? 'go' : 'done'}
              onSubmitEditing={submit}
              style={[styles.flex, { borderWidth: 0, backgroundColor: colors.surface, paddingLeft: 0 }]}
            />
          </View>
        </Card>
        {action.kind === 'refuse' ? (
          <ThemedText variant="footnote" color="inkSecondary" accessibilityLiveRegion="polite" style={inset}>
            {NAME_IS_LINK_FOOTNOTE}
          </ThemedText>
        ) : isLink ? (
          <ThemedText variant="footnote" color="inkSecondary" style={inset}>
            {t('recipes.add.linkNote')}
          </ThemedText>
        ) : null}
        <View style={{ paddingHorizontal: spacing.lg }}>
          <PrimaryButton
            label={t(isLink ? 'recipes.add.importRecipe' : 'recipes.add.create')}
            icon={isLink ? 'link' : undefined}
            disabled={action.kind !== 'create' && !isLink}
            onPress={submit}
          />
        </View>
      </View>

      {canImport ? (
        <>
          <View style={[styles.row, inset, { gap: spacing.md }]}>
            <View style={hairline} />
            <ThemedText variant="footnote" color="inkTertiary">
              {t('recipes.add.or')}
            </ThemedText>
            <View style={hairline} />
          </View>
          <Card>
            <FromPhotoRow disabled={picking} onPress={fromPhoto} />
          </Card>
        </>
      ) : null}
    </View>
  );
}

/**
 * **From photo…** in its own card under the "or" divider (board B1): a `primarySoft` well with a
 * camera, the label over "A cookbook page or a screenshot", and a chevron; one button, VoiceOver
 * "From photo, button".
 */
function FromPhotoRow({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      testID="from-photo"
      accessibilityRole="button"
      accessibilityLabel={t('recipes.add.fromPhotoLabel')}
      accessibilityHint={t('recipes.add.fromPhotoDetail')}
      accessibilityState={disabled ? { disabled } : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.minTapTarget,
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}>
      <View
        style={[
          styles.well,
          { width: sizes.iconWell, height: sizes.iconWell, borderRadius: rounded.sm, backgroundColor: colors.primarySoft },
        ]}>
        <Icon name="camera" color="primary" size={sizes.iconSmall} />
      </View>
      <View style={styles.flex}>
        <ThemedText variant="body">{t('recipes.add.fromPhoto')}</ThemedText>
        <ThemedText variant="footnote" color="inkSecondary">
          {t('recipes.add.fromPhotoDetail')}
        </ThemedText>
      </View>
      <Icon name="chevron.right" color="inkTertiary" size={sizes.iconSmall} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  start: { alignItems: 'flex-start' },
  well: { alignItems: 'center', justifyContent: 'center' },
});
