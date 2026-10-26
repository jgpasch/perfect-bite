import { Host, Menu, RNHostView, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hueHeaderBand } from '@/components/appearance';
import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { MealHues } from '@/constants/theme';
import { groupWeek, weekEntriesQuery } from '@/features/meal-plan/queries';
import {
  mealToast,
  pickButtonLabels,
  type PickMode,
  pickRecipes,
  promptNote,
  type QuickChip,
  quickChipOn,
  recipeAddedLabel,
  type SlotSheetSort,
  slotSheetRecipes,
  toggleQuickChip,
  weekToast,
} from '@/features/meal-plan/slot-actions';
import { type Meal, MEALS, today as dayOf } from '@/features/meal-plan/week';
import { mealLabel, sheetDayLabel } from '@/features/meal-plan/week-view';
import { type EntryInput, setSlot } from '@/features/meal-plan/write';
import { readCollectionsByRecipe, type CollectionsByRecipe } from '@/features/recipes/collections';
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
import { recipesQuery, type RecipeSummary } from '@/features/recipes/recipes';
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
 * bottom; each fills the slot at once and closes the sheet. Search, chips and filters narrow together; Filters
 * shows the filter panel in place. The filters and sort are the sheet's own and go when it closes.
 *
 * Picking recipes (board `d-multi-select`, states a–d): tapping a row ticks it (or unticks it), any number.
 * Ticks, in the order ticked, outlast the search, chips, filters and sort, and go when the sheet closes. With
 * any ticked, the count line starts "2 selected · " and the **add bar** takes the Not cooking? bar's place: a
 * sideways row of the ticked recipes (✕ unticks one), Clear, and Add to dinner / Add 3 to dinner, which writes
 * the slot once (`applyPlanChanges`, the ticked recipes last), closes, and shows the week's "Added 3 recipes to
 * Thu dinner" with Undo. With `mode: 'replace'` (a note's Replace…, the meal sheet's Replace all…) it reads
 * Replace dinner / Replace with 3, replaces everything there, and the toast is "Replaced Thu dinner".
 *
 * With `mode: 'add'`, the add sheet (board E), from the meal sheet: "Add to dinner" under "Tuesday 13 ·
 * Dinner", a line naming the slot's recipes, the same list, chips and filters but no Not cooking? bar (and no
 * bar at all until something's ticked), and the slot's recipes ticked and disabled, never counted. Its button
 * adds the ticked recipes last and goes back to the meal sheet, which shows "Added 2 recipes to dinner".
 */
