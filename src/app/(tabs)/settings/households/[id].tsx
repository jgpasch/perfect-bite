import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';

import { avatarColors, householdBandColors } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useLiveQueryOn } from '@/db/live-query';
import { recipeHue } from '@/domain/aisle-color';
import { useAccountState } from '@/features/auth/account';
import { CombineLanguagesRow } from '@/features/households/combine-languages-row';
import { setDeletedHousehold } from '@/features/households/deleted-household-notice';
import {
  avatarInitial,
  deleteHousehold,
  deleteHouseholdConfirmation,
  fetchHouseholdMembers,
  HOUSEHOLD_COUNT_TABLES,
  householdActionAlert,
  householdCountsLabel,
  householdsWithCountsQuery,
  leaveConfirmation,
  leaveHousehold,
  memberActionsSheet,
  memberLabel,
  memberRowAccessibilityLabel,
  removeMember,
  removeMemberConfirmation,
  renameHousehold,
  roleAfter,
  roleChangeConfirmation,
  roleLabel,
  setMemberRole,
  type HouseholdMember,
  type RoleChange,
} from '@/features/households/households';
import { inviteSheetError } from '@/features/households/invite-sheet';
import { promptHouseholdName } from '@/features/households/prompt-household-name';
import { staplesCountLabel, staplesQuery, STAPLES_QUERY_TABLES } from '@/features/households/staples';
import { createInvite, listHouseholdInvites, revokeInvite, type HouseholdInvite } from '@/features/households/invites';
import {
  pendingInviteAccessibilityLabel,
  pendingInviteActions,
  pendingInviteDetail,
  pendingInviteErrorTitle,
  pendingInviteTitle,
} from '@/features/households/pending-invites';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

type MembersState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; members: HouseholdMember[] };

/**
 * A household and its members (spec 4.7, board 11), read-only: an amber band with the name, its
 * list and recipe counts and the members' avatars, then the Members card. Members come from the
 * server, so this needs a connection and a registered household; anything else shows the error
 * with Retry. "Invite someone" opens the invite sheet (`src/app/household-invite.tsx`). Under
 * Members, the Invited section (design S4) lists the household's open invites, loaded with the
 * members; it's hidden when there are none or they can't be fetched (offline). Tapping one offers
 * Send again (email invites) and Cancel invite. Owners tap another member's row to make them an
 * owner (or, for another owner, a member again) or remove them, and their own row to step down
 * while another owner remains (`memberActionsSheet`); a role change reloads the members, and
 * stepping down hides the owner-only controls at once. Everyone can Leave household (the bottom row), after a confirm worded for their case. Leaving
 * pulls, which drops the household from this device (and brings down the new personal household,
 * if the server made one), then goes back to Settings. The list screen is a root-stack screen above
 * the tabs, so no list of this household can be open under this one. Owners get a pencil beside
 * the name that asks for a new one (`rename_household`); the local row and the list snapshot take
 * it at once, and other members' devices get it on their next sync. Owners also get Delete
 * household above Leave: after a confirm naming what goes and for how many members, it calls
 * `delete_household` and pulls, as leaving does, then goes back to Settings, which says "Deleted
 * <household>". Other members' devices purge it on their next sync, as after a removal; a List tab
 * showing one of its lists falls back to the default list, then the first.
 */
