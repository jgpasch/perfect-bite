import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { useFeature } from '@/features/plans/features';
import { NAME_IS_LINK_FOOTNOTE, nameAction } from '@/features/recipes/add-recipe';
import { urlFromText } from '@/features/recipes/import-sheet';
import { createRecipe } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * "Add recipe" (spec 4.5), the Recipes tab's one way to add: name a blank recipe, or (with
 * `recipe_import`, spec 4.12) paste a link to import it. A link typed as the name imports instead of
 * naming a recipe after it; without import it's refused. Import hands off to the import sheet
 * (spec 4.10), which replaces this one. `focus=link` starts in the link field. Paste shows only when
 * the clipboard holds a link; asking that shows no paste prompt, only reading it does.
 */
export default function AddRecipeSheet() {
  const params = useLocalSearchParams<{ focus?: string }>();
  const t = useT();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const canImport = useFeature('recipe_import');
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
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

  const openImport = (url: string) => router.replace({ pathname: '/import-recipe', params: { url } });

  const submitName = () => {
    if (action.kind === 'create') {
      const id = createRecipe(action.name);
      router.back();
      router.push({ pathname: '/recipe/[id]', params: { id } });
    } else if (action.kind === 'import') {
      openImport(action.url);
    }
  };

  const submitLink = () => {
    const text = link.trim();
    if (text) openImport(urlFromText(text) ?? text);
  };

  const paste = async () => {
    const pasted = await Clipboard.getStringAsync();
    if (pasted) setLink(urlFromText(pasted) ?? pasted.trim());
  };

  const inset = { paddingHorizontal: spacing.lg + spacing.xs };
  const field = [styles.flex, { borderWidth: 0, backgroundColor: colors.surface, paddingLeft: 0 }];

  return (
    // Sized by its content (detent `fitToContents`), so no flex.
    <View
      collapsable={false}
      style={{
        backgroundColor: colors.background,
        gap: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: Math.max(insets.bottom, spacing.lg),
      }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ThemedText variant="sheetTitle" accessibilityRole="header" style={inset}>
        {t('recipes.add.title')}
      </ThemedText>

      <View style={{ gap: spacing.sm }}>
        <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={inset}>
          {t('recipes.add.newRecipe')}
        </ThemedText>
        <Card>
          <View style={[styles.row, { paddingHorizontal: spacing.lg }]}>
            <TextField
              value={name}
              onChangeText={setName}
              placeholder={t('recipes.add.name')}
              accessibilityLabel={t('recipes.add.name')}
              autoCapitalize="words"
              autoFocus={!(canImport && params.focus === 'link')}
              returnKeyType={action.kind === 'import' ? 'go' : 'done'}
              onSubmitEditing={submitName}
              style={field}
            />
          </View>
        </Card>
        {action.kind === 'refuse' ? (
          <ThemedText variant="footnote" color="inkSecondary" accessibilityLiveRegion="polite" style={inset}>
            {NAME_IS_LINK_FOOTNOTE}
          </ThemedText>
        ) : null}
        <View style={{ paddingHorizontal: spacing.lg }}>
          <PrimaryButton
            label={t(action.kind === 'import' ? 'recipes.add.importRecipe' : 'recipes.add.create')}
            icon={action.kind === 'import' ? 'link' : undefined}
            disabled={action.kind !== 'create' && action.kind !== 'import'}
            onPress={submitName}
          />
        </View>
      </View>

      {canImport ? (
        <View style={{ gap: spacing.sm }}>
          <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={inset}>
            {t('recipes.add.orImport')}
          </ThemedText>
          <Card>
            <View style={[styles.row, { paddingLeft: spacing.lg, paddingRight: spacing.sm, gap: spacing.sm }]}>
              <TextField
                value={link}
                onChangeText={setLink}
                placeholder={t('recipes.add.linkPlaceholder')}
                accessibilityLabel={t('recipes.add.link')}
                keyboardType="url"
                textContentType="URL"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus={params.focus === 'link'}
                returnKeyType="go"
                onSubmitEditing={submitLink}
                style={field}
              />
              {clipboardHasLink ? <Button label={t('recipes.add.paste')} variant="plain" onPress={paste} /> : null}
            </View>
          </Card>
          <View style={{ paddingHorizontal: spacing.lg }}>
            <Button label={t('recipes.add.import')} icon="link" disabled={link.trim() === ''} onPress={submitLink} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
