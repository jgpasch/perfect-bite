import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { listItemContributions } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { formatAmount } from '@/domain/quantity-display';
import { summarizeAmounts } from '@/domain/quantity-math';
import { getAccount } from '@/features/auth/account';
import { createCategory, getIngredientCategory, getOrderedCategories } from '@/features/categories/categories';
import {
  contributionsQuery,
  deleteContribution,
  deleteItem,
  getItemEdit,
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
  const amount = amountTouched || contributions.length === 0 ? edit.amount : summarizeAmounts(contributions);

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
  option: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
});
