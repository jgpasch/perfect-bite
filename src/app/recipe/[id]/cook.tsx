import { router, useLocalSearchParams } from 'expo-router';
import { useId, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { itemNameColor } from '@/components/appearance';
import { Button, PrimaryButton } from '@/components/button';
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
  cookPlan,
  tickUses,
  withCookPick,
  type CookCurrent,
  toggleAllUses,
  toggleUse,
  stepAmount,
  stepUseText,
  tickKey,
  usesByIngredient,
} from '@/features/recipes/cook-match';
import { useEnsureStepMatch } from '@/features/recipes/ensure-step-match';
import { RecipeCredit } from '@/features/recipes/recipe-credit';
import { cookProgressLabel, stepLabel } from '@/features/recipes/recipe-view';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { stepMatch } from '@/features/recipes/step-match';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName, stepPath, stepTexts } from '@/shared';

/** The text scale from which the current step's pills go one per line: iOS's largest accessibility sizes (AX3 on). */
const PILLS_STACK_FONT_SCALE = 2;

/**
 * Cooking mode (board 19, and board B "Steps with their ingredients"): a full-screen modal on one scrolling page,
 * with the ingredients scaled to the recipe screen's servings (`servings`) and a card per step, each ticked off
 * with a tap; the first unticked step is the current one, with Mark step done. The ticks are this screen's state
 * only, so they're gone when it closes; the screen stays on while it's open. With a step match (spec 4.5), the
 * current step lists its ingredients and the upcoming ones name theirs on one line, the checklist folds into All
 * ingredients, and Also needed holds the ingredients in no step; ticks are then per use of an ingredient.
 * With step sections (boards B and C, `cookPlan`), the cards sit under their sections' titles; a choice group
 * stands as "How are you cooking it?" until an option is picked, then as that section with Change method; and a
 * named section all ticked behind the current step folds to one row. Picks and folds are screen state too.
 */
