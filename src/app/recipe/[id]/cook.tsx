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
import { formatAmount } from '@/domain/quantity-display';
import { useKeepAwake } from '@/features/lists/keep-awake';
import { startingServings } from '@/features/recipes/add-to-list';
import { cookProgressLabel, scaledAmount, stepLabel, upNextIndex } from '@/features/recipes/recipe-view';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { displayItemName } from '@/shared';

const STEP_UNIT = ['step', 'steps'] as const;

/**
 * Cooking mode (board 19): a full-screen modal on one scrolling page, with the ingredients scaled to the
 * recipe screen's servings (`servings`) and the steps, each ticked off with a tap. The ticks are this screen's
 * state only, so they're gone when it closes; the screen stays on while it's open.
 */
export default function CookScreen() {
  const { id, servings: servingsParam } = useLocalSearchParams<{ id: string; servings?: string }>();
  const { spacing } = useTheme();
  const insets = useSafeAreaInsets();
  // Nothing here is edited, so read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const [ingredients] = useState(() => recipeIngredientsQuery(id).all());
  const steps = recipe?.steps ?? [];
  const [stepsDone, setStepsDone] = useState(() => steps.map(() => false));
  const [ingredientsDone, setIngredientsDone] = useState<ReadonlySet<string>>(() => new Set());
  useKeepAwake(`cook:${id}:${useId()}`, true);

  if (!recipe) return <Screen />;

  const base = recipe.servings;
  const servings = base === null ? null : startingServings(base, servingsParam);
  const upNext = upNextIndex(stepsDone);
  const done = stepsDone.filter(Boolean).length;

  const toggleStep = (index: number) => setStepsDone((ticked) => ticked.map((on, i) => (i === index ? !on : on)));
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
        {ingredients.length > 0 ? (
          <Card>
            <SectionHeader title="Ingredients" count={ingredients.length} />
            {ingredients.map((item) => {
              const amount =
                base !== null && servings !== null && servings !== base ? scaledAmount(item, servings, base) : formatAmount(item);
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
              title="Method"
              count={steps.length}
              countUnit={STEP_UNIT}
              hideCount
              trailing={
                <ThemedText
                  variant="footnote"
                  color="inkSecondary"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={styles.count}>
                  {`${steps.length} ${steps.length === 1 ? STEP_UNIT[0] : STEP_UNIT[1]}`}
                </ThemedText>
              }
            />
            {steps.map((step, index) => (
              <StepRow
                key={index}
                number={index + 1}
                text={step}
                label={stepLabel(index, steps.length, step)}
                checked={stepsDone[index]}
                upNext={index === upNext}
                onToggle={() => toggleStep(index)}
              />
            ))}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** ✕ (Done) on the left, the recipe's name over "For 6 · 2 of 6 steps done" in the middle. */
function TopBar({ name, progress, paddingTop }: { name: string; progress: string; paddingTop: number }) {
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
        accessibilityLabel="Done"
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
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={amount ? `${name}, ${amount}` : name}
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
 * A step to tick off: its number in a ringed circle that fills `primary` with a check when ticked (the text then
 * dims), and the text in `cookStep`. The first unticked step is tinted "Up next". The whole row is the target.
 */
function StepRow({
  number,
  text,
  label,
  checked,
  upNext,
  onToggle,
}: {
  number: number;
  text: string;
  label: string;
  checked: boolean;
  upNext: boolean;
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
        styles.step,
        {
          gap: spacing.md + spacing.xxs,
          padding: spacing.lg,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          backgroundColor: upNext ? colors.primarySoft : undefined,
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
            Up next
          </ThemedText>
        ) : null}
        <ThemedText variant="cookStep" color={checked ? 'inkSecondary' : 'ink'}>
          {text}
        </ThemedText>
      </View>
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
