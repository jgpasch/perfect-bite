import { router, useLocalSearchParams } from 'expo-router';
import { useId, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { itemNameColor } from '@/components/appearance';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { Icon } from '@/components/icon';
import { SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useKeepAwake } from '@/features/lists/keep-awake';
import { startingServings } from '@/features/recipes/add-to-list';
import {
  allTicked,
  cookAmount,
  tickUses,
  toggleAllUses,
  toggleUse,
  stepAmount,
  tickKey,
  usesByIngredient,
} from '@/features/recipes/cook-match';
import { useEnsureStepMatch } from '@/features/recipes/ensure-step-match';
import { RecipeCredit } from '@/features/recipes/recipe-credit';
import { cookProgressLabel, stepLabel, stepUnit, upNextIndex } from '@/features/recipes/recipe-view';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { stepMatch } from '@/features/recipes/step-match';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName } from '@/shared';

/**
 * Cooking mode (board 19): a full-screen modal on one scrolling page, with the ingredients scaled to the
 * recipe screen's servings (`servings`) and the steps, each ticked off with a tap. The ticks are this screen's
 * state only, so they're gone when it closes; the screen stays on while it's open. With a step match (spec 4.5,
 * board 3 G and I), each step lists its ingredients under it, the checklist folds into All ingredients, and
 * Also needed holds the ingredients in no step; ticks are then per use of an ingredient.
 */
