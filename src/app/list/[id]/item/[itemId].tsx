import { Host, Menu, RNHostView, Section, Text as SwiftText, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, View } from 'react-native';

import { aisleSymbol, prominentButtonTint } from '@/components/appearance';
import { Button, PrimaryButton, SoftDangerButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { listItemContributions, listItems } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { addedLine, checkedLine } from '@/domain/added-by';
import { aisleColor } from '@/domain/aisle-color';
import { categoryNameById, effectiveCategoryId, SORTING_CATEGORY_ID } from '@/domain/category-resolver';
import { formatAmount, type Amount } from '@/domain/quantity-display';
import { getAccount } from '@/features/auth/account';
import {
  canStepDown,
  quantityText,
  typedAmount,
  unitLabel,
  unitMenuSections,
  withUnit,
} from '@/features/lists/amount-stepper';
import { createCategory, getIngredientCategory, getOrderedCategories } from '@/features/categories/categories';
import { categorizePending } from '@/features/categories/categorization';
import {
  contributionsQuery,
  deleteContribution,
  deleteItem,
  getItemEdit,
  getItemHouseholdName,
  getMoveTargets,
  itemStatusQuery,
  itemTotal,
  moveItemToList,
  setItemAmount,
  setItemChecked,
  steppableAmount,
  stepItemAmount,
  updateItem,
  type ItemEdit,
} from '@/features/lists/items';
import { setMoveResult } from '@/features/lists/move-result';
import { useTheme } from '@/hooks/use-theme';
import { displayItemName, OTHER_CATEGORY_ID, type Unit } from '@/shared';

/**
 * Item edit sheet (spec 4.2, 4.3.2, board 04): Got it / Still need it, name, amount, note, the
 * amounts added (a recipe's opens it), aisle, and Move to another list.
 */
export default function ItemEditSheet() {
  const { itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
  const { spacing, sizes, scheme, colors, opacity } = useTheme();
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
  const { data: statusRows } = useLiveQueryOn(itemStatusQuery(itemId), [listItems], [itemId]);
  const status = statusRows[0];
  // Move is left out when the household has no other list.
  const [moveTargets] = useState(() => getMoveTargets(itemId));
  const [amountTouched, setAmountTouched] = useState(false);
  // The number field's text while it's being typed in; null shows the saved quantity.
  const [quantityDraft, setQuantityDraft] = useState<string | null>(null);

  if (!edit || !initial) return <Screen />;

  // Deleting an amount below changes the total; follow it until the user types their own.
  const amount = amountTouched || contributions.length === 0 ? edit.amount : itemTotal(contributions, initial.usualUnit);
  // The number field, − / + and unit menu work on the total as one amount; null (`2 cans + 400 g`)
  // disables them and the amount is edited as text.
  const steppable = steppableAmount(contributions, initial.usualUnit);
  // What the number field shows: no number when the item has no amount, in the unit the menu ticks.
  const shown: Amount | null = steppable && { quantity: amount ? steppable.quantity : null, unit: steppable.unit };

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

  // The stepper, unit menu and number field save right away, like deleting an amount; the field follows.
  const saveAmount = (write: () => void): boolean => {
    try {
      write();
      setAmountTouched(false);
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  /**
   * Saves a typed number (on blur, Save, or before − / + or a unit). Returns the amount it saved,
   * null when there was nothing to save, or false when the text isn't a number.
   */
  const commitQuantity = (): Amount | null | false => {
    if (quantityDraft === null || !shown) return null;
    const next = typedAmount(quantityDraft, shown);
    if (next === undefined) {
      setError(`"${quantityDraft.trim()}" isn't a number, like 2 or 1.5`);
      return false;
    }
    setQuantityDraft(null);
    if (!next) return null;
    return saveAmount(() => setItemAmount(itemId, next)) ? next : false;
  };

  const step = (direction: 1 | -1) => {
    if (commitQuantity() === false) return;
    saveAmount(() => stepItemAmount(itemId, direction, initial.usualUnit));
  };

  const chooseUnit = (unit: Unit | null) => {
    if (!steppable) return;
    const typed = commitQuantity();
    if (typed === false) return;
    const next = withUnit(typed ?? steppable, unit);
    if (next) saveAmount(() => setItemAmount(itemId, next));
  };

  /** Saves the sheet's edits (Save, and before Got it, Move or opening a recipe). False if they can't be saved. */
  const persist = (): boolean => {
    try {
      if (steppable && commitQuantity() === false) return false;
      // A single amount is already saved; passing the saved total tells updateItem it's unchanged.
      const amountText = steppable ? (getItemEdit(itemId)?.amount ?? '') : amount;
      // Choosing the default again only needs a write if there was an override to remove.
      const categoryId = edit.categoryId === null && !current?.overrideCategoryId ? undefined : edit.categoryId;
      void categorizePending(updateItem(itemId, { ...edit, amount: amountText, categoryId }, userId));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const save = () => {
    if (persist()) router.back();
  };

  // The row's check (same write, so sync behaves the same). Got it closes the sheet; Still need it
  // stays, unless the item folded into the same one opened since (spec 4.2), which closes it too.
  const setChecked = (checked: boolean) => {
    if (!persist()) return;
    setItemChecked(itemId, checked, userId);
    if (checked || !itemStatusQuery(itemId).get()) router.back();
  };

  const openRecipe = (recipeId: string) => {
    if (!persist()) return;
    router.back();
    router.push({ pathname: '/recipe/[id]', params: { id: recipeId } });
  };

  // Spec 4.4: the item meets the other list as an add would; that list opens with the toast and Undo.
  const move = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'Move to', options: [...moveTargets.map((l) => l.name), 'Cancel'], cancelButtonIndex: moveTargets.length },
      (index) => {
        const target = moveTargets[index];
        if (!target || !persist()) return;
        try {
          setMoveResult(moveItemToList(itemId, target.id));
          router.back();
          router.push({ pathname: '/list/[id]', params: { id: target.id } });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      },
    );
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
            {displayItemName(edit.name.trim() || initial.name)}
          </ThemedText>
          {amount ? (
            <ThemedText variant="amount" color="inkSecondary">
              {amount}
            </ThemedText>
          ) : null}
          {status?.checkedAt ? (
            <ThemedText variant="footnote" color="inkSecondary">
              {checkedLine(status.checkedAt, status.checkedBy, userId, now)}
            </ThemedText>
          ) : null}
        </View>
      </View>

      <View style={{ paddingHorizontal: spacing.lg }}>
        {status?.checkedAt ? (
          <Button label="Still need it" accessibilityHint="Puts it back on the list" onPress={() => setChecked(false)} />
        ) : (
          <PrimaryButton
            label="Got it"
            icon="checkmark"
            accessibilityHint="Checks it off and closes"
            onPress={() => setChecked(true)}
          />
        )}
      </View>

      <Card>
        <FieldRow label="Name" first>
          <InlineField value={edit.name} onChangeText={set('name')} accessibilityLabel="Name" returnKeyType="done" />
        </FieldRow>
        <FieldRow label="Amount">
          <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingVertical: spacing.xs }]}>
            <View style={[styles.grow, { minWidth: sizes.fieldLabel }]}>
              {shown ? (
                <InlineField
                  value={quantityDraft ?? quantityText(shown.quantity)}
                  onChangeText={(value) => {
                    setQuantityDraft(value);
                    setError(null);
                  }}
                  onBlur={() => commitQuantity()}
                  placeholder="None"
                  accessibilityLabel={`Amount, in ${unitLabel(shown.unit)}`}
                  accessibilityHint="Saves when you're done typing. Empty clears the amount."
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                />
              ) : (
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
              )}
            </View>
            <AmountControls
              amount={steppable}
              usual={initial.hasUsualUnit ? initial.usualUnit : undefined}
              canDecrease={!!steppable && canStepDown(steppable, initial.usualUnit)}
              onStep={step}
              onChooseUnit={chooseUnit}
            />
          </View>
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

      {contributions.length > 1 || contributions.some(fromRecipe) ? (
        // Spec 4.4: each add is listed with a delete control (Undo, later); a recipe's add opens it.
        <>
          <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={labelInset}>
            Added
          </ThemedText>
          <Card>
            {contributions.map((c, i) => {
              const text = formatAmount(c) || 'No amount';
              const line = addedLine(c, userId, now);
              return (
                <CardRow key={c.id} first={i === 0}>
                  <ThemedText variant="headline">{text}</ThemedText>
                  {fromRecipe(c) ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${text}, ${line}`}
                      accessibilityHint={`Opens ${c.recipeName}`}
                      onPress={() => openRecipe(c.recipeId)}
                      style={({ pressed }) => [
                        styles.row,
                        styles.flex,
                        { minHeight: sizes.minTapTarget, gap: spacing.xs, opacity: pressed ? opacity.pressed : 1 },
                      ]}>
                      <ThemedText variant="amount" color="inkSecondary" style={styles.flex}>
                        {line}
                      </ThemedText>
                      <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />
                    </Pressable>
                  ) : (
                    <ThemedText variant="amount" color="inkSecondary" style={styles.flex}>
                      {line}
                    </ThemedText>
                  )}
                  {contributions.length > 1 ? (
                    <RemoveButton
                      accessibilityLabel={`Remove ${text}`}
                      accessibilityHint="Removes this amount"
                      onPress={() => deleteContribution(c.id)}
                    />
                  ) : null}
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

      {moveTargets.length > 0 ? (
        <Card>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Move to another list"
            accessibilityHint="Shows the other lists"
            onPress={move}
            style={({ pressed }) => ({ opacity: pressed ? opacity.pressed : 1 })}>
            <CardRow first>
              <Icon name="arrow.right.circle" color="primary" />
              <ThemedText variant="headline" style={styles.flex}>
                Move to another list…
              </ThemedText>
              <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />
            </CardRow>
          </Pressable>
        </Card>
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

/** An "Added" row from a recipe that still exists, which opens it. */
function fromRecipe<C extends { source: string; recipeId: string | null; recipeName: string | null }>(
  c: C,
): c is C & { recipeId: string; recipeName: string } {
  return c.source === 'recipe' && c.recipeId !== null && c.recipeName !== null;
}

const DISABLED_HINT = 'Edit the amount as text';

/** The unit button and − / + beside the number field (spec 4.4). Disabled when `amount` is null. */
function AmountControls({
  amount,
  usual,
  canDecrease,
  onStep,
  onChooseUnit,
}: {
  amount: Amount | null;
  /** The ingredient's usual unit for the menu; undefined when none is known. */
  usual: Unit | null | undefined;
  canDecrease: boolean;
  onStep: (direction: 1 | -1) => void;
  onChooseUnit: (unit: Unit | null) => void;
}) {
  const { spacing } = useTheme();
  const disabledHint = amount ? undefined : DISABLED_HINT;
  return (
    <View style={[styles.row, { gap: spacing.sm }]}>
      {amount ? (
        <UnitMenu unit={amount.unit} usual={usual} onChoose={onChooseUnit} />
      ) : (
        <StepperButton
          icon="chevron.up.chevron.down"
          accessibilityLabel="Unit"
          accessibilityHint={DISABLED_HINT}
          disabled
          onPress={() => {}}
        />
      )}
      <StepperButton
        icon="minus"
        accessibilityLabel="Decrease amount"
        accessibilityHint={disabledHint}
        disabled={!amount || !canDecrease}
        onPress={() => onStep(-1)}
      />
      <StepperButton
        icon="plus"
        accessibilityLabel="Increase amount"
        accessibilityHint={disabledHint}
        disabled={!amount}
        onPress={() => onStep(1)}
      />
    </View>
  );
}

/**
 * The unit button: a native menu grouped Count / Weight / Volume / Packages, the current unit
 * ticked and the usual one first, marked "Usual". Picking a unit keeps the number.
 */
function UnitMenu({
  unit,
  usual,
  onChoose,
}: {
  unit: Unit | null;
  usual: Unit | null | undefined;
  onChoose: (unit: Unit | null) => void;
}) {
  const { scheme, colors } = useTheme();
  const label = unitLabel(unit);
  return (
    <Host matchContents colorScheme={scheme} seedColor={colors.primary}>
      <Menu
        label={
          <RNHostView matchContents>
            <StepperFace icon="chevron.up.chevron.down" label={label} />
          </RNHostView>
        }
        modifiers={[accessibilityLabel(`Unit, ${label}`), accessibilityHint('Shows the units')]}>
        {unitMenuSections(unit, usual).map((section) => (
          <Section key={section.title ?? 'usual'} title={section.title ?? undefined}>
            {section.items.map((item) =>
              item.usual ? (
                // A second Text is the menu item's subtitle.
                <Toggle key={item.label} isOn={item.checked} onIsOnChange={() => onChoose(item.unit)}>
                  <SwiftText>{item.label}</SwiftText>
                  <SwiftText>Usual</SwiftText>
                </Toggle>
              ) : (
                <Toggle
                  key={item.label}
                  label={item.label}
                  isOn={item.checked}
                  onIsOnChange={() => onChoose(item.unit)}
                />
              ),
            )}
          </Section>
        ))}
      </Menu>
    </Host>
  );
}

/** The look of a stepper button: a round 44 pt `surfaceMuted` button; with a `label` it grows into a pill. */
function StepperFace({ icon, label, faded }: { icon: IconName; label?: string; faded?: number }) {
  const { colors, spacing, rounded, sizes } = useTheme();
  return (
    <View
      style={[
        styles.row,
        styles.centered,
        {
          minHeight: sizes.minTapTarget,
          minWidth: sizes.minTapTarget,
          paddingHorizontal: label ? spacing.md : 0,
          gap: spacing.xs,
          borderRadius: rounded.full,
          backgroundColor: colors.surfaceMuted,
          opacity: faded ?? 1,
        },
      ]}>
      {label ? <ThemedText variant="amount">{label}</ThemedText> : null}
      <Icon name={icon} color={label ? 'inkSecondary' : 'ink'} size={label ? sizes.iconSmall : sizes.icon} weight="semibold" />
    </View>
  );
}

/** A `StepperFace` that's a button. */
function StepperButton({
  icon,
  accessibilityLabel: label,
  accessibilityHint: hint,
  disabled,
  onPress,
}: {
  icon: IconName;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}>
      {({ pressed }) => (
        <StepperFace icon={icon} faded={disabled ? opacity.disabled : pressed ? opacity.pressed : undefined} />
      )}
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
  grow: { flexGrow: 1, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  centered: { alignItems: 'center', justifyContent: 'center' },
  label: { alignSelf: 'flex-start' },
  inline: { borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0 },
});
