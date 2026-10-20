import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View, type LayoutChangeEvent } from 'react-native';

import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { Stepper } from '@/components/stepper';
import { ThemedText } from '@/components/themed-text';
import type { Recipe, RecipeIngredient } from '@/db';
import type { AisleHue } from '@/domain/aisle-color';
import { formatAmount } from '@/domain/quantity-display';
import { PlanBadges } from '@/features/meal-plan/plan-badges';
import { AddIngredientRow } from '@/features/recipes/add-ingredient-row';
import { RecipeIngredientRow } from '@/features/recipes/recipe-ingredient-row';
import { openRecipeLink, recipeLinkParts } from '@/features/recipes/recipe-link';
import { RecipeMethodCard } from '@/features/recipes/recipe-method-card';
import type { RecipeImageSource } from '@/features/recipes/recipe-photo-source';
import { forServingsLabel, scaledAmount, SERVINGS_MAX, SERVINGS_MIN } from '@/features/recipes/recipe-view';
import { updateRecipe } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** The amount column's widest share of the ingredient rows' width. */
const AMOUNT_COLUMN_SHARE = 0.4;

/**
 * The index card's amount column: the widest measured amount, capped at 40% of the rows' width (`contentWidth`,
 * their width less the side margins). None until the rows' width is known.
 */
export function amountColumnWidth(widths: readonly number[], contentWidth: number): number | undefined {
  if (contentWidth <= 0) return undefined;
  return Math.min(Math.max(0, ...widths), contentWidth * AMOUNT_COLUMN_SHARE);
}

type Props = {
  recipe: Recipe;
  hue: AisleHue;
  ingredients: readonly RecipeIngredient[];
  /** The photo to show in the square (the household's own, else the site's, or the device's copy while it uploads). */
  photoSource: RecipeImageSource | null;
  /** Whether the recipe has a photo, for the square's VoiceOver label. */
  hasPhoto: boolean;
  /** Generate with AI is running: a spinner in the square. */
  generating: boolean;
  onPhotoError: (event?: { error?: string }) => void;
  /** The Choose a photo sheet. */
  onOpenPhoto: () => void;
  /** The recipe's own servings, and the stepper's (null without servings). */
  base: number | null;
  servings: number | null;
  /** The stepper's servings; null is the recipe's own. */
  onServingsChange: (servings: number | null) => void;
  /** The servings prompt, for Add servings. */
  onEditServings: () => void;
  onPlan: () => void;
  onEditIngredient: (ingredient: RecipeIngredient) => void;
  onAddIngredientToList: (ingredient: RecipeIngredient) => void;
  onDeleteIngredient: (ingredient: RecipeIngredient) => void;
  /** Add ingredient: the add bar. */
  onAddIngredient: () => void;
  /** The ingredients' layout, so the screen can scroll a new row into view. */
  onIngredientsLayout: (e: LayoutChangeEvent) => void;
  /** Whether the recipe has steps (headings aren't steps). */
  hasSteps: boolean;
  /** The Method card's pick in each choice group, and the path's step count. */
  methodPicks: readonly number[];
  methodCount: number;
  onPick: (group: number, option: number) => void;
  pageCount: number;
  onViewPages: () => void;
  onEditSteps: () => void;
};

/**
 * The index card recipe view (spec 4.5, board F): on the plain `background`, 20 pt in, the name beside a 64 pt photo
 * square, the plan badges, the source line (the link's host · "For 4", which turns into the servings stepper), the
 * notes in quotes, a hairline, then the ingredients as an amount column and names, Add ingredient, and the method
 * folded behind "Method, 8 steps". The screen keeps the state and the handlers, so it behaves as the standard view does.
 */
