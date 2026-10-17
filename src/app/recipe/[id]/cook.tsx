import { router, useLocalSearchParams } from 'expo-router';
import { useId, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { itemNameColor } from '@/components/appearance';
import { PrimaryButton } from '@/components/button';
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
  stepUseText,
  tickKey,
  usesByIngredient,
} from '@/features/recipes/cook-match';
import { useEnsureStepMatch } from '@/features/recipes/ensure-step-match';
import { RecipeCredit } from '@/features/recipes/recipe-credit';
import { cookProgressLabel, stepLabel, upNextIndex } from '@/features/recipes/recipe-view';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { stepMatch } from '@/features/recipes/step-match';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName } from '@/shared';

/**
 * Cooking mode (board 19, and board B "Steps with their ingredients"): a full-screen modal on one scrolling page,
 * with the ingredients scaled to the recipe screen's servings (`servings`) and a card per step, each ticked off
 * with a tap; the first unticked step is the current one, with Mark step done. The ticks are this screen's state
 * only, so they're gone when it closes; the screen stays on while it's open. With a step match (spec 4.5), the
 * current step lists its ingredients and the upcoming ones name theirs on one line, the checklist folds into All
 * ingredients, and Also needed holds the ingredients in no step; ticks are then per use of an ingredient.
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
  const reduceMotion = useReducedMotion();
  const scroll = useRef<ScrollView>(null);
  // Where the step cards start in the scroll content, and the step whose card to scroll to once it lays out.
  const stepsY = useRef(0);
  const pendingScroll = useRef<number | null>(null);
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
  // Mark step done ticks the current step, then scrolls to the next current card once it has laid out in its new
  // place (the step above it shrinks as it's done, so its old position is stale).
  const markDone = (index: number) => {
    toggleStep(index);
    const next = upNextIndex(stepsDone.map((on, i) => on || i === index));
    pendingScroll.current = next === -1 ? null : next;
  };
  const cardLaidOut = (index: number, y: number) => {
    if (pendingScroll.current !== index) return;
    pendingScroll.current = null;
    scroll.current?.scrollTo({ y: Math.max(0, stepsY.current + y - spacing.md), animated: !reduceMotion });
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
        ref={scroll}
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
          <View style={{ gap: spacing.md }} onLayout={(event) => (stepsY.current = event.nativeEvent.layout.y)}>
            {steps.map((step, index) => {
              const stepUses = matched ? match.steps[index] : [];
              const label = stepLabel(index, steps.length, step);
              const state: StepState = stepsDone[index] ? 'done' : index === upNext ? 'current' : 'upcoming';
              return (
                <StepCard
                  key={index}
                  number={index + 1}
                  text={step}
                  label={
                    stepUses.length > 0
                      ? t('recipes.cook.stepUses', { step: label, names: stepUses.map((use) => use.ingredient.displayName).join(', ') })
                      : label
                  }
                  state={state}
                  line={
                    state === 'upcoming' && stepUses.length > 0
                      ? stepUses
                          .map(({ ingredient: item, quantity }) =>
                            stepUseText(item, quantity, usesOf(item.id).length > 1, servings, base),
                          )
                          .join(' · ')
                      : null
                  }
                  onToggle={() => toggleStep(index)}
                  onDone={() => markDone(index)}
                  onLayout={(event) => cardLaidOut(index, event.nativeEvent.layout.y)}>
                  {state === 'current'
                    ? stepUses.map(({ ingredient: item, quantity }, n) => {
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
                      })
                    : []}
                </StepCard>
              );
            })}
            {/* The source credit under the last step (spec 4.5). */}
            <RecipeCredit sourceUrl={recipe.sourceUrl} underCard />
          </View>
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

type StepState = 'done' | 'current' | 'upcoming';

/**
 * A step's card (board B). **done**: a `primarySoft` round check, the text in `callout` `inkSecondary`.
 * **current** (the first unticked step): a 2 pt `primary` border, a filled `primary` number badge, the text in
 * `cookStepCurrent`, its ingredient rows (`children`) in a rounded inset, then Mark step done. **upcoming**: an
 * outlined `controlBorder` number badge, the text in `body`, and its ingredients as one `footnote` `line`. The badge
 * and text are one checkbox that toggles the step; the inset rows and the button are its siblings, so VoiceOver
 * reaches each one.
 */
function StepCard({
  number,
  text,
  label,
  state,
  line,
  onToggle,
  onDone,
  onLayout,
  children,
}: {
  number: number;
  text: string;
  label: string;
  state: StepState;
  /** An upcoming step's ingredients, "1 lemon · ½ tsp chili flakes · spaghetti"; null for none. */
  line: string | null;
  onToggle: () => void;
  onDone: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
  children: React.ReactNode[];
}) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const current = state === 'current';
  const done = state === 'done';
  const inset = current && children.length > 0;
  // Badge and text, then the inset, the line or the button, lined up with the text.
  const indent = spacing.lg + sizes.cookStepCheck + spacing.md;
  const below = current || line !== null;
  return (
    <Card
      onLayout={onLayout}
      style={current ? { borderWidth: sizes.cookCurrentBorder, borderColor: colors.primary } : undefined}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.step,
          {
            gap: spacing.md,
            paddingHorizontal: spacing.lg,
            paddingTop: current ? spacing.lg : spacing.md + spacing.xxs,
            paddingBottom: below ? spacing.sm + spacing.xxs : spacing.md + spacing.xxs,
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
              borderColor: done ? colors.primarySoft : current ? colors.primary : colors.controlBorder,
              backgroundColor: done ? colors.primarySoft : current ? colors.primary : colors.surface,
            },
          ]}>
          {done ? (
            <Icon name="checkmark" color="primary" weight="bold" size={sizes.iconSmall} />
          ) : (
            <ThemedText
              variant="amount"
              color={current ? 'onPrimary' : 'inkSecondary'}
              maxFontSizeMultiplier={1}
              style={styles.digit}>
              {number}
            </ThemedText>
          )}
        </View>
        <ThemedText
          variant={done ? 'callout' : current ? 'cookStepCurrent' : 'body'}
          color={done ? 'inkSecondary' : 'ink'}
          style={styles.flex}>
          {text}
        </ThemedText>
      </Pressable>
      {inset ? (
        <View
          style={{
            marginLeft: indent,
            marginRight: spacing.lg,
            marginBottom: spacing.md,
            borderRadius: rounded.md,
            overflow: 'hidden',
            backgroundColor: colors.background,
          }}>
          {children}
        </View>
      ) : null}
      {line !== null ? (
        // The step's label already names its ingredients, so VoiceOver skips the line.
        <ThemedText
          variant="footnote"
          color="inkSecondary"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ marginLeft: indent, marginRight: spacing.lg, marginBottom: spacing.md + spacing.xxs }}>
          {line}
        </ThemedText>
      ) : null}
      {current ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}>
          <PrimaryButton
            label={t('recipes.cook.markDone')}
            accessibilityLabel={t('recipes.cook.markDoneLabel', { number })}
            onPress={onDone}
          />
        </View>
      ) : null}
    </Card>
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
  struck: { textDecorationLine: 'line-through' },
});
