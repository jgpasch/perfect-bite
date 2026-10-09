import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { listItemContributions } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { formatAmount, type Amount } from '@/domain/quantity-display';
import { getAccount } from '@/features/auth/account';
import { canStepDown, unitLabel, unitMenuChoice, unitMenuOptions, withUnit } from '@/features/lists/amount-stepper';
import { createCategory, getIngredientCategory, getOrderedCategories } from '@/features/categories/categories';
import {
  contributionsQuery,
  deleteContribution,
  deleteItem,
  getItemEdit,
  itemTotal,
  setItemAmount,
  steppableAmount,
  stepItemAmount,
  updateItem,
  type ItemEdit,
} from '@/features/lists/items';
import { useTheme } from '@/hooks/use-theme';
import { OTHER_CATEGORY_ID } from '@/shared';

/** Item edit sheet (spec 4.2, 4.3.2): name, amount, note, category. M3 lists contributions. */
export default function ItemEditSheet() {
  const { itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
  const { spacing } = useTheme();
  const userId = getAccount()?.userId ?? null;
  const [initial] = useState(() => getItemEdit(itemId));
  const [edit, setEdit] = useState<ItemEdit | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [categoryList, setCategoryList] = useState(() => (userId ? getOrderedCategories(userId) : []));
  const [pickingCategory, setPickingCategory] = useState(false);
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

  const defaultId = current?.defaultCategoryId ?? OTHER_CATEGORY_ID;
  // undefined: untouched (show the override or default); null: reset to default.
  const selectedId =
    edit.categoryId === undefined ? (current?.overrideCategoryId ?? defaultId) : (edit.categoryId ?? defaultId);
  const isOverride = selectedId !== defaultId;
  const categoryName = (id: string) => categoryList.find((c) => c.id === id)?.name ?? 'Other';

  const chooseCategory = (id: string) => {
    setEdit({ ...edit, categoryId: id === defaultId ? null : id });
    setPickingCategory(false);
  };

  const newCategory = () => {
    if (!userId) return;
    Alert.prompt('New category', undefined, (name) => {
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
      updateItem(itemId, { ...edit, amount, categoryId }, userId);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Screen scroll keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" onPress={save}>
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <Field label="Name">
        <TextField value={edit.name} onChangeText={set('name')} accessibilityLabel="Name" returnKeyType="done" />
      </Field>
      <Field label="Amount">
        <TextField
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
      </Field>
      {contributions.length > 1 ? (
        // Spec 4.4: each add is listed with a delete control (Undo / Keep existing, later).
        <Field label="Added">
          {contributions.map((c) => (
            <Option
              key={c.id}
              label={formatAmount(c) || 'No amount'}
              detail={c.source === 'recipe' ? 'From a recipe' : c.source === 'siri' ? 'From Siri' : undefined}
              icon="minus.circle"
              accessibilityHint="Removes this amount"
              onPress={() => deleteContribution(c.id)}
            />
          ))}
        </Field>
      ) : null}
      <Field label="Note">
        <TextField
          value={edit.note}
          onChangeText={set('note')}
          placeholder="e.g. the big bag"
          accessibilityLabel="Note"
          multiline
        />
      </Field>

      {userId ? (
        <Field label="Category">
          <Option
            label={categoryName(selectedId)}
            detail={isOverride ? 'Just for you' : undefined}
            icon={pickingCategory ? 'chevron.down' : 'chevron.right'}
            accessibilityHint="Shows the categories"
            onPress={() => setPickingCategory((v) => !v)}
          />
          {pickingCategory ? (
            <View>
              {categoryList.map((c) => (
                <Option
                  key={c.id}
                  label={c.name}
                  icon={c.id === selectedId ? 'checkmark' : undefined}
                  selected={c.id === selectedId}
                  onPress={() => chooseCategory(c.id)}
                />
              ))}
              <Option label="New category…" icon="plus" onPress={newCategory} />
              {isOverride ? (
                <Option label={`Reset to default (${categoryName(defaultId)})`} icon="arrow.uturn.backward" onPress={() => chooseCategory(defaultId)} />
              ) : null}
            </View>
          ) : null}
        </Field>
      ) : null}

      {error ? (
        <ThemedText variant="footnote" color="danger" accessibilityRole="alert">
          {error}
        </ThemedText>
      ) : null}

      <Button
        label="Delete item"
        variant="secondary"
        onPress={() => {
          deleteItem(itemId);
          router.back();
        }}
      />
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
    <View style={[styles.row, { gap: spacing.sm }]}>
      <StepperButton
        icon="minus"
        accessibilityLabel="Decrease amount"
        accessibilityHint={disabledHint}
        disabled={!amount || !canDecrease}
        onPress={() => onStep(-1)}
      />
      <ThemedText variant="body" style={[styles.flex, styles.center]} numberOfLines={1}>
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
          minHeight: sizes.rowMin,
          minWidth: sizes.rowMin,
          paddingHorizontal: spacing.md,
          gap: spacing.xs,
          borderRadius: rounded.md,
          backgroundColor: colors.surfaceMuted,
          opacity: disabled ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}>
      {label ? <ThemedText variant="body">{label}</ThemedText> : null}
      <Icon name={icon} color={label ? 'inkSecondary' : 'ink'} size={label ? sizes.iconSmall : sizes.icon} />
    </Pressable>
  );
}

function Option({
  label,
  detail,
  icon,
  selected,
  accessibilityHint,
  onPress,
}: {
  label: string;
  detail?: string;
  icon?: IconName;
  selected?: boolean;
  accessibilityHint?: string;
  onPress: () => void;
}) {
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        {
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.md,
          gap: spacing.sm,
          borderBottomColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="body" style={styles.flex}>
        {label}
      </ThemedText>
      {detail ? (
        <ThemedText variant="footnote" color="inkSecondary">
          {detail}
        </ThemedText>
      ) : null}
      {icon ? <Icon name={icon} color={selected ? 'primary' : 'inkSecondary'} size={sizes.iconSmall} /> : null}
    </Pressable>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.xs }}>
        {label}
      </ThemedText>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  centered: { justifyContent: 'center' },
  option: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
});
