import { Link, router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { prominentButtonTint } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { Button, PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { IconTile } from '@/components/icon-tile';
import { ThemedText } from '@/components/themed-text';
import { Toast, type ToastAction } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { failedImports } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { recipeHue } from '@/domain/aisle-color';
import { getList } from '@/features/lists/lists';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { importedOnRecipesToast, sharedImportsToast } from '@/features/recipes/import-sheet';
import { ImportsCard } from '@/features/recipes/imports-card';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { groupRecipesByHousehold, ingredientCountLabel, onListByRecipe, recipeCardLabel } from '@/features/recipes/recipe-view';
import {
  deleteRecipe,
  RECIPES_TAB_TABLES,
  recipesOnListsQuery,
  recipesQuery,
  type RecipeSummary,
} from '@/features/recipes/recipes';
import { onShareImports } from '@/features/recipes/share-drain';
import { importsCardHeading, useShareQueueStatus } from '@/features/recipes/share-queue-status';
import { useTheme } from '@/hooks/use-theme';

/** Recipes tab (spec 4.5, board 05): a card per recipe under each household's name. */
export default function RecipesScreen() {
  const { spacing, scheme, colors } = useTheme();
  const { data } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: onLists } = useLiveQueryOn(recipesOnListsQuery(), RECIPES_TAB_TABLES);
  const { data: failed } = useLiveQueryOn(failedImportsQuery(), [failedImports]);
  const queue = useShareQueueStatus();
  const showImports = importsCardHeading(failed.length, queue) !== null;
  const [toast, setToast] = useState<{
    key: string;
    message: string;
    emphasis?: string;
    actions: ToastAction[];
    /** The recipe the toast is about, outlined while it shows. */
    recipeId?: string;
  } | null>(
    null,
  );
  const dismissToast = useCallback(() => setToast(null), []);
  const groups = useMemo(() => groupRecipesByHousehold(data), [data]);
  const onList = useMemo(() => onListByRecipe(onLists), [onLists]);

  const create = () => promptRecipeName(null, '', (id) => router.push({ pathname: '/recipe/[id]', params: { id } }));
  // Spec 4.10: the sheet asks for the list.
  const importFromLink = () => router.push('/import-recipe');
  const empty = (
    <EmptyState
      message="No recipes yet."
      action={
        <View style={{ gap: spacing.sm }}>
          <PrimaryButton label="New recipe" onPress={create} />
          <Button label="Import from link" variant="plain" onPress={importFromLink} />
        </View>
      }
    />
  );

  // Recipes shared to the extension (spec 4.10), when the drain finishes while this tab shows.
  useFocusEffect(
    useCallback(
      () =>
        onShareImports((imported) => {
          if (imported.length > 1) {
            setToast({ key: `shared-${Date.now()}`, ...sharedImportsToast(imported.length), actions: [] });
            return;
          }
          const [result] = imported;
          setToast({
            key: `shared-${result.recipeId}-${Date.now()}`,
            recipeId: result.recipeId,
            ...importedOnRecipesToast(result.recipeName, result.added, getList(result.listId)?.name ?? null),
            actions: [
              { label: 'Undo', onPress: () => (result.undo(), setToast(null)) },
              {
                label: 'Open list',
                onPress: () => (setToast(null), router.push({ pathname: '/list/[id]', params: { id: result.listId } })),
              },
            ],
          });
        }),
      [],
    ),
  );

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="link" accessibilityLabel="Import from link" onPress={importFromLink} />
        <Stack.Toolbar.Button
          icon="plus"
          variant="prominent"
          tintColor={prominentButtonTint(scheme, colors)}
          accessibilityLabel="New recipe"
          onPress={create}
        />
      </Stack.Toolbar>
      {data.length === 0 && !showImports ? (
        empty
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={[styles.grow, { paddingBottom: spacing.xl }]}>
          {/* Spec 4.10: shares importing, waiting or that won't import, at the top. */}
          {showImports ? (
            <View style={{ paddingTop: spacing.xs }}>
              <ImportsCard failed={failed} queue={queue} />
            </View>
          ) : null}
          {data.length === 0 ? empty : null}
          {groups.map((group, i) => (
            <View key={group.householdId}>
              <ThemedText
                variant="sectionLabel"
                color="inkSecondary"
                accessibilityRole="header"
                style={{
                  paddingHorizontal: spacing.lg + spacing.xs,
                  paddingTop: i === 0 ? spacing.xs : spacing.lg + spacing.xxs,
                  paddingBottom: spacing.sm,
                }}>
                {group.name}
              </ThemedText>
              <View style={{ gap: spacing.sm + spacing.xxs, paddingHorizontal: spacing.lg }}>
                {group.recipes.map((r) => (
                  <RecipeCard
                    key={r.id}
                    recipe={r}
                    onList={onList.get(r.id) ?? null}
                    highlighted={toast?.recipeId === r.id}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
      {toast ? (
        // Above the tab bar: the bottom safe area here includes it.
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

function RecipeCard({
  recipe,
  onList,
  highlighted,
}: {
  recipe: RecipeSummary;
  onList: string | null;
  /** Just imported: outlined in `primary` while the toast shows. */
  highlighted: boolean;
}) {
  const { colors, spacing, sizes, rounded } = useTheme();

  const confirmDelete = () =>
    Alert.alert(`Delete “${recipe.name}”?`, 'Items already on your lists stay there.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteRecipe(recipe.id) },
    ]);

  return (
    <Link href={{ pathname: '/recipe/[id]', params: { id: recipe.id } }} asChild>
      <Link.Trigger>
        <Pressable accessibilityRole="button" accessibilityLabel={recipeCardLabel(recipe.name, recipe.ingredientCount, onList)}>
          {/* Layout lives on a View: Link's trigger replaces the Pressable's style. */}
          <View
            style={[
              styles.card,
              {
                padding: spacing.md + spacing.xxs,
                gap: spacing.md + spacing.xxs,
                borderRadius: rounded.card,
                backgroundColor: colors.surface,
                borderWidth: sizes.focusRing,
                borderColor: highlighted ? colors.primary : 'transparent',
              },
            ]}>
            <IconTile hue={recipeHue(recipe.id)} name="fork.knife" size={sizes.recipeTile} />
            <View style={styles.flex}>
              <ThemedText variant="headline" numberOfLines={2}>
                {recipe.name}
              </ThemedText>
              <ThemedText variant="footnote" color="inkSecondary">
                {ingredientCountLabel(recipe.ingredientCount)}
              </ThemedText>
            </View>
            {onList ? (
              // Badge pins itself to the top; the wrapper centres it in the row.
              <View>
                <Badge label={`On ${onList}`} />
              </View>
            ) : null}
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction title="Rename" icon="pencil" onPress={() => promptRecipeName(recipe.id, recipe.name)} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={confirmDelete} />
      </Link.Menu>
    </Link>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  card: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
});