export default function HouseholdScreen() {
  const { colors, aisles, spacing, sizes } = useTheme();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : null;
  const { data } = useLiveQueryOn(householdsWithCountsQuery(), HOUSEHOLD_COUNT_TABLES);
  const household = data.find((h) => h.id === id);
  const { data: staples } = useLiveQueryOn(staplesQuery(id), STAPLES_QUERY_TABLES, [id]);
  const band = householdBandColors(colors, aisles);

  const [state, setState] = useState<MembersState>({ status: 'loading' });
  const [invites, setInvites] = useState<HouseholdInvite[]>([]);
  const [busyInvite, setBusyInvite] = useState<string | null>(null);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const request = useRef(0);

  const load = useCallback(() => {
    const current = ++request.current;
    // Keep showing members already loaded while refreshing on refocus.
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    const done = (next: MembersState) => current === request.current && setState(next);
    if (!userId) {
      done({ status: 'error' });
      setInvites([]);
      return;
    }
    // Invites are extra: if they can't load (offline), the section just doesn't show.
    listHouseholdInvites(id).then(
      (list) => current === request.current && setInvites(list),
      (err) => {
        console.warn(`[households] couldn't load invites of ${id}`, err);
        if (current === request.current) setInvites([]);
      },
    );
    fetchHouseholdMembers(id, userId).then(
      (members) => done({ status: 'ready', members }),
      (err) => {
        console.warn(`[households] couldn't load members of ${id}`, err);
        done({ status: 'error' });
      },
    );
  }, [id, userId]);

  const you = state.status === 'ready' ? state.members.find((m) => m.isYou)?.displayName : undefined;
  const invite = (resend?: { email: string; link: string }) => {
    router.push({ pathname: '/household-invite', params: { household: id, ...(you ? { inviter: you } : {}), ...resend } });
  };

  // Send again makes a new link for the same email (revoking the old one), then opens the sheet's step 2.
  const sendAgain = async (pending: HouseholdInvite) => {
    const email = pending.email;
    if (!email) return;
    setBusyInvite(pending.id);
    try {
      const link = await createInvite(id, email);
      invite({ email, link });
    } catch (err) {
      console.warn(`[households] couldn't re-create the invite ${pending.id}`, err);
      Alert.alert(pendingInviteErrorTitle('send-again'), inviteSheetError(err, { email, householdName: household?.name }));
    } finally {
      setBusyInvite(null);
    }
  };

  const revoke = async (pending: HouseholdInvite) => {
    setBusyInvite(pending.id);
    try {
      await revokeInvite(pending.id);
      setInvites((list) => list.filter((i) => i.id !== pending.id));
    } catch (err) {
      console.warn(`[households] couldn't revoke the invite ${pending.id}`, err);
      Alert.alert(pendingInviteErrorTitle('revoke'), inviteSheetError(err, {}));
    } finally {
      setBusyInvite(null);
    }
  };

  const inviteMenu = (pending: HouseholdInvite) => {
    if (busyInvite) return;
    const sheet = pendingInviteActions(pending);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: pendingInviteTitle(pending),
        options: sheet.options,
        destructiveButtonIndex: sheet.destructiveButtonIndex,
        cancelButtonIndex: sheet.cancelButtonIndex,
      },
      (index) => {
        const action = sheet.actions[index];
        if (action === 'send-again') void sendAgain(pending);
        if (action === 'revoke') void revoke(pending);
      },
    );
  };

  const members = state.status === 'ready' ? state.members : [];
  const isOwner = members.some((m) => m.isYou && m.role === 'owner');
  const householdName = household?.name ?? '';

  const remove = async (member: HouseholdMember) => {
    setBusyMember(member.userId);
    try {
      await removeMember(id, member.userId);
      load();
    } catch (err) {
      console.warn(`[households] couldn't remove ${member.userId} from ${id}`, err);
      const alert = householdActionAlert('remove', err, { householdName, memberName: member.displayName });
      Alert.alert(alert.title, alert.message);
    } finally {
      setBusyMember(null);
    }
  };

  const changeRole = async (member: HouseholdMember, change: RoleChange) => {
    setBusyMember(member.userId);
    try {
      const role = roleAfter(change);
      await setMemberRole(id, member.userId, role);
      // Show the new role at once (stepping down hides the owner-only controls), then reload.
      setState((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', members: prev.members.map((m) => (m.userId === member.userId ? { ...m, role } : m)) }
          : prev,
      );
      load();
    } catch (err) {
      console.warn(`[households] couldn't change the role of ${member.userId} in ${id}`, err);
      const alert = householdActionAlert(change, err, { householdName, memberName: member.displayName });
      Alert.alert(alert.title, alert.message);
    } finally {
      setBusyMember(null);
    }
  };

  const memberMenu = (member: HouseholdMember) => {
    if (busyMember || leaving || deleting) return;
    const sheet = memberActionsSheet(member, members, householdName);
    if (!sheet) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: member.displayName,
        options: sheet.options,
        destructiveButtonIndex: sheet.destructiveButtonIndex,
        cancelButtonIndex: sheet.cancelButtonIndex,
      },
      (index) => {
        const action = sheet.actions[index];
        if (!action) return;
        if (action === 'remove') {
          const confirm = removeMemberConfirmation(member.displayName, householdName);
          Alert.alert(confirm.title, confirm.message, [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.remove'), style: 'destructive', onPress: () => void remove(member) },
          ]);
          return;
        }
        const confirm = roleChangeConfirmation(action, member.displayName);
        Alert.alert(confirm.title, confirm.message, [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: confirm.confirmLabel,
            style: confirm.destructive ? 'destructive' : 'default',
            onPress: () => void changeRole(member, action),
          },
        ]);
      },
    );
  };

  const rename = async (name: string) => {
    try {
      await renameHousehold(id, name, userId);
    } catch (err) {
      console.warn(`[households] couldn't rename ${id}`, err);
      const alert = householdActionAlert('rename', err, { householdName });
      Alert.alert(alert.title, alert.message);
    }
  };

  const leave = async () => {
    setLeaving(true);
    try {
      await leaveHousehold(id);
      router.back();
    } catch (err) {
      console.warn(`[households] couldn't leave ${id}`, err);
      const alert = householdActionAlert('leave', err, { householdName });
      Alert.alert(alert.title, alert.message);
      setLeaving(false);
    }
  };

  const runDelete = async () => {
    setDeleting(true);
    try {
      await deleteHousehold(id);
      setDeletedHousehold(householdName);
      router.back();
    } catch (err) {
      console.warn(`[households] couldn't delete ${id}`, err);
      const alert = householdActionAlert('delete', err, { householdName });
      Alert.alert(alert.title, alert.message);
      setDeleting(false);
    }
  };

  const confirmDelete = () => {
    if (deleting || leaving || busyMember || !household) return;
    const confirm = deleteHouseholdConfirmation({
      householdName,
      memberCount: members.length,
      listCount: household.listCount,
      recipeCount: household.recipeCount,
      onlyHousehold: data.length === 1,
    });
    Alert.alert(confirm.title, confirm.message, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: confirm.confirmLabel, style: 'destructive', onPress: () => void runDelete() },
    ]);
  };

  const confirmLeave = () => {
    if (leaving || deleting || busyMember || !household) return;
    const confirm = leaveConfirmation({
      householdName,
      members,
      listCount: household.listCount,
      recipeCount: household.recipeCount,
      onlyHousehold: data.length === 1,
    });
    Alert.alert(confirm.title, confirm.message, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: confirm.confirmLabel, style: 'destructive', onPress: () => void leave() },
    ]);
  };

  useFocusEffect(
    useCallback(() => {
      load();
      return () => {
        request.current++;
      };
    }, [load]),
  );

  return (
    <Screen scroll contentContainerStyle={{ paddingBottom: spacing.xl }}>
      <View
        style={{
          backgroundColor: band.fill,
          paddingHorizontal: spacing.lg + spacing.xs,
          paddingTop: spacing.md + spacing.xxs,
          paddingBottom: spacing.xl - spacing.xxs,
          gap: spacing.lg + spacing.xxs,
        }}>
        <View style={{ gap: spacing.xs }}>
          <View style={[styles.titleRow, { gap: spacing.sm }]}>
            <ThemedText variant="screenTitle" accessibilityRole="header" style={[styles.title, { color: band.text }]}>
              {household?.name ?? ''}
            </ThemedText>
            {isOwner && household ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('households.screen.rename')}
                accessibilityHint={t('households.hints.rename')}
                hitSlop={(sizes.minTapTarget - sizes.iconSmall) / 2}
                onPress={() => promptHouseholdName(householdName, (name) => void rename(name))}>
                <Icon name="pencil" tint={band.text} size={sizes.iconSmall} weight="semibold" />
              </Pressable>
            ) : null}
          </View>
          {household ? (
            <ThemedText variant="amount" style={{ color: band.secondary }}>
              {householdCountsLabel(household.listCount, household.recipeCount)}
            </ThemedText>
          ) : null}
        </View>
        {state.status === 'ready' && state.members.length > 0 ? (
          <Avatars members={state.members} ring={band.fill} />
        ) : null}
      </View>

      <SettingsSection title={t('households.screen.members')}>
        {state.status === 'loading' ? (
          <View style={{ padding: spacing.lg }}>
            <ActivityIndicator color={colors.inkSecondary} accessibilityLabel={t('households.screen.loadingMembers')} />
          </View>
        ) : state.status === 'error' ? (
          <View style={{ padding: spacing.lg, gap: spacing.sm }}>
            <ThemedText variant="body" color="inkSecondary">
              {t('households.membersError')}
            </ThemedText>
            <Button label={t('common.retry')} variant="plain" onPress={load} />
          </View>
        ) : (
          state.members.map((m, i) => {
            const sheet = memberActionsSheet(m, state.members, householdName);
            return (
              <SettingsRow
                key={m.userId}
                label={memberLabel(m)}
                value={m.role === 'owner' ? undefined : roleLabel(m.role)}
                accessibilityLabel={sheet ? memberRowAccessibilityLabel(m) : undefined}
                accessibilityHint={sheet?.hint}
                trailing={
                  busyMember === m.userId ? (
                    <ActivityIndicator color={colors.inkSecondary} />
                  ) : m.role === 'owner' ? (
                    <Badge label={roleLabel(m.role)} tone="owner" />
                  ) : undefined
                }
                chevron={false}
                last={i === state.members.length - 1}
                onPress={sheet ? () => memberMenu(m) : undefined}
              />
            );
          })
        )}
      </SettingsSection>

      {state.status === 'ready' && invites.length > 0 ? (
        <SettingsSection title={t('households.screen.invited')}>
          {invites.map((pending, i) => (
            <SettingsRow
              key={pending.id}
              label={pendingInviteTitle(pending)}
              detail={pendingInviteDetail(pending)}
              accessibilityLabel={pendingInviteAccessibilityLabel(pending)}
              trailing={
                busyInvite === pending.id ? (
                  <ActivityIndicator color={colors.inkSecondary} />
                ) : (
                  <Badge label={t('households.screen.pending')} tone="pending" />
                )
              }
              chevron={false}
              last={i === invites.length - 1}
              onPress={() => inviteMenu(pending)}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title={t('households.screen.settings')}>
        <SettingsRow
          label={t('settings.alwaysHave')}
          value={staplesCountLabel(staples.length)}
          icon={{ name: 'cart', hue: 'amber' }}
          last={!household}
          onPress={() => router.push({ pathname: '/settings/always-have', params: { household: id } })}
        />
        {household ? <CombineLanguagesRow household={household} last /> : null}
      </SettingsSection>
      <ThemedText variant="footnote" color="inkSecondary" style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
        {t('households.screen.settingsFootnote', { name: householdName })}
      </ThemedText>

      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg }}>
        <PrimaryButton label={t('households.screen.inviteSomeone')} icon="person.badge.plus" disabled={!household} onPress={() => invite()} />
      </View>

      {state.status === 'ready' && household ? (
        <View style={{ paddingTop: spacing.lg }}>
          <Card>
            {isOwner ? (
              <SettingsRow
                label={t('households.screen.delete')}
                labelColor="danger"
                accessibilityHint={t('households.hints.delete')}
                trailing={
                  deleting ? (
                    <ActivityIndicator color={colors.inkSecondary} accessibilityLabel={t('households.screen.deleting')} />
                  ) : undefined
                }
                chevron={false}
                onPress={confirmDelete}
              />
            ) : null}
            <SettingsRow
              label={t('households.screen.leave')}
              labelColor="danger"
              accessibilityHint={t('households.hints.leave')}
              trailing={
                leaving ? (
                  <ActivityIndicator color={colors.inkSecondary} accessibilityLabel={t('households.screen.leaving')} />
                ) : undefined
              }
              chevron={false}
              last
              onPress={confirmLeave}
            />
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}

/** The members' initials in overlapping round avatars, each ringed in the band's colour. Decorative. */
function Avatars({ members, ring }: { members: HouseholdMember[]; ring: string }) {
  const { colors, aisles, sizes, spacing, rounded } = useTheme();
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={styles.row}>
      {members.map((m, i) => {
        const look = avatarColors(recipeHue(m.userId), colors, aisles);
        return (
          <View
            key={m.userId}
            style={[
              styles.avatar,
              {
                width: sizes.avatar,
                height: sizes.avatar,
                borderRadius: rounded.full,
                borderWidth: sizes.avatarRing,
                borderColor: ring,
                backgroundColor: look.fill,
                marginLeft: i === 0 ? 0 : -(spacing.sm + spacing.xxs),
              },
            ]}>
            <ThemedText variant="initial" maxFontSizeMultiplier={1.5} style={{ color: look.text }}>
              {avatarInitial(m.displayName)}
            </ThemedText>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  title: { flexShrink: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
});
