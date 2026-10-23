import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { prominentButtonTint } from '@/components/appearance';
import { Button, PrimaryButton } from '@/components/button';
import { SegmentedControl } from '@/components/segmented-control';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { resolveAisleOrder } from '@/domain/aisle-order';
import { getAccount } from '@/features/auth/account';
import { moveId } from '@/features/categories/aisle-order';
import { AisleOrderList } from '@/features/categories/aisle-order-list';
import {
  saveHouseholdAisleOrder,
  saveMyAisleOrder,
  useHouseholdAisleOrder as followHouseholdAisleOrder,
} from '@/features/categories/aisle-orders';
import { myAisleOrderQuery } from '@/features/categories/categories';
import { useAisleOrders } from '@/features/categories/use-aisle-order';
import { useTheme } from '@/hooks/use-theme';
import { i18n, useT } from '@/i18n';

/** Which order the drags edit: the household's, or the user's own for this household. */
type Side = 'household' | 'mine';

/** "Discard your changes?" (Discard / Keep editing); `onDiscard` runs only on Discard. */
function confirmDiscard(onDiscard: () => void) {
  Alert.alert(i18n.t('aisleOrder.discardTitle'), undefined, [
    { text: i18n.t('aisleOrder.keepEditing'), style: 'cancel' },
    { text: i18n.t('aisleOrder.discard'), style: 'destructive', onPress: onDiscard },
  ]);
}

/**
 * "Aisle order" (spec 4.3.3, board 12): the aisles of the household `householdId` (its system
 * aisles plus its own custom ones). The source line says which order the user follows; the
 * Household order | My order control picks which one the drags edit. Moves change a draft only,
 * saved as a whole order with the button under the rows; leaving or switching sides with unsaved
 * moves asks first. Opened from the household's screen (Settings → Households → [Household] →
 * Aisle order) or from a list's ⋯ menu in By aisle (Reorder aisles…).
 */
export default function CategoryOrderScreen() {
  const t = useT();
  const { spacing, colors, scheme } = useTheme();
  const navigation = useNavigation();
  const userId = getAccount()?.userId ?? '';
  const { householdId = '' } = useLocalSearchParams<{ householdId?: string }>();
  const orders = useAisleOrders(userId, householdId);
  const hasOwn = orders.resolved.source === 'personal';
  // Starts on the side the user follows, read now: the live queries fill in after the first render.
  const [side, setSide] = useState<Side>(() =>
    myAisleOrderQuery(userId, householdId).all().length > 0 ? 'mine' : 'household',
  );
  const [draft, setDraft] = useState<string[] | null>(null);

  // The chosen side's order as it would apply (My order: the user's own, else the one they use now).
  const base = side === 'household' ? orders.household.categories : orders.resolved.categories;
  const shown = useMemo(
    () => (draft ? resolveAisleOrder({ personal: draft, household: null, categories: base }).categories : base),
    [draft, base],
  );
  const dirty = draft !== null && shown.map((c) => c.id).join('|') !== base.map((c) => c.id).join('|');

  // Done, swipe down and back all go through here; a modal's swipe-down is blocked while dirty.
  usePreventRemove(dirty, ({ data }) => confirmDiscard(() => navigation.dispatch(data.action)));

  const chooseSide = (next: Side) => {
    const go = () => {
      setDraft(null);
      setSide(next);
    };
    if (dirty) confirmDiscard(go);
    else go();
  };

  const save = () => {
    const ids = shown.map((c) => c.id);
    if (side === 'household') saveHouseholdAisleOrder(householdId, ids);
    else saveMyAisleOrder(householdId, ids);
    setDraft(null);
  };

  const inset = spacing.lg + spacing.xs;

  return (
    // A modal is its own native view tree, so the drag gesture needs its own root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Screen>
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={() => router.back()}>
            {t('common.done')}
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
        <AisleOrderList
          aisles={shown}
          onMove={(from, to) => setDraft(moveId(shown.map((c) => c.id), from, to))}
          header={
            <>
              <ThemedText
                variant="screenTitle"
                accessibilityRole="header"
                style={{ paddingHorizontal: inset, paddingTop: spacing.md + spacing.xxs, paddingBottom: spacing.xs }}>
                {t('aisleOrder.title')}
              </ThemedText>
              <ThemedText variant="callout" color="inkSecondary" style={{ paddingHorizontal: inset, paddingBottom: spacing.lg }}>
                {t(hasOwn ? 'aisleOrder.sourcePersonal' : 'aisleOrder.sourceHousehold')}
              </ThemedText>
              <SegmentedControl<Side>
                accessibilityLabel={t('aisleOrder.sides')}
                segments={[
                  { value: 'household', label: t('aisleOrder.sideHousehold') },
                  { value: 'mine', label: t('aisleOrder.sideMine') },
                ]}
                value={side}
                onChange={chooseSide}
              />
              <ThemedText
                variant="footnote"
                color="inkSecondary"
                style={{ paddingHorizontal: inset, paddingTop: spacing.sm, paddingBottom: spacing.lg }}>
                {t(side === 'household' ? 'aisleOrder.footnoteHousehold' : 'aisleOrder.footnoteMine')}
              </ThemedText>
            </>
          }
          footer={
            <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm }}>
              <PrimaryButton
                label={t(side === 'household' ? 'aisleOrder.saveHousehold' : 'aisleOrder.saveMine')}
                disabled={!dirty || !householdId}
                onPress={save}
              />
              {hasOwn ? (
                <Button variant="plain" label={t('aisleOrder.useHousehold')} onPress={() => followHouseholdAisleOrder(householdId)} />
              ) : null}
            </View>
          }
        />
      </Screen>
    </GestureHandlerRootView>
  );
}
