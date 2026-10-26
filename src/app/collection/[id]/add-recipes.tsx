import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useLiveQueryOn } from '@/db/live-query';
import { toggled } from '@/features/recipes/add-sheet';
import { addRecipesToCollection, useCollection } from '@/features/recipes/collections';
import { selectLabel } from '@/features/recipes/recipe-card';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { NO_RECIPES_MATCH, searchRecipes } from '@/features/recipes/recipe-search';
import { sortRecipesByName } from '@/features/recipes/recipe-sort';
import { recipeMetaLine } from '@/features/recipes/recipe-view';
import { recipeIngredientNamesQuery, RECIPES_TAB_TABLES, recipesQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * A collection's Add recipes (board D): the household's recipes A–Z under a search field, each ticking with a
 * tap; the ones already in the collection are shown ticked and disabled, "Already in Mom's cookbook". With any
 * ticked, the add bar's **Add 3 to Mom's cookbook** adds them in one go and closes. Ticks outlast the search.
 */
export default function AddRecipesSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  const insets = useSafeAreaInsets();
  const found = useCollection(id);
  const { data } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: ingredientNames } = useLiveQueryOn(recipeIngredientNamesQuery(), RECIPES_TAB_TABLES);
  const [query, setQuery] = useState('');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());

  const householdId = found?.collection.householdId;
  const own = useMemo(() => sortRecipesByName(data.filter((r) => r.householdId === householdId)), [data, householdId]);
  const shown = useMemo(() => searchRecipes(own, ingredientNames, query), [own, ingredientNames, query]);

  if (!found) return <Screen />;
  const { collection, recipeIds: inIt } = found;
  const adding = [...ticked].filter((r) => !inIt.has(r) && own.some((o) => o.id === r));
  const add = () => {
    addRecipesToCollection(collection.id, adding);
    router.back();
  };

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
        <View style={{ gap: spacing.xs, paddingHorizontal: spacing.lg + spacing.xs }}>
          <ThemedText variant="title" accessibilityRole="header">
            {t('recipes.collections.addRecipes')}
          </ThemedText>
          <ThemedText variant="subhead" color="inkSecondary" numberOfLines={1}>
            {collection.name}
          </ThemedText>
        </View>
        {own.length > 0 ? (
          <View style={{ paddingHorizontal: spacing.lg }}>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder={t('recipes.collections.searchRecipes')}
              accessibilityLabel={t('recipes.collections.searchRecipes')}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>
        ) : null}
        {shown.length > 0 ? (
          <Card>
            {shown.map(({ recipe: r }, i) => {
              const already = inIt.has(r.id);
              const on = already || ticked.has(r.id);
              const line = already ? t('recipes.collections.alreadyIn', { name: collection.name }) : recipeMetaLine(r);
              return (
                <Pressable
                  key={r.id}
                  testID="add-recipes-row"
                  accessibilityRole="button"
                  accessibilityLabel={[selectLabel(r.name, on && !already), line].filter(Boolean).join(', ')}
                  accessibilityState={{ selected: on, disabled: already }}
                  disabled={already}
                  onPress={() => setTicked((current) => toggled(current, r.id))}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      minHeight: sizes.recipeTile + spacing.md * 2,
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.md,
                      gap: spacing.md,
                      borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                      backgroundColor: on && !already ? colors.primarySoft : undefined,
                      opacity: already ? opacity.disabled : pressed ? opacity.pressed : 1,
                    },
                  ]}>
                  <CheckCircle checked={on} />
                  <RecipePhotoTile recipeId={r.id} imageUrl={r.imageUrl} photoPath={r.photoPath} />
                  <View style={styles.flex}>
                    <ThemedText variant="headline" numberOfLines={1}>
                      {r.name}
                    </ThemedText>
                    {line ? (
                      <ThemedText variant="footnote" color="inkSecondary">
                        {line}
                      </ThemedText>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </Card>
        ) : (
          <ThemedText variant="callout" color="inkSecondary" style={[styles.center, { paddingHorizontal: spacing.lg }]}>
            {own.length === 0 ? t('recipes.collections.noHouseholdRecipes') : NO_RECIPES_MATCH}
          </ThemedText>
        )}
      </ScrollView>
      {adding.length > 0 ? (
        <View
          testID="add-recipes-bar"
          style={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
            paddingBottom: Math.max(insets.bottom, spacing.lg),
            backgroundColor: colors.background,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
          }}>
          <PrimaryButton
            testID="add-recipes-add"
            label={t('recipes.collections.addCount', { count: adding.length, name: collection.name })}
            onPress={add}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { textAlign: 'center' },
});
