import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Modal, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { avatarColors } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { SegmentedControl } from '@/components/segmented-control';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Toast } from '@/components/toast';
import { Screen } from '@/components/themed-view';
import { FontSetSpecs } from '@/constants/theme';
import { households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { recipeHue } from '@/domain/aisle-color';
import { useAccountState } from '@/features/auth/account';
import { signOutAndWipe } from '@/features/auth/sign-out';
import {
  DELETE_ACCOUNT_FAILED,
  DELETE_ACCOUNT_OFFLINE,
  DELETE_ACCOUNT_SECOND_CONFIRM,
  DeleteAccountError,
  deleteAccount,
  deleteAccountConfirmation,
  householdsForDeletion,
  isOffline,
} from '@/features/auth/delete-account';
import { takeDeletedHousehold } from '@/features/households/deleted-household-notice';
import {
  avatarInitial,
  deletedHouseholdToast,
  householdCountsLabel,
  householdsWithCountsQuery,
  HOUSEHOLD_COUNT_TABLES,
} from '@/features/households/households';
import { useKeepScreenOnSetting } from '@/features/lists/keep-awake';
import { aisleColorStyleLabel } from '@/features/lists/list-view';
import { PLAN_GRID_STYLES, setPlanGridStyle, usePlanGridStyle, type PlanGridStyle } from '@/features/meal-plan/grid-style';
import { usePlanTabSetting } from '@/features/meal-plan/plan-tab';
import { RECIPE_VIEW_STYLES, setRecipeViewStyle, useRecipeViewStyle, type RecipeViewStyle } from '@/features/recipes/view-style';
import { getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import {
  getAisleColorStyle,
  getAlwaysShowChecked,
  setAlwaysShowChecked,
  setKeepScreenOn,
  setPlanTab,
} from '@/features/settings/device-settings';
import { useSyncStatus } from '@/features/settings/use-sync-status';
import { useFontSet } from '@/hooks/font-set';
import { useTheme } from '@/hooks/use-theme';
import { currentLanguage, i18n, LANGUAGE_NAMES, useT } from '@/i18n';

/** Settings (board 10): the account card, Households, Shopping, Aisles, Meal plan and General cards, then Sign out, Delete account and the version. */
export default function SettingsScreen() {
  const { colors, aisles, spacing, sizes, rounded } = useTheme();
  const t = useT();
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : undefined;
  const email = account.status === 'ready' ? account.account.email : undefined;
  const version = Constants.expoConfig?.version ?? '—';
  const { data: householdRows } = useLiveQueryOn(householdsWithCountsQuery(), HOUSEHOLD_COUNT_TABLES);
  // userSettings: so "Siri adds to" follows a list's "Default list for Siri".
  const { data: listRows } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  const siriList = useMemo(() => {
    const id = userId && listRows.length > 0 ? getDefaultListId(userId) : null;
    return listRows.find((l) => l.id === id)?.name;
  }, [userId, listRows]);
  const avatar = avatarColors('amber', colors, aisles);
  const sync = useSyncStatus();
  // A device setting: read again on coming back from its screen.
  const [aisleColors, setAisleColors] = useState(getAisleColorStyle);
  useFocusEffect(useCallback(() => setAisleColors(getAisleColorStyle()), []));
  const keepScreenOn = useKeepScreenOnSetting();
  const planTab = usePlanTabSetting();
  const fontSet = useFontSet();
  const planGridStyle = usePlanGridStyle();
  const recipeViewStyle = useRecipeViewStyle();
  const [alwaysShowChecked, setAlwaysShowCheckedState] = useState(getAlwaysShowChecked);
  const [deleting, setDeleting] = useState(false);
  // "Deleted <household>" after deleting one on its screen (spec 4.7), taken on coming back.
  const [toast, setToast] = useState<{ key: number; message: string; emphasis?: string } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  useFocusEffect(
    useCallback(() => {
      const name = takeDeletedHousehold();
      if (name !== null) setToast({ key: Date.now(), ...deletedHouseholdToast(name) });
    }, []),
  );

  return (
    // The scroll view sits inside a plain view, as on the other tabs: as the screen's root view the
    // native large title didn't show.
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
        <Card
          accessible
          accessibilityLabel={t('settings.accountLabel', { email: email ?? t('settings.unknownEmail'), status: sync.label })}
          style={[styles.row, { padding: spacing.lg, gap: spacing.md + spacing.xxs }]}>
          <View
            style={[
              styles.avatar,
              { width: sizes.accountAvatar, height: sizes.accountAvatar, borderRadius: rounded.full, backgroundColor: avatar.fill },
            ]}>
            {/* One letter in a fixed circle: capped so it stays inside at the largest text sizes. */}
            <ThemedText variant="initial" maxFontSizeMultiplier={1.5} style={{ color: avatar.text }}>
              {avatarInitial(email)}
            </ThemedText>
          </View>
          <View style={styles.flex}>
            <ThemedText variant="headline">{email ?? '—'}</ThemedText>
            <ThemedText variant="footnote" color="inkSecondary">
              {t('settings.signedIn')}
            </ThemedText>
          </View>
          {/* Badges align to the top of their parent; this keeps it centred beside the name. */}
          <View>
            <Badge label={sync.label} tone={sync.tone} />
          </View>
        </Card>

        {/* One row per household, opening its screen, where its members, invites and settings are. */}
        {householdRows.length > 0 ? (
          <>
            <SettingsSection title={t('settings.households')}>
              {householdRows.map((h, i) => (
                <SettingsRow
                  key={h.id}
                  label={h.name}
                  detail={householdCountsLabel(h.listCount, h.recipeCount)}
                  icon={{ name: 'house', hue: recipeHue(h.id) }}
                  last={i === householdRows.length - 1}
                  onPress={() => router.push({ pathname: '/settings/households/[id]', params: { id: h.id } })}
                />
              ))}
            </SettingsSection>
            <ThemedText
              variant="footnote"
              color="inkSecondary"
              style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
              {t('settings.householdsFootnote')}
            </ThemedText>
          </>
        ) : null}

        <SettingsSection title={t('settings.shopping')}>
          <SettingsRow
            label={t('settings.siriAddsTo')}
            value={siriList ?? '—'}
            icon={{ name: 'mic', hue: 'green' }}
            onPress={() => router.push('/settings/siri')}
          />
          <SettingsRow
            label={t('settings.notifications')}
            icon={{ name: 'bell.badge', hue: 'rose' }}
            onPress={() => router.push('/settings/notifications')}
          />
          <SettingsRow
            label={t('settings.keepScreenOn')}
            detail={t('settings.keepScreenOnDetail')}
            icon={{ name: 'sun.max', hue: 'amber' }}
            trailing={
              <Switch
                value={keepScreenOn}
                onValueChange={setKeepScreenOn}
                trackColor={{ true: colors.primary }}
                accessibilityLabel={t('settings.keepScreenOn')}
                accessibilityHint={t('settings.keepScreenOnHint')}
              />
            }
          />
          <SettingsRow
            label={t('settings.alwaysShowChecked')}
            detail={t('settings.alwaysShowCheckedDetail')}
            icon={{ name: 'checklist', hue: 'teal' }}
            trailing={
              <Switch
                value={alwaysShowChecked}
                onValueChange={(on) => {
                  setAlwaysShowChecked(on);
                  setAlwaysShowCheckedState(on);
                }}
                trackColor={{ true: colors.primary }}
                accessibilityLabel={t('settings.alwaysShowChecked')}
                accessibilityHint={t('settings.alwaysShowCheckedHint')}
              />
            }
            last
          />
        </SettingsSection>

        <SettingsSection title={t('settings.aisles')}>
          <SettingsRow
            label={t('settings.aisleOrder')}
            icon={{ name: 'arrow.up.arrow.down', hue: 'blue' }}
            onPress={() => router.push('/category-order')}
          />
          <SettingsRow
            label={t('settings.aisleColours')}
            value={aisleColorStyleLabel(aisleColors)}
            icon={{ name: 'paintpalette', hue: 'rose' }}
            onPress={() => router.push('/settings/aisle-colors')}
            last
          />
        </SettingsSection>

        <SettingsSection title={t('settings.mealPlan')}>
          <SettingsRow
            label={t('settings.planTab')}
            detail={t('settings.planTabDetail')}
            icon={{ name: 'calendar', hue: 'green' }}
            trailing={
              <Switch
                value={planTab}
                onValueChange={setPlanTab}
                trackColor={{ true: colors.primary }}
                accessibilityLabel={t('settings.planTab')}
                accessibilityHint={t('settings.planTabDetail')}
              />
            }
            last
          />
        </SettingsSection>

        <SettingsSection title={t('settings.general')}>
          <SettingsRow
            label={t('settings.language')}
            value={LANGUAGE_NAMES[currentLanguage()]}
            icon={{ name: 'globe', hue: 'blue' }}
            onPress={() => router.push('/settings/language')}
          />
          <SettingsRow
            label={t('settings.syncStatus')}
            value={sync.label}
            icon={{ name: 'arrow.triangle.2.circlepath', hue: 'grey' }}
            onPress={() => router.push('/settings/sync')}
            last
          />
        </SettingsSection>

        {/* Every build, TestFlight included, until the trials end. */}
        <SettingsSection title={t('settings.designTrials')}>
          <SettingsRow
            label={t('settings.fonts')}
            value={FontSetSpecs[fontSet].display}
            icon={{ name: 'textformat', hue: 'plum' }}
            onPress={() => router.push('/font-sets')}
          />
          {/* The week grid's cells (spec 4.16), on the Plan tab and in the plan modal. */}
          <View style={{ paddingVertical: spacing.md, gap: spacing.sm }}>
            <ThemedText variant="body" importantForAccessibility="no" accessibilityElementsHidden style={{ paddingHorizontal: spacing.lg }}>
              {t('settings.planGrid')}
            </ThemedText>
            <SegmentedControl<PlanGridStyle>
              accessibilityLabel={t('settings.planGridLabel')}
              segments={PLAN_GRID_STYLES.map((style) => ({ value: style, label: t(PLAN_GRID_STYLE_LABELS[style]) }))}
              value={planGridStyle}
              onChange={setPlanGridStyle}
            />
          </View>
          {/* The recipe screen's layout (spec 4.5). */}
          <View style={{ paddingVertical: spacing.md, gap: spacing.sm }}>
            <ThemedText variant="body" importantForAccessibility="no" accessibilityElementsHidden style={{ paddingHorizontal: spacing.lg }}>
              {t('settings.recipeView')}
            </ThemedText>
            <SegmentedControl<RecipeViewStyle>
              accessibilityLabel={t('settings.recipeViewLabel')}
              segments={RECIPE_VIEW_STYLES.map((style) => ({ value: style, label: t(RECIPE_VIEW_STYLE_LABELS[style]) }))}
              value={recipeViewStyle}
              onChange={setRecipeViewStyle}
            />
          </View>
        </SettingsSection>

        {__DEV__ ? (
          <SettingsSection title={t('settings.developer')}>
            <SettingsRow
              label={t('settings.developerRow')}
              icon={{ name: 'hammer', hue: 'grey' }}
              onPress={() => router.push('/settings/developer')}
              last
            />
          </SettingsSection>
        ) : null}

        <View style={[styles.start, { paddingVertical: spacing.lg, paddingHorizontal: spacing.xl, gap: spacing.sm }]}>
          <Button
            label={t('settings.signOut')}
            variant="plain"
            color="danger"
            onPress={() => signOutAndWipe().catch((err) => console.warn('[settings] sign out failed', err))}
          />
          <Button
            label={t('account.delete')}
            variant="plain"
            color="danger"
            accessibilityHint={t('account.deleteHint')}
            disabled={deleting}
            onPress={() => {
              if (userId) void confirmDeleteAccount(userId, () => setDeleting(true), () => setDeleting(false));
            }}
          />
          <ThemedText variant="footnote" color="inkSecondary">
            {t('settings.version', { version })}
          </ThemedText>
        </View>
      </ScrollView>
      {toast ? (
        // Above the tab bar: the screen ends there.
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={[]} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
      <DeletingOverlay visible={deleting} />
    </Screen>
  );
}

/**
 * Delete account (spec 4.8): offline it only says so; online it asks twice, then deletes behind
 * `onStart`'s overlay. Success lands on sign-in; a failure says nothing was deleted.
 */
async function confirmDeleteAccount(userId: string, onStart: () => void, onEnd: () => void) {
  if (await isOffline()) {
    Alert.alert(DELETE_ACCOUNT_OFFLINE.title, DELETE_ACCOUNT_OFFLINE.message);
    return;
  }
  const first = deleteAccountConfirmation(await householdsForDeletion(userId));
  const run = async () => {
    onStart();
    try {
      await deleteAccount();
    } catch (err) {
      onEnd();
      const alert =
        err instanceof DeleteAccountError && err.kind === 'offline' ? DELETE_ACCOUNT_OFFLINE : DELETE_ACCOUNT_FAILED;
      Alert.alert(alert.title, alert.message);
    }
  };
  Alert.alert(first.title, first.message, [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    {
      text: i18n.t('account.delete'),
      style: 'destructive',
      onPress: () =>
        Alert.alert(DELETE_ACCOUNT_SECOND_CONFIRM.title, DELETE_ACCOUNT_SECOND_CONFIRM.message, [
          { text: i18n.t('common.cancel'), style: 'cancel' },
          { text: i18n.t('common.delete'), style: 'destructive', onPress: () => void run() },
        ]),
    },
  ]);
}

/** Full screen while the account is deleted; it can't be dismissed. */
const PLAN_GRID_STYLE_LABELS = {
  compact: 'settings.planGridCompact',
  photo: 'settings.planGridPhoto',
  expand: 'settings.planGridExpand',
} as const satisfies Record<PlanGridStyle, string>;

const RECIPE_VIEW_STYLE_LABELS = {
  standard: 'settings.recipeViewStandard',
  indexCard: 'settings.recipeViewIndexCard',
} as const satisfies Record<RecipeViewStyle, string>;

function DeletingOverlay({ visible }: { visible: boolean }) {
  const { colors, spacing } = useTheme();
  const t = useT();
  useEffect(() => {
    if (visible) AccessibilityInfo.announceForAccessibility(i18n.t('account.deletingAnnouncement'));
  }, [visible]);
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={() => {}}>
      <View
        accessibilityViewIsModal
        style={[styles.overlay, { backgroundColor: colors.background, gap: spacing.md, padding: spacing.xl }]}>
        <ActivityIndicator color={colors.inkSecondary} />
        <ThemedText variant="headline">{t('account.deleting')}</ThemedText>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  start: { alignItems: 'flex-start' },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
