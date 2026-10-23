import { Host, Menu, RNHostView, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hueHeaderBand } from '@/components/appearance';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { MealHues } from '@/constants/theme';
import { groupWeek, weekEntriesQuery } from '@/features/meal-plan/queries';
import {
  promptNote,
  type QuickChip,
  quickChipOn,
  recipeAddedLabel,
  type SlotSheetSort,
  slotSheetRecipes,
  toggleQuickChip,
} from '@/features/meal-plan/slot-actions';
import { type Meal, MEALS } from '@/features/meal-plan/week';
import { mealLabel, sheetDayLabel } from '@/features/meal-plan/week-view';
import { addRecipeToSlot, type EntryInput, setSlot } from '@/features/meal-plan/write';
import { readRecipeFavorites, type FavoritesByRecipe } from '@/features/recipes/favorites';
import { RecipeFilterBar } from '@/features/recipes/recipe-filter-bar';
import { RecipeFilterPanel } from '@/features/recipes/recipe-filter-panel';
import {
  activeFilterCount,
  type FilterChip,
  noRecipeFilters,
  removeFilterChip,
  type RecipeFilters,
} from '@/features/recipes/recipe-filters';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { NO_RECIPES_MATCH } from '@/features/recipes/recipe-search';
import { recipeTimeLabel } from '@/features/recipes/recipe-view';
import { recipesQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { tagLabel } from '@/i18n/vocabulary';

const isMeal = (value: string | undefined): value is Meal => MEALS.includes(value as Meal);

const QUICK_CHIPS: readonly QuickChip[] = ['meal', 'favorites', 'want-to-try'];
const SORTS: readonly { sort: SlotSheetSort; icon: IconName }[] = [
  { sort: 'recent', icon: 'clock' },
  { sort: 'name', icon: 'textformat' },
];

/**
 * The slot sheet (spec 4.16, boards `docs/design/plan-slot-picker/` A–C): the day in the meal's hue over the
 * meal, a search field, one sideways row of chips (Filters, a ✕ chip per other active filter, then the quick
 * chips: the meal, Favorites, Want to try), the count ("All recipes", "4 recipes") with the sort menu (Newest
 * first, A–Z), then every recipe of the household, newest first, each with its time and when it was added,
 * and Clear filters while any are on. The **Not cooking?** bar (Leftovers, Eating out, Note…) is pinned to the
 * bottom. Search, chips and filters narrow together; Filters shows the filter panel in place. The filters and
 * sort are the sheet's own and go when it closes. Picking fills the slot and closes the sheet.
 *
 * With `mode: 'add'`, the add sheet (board E), from the meal sheet: "Add to dinner" under "Tuesday 13 ·
 * Dinner", a line naming the slot's recipes, the same list, chips and filters but no Not cooking? bar, and the
 * slot's recipes ticked and disabled. Picking adds the recipe last and goes back to the meal sheet.
 */
export default function PlanSlotSheet() {
  const { householdId, day, meal, mode } = useLocalSearchParams<{ householdId: string; day: string; meal: string; mode?: string }>();
  const t = useT();
  const { colors, scheme, spacing, sizes, opacity, rounded } = useTheme();
  const insets = useSafeAreaInsets();
  const adding = mode === 'add';
  // A sheet is short-lived: read once rather than live.
  const [recipes] = useState(() => recipesQuery().all());
  const [own] = useState(() => recipes.filter((r) => r.householdId === householdId));
  const [favorites] = useState<FavoritesByRecipe>(() => (own.length > 0 ? readRecipeFavorites() : new Map()));
  const [now] = useState(() => new Date());
  // The add sheet's slot recipes, in order.
  const [inSlot] = useState(() =>
    adding && householdId && day && isMeal(meal)
      ? groupWeek(weekEntriesQuery(householdId, day).all())
          .slotEntries(day, meal)
          .filter((e) => e.kind === 'recipe')
      : [],
  );
  const inSlotIds = useMemo(() => new Set(inSlot.map((e) => e.recipeId)), [inSlot]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<RecipeFilters>(noRecipeFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<SlotSheetSort>('recent');
  const shown = useMemo(
    () => (householdId ? slotSheetRecipes(own, { householdId, query, filters, sort }, favorites) : []),
    [own, householdId, query, filters, sort, favorites],
  );

  if (!householdId || !day || !isMeal(meal)) return <Screen />;

  // The Filters pill shows the filter panel in place; Show N recipes comes back.
  if (filtersOpen) {
    return (
      <Screen>
        <RecipeFilterPanel
          recipes={own}
          favorites={favorites}
          filters={filters}
          onChange={setFilters}
          count={shown.length}
          onDone={() => setFiltersOpen(false)}
        />
      </Screen>
    );
  }

  const band = hueHeaderBand(MealHues[meal], scheme);
  const pick = (entry: EntryInput) => {
    if (adding && entry.kind === 'recipe') addRecipeToSlot(householdId, day, meal, entry.recipeId);
    else setSlot(householdId, day, meal, entry);
    router.back();
  };
  const filtering = activeFilterCount(filters) > 0;
  const narrowed = filtering || query.trim() !== '';
  const chipLabel = (chip: QuickChip) =>
    chip === 'meal' ? mealLabel(meal) : chip === 'favorites' ? t('recipes.filters.favorites') : tagLabel('saved', 'want-to-try')!;
  // A value a quick chip shows isn't repeated as a ✕ chip.
  const quickChipShows = (chip: FilterChip) =>
    (chip.facet === 'meal' && chip.slug === meal) || (chip.facet === 'saved' && (chip.slug === 'favorites' || chip.slug === 'want-to-try'));

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
        <View accessible accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          <ThemedText variant="headline" style={{ color: band.text }}>
            {adding ? t('mealPlan.addDayLine', { day: sheetDayLabel(day), meal: mealLabel(meal) }) : sheetDayLabel(day)}
          </ThemedText>
          <ThemedText variant="sheetTitle">{adding ? t(`mealPlan.addTo.${meal}`) : mealLabel(meal)}</ThemedText>
        </View>

        {adding && inSlot.length > 0 ? (
          <View
            testID="slot-with"
            style={[
              styles.row,
              {
                marginHorizontal: spacing.lg,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                borderRadius: rounded.md,
                backgroundColor: colors.primarySoft,
              },
            ]}>
            <ThemedText variant="footnote" color="onPrimarySoft" numberOfLines={1} style={[styles.flex, styles.strong]}>
              {t('mealPlan.withRecipes', { names: inSlot.map((e) => e.recipeName ?? '').join(', ') })}
            </ThemedText>
          </View>
        ) : null}

        <View style={{ gap: spacing.xs }}>
          <View style={{ paddingHorizontal: spacing.lg }}>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder={t('mealPlan.searchRecipes')}
              accessibilityLabel={t('mealPlan.searchRecipes')}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>
          <RecipeFilterBar
            row
            filters={filters}
            onOpen={() => setFiltersOpen(true)}
            onRemove={(chip) => setFilters(removeFilterChip(filters, chip))}
            hideChip={quickChipShows}>
            {QUICK_CHIPS.map((chip) => (
              <Pill
                key={chip}
                label={chipLabel(chip)}
                selected={quickChipOn(filters, chip, meal)}
                onPress={() => setFilters(toggleQuickChip(filters, chip, meal))}
              />
            ))}
          </RecipeFilterBar>
        </View>

        <View style={[styles.row, styles.between, { gap: spacing.md, paddingHorizontal: spacing.lg + spacing.xs }]}>
          <ThemedText variant="sectionLabel" color="inkSecondary" style={styles.shrink}>
            {narrowed ? t('mealPlan.recipeCount', { count: shown.length }) : t('mealPlan.allRecipes')}
          </ThemedText>
          <Host matchContents colorScheme={scheme} seedColor={colors.primary}>
            <Menu
              label={
                <RNHostView matchContents>
                  <View testID="slot-sort" style={[styles.row, { minHeight: sizes.minTapTarget, gap: spacing.xs }]}>
                    <ThemedText variant="amount" color="primary" style={styles.strong}>
                      {t(`mealPlan.sort.${sort}`)}
                    </ThemedText>
                    <Icon name="chevron.down" color="primary" size={sizes.iconSmall} weight="bold" />
                  </View>
                </RNHostView>
              }
              modifiers={[
                accessibilityLabel(t('recipes.sort.button', { choice: t(`mealPlan.sort.${sort}`) })),
                accessibilityHint(t('mealPlan.sortHint')),
              ]}>
              {SORTS.map((item) => (
                <Toggle
                  key={item.sort}
                  label={t(`mealPlan.sort.${item.sort}`)}
                  systemImage={item.icon}
                  isOn={item.sort === sort}
                  onIsOnChange={() => setSort(item.sort)}
                />
              ))}
            </Menu>
          </Host>
        </View>

        {shown.length > 0 ? (
          <Card>
            {shown.map((r, i) => {
              const already = inSlotIds.has(r.id);
              const line = already
                ? t(`mealPlan.alreadyIn.${meal}`)
                : [recipeTimeLabel(r.totalMinutes), recipeAddedLabel(r.createdAt, now)].filter(Boolean).join(' · ');
              return (
                <Pressable
                  key={r.id}
                  testID={`slot-recipe-${r.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${r.name}, ${line}`}
                  accessibilityState={{ disabled: already, checked: already ? true : undefined }}
                  disabled={already}
                  onPress={() => pick({ kind: 'recipe', recipeId: r.id })}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      minHeight: sizes.cardRowMin,
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.sm,
                      gap: spacing.md,
                      borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                      opacity: already ? opacity.disabled : pressed ? opacity.pressed : 1,
                    },
                  ]}>
                  <RecipePhotoTile recipeId={r.id} imageUrl={r.imageUrl} photoPath={r.photoPath} />
                  <View style={styles.flex}>
                    <ThemedText variant="body" numberOfLines={2}>
                      {r.name}
                    </ThemedText>
                    <ThemedText variant="footnote" color="inkSecondary">
                      {line}
                    </ThemedText>
                  </View>
                  {already ? <Icon name="checkmark" color="primary" size={sizes.icon} weight="bold" /> : null}
                </Pressable>
              );
            })}
          </Card>
        ) : (
          <ThemedText variant="callout" color="inkSecondary" style={[styles.centerText, { paddingHorizontal: spacing.lg }]}>
            {own.length === 0 ? t('mealPlan.noRecipes') : NO_RECIPES_MATCH}
          </ThemedText>
        )}

        {filtering ? (
          <View style={[styles.row, styles.center]}>
            <Button label={t('recipes.filters.clearFilters')} variant="plain" onPress={() => setFilters(noRecipeFilters())} />
          </View>
        ) : null}
      </ScrollView>

      {adding ? null : (
        <View
          testID="not-cooking"
          style={[
            styles.row,
            {
              gap: spacing.sm,
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.md,
              paddingBottom: Math.max(insets.bottom, spacing.lg),
              backgroundColor: colors.background,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
            },
          ]}>
          <ThemedText variant="sectionLabel" color="inkSecondary" style={{ width: sizes.slotBarLabel }}>
            {t('mealPlan.notCooking')}
          </ThemedText>
          <NotCookingButton icon="takeoutbag.and.cup.and.straw" label={t('mealPlan.leftovers')} onPress={() => pick({ kind: 'leftovers' })} />
          <NotCookingButton icon="fork.knife" label={t('mealPlan.eatingOut')} onPress={() => pick({ kind: 'eating-out' })} />
          <NotCookingButton
            icon="note.text"
            label={t('mealPlan.note')}
            onPress={() => promptNote('', (note) => pick({ kind: 'note', note }))}
          />
        </View>
      )}
    </Screen>
  );
}

/** One of the Not cooking? bar's three equal buttons: a `surface` tile, the glyph over a `caption` label. */
function NotCookingButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.flex,
        styles.center,
        {
          minHeight: sizes.slotBarButton,
          paddingVertical: spacing.xs,
          paddingHorizontal: spacing.xxs,
          gap: spacing.xxs,
          borderRadius: rounded.md,
          backgroundColor: colors.surface,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name={icon} color="ink" size={sizes.icon} weight="semibold" />
      <ThemedText variant="caption" style={styles.centerText}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  strong: { fontWeight: '600' },
});