export default function CookScreen() {
  const { id, servings: servingsParam } = useLocalSearchParams<{ id: string; servings?: string }>();
  const t = useT();
  const { spacing } = useTheme();
  const insets = useSafeAreaInsets();
  // Nothing here is edited, so read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const [ingredients] = useState(() => recipeIngredientsQuery(id).all());
  // The step strings, which the ticks, numbers and match follow; the headings shape the page (`cookPlan`).
  const steps = stepTexts(recipe?.steps);
  const [stepsDone, setStepsDone] = useState(() => steps.map(() => false));
  // The option picked in each choice group (null until one is), and the folded sections unfolded by a tap.
  const [picks, setPicks] = useState<readonly (number | null)[]>([]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const [ingredientsDone, setIngredientsDone] = useState<ReadonlySet<string>>(() => new Set());
  // With a match: the ticked uses (`tickKey`), and whether All ingredients is unfolded.
  const [usesDone, setUsesDone] = useState<ReadonlySet<string>>(() => new Set());
  const [unfolded, setUnfolded] = useState(false);
  const [match] = useState(() => (recipe ? stepMatch(recipe, ingredients) : null));
  const reduceMotion = useReducedMotion();
  // At the largest text sizes the current step's pills go one per line.
  const stacked = useWindowDimensions().fontScale >= PILLS_STACK_FONT_SCALE;
  const scroll = useRef<ScrollView>(null);
  // Where the step cards start in the scroll content, and the card (`cardKey`) to scroll to once it lays out.
  const stepsY = useRef(0);
  const pendingScroll = useRef<string | null>(null);
  useKeepAwake(`cook:${id}:${useId()}`, true);
  // Opening cook mode matches the recipe's steps if they need it (spec 4.5).
  useEnsureStepMatch(id);

  if (!recipe) return <Screen />;

  const base = recipe.servings;
  const servings = base === null ? null : startingServings(base, servingsParam);
  const plan = cookPlan(recipe.steps, picks, stepsDone, opened);
  // Steps are numbered and counted along the path shown (each group's first option until one is picked).
  const pathLength = stepPath(recipe.steps, picks).length;

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
  // Mark step done ticks the current step, then scrolls to the next current card (a step, or the method picker)
  // once it has laid out in its new place (the step above it shrinks as it's done, so its old position is stale).
  const markDone = (index: number) => {
    toggleStep(index);
    const next = cookPlan(recipe.steps, picks, stepsDone.map((on, i) => on || i === index), opened).current;
    pendingScroll.current = next === null ? null : cardKey(next);
  };
  const cardLaidOut = (key: string, y: number) => {
    if (pendingScroll.current !== key) return;
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
        progress={cookProgressLabel(servings, plan.done, plan.total, plan.picking)}
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
            {plan.blocks.map((block) => {
              if (block.kind === 'title') {
                return (
                  <SectionTitle
                    key={`title-${block.section}`}
                    title={block.title}
                    onChange={block.group === null ? undefined : () => setPicks((p) => withCookPick(p, block.group!, null))}
                  />
                );
              }
              if (block.kind === 'fold') {
                return (
                  <FoldedSection
                    key={`fold-${block.section}`}
                    title={block.title}
                    count={block.count}
                    onOpen={() => setOpened((open) => new Set(open).add(block.section))}
                  />
                );
              }
              if (block.kind === 'picker') {
                return (
                  <MethodPicker
                    key={`picker-${block.group}`}
                    options={block.options}
                    current={block.current}
                    onPick={(option) => setPicks((p) => withCookPick(p, block.group, option))}
                    onLayout={(event) => cardLaidOut(cardKey({ kind: 'picker', group: block.group }), event.nativeEvent.layout.y)}
                  />
                );
              }
              const { index, number, state } = block;
              const step = steps[index];
              const stepUses = matched ? match.steps[index] : [];
              const label = stepLabel(number - 1, pathLength, step);
              return (
                <StepCard
                  key={index}
                  number={number}
                  text={step}
                  label={
                    stepUses.length > 0
                      ? t('recipes.cook.stepUses', { step: label, names: stepUses.map((use) => use.ingredient.displayName).join(', ') })
                      : label
                  }
                  state={state}
                  stacked={stacked}
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
                  onLayout={(event) => cardLaidOut(cardKey({ kind: 'step', index }), event.nativeEvent.layout.y)}>
                  {state === 'current'
                    ? stepUses.map(({ ingredient: item, quantity }) => {
                        const key = tickKey(index, item.id);
                        const split = usesOf(item.id).length > 1;
                        const amount = stepAmount(item, quantity, split, servings, base);
                        const name = displayItemName(item.displayName);
                        return (
                          <IngredientPill
                            key={key}
                            text={stepUseText(item, quantity, split, servings, base)}
                            stacked={stacked}
                            label={
                              amount.spoken
                                ? t('recipes.cook.stepIngredient', { name, amount: amount.spoken, number })
                                : t('recipes.cook.stepIngredientNoAmount', { name, number })
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

/** The key a card is scrolled to by: a step's, or a choice group's picker. */
function cardKey(card: NonNullable<CookCurrent>): string {
  return card.kind === 'step' ? `step:${card.index}` : `picker:${card.group}`;
}

/** A named section's title over its cards (`sectionLabel` `inkSecondary`, a header); a picked option's has Change method. */
function SectionTitle({ title, onChange }: { title: string; onChange?: () => void }) {
  const t = useT();
  const { spacing, sizes } = useTheme();
  return (
    <View
      style={[
        styles.row,
        { gap: spacing.sm, minHeight: onChange ? sizes.minTapTarget : undefined, paddingTop: spacing.xs, paddingHorizontal: spacing.lg + spacing.xs },
      ]}>
      <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={styles.flex}>
        {title}
      </ThemedText>
      {onChange ? <Button variant="plain" label={t('recipes.cook.changeMethod')} onPress={onChange} /> : null}
    </View>
  );
}

/** A named section all ticked and behind the current step (board C): one row, its title and "3 done", that unfolds on a tap. */
function FoldedSection({ title, count, onOpen }: { title: string; count: number; onOpen: () => void }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Card>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityState={{ expanded: false }}
        accessibilityLabel={t('recipes.cook.foldLabel', { title, count })}
        style={({ pressed }) => [
          styles.row,
          { gap: spacing.sm + spacing.xxs, minHeight: sizes.rowMin, paddingHorizontal: spacing.lg, opacity: pressed ? opacity.pressed : 1 },
        ]}>
        <View
          style={[
            styles.center,
            {
              width: sizes.cookIngredientCheck,
              height: sizes.cookIngredientCheck,
              borderRadius: rounded.full,
              backgroundColor: colors.primarySoft,
            },
          ]}>
          <Icon name="checkmark" color="primary" weight="bold" size={sizes.iconSmall} />
        </View>
        <ThemedText variant="amount" style={styles.flex}>
          {title}
        </ThemedText>
        <ThemedText variant="subhead" color="inkSecondary">
          {t('recipes.cook.foldDone', { count })}
        </ThemedText>
        <Icon name="chevron.down" color="inkTertiary" size={sizes.iconSmall} />
      </Pressable>
    </Card>
  );
}

/**
 * A choice group with no pick (board B): "How are you cooking it?" and a row per option (its title, "4 steps",
 * a chevron; at least 56 pt). The current card's border once every step before it is ticked.
 */
function MethodPicker({
  options,
  current,
  onPick,
  onLayout,
}: {
  options: { title: string; count: number }[];
  current: boolean;
  onPick: (option: number) => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Card
      onLayout={onLayout}
      style={[
        { paddingTop: spacing.lg, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
        current ? { borderWidth: sizes.cookCurrentBorder, borderColor: colors.primary } : undefined,
      ]}>
      <ThemedText variant="cookStepCurrent" accessibilityRole="header">
        {t('recipes.cook.howCooking')}
      </ThemedText>
      <ThemedText variant="subhead" color="inkSecondary" style={{ marginTop: spacing.xxs, marginBottom: spacing.sm }}>
        {t('recipes.cook.howCookingNote', { count: options.length })}
      </ThemedText>
      {options.map((option, o) => {
        const steps = t('recipes.cook.optionSteps', { count: option.count });
        return (
          <Pressable
            key={o}
            onPress={() => onPick(o)}
            accessibilityRole="button"
            accessibilityLabel={t('recipes.cook.optionLabel', { title: option.title, steps })}
            style={({ pressed }) => [
              styles.row,
              {
                gap: spacing.md,
                minHeight: sizes.cardRowMin + spacing.sm - spacing.xxs,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.border,
                opacity: pressed ? opacity.pressed : 1,
              },
            ]}>
            <ThemedText variant="headline" style={styles.flex}>
              {option.title}
            </ThemedText>
            <ThemedText variant="callout" color="inkSecondary">
              {steps}
            </ThemedText>
            <Icon name="chevron.right" color="inkTertiary" size={sizes.iconSmall} />
          </Pressable>
        );
      })}
    </Card>
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

/** An ingredient to tick off: round check, name in `cookStep` (struck through when ticked), amount. The whole row is the target. */
function IngredientRow({
  name,
  amount,
  checked,
  onToggle,
}: {
  name: string;
  amount: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={amount ? t('recipes.cook.ingredient', { name, amount }) : name}
      style={({ pressed }) => [
        styles.row,
        {
          gap: spacing.md,
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <CheckCircle checked={checked} />
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
 * One of the current step's ingredients as a pill to tick off (board B): a `surfaceMuted` rounded pill, at least
 * 44 pt tall, with a 22 pt check and the use amount first ("2 tbsp butter", "1 of 3 limes"); ticked, the check fills
 * and the text goes `inkSecondary`. `stacked` stretches it to the line, one per line at the largest text sizes.
 */
function IngredientPill({
  text,
  label,
  checked,
  stacked,
  onToggle,
}: {
  text: string;
  label: string;
  checked: boolean;
  stacked: boolean;
  onToggle: () => void;
}) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        {
          alignSelf: stacked ? 'stretch' : 'flex-start',
          maxWidth: '100%',
          gap: spacing.sm,
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs,
          borderRadius: rounded.full,
          backgroundColor: colors.surfaceMuted,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <CheckCircle checked={checked} size={sizes.cookIngredientCheck} />
      <ThemedText variant="callout" color={checked ? 'inkSecondary' : 'ink'} style={styles.shrink}>
        {text}
      </ThemedText>
    </Pressable>
  );
}

type StepState = 'done' | 'current' | 'upcoming';

/**
 * A step's card (board B). **done**: a `primarySoft` round check, the text in `callout` `inkSecondary`.
 * **current** (the first unticked step): a 2 pt `primary` border, a filled `primary` number badge, the text in
 * `cookStepCurrent`, its ingredient pills (`children`) wrapping under the text, then Mark step done. **upcoming**: an
 * outlined `controlBorder` number badge, the text in `body`, and its ingredients as one `footnote` `line`. The badge
 * and text are one checkbox that toggles the step; the pills and the button are its siblings, so VoiceOver
 * reaches each one.
 */
function StepCard({
  number,
  text,
  label,
  state,
  stacked,
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
  /** The pills one per line, at the largest text sizes. */
  stacked: boolean;
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
  const pills = current && children.length > 0;
  // Badge and text, then the pills, the line or the button, lined up with the text.
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
      {pills ? (
        <View
          style={[
            stacked ? styles.stack : styles.wrap,
            { gap: spacing.sm, marginLeft: indent, marginRight: spacing.lg, marginBottom: spacing.md },
          ]}>
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
  shrink: { flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  step: { flexDirection: 'row', alignItems: 'flex-start' },
  center: { alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, alignItems: 'center' },
  centredText: { textAlign: 'center' },
  count: { fontWeight: '600' },
  digit: { fontWeight: '700' },
  struck: { textDecorationLine: 'line-through' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
  stack: { flexDirection: 'column' },
});