export function RecipeIndexCard({
  recipe,
  hue,
  ingredients,
  photoSource,
  hasPhoto,
  generating,
  onPhotoError,
  onOpenPhoto,
  base,
  servings,
  onServingsChange,
  onEditServings,
  onPlan,
  onEditIngredient,
  onAddIngredientToList,
  onDeleteIngredient,
  onAddIngredient,
  onIngredientsLayout,
  hasSteps,
  methodPicks,
  methodCount,
  onPick,
  pageCount,
  onViewPages,
  onEditSteps,
}: Props) {
  const t = useT();
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const tint = aisles[hue];
  const margin = spacing.lg + spacing.xs;
  // The method shows under its line once tapped, and stays open while the screen is.
  const [methodOpen, setMethodOpen] = useState(false);
  // Each amount's measured width, by its text, and the rows' width, for the amount column.
  const [amountWidths, setAmountWidths] = useState<Record<string, number>>({});
  const [rowsWidth, setRowsWidth] = useState(0);
  const amounts = ingredients.map((item) =>
    base !== null && servings !== null && servings !== base ? scaledAmount(item, servings, base) : formatAmount(item),
  );
  const shown = [...new Set(amounts.filter(Boolean))];
  const amountWidth = amountColumnWidth(
    shown.map((text) => amountWidths[text] ?? 0),
    rowsWidth - margin * 2,
  );

  return (
    <View>
      <View style={{ paddingHorizontal: margin, paddingTop: spacing.md, gap: spacing.sm }}>
        <View style={[styles.top, { gap: spacing.lg }]}>
          <View style={[styles.flex, { gap: spacing.sm }]}>
            <ThemedText variant="screenTitle" accessibilityRole="header">
              {recipe.name}
            </ThemedText>
            <PlanBadges recipeId={recipe.id} onOpen={onPlan} />
          </View>
          <Pressable
            testID="index-photo"
            onPress={onOpenPhoto}
            accessibilityRole="button"
            accessibilityLabel={t(hasPhoto ? 'recipes.indexCard.changePhoto' : 'recipes.photo.add')}
            style={({ pressed }) => [
              styles.photo,
              {
                width: sizes.recipeIndexPhoto,
                height: sizes.recipeIndexPhoto,
                borderRadius: rounded.md,
                backgroundColor: tint.soft,
                opacity: pressed ? opacity.pressed : 1,
              },
            ]}>
            {photoSource !== null ? (
              <Image
                testID="recipe-photo"
                source={photoSource}
                contentFit="cover"
                cachePolicy="disk"
                accessible={false}
                onError={onPhotoError}
                style={StyleSheet.absoluteFill}
              />
            ) : null}
            {generating ? (
              <ActivityIndicator
                testID="photo-generating"
                color={tint.strong}
                accessibilityLabel={t('recipes.photo.generating')}
              />
            ) : null}
          </Pressable>
        </View>
        <SourceLine
          sourceUrl={recipe.sourceUrl}
          hue={hue}
          base={base}
          servings={servings}
          onServingsChange={onServingsChange}
          onEditServings={onEditServings}
        />
        <IndexNotes recipe={recipe} hue={hue} />
      </View>
      <View
        testID="index-separator"
        style={{
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.border,
          marginHorizontal: margin,
          marginVertical: spacing.lg,
        }}
      />
      <View testID="recipe-ingredients" onLayout={onIngredientsLayout}>
        <View testID="ingredient-rows" onLayout={(e) => setRowsWidth(e.nativeEvent.layout.width)}>
          {/* Each amount once, unconstrained and unseen, to size the column; it follows Dynamic Type. */}
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.measure}>
            {shown.map((text) => (
              <ThemedText
                key={text}
                testID="amount-measure"
                variant="body"
                onLayout={(e) => {
                  const width = e.nativeEvent.layout.width;
                  setAmountWidths((current) => (current[text] === width ? current : { ...current, [text]: width }));
                }}>
                {text}
              </ThemedText>
            ))}
          </View>
          {ingredients.length === 0 ? (
            <ThemedText
              variant="callout"
              color="inkSecondary"
              style={{ paddingHorizontal: margin, paddingVertical: spacing.xs }}>
              {t('recipes.screen.noIngredients')}
            </ThemedText>
          ) : (
            ingredients.map((item, index) => (
              <RecipeIngredientRow
                key={item.id}
                layout="indexCard"
                ingredient={item}
                dotColor={tint.dot}
                amount={amounts[index]}
                amountWidth={amountWidth}
                onEdit={() => onEditIngredient(item)}
                onAddToList={() => onAddIngredientToList(item)}
                onDelete={() => onDeleteIngredient(item)}
              />
            ))
          )}
        </View>
        <AddIngredientRow onPress={onAddIngredient} />
      </View>
      {hasSteps ? (
        <>
          <Pressable
            testID="method-line"
            onPress={() => setMethodOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel={t('recipes.method.tabLabel', { count: methodCount })}
            accessibilityState={{ expanded: methodOpen }}
            style={({ pressed }) => [
              styles.row,
              styles.start,
              {
                gap: spacing.xs,
                minHeight: sizes.minTapTarget,
                marginHorizontal: margin,
                marginTop: spacing.sm,
                opacity: pressed ? opacity.pressed : 1,
              },
            ]}>
            <ThemedText variant="headline" style={{ color: tint.strong }}>
              {methodOpen ? t('recipes.indexCard.hideMethod') : t('recipes.method.tabLabel', { count: methodCount })}
            </ThemedText>
            <Icon
              name={methodOpen ? 'chevron.down' : 'chevron.right'}
              tint={tint.strong}
              size={sizes.iconSmall}
              weight="bold"
            />
          </Pressable>
          {methodOpen ? (
            <View style={{ paddingTop: spacing.sm }}>
              <RecipeMethodCard
                steps={recipe.steps}
                hue={hue}
                picks={methodPicks}
                onPick={onPick}
                sourceUrl={recipe.sourceUrl}
                pageCount={pageCount}
                onViewPages={onViewPages}
                onEdit={onEditSteps}
              />
            </View>
          ) : null}
        </>
      ) : (
        <View style={{ paddingTop: spacing.md }}>
          <RecipeMethodCard steps={recipe.steps} hue={hue} onEdit={onEditSteps} />
        </View>
      )}
    </View>
  );
}

/**
 * The source line: the link's host (without `www.`) in the hue's `strong`, opening Safari, then " · " and "For 4"
 * with a soft underline, which turns into the servings stepper (and Reset off the recipe's servings) when tapped.
 * No link: just the servings. No servings: a dashed Add servings pill. Neither: nothing.
 */
