import { Host, Menu, RNHostView, Section, Text as SwiftText, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';

import { aisleSymbol, avatarColors, prominentButtonTint } from '@/components/appearance';
import { Button, SoftDangerButton } from '@/components/button';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { Icon, type IconName } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { Pill } from '@/components/pill';
import { SettingsRow } from '@/components/settings-group';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { listItemContributions, listItems } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { addedBySummary, addedLine, checkedLine, type AddedBySummary } from '@/domain/added-by';
import { aisleColor, memberHue, recipeHue } from '@/domain/aisle-color';
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
import { sharedAisleFootnote } from '@/features/categories/aisle-copy';
import { createCategory, getIngredientCategory, getOrderedCategories } from '@/features/categories/categories';
import { categorizePending } from '@/features/categories/categorization';
import { avatarInitial } from '@/features/households/households';
import { useMemberNames, type MemberNames } from '@/features/households/member-names';
import { alwaysHaveFootnote, isStaple, setStaple } from '@/features/households/staples';
import { openList } from '@/features/lists/current-list';
import { useFeature } from '@/features/plans/features';
import {
  contributionsQuery,
  deleteContribution,
  deleteItem,
  getItemEdit,
  getItemHouseholdName,
  getMoveTargets,
  itemPhotoQuery,
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
import { ItemPhotoSection } from '@/features/lists/item-photo';
import { setMoveResult } from '@/features/lists/move-result';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName, OTHER_CATEGORY_ID, type Unit } from '@/shared';

/**
 * Item edit sheet (spec 4.2, 4.3.2, board 04): the name (the title, edited in place) and its check, the item's photo
 * (spec 4.4, board G), amount, note, the amounts added (a recipe's opens it), aisle, and Move to another list.
 */
export default function ItemEditSheet() {
  const { itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
  const { spacing, sizes, scheme, colors, aisles, opacity, typography } = useTheme();
  const userId = getAccount()?.userId ?? null;
  const [initial] = useState(() => getItemEdit(itemId));
  const [householdName] = useState(() => getItemHouseholdName(itemId));
  const [edit, setEdit] = useState<ItemEdit | null>(initial);
  const [error, setError] = useState<string | null>(null);
  // The aisles are the list household's (spec 4.3.2), in this user's order.
  const [categoryList, setCategoryList] = useState(() =>
    userId && initial ? getOrderedCategories(userId, initial.householdId) : [],
  );
  const current = useMemo(
    () => (userId && initial ? getIngredientCategory(initial.householdId, initial.ingredientName) : null),
    [userId, initial],
  );
  const { data: contributions } = useLiveQueryOn(contributionsQuery(itemId), [listItemContributions], [itemId]);
  const { data: statusRows } = useLiveQueryOn(itemStatusQuery(itemId), [listItems], [itemId]);
  const { data: photoRows } = useLiveQueryOn(itemPhotoQuery(itemId), [listItems], [itemId]);
  const memberNames = useMemberNames(initial?.householdId);
  const status = statusRows[0];
  // Move is left out when the household has no other list.
  const [moveTargets] = useState(() => getMoveTargets(itemId));
  const [amountTouched, setAmountTouched] = useState(false);
  // The number field's text while it's being typed in; null shows the saved quantity.
  const [quantityDraft, setQuantityDraft] = useState<string | null>(null);
  // The title is the name field; it shows the name as typed while editing, capitalized otherwise.
  const [editingName, setEditingName] = useState(false);
  // The aisle picker shows the first few aisles (always with the current one) until Show all.
  const [aislesOpen, setAislesOpen] = useState(false);
  // Always have (spec 4.2, 4.5): the household's staple, saved as soon as it's switched.
  const [staple, setStapleState] = useState(() => (initial ? isStaple(initial.householdId, initial.ingredientName) : false));
  const sorts = useFeature('categorize');
  const t = useT();

  if (!edit || !initial) return <Screen />;

  // Deleting an amount below changes the total; follow it until the user types their own.
  const amount = amountTouched || contributions.length === 0 ? edit.amount : itemTotal(contributions, initial.usualUnit);
  // The number field, − / + and unit menu work on the total as one amount; null (`2 cans + 400 g`)
  // disables them and the amount is edited as text.
  const steppable = steppableAmount(contributions, initial.usualUnit);
  // What the number field shows: no number when the item has no amount, in the unit the menu ticks.
  const shown: Amount | null = steppable && { quantity: amount ? steppable.quantity : null, unit: steppable.unit };

  // A pending ingredient's default is "Sorting..." until categorization returns (spec 4.3.1), or
  // Other when the plan has no `categorize` (4.12).
  const defaultId = current
    ? effectiveCategoryId(null, current.defaultCategoryId, current.status, sorts)
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
  const shownAisles = aislesOpen ? categoryList : previewAisles(categoryList, selectedId, sortingDefault);
  const hiddenAisles = categoryList.length - shownAisles.length;

  const chooseCategory = (id: string) => {
    setEdit({ ...edit, categoryId: id === defaultId ? null : id });
  };

  const newCategory = () => {
    if (!userId) return;
    Alert.prompt(t('item.newAisle'), undefined, (name) => {
      if (!name?.trim()) return;
      const id = createCategory(userId, initial.householdId, name);
      setCategoryList(getOrderedCategories(userId, initial.householdId));
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
      setError(t('item.notANumber', { text: quantityDraft.trim() }));
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

  /** Saves the sheet's edits (Save, and before Move or opening a recipe). False if they can't be saved. */
  const persist = (): boolean => {
    try {
      if (steppable && commitQuantity() === false) return false;
      // A single amount is already saved; passing the saved total tells updateItem it's unchanged.
      const amountText = steppable ? (getItemEdit(itemId)?.amount ?? '') : amount;
      // Choosing the default again only needs a write if there was an override to remove.
      const categoryId = edit.categoryId === null && !current?.overrideCategoryId ? undefined : edit.categoryId;
      void categorizePending(updateItem(itemId, { ...edit, amount: amountText, categoryId }));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const save = () => {
    if (persist()) router.back();
  };

  // The row's check (same write, so sync behaves the same). It saves right away, like the stepper, and the
  // sheet stays, unless unchecking folded the item into the same one opened since (spec 4.2).
  const setChecked = (checked: boolean) => {
    setItemChecked(itemId, checked, userId);
    if (!itemStatusQuery(itemId).get()) router.back();
  };

  const openRecipe = (recipeId: string) => {
    if (!persist()) return;
    router.back();
    router.push({ pathname: '/recipe/[id]', params: { id: recipeId } });
  };

  // Spec 4.4: the item meets the other list as an add would; that list opens with the toast and Undo.
  const move = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: t('item.moveTo'),
        options: [...moveTargets.map((l) => l.name), t('common.cancel')],
        cancelButtonIndex: moveTargets.length,
      },
      (index) => {
        const target = moveTargets[index];
        if (!target || !persist()) return;
        try {
          setMoveResult(moveItemToList(itemId, target.id));
          router.back();
          openList(target.id);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      },
    );
  };

  const toggleStaple = (on: boolean) => {
    setStaple(initial.householdId, initial.ingredientName, on, userId);
    setStapleState(on);
  };

  const now = new Date();
  const checked = !!status?.checkedAt;
  const addedBy = addedBySummary(contributions, userId, memberNames, now);
  const labelInset = { paddingHorizontal: spacing.xxl };

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.md }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={save}>
          {t('item.save')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <View style={[styles.row, { paddingHorizontal: spacing.lg + spacing.xs, paddingVertical: spacing.xs, gap: spacing.md }]}>
        <IconTile hue={hue} name={sorting ? 'hourglass' : aisleSymbol(slugOf(selectedId))} size={sizes.sheetIcon} />
        <View style={styles.flex}>
          <TextInput
            value={editingName ? edit.name : displayItemName(edit.name.trim() || initial.name)}
            onChangeText={set('name')}
            onFocus={() => setEditingName(true)}
            onBlur={() => setEditingName(false)}
            accessibilityLabel={t('item.name')}
            accessibilityHint={t('item.nameHint')}
            multiline
            submitBehavior="blurAndSubmit"
            returnKeyType="done"
            selectionColor={colors.primary}
            style={[
              typography.sheetTitle,
              styles.title,
              checked && !editingName ? { color: colors.inkSecondary, textDecorationLine: 'line-through' } : { color: colors.ink },
            ]}
          />
          {amount ? (
            <ThemedText variant="amount" color="inkSecondary">
              {amount}
            </ThemedText>
          ) : null}
          {addedBy ? <AddedByRow summary={addedBy} /> : null}
          {status?.checkedAt ? (
            <ThemedText variant="footnote" color="inkSecondary">
              {checkedLine(status.checkedAt, status.checkedBy, userId, now, memberNames)}
            </ThemedText>
          ) : null}
        </View>
        {/* Centred on the title's first line, so it stays put when the name wraps. */}
        <View style={[styles.centered, styles.top, { height: typography.sheetTitle.lineHeight }]}>
          <CheckCircle
            checked={checked}
            pending={sorting}
            ring={sorting ? undefined : aisles[hue].dot}
            fill={colors.surface}
            onPress={() => setChecked(!checked)}
            accessibilityLabel={t('item.gotIt')}
          />
        </View>
      </View>

      <ItemPhotoSection itemId={itemId} name={initial.name} photoPath={photoRows[0]?.photoPath ?? null} />

      <Card>
        <FieldRow label={t('item.amount')} first>
          <View style={[styles.row, styles.wrap, { gap: spacing.sm }]}>
            <View style={[styles.grow, { minWidth: sizes.fieldLabel }]}>
              {shown ? (
                <InlineField
                  value={quantityDraft ?? quantityText(shown.quantity)}
                  onChangeText={(value) => {
                    setQuantityDraft(value);
                    setError(null);
                  }}
                  onBlur={() => commitQuantity()}
                  placeholder={t('item.amountNone')}
                  accessibilityLabel={t('item.amountIn', { unit: unitLabel(shown.unit) })}
                  accessibilityHint={t('item.amountHint')}
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
                  placeholder={t('item.amountPlaceholder')}
                  accessibilityLabel={t('item.amount')}
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
        <FieldRow label={t('item.note')}>
          <InlineField
            value={edit.note}
            onChangeText={set('note')}
            placeholder={t('item.notePlaceholder')}
            accessibilityLabel={t('item.note')}
            multiline
          />
        </FieldRow>
      </Card>

      {contributions.length > 1 || contributions.some(fromRecipe) ? (
        // Spec 4.4: each add is listed with a delete control (Undo, later); a recipe's add opens it.
        <>
          <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={labelInset}>
            {t('item.added')}
          </ThemedText>
          <Card>
            {contributions.map((c, i) => {
              const text = formatAmount(c) || t('item.noAmount');
              const line = addedLine(c, userId, now, memberNames);
              return (
                <CardRow key={c.id} first={i === 0}>
                  <ThemedText variant="headline">{text}</ThemedText>
                  {fromRecipe(c) ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('item.addedRow', { amount: text, line })}
                      accessibilityHint={t('item.opensRecipe', { name: c.recipeName })}
                      onPress={() => openRecipe(c.recipeId)}
                      style={({ pressed }) => [
                        styles.row,
                        styles.flex,
                        { minHeight: sizes.minTapTarget, gap: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
                      ]}>
                      <AddedAvatar add={c} names={memberNames} />
                      <ThemedText variant="amount" color="inkSecondary" style={styles.flex}>
                        {line}
                      </ThemedText>
                      <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />
                    </Pressable>
                  ) : (
                    <View style={[styles.row, styles.flex, { gap: spacing.sm }]}>
                      <AddedAvatar add={c} names={memberNames} />
                      <ThemedText variant="amount" color="inkSecondary" style={styles.flex}>
                        {line}
                      </ThemedText>
                    </View>
                  )}
                  {contributions.length > 1 ? (
                    <RemoveButton
                      accessibilityLabel={t('item.removeAmount', { amount: text })}
                      accessibilityHint={t('item.removeAmountHint')}
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
            {t('item.aisle')}
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
            {shownAisles.map((c) => (
              <Pill
                key={c.id}
                label={c.name}
                selected={c.id === selectedId}
                hue={aisleColor(c.slug)}
                onPress={() => chooseCategory(c.id)}
              />
            ))}
            {hiddenAisles > 0 ? (
              <Pill
                label={t('item.showAll')}
                outline
                trailingIcon="chevron.down"
                accessibilityHint={t('item.showMore', { count: hiddenAisles })}
                onPress={() => setAislesOpen(true)}
              />
            ) : (
              <Pill label={t('item.newPill')} accessibilityLabel={t('item.newAisle')} dashed onPress={newCategory} />
            )}
          </View>
          {isOverride ? (
            // The aisle is the household's (spec 4.3.2): read after the pills.
            <View style={[styles.start, labelInset]}>
              <ThemedText variant="footnote" color="inkSecondary">
                {sharedAisleFootnote(householdName)}
              </ThemedText>
              <Button
                label={t('item.resetToDefault')}
                variant="plain"
                accessibilityHint={t('item.resetHint')}
                onPress={() => chooseCategory(defaultId)}
              />
            </View>
          ) : null}
          <View style={{ gap: spacing.sm }}>
            <Card>
              <SettingsRow
                label={t('item.alwaysHave')}
                last
                trailing={
                  <Switch
                    value={staple}
                    onValueChange={toggleStaple}
                    trackColor={{ true: colors.primary }}
                    accessibilityLabel={t('item.alwaysHave')}
                    accessibilityHint={t('item.alwaysHaveHint')}
                  />
                }
              />
            </Card>
            <ThemedText variant="footnote" color="inkSecondary" style={labelInset}>
              {alwaysHaveFootnote(householdName)}
            </ThemedText>
          </View>
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
            accessibilityLabel={t('item.moveToAnother')}
            accessibilityHint={t('item.moveHint')}
            onPress={move}
            style={({ pressed }) => ({ opacity: pressed ? opacity.pressed : 1 })}>
            <CardRow first>
              <Icon name="arrow.right.circle" color="primary" />
              <ThemedText variant="headline" style={styles.flex}>
                {t('item.moveToAnotherMenu')}
              </ThemedText>
              <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />
            </CardRow>
          </Pressable>
        </Card>
      ) : null}

      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg }}>
        <SoftDangerButton
          label={t('item.deleteItem')}
          onPress={() => {
            deleteItem(itemId);
            router.back();
          }}
        />
      </View>
    </Screen>
  );
}

// About two rows of pills on a phone before Show all.
const PREVIEW_AISLES = 6;

/** The first aisles in the user's order, swapping the last for the current one when it's further down. */
function previewAisles<C extends { id: string }>(aisles: C[], selectedId: string, sortingDefault: boolean): C[] {
  // The Sorting… pill takes one of the places while it's shown.
  const room = sortingDefault ? PREVIEW_AISLES - 1 : PREVIEW_AISLES;
  // Showing all but one would hide a single aisle behind a button the same size.
  if (aisles.length <= room + 1) return aisles;
  const first = aisles.slice(0, room);
  const selected = aisles.find((c) => c.id === selectedId);
  if (!selected || first.includes(selected)) return first;
  return [...first.slice(0, -1), selected];
}

/** An "Added" row from a recipe that still exists, which opens it. */
function fromRecipe<C extends { source: string; recipeId: string | null; recipeName: string | null }>(
  c: C,
): c is C & { recipeId: string; recipeName: string } {
  return c.source === 'recipe' && c.recipeId !== null && c.recipeName !== null;
}

/**
 * Who made an "Added" row's add, before its text (spec 4.4): a 24 pt round avatar with the
 * member's initial in their colour (yours too); a recipe add keeps its recipe's tile, and Siri gets
 * a grey `mic` tile. Decorative: the row's text already names them.
 */
function AddedAvatar({
  add,
  names,
}: {
  add: { source: string; recipeId: string | null; addedBy: string | null };
  names: MemberNames;
}) {
  const { colors, aisles, sizes, rounded } = useTheme();
  if (add.source === 'recipe') {
    return <IconTile hue={add.recipeId ? recipeHue(add.recipeId) : 'grey'} name="fork.knife" size={sizes.addedAvatar} />;
  }
  if (add.source === 'siri') return <IconTile hue="grey" name="mic" size={sizes.addedAvatar} />;
  // An old add with no one recorded has no colour of its own.
  const avatar = avatarColors(add.addedBy ? memberHue(add.addedBy) : 'grey', colors, aisles);
  return (
    <View
      testID="added-avatar"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        styles.centered,
        { width: sizes.addedAvatar, height: sizes.addedAvatar, borderRadius: rounded.full, backgroundColor: avatar.fill },
      ]}>
      <ThemedText variant="caption" maxFontSizeMultiplier={1.3} style={{ color: avatar.text }}>
        {avatarInitial(add.addedBy ? names.get(add.addedBy) : null)}
      </ThemedText>
    </View>
  );
}

/**
 * "Added by Alex · Tuesday" under the item's name (spec 4.4, board A): up to three overlapping
 * 22 pt avatars, each ringed in the sheet's `background`, then the text with the names in `ink`
 * 700. VoiceOver reads it as one element.
 */
function AddedByRow({ summary }: { summary: AddedBySummary }) {
  const { colors, aisles, sizes, rounded, spacing } = useTheme();
  return (
    <View
      testID="added-by-row"
      accessible
      accessibilityLabel={summary.label}
      style={[styles.row, { gap: spacing.xs + spacing.xxs, marginTop: spacing.xs + spacing.xxs }]}>
      <View style={styles.row}>
        {summary.people.map((p, i) => {
          const avatar = avatarColors(memberHue(p.userId), colors, aisles);
          return (
            <View
              key={p.userId}
              testID="added-by-avatar"
              style={[
                styles.centered,
                {
                  width: sizes.addedByAvatar,
                  height: sizes.addedByAvatar,
                  borderRadius: rounded.full,
                  borderWidth: sizes.addedByAvatarRing,
                  borderColor: colors.background,
                  backgroundColor: avatar.fill,
                  marginLeft: i === 0 ? 0 : -sizes.addedByAvatarOverlap,
                },
              ]}>
              <ThemedText variant="caption" maxFontSizeMultiplier={1.3} style={{ color: avatar.text }}>
                {p.initial}
              </ThemedText>
            </View>
          );
        })}
      </View>
      <ThemedText variant="footnote" color="inkSecondary" style={styles.flex}>
        {summary.text.map((part, i) =>
          part.bold ? (
            <ThemedText key={i} variant="footnote" style={styles.bold}>
              {part.text}
            </ThemedText>
          ) : (
            part.text
          ),
        )}
      </ThemedText>
    </View>
  );
}

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
  const t = useT();
  const { spacing } = useTheme();
  const disabledHint = amount ? undefined : t('item.editAsText');
  return (
    <View style={[styles.row, { gap: spacing.sm }]}>
      {amount ? (
        <UnitMenu unit={amount.unit} usual={usual} onChoose={onChooseUnit} />
      ) : (
        <StepperButton
          icon="chevron.up.chevron.down"
          accessibilityLabel={t('item.unit')}
          accessibilityHint={t('item.editAsText')}
          disabled
          onPress={() => {}}
        />
      )}
      <StepperButton
        icon="minus"
        accessibilityLabel={t('item.decrease')}
        accessibilityHint={disabledHint}
        disabled={!amount || !canDecrease}
        onPress={() => onStep(-1)}
      />
      <StepperButton
        icon="plus"
        accessibilityLabel={t('item.increase')}
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
  const t = useT();
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
        modifiers={[accessibilityLabel(t('item.unitWith', { unit: label })), accessibilityHint(t('item.unitsHint'))]}>
        {unitMenuSections(unit, usual).map((section) => (
          <Section key={section.title ?? 'usual'} title={section.title ?? undefined}>
            {section.items.map((item) =>
              item.usual ? (
                // A second Text is the menu item's subtitle.
                <Toggle key={item.label} isOn={item.checked} onIsOnChange={() => onChoose(item.unit)}>
                  <SwiftText>{item.label}</SwiftText>
                  <SwiftText>{t('item.usualUnit')}</SwiftText>
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
  const { sizes, spacing, typography } = useTheme();
  // Top-aligned with the input's first line, so it stays put beside a multiline note or the stepper:
  // row + input padding, the input's line height, and the size difference so the smaller label's
  // baseline lands on the value's.
  const paddingTop = spacing.xs + spacing.md + (typography.body.fontSize - typography.amount.fontSize);
  return (
    <CardRow first={first}>
      <ThemedText
        variant="amount"
        color="inkSecondary"
        style={[styles.label, { minWidth: sizes.fieldLabel, paddingTop, lineHeight: typography.body.lineHeight }]}>
        {label}
      </ThemedText>
      <View style={[styles.flex, { paddingVertical: spacing.xs }]}>{children}</View>
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
  start: { alignItems: 'flex-start' },
  top: { alignSelf: 'flex-start' },
  inline: { borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0 },
  title: { padding: 0 },
  bold: { fontWeight: '700' },
});