export default function CookScreen() {
  const { id, servings: servingsParam } = useLocalSearchParams<{ id: string; servings?: string }>();
  const t = useT();
  const { spacing } = useTheme();
  const insets = useSafeAreaInsets();
  // Nothing here is edited, so read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const [ingredients] = useState(() => recipeIngredientsQuery(id).all());
  const steps = recipe?.steps ?? [];
  const [stepsDone, setStepsDone] = useState(() => steps.map(() => false));
  const [ingredientsDone, setIngredientsDone] = useState<ReadonlySet<string>>(() => new Set());
  // With a match: the ticked uses (`tickKey`), and whether All ingredients is unfolded.
  const [usesDone, setUsesDone] = useState<ReadonlySet<string>>(() => new Set());
  const [unfolded, setUnfolded] = useState(false);
  const [match] = useState(() => (recipe ? stepMatch(recipe, ingredients) : null));
  useKeepAwake(`cook:${id}:${useId()}`, true);
  // Opening cook mode matches the recipe's steps if they need it (spec 4.5).
  useEnsureStepMatch(id);

  if (!recipe) return <Screen />;

  const base = recipe.servings;
  const servings = base === null ? null : startingServings(base, servingsParam);
  const upNext = upNextIndex(stepsDone);
  const done = stepsDone.filter(Boolean).length;

  const matched = match !== null && match.state !== 'none';
  const uses = matched ? usesByIngredient(match) : new Map<string, string[]>();
  const usesOf = (ingredientId: string) => uses.get(ingredientId) ?? [];
  const amountOf = (item: (typeof ingredients)[number]) => cookAmount(item, servings, base);

  const toggleStep = (index: number) => {
    // Ticking a step ticks its ingredients; unticking it leaves them.
    if (matched && !stepsDone[index]) {
      setUsesDone((ticked) => tickUses(ticked, match.steps[index].map((use) => tickKey(index, use.ingredient.id))));
    }
    setStepsDone((ticked) => ticked.map((on, i) => (i === index ? !on : on)));
  };
  const toggleIngredient = (ingredientId: string) =>
    setIngredientsDone((ticked) => {
      const next = new Set(ticked);
      if (!next.delete(ingredientId)) next.add(ingredientId);
      return next;
    });

  return (
    <Screen>
      <TopBar
        name={recipe.name}
        progress={cookProgressLabel(servings, done, steps.length)}
        paddingTop={insets.top + spacing.sm}
      />
      <ScrollView
        style={styles.flex}
        contentContainerStyle={{ paddingTop: spacing.lg, paddingBottom: insets.bottom + spacing.xl, gap: spacing.md + spacing.xxs }}>
        {matched && ingredients.length > 0 ? (
          <Card>
            <FoldRow
              total={ingredients.length}
              ticked={ingredients.filter((item) => allTicked(usesDone, usesOf(item.id))).length}
              unfolded={unfolded}
              onToggle={() => setUnfolded((on) => !on)}
            />
            {unfolded
              ? ingredients.map((item) => (
                  <IngredientRow
                    key={item.id}
                    name={displayItemName(item.displayName)}
                    amount={amountOf(item)}
                    checked={allTicked(usesDone, usesOf(item.id))}
                    onToggle={() => setUsesDone((ticked) => toggleAllUses(ticked, usesOf(item.id)))}
                  />
                ))
              : null}
          </Card>
        ) : ingredients.length > 0 ? (
          <Card>
            <SectionHeader title={t('recipes.screen.ingredients')} count={ingredients.length} />
            {ingredients.map((item) => {
              const amount = amountOf(item);
              return (
                <IngredientRow
                  key={item.id}
                  name={displayItemName(item.displayName)}
                  amount={amount}
                  checked={ingredientsDone.has(item.id)}
                  onToggle={() => toggleIngredient(item.id)}
                />
              );
            })}
          </Card>
        ) : null}
        {steps.length > 0 ? (
          <Card>
            <SectionHeader
              title={t('recipes.method.title')}
              count={steps.length}
              countUnit={stepUnit()}
              hideCount
              trailing={
                <ThemedText
                  variant="footnote"
                  color="inkSecondary"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={styles.count}>
                  {t('recipes.method.count', { count: steps.length })}
                </ThemedText>
              }
            />
            {steps.map((step, index) => {
              const stepUses = matched ? match.steps[index] : [];
              const label = stepLabel(index, steps.length, step);
              return (
                <StepRow
                  key={index}
                  number={index + 1}
                  text={step}
                  label={
                    stepUses.length > 0
                      ? t('recipes.cook.stepUses', { step: label, names: stepUses.map((use) => use.ingredient.displayName).join(', ') })
                      : label
                  }
                  checked={stepsDone[index]}
                  upNext={index === upNext}
                  onToggle={() => toggleStep(index)}>
                  {stepUses.map(({ ingredient: item, quantity }, n) => {
                    const key = tickKey(index, item.id);
                    const amount = stepAmount(item, quantity, usesOf(item.id).length > 1, servings, base);
                    const name = displayItemName(item.displayName);
                    return (
                      <IngredientRow
                        key={key}
                        compact
                        first={n === 0}
                        name={name}
                        amount={amount.text}
                        label={
                          amount.spoken
                            ? t('recipes.cook.stepIngredient', { name, amount: amount.spoken, number: index + 1 })
                            : t('recipes.cook.stepIngredientNoAmount', { name, number: index + 1 })
                        }
                        checked={usesDone.has(key)}
                        onToggle={() => setUsesDone((ticked) => toggleUse(ticked, key))}
                      />
                    );
                  })}
                </StepRow>
              );
            })}
            {/* The source credit at the foot of the last step (spec 4.5). */}
            <RecipeCredit sourceUrl={recipe.sourceUrl} />
          </Card>
        ) : null}
        {matched && match.unplaced.length > 0 ? (
          <Card>
            <SectionHeader
              title={t('recipes.cook.alsoNeeded')}
              trailing={
                <ThemedText variant="footnote" color="inkSecondary" style={styles.count}>
                  {t('recipes.cook.notInStep')}
                </ThemedText>
              }
            />
            {match.unplaced.map((item) => {
              const key = tickKey('also', item.id);
              return (
                <IngredientRow
                  key={key}
                  name={displayItemName(item.displayName)}
                  amount={amountOf(item)}
                  checked={usesDone.has(key)}
                  onToggle={() => setUsesDone((ticked) => toggleUse(ticked, key))}
                />
              );
            })}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** ✕ (Done) on the left, the recipe's name over "For 6 · 2 of 6 steps done" in the middle. */
function TopBar({ name, progress, paddingTop }: { name: string; progress: string; paddingTop: number }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <View
      style={[
        styles.row,
        {
          gap: spacing.md,
          paddingTop,
          paddingBottom: spacing.sm + spacing.xxs,
          paddingHorizontal: spacing.lg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        },
      ]}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel={t('common.done')}
        style={({ pressed }) => [
          styles.center,
          {
            width: sizes.minTapTarget,
            height: sizes.minTapTarget,
            borderRadius: rounded.full,
            backgroundColor: colors.surface,
            opacity: pressed ? opacity.pressed : 1,
          },
        ]}>
        <Icon name="xmark" weight="semibold" />
      </Pressable>
      <View style={styles.title}>
        <ThemedText variant="headline" accessibilityRole="header" style={styles.centredText}>
          {name}
        </ThemedText>
        <ThemedText variant="footnote" color="inkSecondary" style={styles.centredText}>
          {progress}
        </ThemedText>
      </View>
      {/* Balances the ✕, so the title sits in the middle. */}
      <View style={{ width: sizes.minTapTarget }} />
    </View>
  );
}

/**
 * An ingredient to tick off: round check, name in `cookStep` (struck through when ticked), amount. The whole row is
 * the target. `compact` is a row in a step's inset: a 22 pt check, 44 pt tall, the first without a hairline.
 */
function IngredientRow({
  name,
  amount,
  label,
  checked,
  compact,
  first,
  onToggle,
}: {
  name: string;
  amount: string;
  /** VoiceOver's label; "<name>, <amount>" when left out. */
  label?: string;
  checked: boolean;
  compact?: boolean;
  /** The first row in a step's inset, with no hairline above it. */
  first?: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label ?? (amount ? t('recipes.cook.ingredient', { name, amount }) : name)}
      style={({ pressed }) => [
        styles.row,
        {
          gap: compact ? spacing.sm + spacing.xxs : spacing.md,
          minHeight: compact ? sizes.minTapTarget : sizes.cardRowMin,
          paddingHorizontal: compact ? spacing.md : spacing.lg,
          paddingVertical: compact ? spacing.xs : spacing.sm,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <CheckCircle checked={checked} size={compact ? sizes.cookIngredientCheck : undefined} />
      <ThemedText variant="cookStep" color={itemNameColor(checked)} style={[styles.flex, checked && styles.struck]}>
        {name}
      </ThemedText>
      {amount ? (
        <ThemedText variant="amount" color="inkSecondary">
          {amount}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

/**
 * A step to tick off: its number in a ringed circle that fills `primary` with a check when ticked (the text then
 * dims), and the text in `cookStep`. The first unticked step is tinted "Up next". The whole row is the target.
 * `children` are the step's ingredient rows, in a rounded inset under the text: a sibling of the row, not inside
 * it, so VoiceOver reaches each one.
 */
function StepRow({
  number,
  text,
  label,
  checked,
  upNext,
  onToggle,
  children,
}: {
  number: number;
  text: string;
  label: string;
  checked: boolean;
  upNext: boolean;
  onToggle: () => void;
  children?: React.ReactNode[];
}) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const tint = upNext ? colors.primarySoft : undefined;
  const inset = children !== undefined && children.length > 0;
  const row = (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.step,
        {
          gap: spacing.md + spacing.xxs,
          padding: spacing.lg,
          paddingBottom: inset ? spacing.sm + spacing.xxs : spacing.lg,
          borderTopWidth: inset ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: tint,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <View
        style={[
          styles.center,
          {
            width: sizes.cookStepCheck,
            height: sizes.cookStepCheck,
            borderRadius: rounded.full,
            borderWidth: sizes.checkBorder,
            borderColor: checked ? colors.primary : colors.controlBorder,
            backgroundColor: checked ? colors.primary : colors.surface,
          },
        ]}>
        {checked ? (
          <Icon name="checkmark" color="onPrimary" weight="bold" size={sizes.iconSmall} />
        ) : (
          <ThemedText variant="amount" color="inkSecondary" maxFontSizeMultiplier={1} style={styles.digit}>
            {number}
          </ThemedText>
        )}
      </View>
      <View style={[styles.flex, { gap: spacing.xs }]}>
        {upNext ? (
          <ThemedText variant="caption" color="onPrimarySoft" style={styles.caps}>
            {t('recipes.cook.upNext')}
          </ThemedText>
        ) : null}
        <ThemedText variant="cookStep" color={checked ? 'inkSecondary' : 'ink'}>
          {text}
        </ThemedText>
      </View>
    </Pressable>
  );
  if (!inset) return row;
  return (
    <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: tint }}>
      {row}
      <View
        style={{
          marginLeft: spacing.lg + sizes.cookStepCheck + spacing.md + spacing.xxs,
          marginRight: spacing.lg,
          marginBottom: spacing.lg,
          borderRadius: rounded.md,
          overflow: 'hidden',
          backgroundColor: upNext ? colors.surface : colors.background,
        }}>
        {children}
      </View>
    </View>
  );
}

/** All ingredients, folded: the title over "9 · 5 ticked", and a chevron. Tapping folds and unfolds the checklist. */
function FoldRow({
  total,
  ticked,
  unfolded,
  onToggle,
}: {
  total: number;
  ticked: number;
  unfolded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: unfolded }}
      accessibilityLabel={t('recipes.cook.allLabel', { total, count: ticked })}
      style={({ pressed }) => [
        styles.row,
        {
          gap: spacing.md,
          minHeight: sizes.cardRowMin + spacing.sm - spacing.xxs,
          paddingHorizontal: spacing.lg,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <View style={styles.flex}>
        <ThemedText variant="headline">{t('recipes.cook.allIngredients')}</ThemedText>
        <ThemedText variant="footnote" color="inkSecondary">
          {t('recipes.cook.allCount', { total, count: ticked })}
        </ThemedText>
      </View>
      <Icon name={unfolded ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  step: { flexDirection: 'row', alignItems: 'flex-start' },
  center: { alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, alignItems: 'center' },
  centredText: { textAlign: 'center' },
  count: { fontWeight: '600' },
  digit: { fontWeight: '700' },
  caps: { textTransform: 'uppercase' },
  struck: { textDecorationLine: 'line-through' },
});
