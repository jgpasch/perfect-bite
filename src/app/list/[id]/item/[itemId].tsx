import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, View } from 'react-native';

import { aisleSymbol, prominentButtonTint } from '@/components/appearance';
import { SoftDangerButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { listItemContributions } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { addedLine } from '@/domain/added-by';
import { aisleColor } from '@/domain/aisle-color';
import { categoryNameById, effectiveCategoryId, SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { formatAmount, type Amount } from '@/domain/quantity-display';
import { getAccount } from '@/features/auth/account';
import { canStepDown, unitLabel, unitMenuChoice, unitMenuOptions, withUnit } from '@/features/lists/amount-stepper';
import { createCategory, getIngredientCategory, getOrderedCategories } from '@/features/categories/categories';
import { categorizePending } from '@/features/categories/categorization';
import {
  contributionsQuery,
  deleteContribution,
  deleteItem,
  getItemEdit,
  getItemHouseholdName,
  itemTotal,
  setItemAmount,
  steppableAmount,
  stepItemAmount,
  updateItem,
  type ItemEdit,
} from '@/features/lists/items';
import { useTheme } from '@/hooks/use-theme';
import { OTHER_CATEGORY_ID } from '@/shared';

/** Item edit sheet (spec 4.2, 4.3.2, board 04): name, amount, note, aisle, and the amounts added. */
export default function ItemEditSheet() {
  const { itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
  const { spacing, sizes, scheme, colors } = useTheme();
  const userId = getAccount()?.userId ?? null;
  const [initial] = useState(() => getItemEdit(itemId));
  const [householdName] = useState(() => getItemHouseholdName(itemId));
  const [edit, setEdit] = useState<ItemEdit | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [categoryList, setCategoryList] = useState(() => (userId ? getOrderedCategories(userId) : []));
  const current = useMemo(
    () => (userId && initial ? getIngredientCategory(userId, initial.ingredientName) : null),
    [userId, initial],
  );
  const { data: contributions } = useLiveQueryOn(contributionsQuery(itemId), [listItemContributions], [itemId]);
  const [amountTouched, setAmountTouched] = useState(false);

  if (!edit || !initial) return <Screen />;

  // Deleting an amount below changes the total; follow it until the user types their own.
  const amount = amountTouched || contributions.length === 0 ? edit.amount : itemTotal(contributions, initial.usualUnit);
  // The − / + and unit picker work on the total as one amount; null (`2 cans + 400 g`) disables them.
  const steppable = steppableAmount(contributions, initial.usualUnit);

  // A pending ingredient's default is "Sorting..." until categorization returns (spec 4.3.1).
  const defaultId = current
    ? effectiveCategoryId(null, current.defaultCategoryId, current.status)
    : OTHER_CATEGORY_ID;
  // undefined: untouched (show the override or default); null: reset to default.
  const selectedId =
    edit.categoryId === undefined ? (current?.overrideCategoryId ?? defaultId) : (edit.categoryId ?? defaultId);
  const isOverride = selectedId !== defaultId;
  const categoryName = (id: string) => categoryNameById(categoryList, id);
  const slugOf = (id: string) => categoryList.find((c) => c.id === id)?.slug ?? null;
  // Sorting… isn't one of the user's aisles, so it gets its own pill while it's the default.
  const sortingDefault = defaultId === SORTING_CATEGORY_ID;
  const sorting = selectedId === SORTING_CATEGORY_ID;
  const hue = sorting ? 'amber' : aisleColor(slugOf(selectedId));

  const chooseCategory = (id: string) => {
    setEdit({ ...edit, categoryId: id === defaultId ? null : id });
  };

  const newCategory = () => {
    if (!userId) return;
    Alert.prompt('New aisle', undefined, (name) => {
      if (!name?.trim()) return;
      const id = createCategory(userId, name);
      setCategoryList(getOrderedCategories(userId));
      chooseCategory(id);
    });
  };

  const set = (field: keyof ItemEdit) => (value: string) => {
    setEdit({ ...edit, [field]: value });
    setError(null);
  };

  // The stepper and unit picker save right away, like deleting an amount; the field follows.
  const saveAmount = (write: () => void) => {
    try {
      write();
      setAmountTouched(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseUnit = () => {
    if (!steppable) return;
    ActionSheetIOS.showActionSheetWithOptions({ title: 'Unit', ...unitMenuOptions() }, (index) => {
      const unit = unitMenuChoice(index);
      const next = unit === undefined ? null : withUnit(steppable, unit);
      if (next) saveAmount(() => setItemAmount(itemId, next));
    });
  };

  const save = () => {
    try {
      // Choosing the default again only needs a write if there was an override to remove.
      const categoryId = edit.categoryId === null && !current?.overrideCategoryId ? undefined : edit.categoryId;
      void categorizePending(updateItem(itemId, { ...edit, amount, categoryId }, userId));
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const now = new Date();
  const labelInset = { paddingHorizontal: spacing.xxl };

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.md }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={save}>
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <View style={[styles.row, { paddingHorizontal: spacing.lg + spacing.xs, paddingVertical: spacing.xs, gap: spacing.md }]}>
        <IconTile hue={hue} name={sorting ? 'hourglass' : aisleSymbol(slugOf(selectedId))} size={sizes.sheetIcon} />
        <View style={styles.flex}>
          <ThemedText variant="sheetTitle" accessibilityRole="header" numberOfLines={2}>
            {edit.name.trim() || initial.name}
          </ThemedText>
          {amount ? (
            <ThemedText variant="amount" color="inkSecondary">
              {amount}
            </ThemedText>
          ) : null}
        </View>
      </View>

      <Card>
        <FieldRow label="Name" first>
          <InlineField value={edit.name} onChangeText={set('name')} accessibilityLabel="Name" returnKeyType="done" />
        </FieldRow>
        <FieldRow label="Amount">
          <InlineField
            value={amount}
            onChangeText={(value) => {
              setAmountTouched(true);
              set('amount')(value);
            }}
            placeholder="e.g. 2 lb"
            accessibilityLabel="Amount"
            autoCapitalize="none"
            returnKeyType="done"
          />
          <AmountStepper
            amount={steppable}
            totalText={amount}
            canDecrease={!!steppable && canStepDown(steppable, initial.usualUnit)}
            onStep={(direction) => saveAmount(() => stepItemAmount(itemId, direction, initial.usualUnit))}
            onChooseUnit={chooseUnit}
          />
        </FieldRow>
        <FieldRow label="Note">
          <InlineField
            value={edit.note}
            onChangeText={set('note')}
            placeholder="e.g. the big bag"
            accessibilityLabel="Note"
            multiline
          />
        </FieldRow>
      </Card>

      {contributions.length > 1 ? (
        // Spec 4.4: each add is listed with a delete control (Undo / Keep existing, later).
        <>
          <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={labelInset}>
            Added
          </ThemedText>
          <Card>
            {contributions.map((c, i) => {
              const text = formatAmount(c) || 'No amount';
              return (
                <CardRow key={c.id} first={i === 0}>
                  <ThemedText variant="headline">{text}</ThemedText>
                  <ThemedText variant="amount" color="inkSecondary" style={styles.flex}>
                    {addedLine(c, userId, now)}
                  </ThemedText>
                  <RemoveButton
                    accessibilityLabel={`Remove ${text}`}
                    accessibilityHint="Removes this amount"
                    onPress={() => deleteContribution(c.id)}
                  />
                </CardRow>
              );
            })}
          </Card>
        </>
      ) : null}

      {userId ? (
        <>
          <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={labelInset}>
            Aisle
          </ThemedText>
          <View style={[styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
            {sortingDefault ? (
              <Pill
                label={categoryName(SORTING_CATEGORY_ID)}
                selected={sorting}
                hue="amber"
                onPress={() => chooseCategory(defaultId)}
              />
            ) : null}
            {categoryList.map((c) => (
              <Pill
                key={c.id}
                label={c.name}
                selected={c.id === selectedId}
                hue={aisleColor(c.slug)}
                onPress={() => chooseCategory(c.id)}
              />
            ))}
            <Pill label="+ New" accessibilityLabel="New aisle" dashed onPress={newCategory} />
          </View>
          {isOverride ? (
            <ThemedText variant="footnote" color="inkSecondary" style={labelInset}>
              {householdName
                ? `Just for you. Others in ${householdName} still see ${categoryName(defaultId)}.`
                : `Just for you. Others still see ${categoryName(defaultId)}.`}
            </ThemedText>
          ) : null}
        </>
      ) : null}

      {error ? (
        <ThemedText variant="footnote" color="danger" accessibilityRole="alert" style={{ paddingHorizontal: spacing.lg }}>
          {error}
        </ThemedText>
      ) : null}

      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg }}>
        <SoftDangerButton
          label="Delete item"
          onPress={() => {
            deleteItem(itemId);
            router.back();
          }}
        />
      </View>
    </Screen>
  );
}

const DISABLED_HINT = 'Edit the amount as text';

/** − / + and a unit button under the Amount field (spec 4.4). Disabled when `amount` is null. */
function AmountStepper({
  amount,
  totalText,
  canDecrease,
  onStep,
  onChooseUnit,
}: {
  amount: Amount | null;
  totalText: string;
  canDecrease: boolean;
  onStep: (direction: 1 | -1) => void;
  onChooseUnit: () => void;
}) {
  const { spacing } = useTheme();
  const disabledHint = amount ? undefined : DISABLED_HINT;
  return (
    <View style={[styles.row, { gap: spacing.sm, paddingBottom: spacing.sm }]}>
      <StepperButton
        icon="minus"
        accessibilityLabel="Decrease amount"
        accessibilityHint={disabledHint}
        disabled={!amount || !canDecrease}
        onPress={() => onStep(-1)}
      />
      <ThemedText variant="amount" style={[styles.flex, styles.center]} numberOfLines={1}>
        {amount ? formatAmount(amount) : totalText}
      </ThemedText>
      <StepperButton
        icon="plus"
        accessibilityLabel="Increase amount"
        accessibilityHint={disabledHint}
        disabled={!amount}
        onPress={() => onStep(1)}
      />
      <StepperButton
        icon="chevron.up.chevron.down"
        label={amount ? unitLabel(amount.unit) : undefined}
        accessibilityLabel={amount ? `Unit, ${unitLabel(amount.unit)}` : 'Unit'}
        accessibilityHint={disabledHint ?? 'Shows the units'}
        disabled={!amount}
        onPress={onChooseUnit}
      />
    </View>
  );
}

/** A round 44 pt `surfaceMuted` button for the stepper; with a `label` it grows into a pill. */
function StepperButton({
  icon,
  label,
  accessibilityLabel,
  accessibilityHint,
  disabled,
  onPress,
}: {
  icon: IconName;
  label?: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        styles.centered,
        {
          minHeight: sizes.minTapTarget,
          minWidth: sizes.minTapTarget,
          paddingHorizontal: label ? spacing.md : 0,
          gap: spacing.xs,
          borderRadius: rounded.full,
          backgroundColor: colors.surfaceMuted,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}>
      {label ? <ThemedText variant="amount">{label}</ThemedText> : null}
      <Icon name={icon} color={label ? 'inkSecondary' : 'ink'} size={label ? sizes.iconSmall : sizes.icon} weight="semibold" />
    </Pressable>
  );
}

/** The soft red round − on an "Added" row: 32 pt, with a 44 pt hit area. */
function RemoveButton({
  accessibilityLabel,
  accessibilityHint,
  onPress,
}: {
  accessibilityLabel: string;
  accessibilityHint: string;
  onPress: () => void;
}) {
  const { colors, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      hitSlop={(sizes.minTapTarget - sizes.removeButton) / 2}
      onPress={onPress}
      style={({ pressed }) => [
        styles.centered,
        {
          width: sizes.removeButton,
          height: sizes.removeButton,
          borderRadius: rounded.full,
          backgroundColor: colors.dangerSoft,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name="minus" color="danger" weight="bold" />
    </Pressable>
  );
}

/** A row inside a card: 16 pt sides, at least 50 pt tall, a hairline above all but the first. */
function CardRow({ first, children }: { first?: boolean; children: ReactNode }) {
  const { colors, spacing, sizes } = useTheme();
  return (
    <View
      style={[
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          gap: spacing.md,
          borderTopWidth: first ? 0 : 1,
          borderTopColor: colors.border,
        },
      ]}>
      {children}
    </View>
  );
}

/** A labelled field inside the card: the label in a 76 pt column, the input (and any extras) beside it. */
function FieldRow({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
  const { sizes, spacing } = useTheme();
  return (
    <CardRow first={first}>
      {/* Top-aligned with the input's first line, so it stays put beside a multiline note or the stepper. */}
      <ThemedText
        variant="amount"
        color="inkSecondary"
        style={[styles.label, { minWidth: sizes.fieldLabel, paddingTop: spacing.md }]}>
        {label}
      </ThemedText>
      <View style={styles.flex}>{children}</View>
    </CardRow>
  );
}

/** A borderless input for a `FieldRow`: the card is its surface. */
function InlineField(props: ComponentProps<typeof TextField>) {
  return <TextField {...props} style={styles.inline} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  centered: { alignItems: 'center', justifyContent: 'center' },
  label: { alignSelf: 'flex-start' },
  inline: { borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0 },
});