export default function PlanSlotSheet() {
  const { householdId, day, meal, mode } = useLocalSearchParams<{ householdId: string; day: string; meal: string; mode?: string }>();
  const t = useT();
  const { colors, scheme, spacing, sizes, opacity, rounded } = useTheme();
  const insets = useSafeAreaInsets();
  const adding = mode === 'add';
  const pickMode: PickMode = adding ? 'add' : mode === 'replace' ? 'replace' : 'fill';
  // A sheet is short-lived: read once rather than live.
  const [recipes] = useState(() => recipesQuery().all());
  const [own] = useState(() => recipes.filter((r) => r.householdId === householdId));
  const [favorites] = useState<FavoritesByRecipe>(() => (own.length > 0 ? readRecipeFavorites() : new Map()));
  // Recipe collections board E: the names of the collections each recipe is in, for the Collections filters.
  const [collections] = useState<CollectionsByRecipe>(() => (own.length > 0 ? readCollectionsByRecipe() : new Map()));
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
  // The ticked recipes' ids, in the order ticked.
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const picked = useMemo(() => {
    const byId = new Map(own.map((r) => [r.id, r]));
    return ticked.map((id) => byId.get(id)).filter((r): r is RecipeSummary => r !== undefined);
  }, [own, ticked]);
  const shown = useMemo(
    () => (householdId ? slotSheetRecipes(own, { householdId, query, filters, sort, collections }, favorites) : []),
    [own, householdId, query, filters, sort, favorites, collections],
  );

  if (!householdId || !day || !isMeal(meal)) return <Screen />;

  // The Filters pill shows the filter panel in place; Show N recipes comes back.
  if (filtersOpen) {
    return (
      <Screen>
        <RecipeFilterPanel
          recipes={own}
          favorites={favorites}
          collections={collections}
          filters={filters}
          onChange={setFilters}
          count={shown.length}
          onDone={() => setFiltersOpen(false)}
        />
      </Screen>
    );
  }

  const band = hueHeaderBand(MealHues[meal], scheme);
  // Leftovers, Eating out and Note… fill the slot at once.
  const fill = (entry: EntryInput) => {
    setSlot(householdId, day, meal, entry);
    router.back();
  };
  const toggle = (id: string) => setTicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const commit = () => {
    const onToast = adding ? mealToast : weekToast;
    const toast = pickRecipes(householdId, day, meal, picked, pickMode, dayOf(now), onToast);
    router.back();
    onToast(toast);
  };
  const buttonLabels = pickButtonLabels(meal, picked.length, pickMode);
  const filtering = activeFilterCount(filters) > 0;
  const narrowed = filtering || query.trim() !== '';
  const countLine = narrowed ? t('mealPlan.recipeCount', { count: shown.length }) : t('mealPlan.allRecipes');
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
            {picked.length > 0 ? t('mealPlan.selectedCount', { count: picked.length, rest: countLine }) : countLine}
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
              const on = !already && ticked.includes(r.id);
              const line = already
                ? t(`mealPlan.alreadyIn.${meal}`)
                : [recipeTimeLabel(r.totalMinutes), recipeAddedLabel(r.createdAt, now)].filter(Boolean).join(' · ');
              return (
                <Pressable
                  key={r.id}
                  testID={`slot-recipe-${r.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${on ? t('mealPlan.tickedRecipe', { name: r.name }) : r.name}, ${line}`}
                  accessibilityState={{ disabled: already, checked: already ? true : undefined }}
                  disabled={already}
                  onPress={() => toggle(r.id)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      minHeight: sizes.cardRowMin,
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.sm,
                      gap: spacing.md,
                      borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                      backgroundColor: on ? colors.primarySoft : undefined,
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
                  <TickCircle state={already ? 'already' : on ? 'on' : 'off'} />
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

      {picked.length > 0 ? (
        <View
          testID="add-bar"
          style={{
            gap: spacing.md,
            paddingTop: spacing.md,
            paddingBottom: Math.max(insets.bottom, spacing.lg),
            backgroundColor: colors.background,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
          }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}>
            {picked.map((r) => (
              <PickedChip key={r.id} recipe={r} onRemove={() => toggle(r.id)} />
            ))}
          </ScrollView>
          <View style={[styles.row, { gap: spacing.md, paddingHorizontal: spacing.lg }]}>
            <Button label={t('mealPlan.clearPicked')} variant="plain" onPress={() => setTicked([])} />
            <View style={styles.flex}>
              <PrimaryButton label={buttonLabels.label} accessibilityLabel={buttonLabels.accessibilityLabel} onPress={commit} />
            </View>
          </View>
        </View>
      ) : adding ? null : (
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
          <NotCookingButton icon="takeoutbag.and.cup.and.straw" label={t('mealPlan.leftovers')} onPress={() => fill({ kind: 'leftovers' })} />
          <NotCookingButton icon="fork.knife" label={t('mealPlan.eatingOut')} onPress={() => fill({ kind: 'eating-out' })} />
          <NotCookingButton
            icon="note.text"
            label={t('mealPlan.note')}
            onPress={() => promptNote('', (note) => fill({ kind: 'note', note }))}
          />
        </View>
      )}
    </Screen>
  );
}

/**
 * A recipe row's tick circle: a `controlBorder` ring; ticked, filled `primary` with an `onPrimary` check;
 * already in the slot (the add sheet), filled `surfaceMuted` with an `inkSecondary` check.
 */
function TickCircle({ state }: { state: 'off' | 'on' | 'already' }) {
  const { colors, sizes, rounded } = useTheme();
  return (
    <View
      style={[
        styles.center,
        {
          width: sizes.slotTick,
          height: sizes.slotTick,
          borderRadius: rounded.full,
          borderWidth: state === 'off' ? sizes.checkBorder : 0,
          borderColor: colors.controlBorder,
          backgroundColor: state === 'on' ? colors.primary : state === 'already' ? colors.surfaceMuted : 'transparent',
        },
      ]}>
      {state === 'off' ? null : (
        <Icon name="checkmark" color={state === 'on' ? 'onPrimary' : 'inkSecondary'} size={sizes.iconSmall} weight="bold" />
      )}
    </View>
  );
}

/** A ticked recipe in the add bar: a `surface` chip with its tile, name and a ✕ that unticks it. */
function PickedChip({ recipe, onRemove }: { recipe: RecipeSummary; onRemove: () => void }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <View
      testID={`picked-${recipe.id}`}
      style={[styles.row, { minHeight: sizes.pill, gap: spacing.sm, paddingLeft: spacing.xs, borderRadius: rounded.md, backgroundColor: colors.surface }]}>
      <RecipePhotoTile recipeId={recipe.id} imageUrl={recipe.imageUrl} photoPath={recipe.photoPath} size={sizes.slotTrayTile} />
      <ThemedText variant="callout" numberOfLines={1} style={styles.strong}>
        {recipe.name}
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('mealPlan.removeRecipe', { name: recipe.name })}
        hitSlop={spacing.xs}
        onPress={onRemove}
        style={({ pressed }) => [
          styles.center,
          { minWidth: sizes.removeButton, minHeight: sizes.removeButton, opacity: pressed ? opacity.pressed : 1 },
        ]}>
        <Icon name="xmark" color="inkSecondary" size={sizes.iconSmall} weight="bold" />
      </Pressable>
    </View>
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