function SourceLine({
  sourceUrl,
  hue,
  base,
  servings,
  onServingsChange,
  onEditServings,
}: {
  sourceUrl: string | null;
  hue: AisleHue;
  base: number | null;
  servings: number | null;
  onServingsChange: (servings: number | null) => void;
  onEditServings: () => void;
}) {
  const t = useT();
  const { aisles, spacing, sizes, opacity } = useTheme();
  const tint = aisles[hue];
  const [stepping, setStepping] = useState(false);
  const link = recipeLinkParts(sourceUrl);
  if (!link && base === null) return null;

  let servingsPart: React.ReactNode;
  if (base === null || servings === null) {
    servingsPart = <Pill dashed icon="person.2" label={t('recipes.servings.add')} onPress={onEditServings} />;
  } else if (stepping) {
    servingsPart = (
      <View style={[styles.row, { gap: spacing.xxs }]}>
        {servings !== base ? (
          <Button variant="plain" label={t('recipes.screen.reset')} onPress={() => onServingsChange(null)} />
        ) : null}
        <Stepper
          value={servings}
          min={SERVINGS_MIN}
          max={SERVINGS_MAX}
          onChange={onServingsChange}
          label={forServingsLabel(servings)}
          accessibilityLabel={t('recipes.servings.title')}
        />
      </View>
    );
  } else {
    servingsPart = (
      <Pressable
        testID="index-servings"
        onPress={() => setStepping(true)}
        accessibilityRole="button"
        accessibilityLabel={t('recipes.servings.title')}
        accessibilityValue={{ text: forServingsLabel(servings) }}
        style={({ pressed }) => [styles.center, { minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 }]}>
        <View testID="servings-underline" style={{ borderBottomWidth: sizes.checkBorder, borderBottomColor: tint.soft }}>
          <ThemedText variant="headline">{forServingsLabel(servings)}</ThemedText>
        </View>
      </Pressable>
    );
  }

  return (
    <View testID="index-source-line" style={[styles.row, styles.wrap, { columnGap: spacing.xs }]}>
      {link ? (
        <>
          <Pressable
            onPress={() => void openRecipeLink(sourceUrl!)}
            accessibilityRole="link"
            accessibilityLabel={t('recipes.link.row', { link: link.host })}
            accessibilityHint={t('recipes.link.openHint')}
            style={({ pressed }) => [styles.center, { minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 }]}>
            <ThemedText variant="headline" style={{ color: tint.strong }}>
              {link.host}
            </ThemedText>
          </Pressable>
          <ThemedText variant="headline" color="inkSecondary" accessible={false}>
            ·
          </ThemedText>
        </>
      ) : null}
      {servingsPart}
    </View>
  );
}

/**
 * The notes in `lead` italic, the hue's `strong`, in quotes and in full; a tap turns them into the field, saved when
 * it loses focus, as the band's are. No notes: "+ Add notes".
 */
function IndexNotes({ recipe, hue }: { recipe: Recipe; hue: AisleHue }) {
  const t = useT();
  const { colors, aisles, spacing, typography, sizes, opacity } = useTheme();
  const tint = aisles[hue];
  const [notes, setNotes] = useState(recipe.notes ?? '');
  const [editing, setEditing] = useState(false);
  const notesStyle = [typography.lead, styles.italic, { color: tint.strong }];

  if (editing) {
    return (
      <TextInput
        value={notes}
        onChangeText={setNotes}
        onEndEditing={() => {
          updateRecipe(recipe.id, { name: recipe.name, notes, sourceUrl: recipe.sourceUrl ?? '' });
          setEditing(false);
        }}
        autoFocus
        placeholder={t('recipes.screen.addNotes')}
        placeholderTextColor={colors.inkSecondary}
        selectionColor={tint.strong}
        accessibilityLabel={t('recipes.screen.notes')}
        multiline
        style={[notesStyle, { minHeight: sizes.minTapTarget }]}
      />
    );
  }
  if (notes.trim()) {
    return (
      <Pressable
        onPress={() => setEditing(true)}
        accessibilityRole="button"
        accessibilityLabel={t('recipes.screen.notesLabel', { notes: notes.trim() })}
        style={({ pressed }) => [styles.center, { minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 }]}>
        <ThemedText variant="lead" style={[styles.italic, { color: tint.strong }]}>
          {t('recipes.indexCard.notes', { notes: notes.trim() })}
        </ThemedText>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={() => setEditing(true)}
      accessibilityRole="button"
      accessibilityLabel={t('recipes.screen.addNotes')}
      style={({ pressed }) => [
        styles.row,
        styles.start,
        { gap: spacing.xs, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <Icon name="plus" color="inkSecondary" size={sizes.iconSmall} weight="semibold" />
      <ThemedText variant="footnote" color="inkSecondary">
        {t('recipes.screen.addNotes')}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  center: { justifyContent: 'center' },
  start: { alignSelf: 'flex-start' },
  italic: { fontStyle: 'italic' },
  photo: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  measure: { position: 'absolute', top: 0, left: 0, opacity: 0, alignItems: 'flex-start' },
});
