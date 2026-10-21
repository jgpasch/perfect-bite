import { Fragment, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { avatarColors } from '@/components/appearance';
import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import { Toast } from '@/components/toast';
import { householdColor } from '@/domain/aisle-color';
import { getAccount } from '@/features/auth/account';
import { setCurrentList } from '@/features/lists/current-list';
import { firstOpenListIn, startOwnList } from '@/features/lists/lists';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { avatarInitial } from './households';
import { useInviteActions, type InviteBusy } from './invite-actions';
import type { MyInvite } from './invites';
import {
  dismissJoined,
  hideInvite,
  inviteCardAccessibilityLabel,
  inviteCardInitial,
  pinnedInvite,
  useHiddenInviteIds,
  useJoinedHousehold,
  useMyInvites,
  type JoinedHousehold,
} from './my-invites';

/** After a join from a card, the List tab opens one of the household's lists. */
function openJoinedList(invite: MyInvite) {
  const listId = firstOpenListIn(invite.householdId);
  if (listId) setCurrentList(listId);
}

function InviteAvatar({ householdId, initial, large = false }: { householdId: string; initial: string; large?: boolean }) {
  const { colors, aisles, sizes, rounded } = useTheme();
  const avatar = avatarColors(householdColor(householdId), colors, aisles);
  const size = large ? sizes.inviteAvatar : sizes.iconWell;
  return (
    <View style={[styles.center, { width: size, height: size, borderRadius: rounded.full, backgroundColor: avatar.fill }]}>
      <ThemedText variant={large ? 'title' : 'initial'} maxFontSizeMultiplier={1.5} style={{ color: avatar.text }}>
        {initial}
      </ThemedText>
    </View>
  );
}

const householdOf = (invite: MyInvite, fallback: string) => invite.householdName.trim() || fallback;

/**
 * The List tab with no lists while invites are waiting (spec 4.7, mockup A): a card per invite with
 * Join and Decline, then Start my own list. `footer` goes under it (the Your lists button when lists
 * are archived).
 */
export function InviteWelcome({ invites, footer }: { invites: MyInvite[]; footer?: ReactNode }) {
  const { spacing } = useTheme();
  const t = useT();
  const { join, decline, busyFor, toast, dismissToast } = useInviteActions({ onJoined: openJoinedList });
  const startOwn = () => {
    const userId = getAccount()?.userId;
    if (userId) setCurrentList(startOwnList(userId));
  };
  const one = invites.length === 1;
  return (
    <View style={styles.flex}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.lg }}>
        {one ? (
          <View style={{ gap: spacing.sm }}>
            <ThemedText variant="sectionLabel" color="inkSecondary" style={{ paddingHorizontal: spacing.xs }}>
              {t('invites.welcome.label')}
            </ThemedText>
            <OneInviteCard invite={invites[0]} busy={busyFor(invites[0])} onJoin={join} onDecline={decline} />
          </View>
        ) : (
          <Fragment>
            <View style={{ gap: spacing.xs, paddingHorizontal: spacing.xs }}>
              <ThemedText variant="screenTitle" accessibilityRole="header">
                {t('invites.welcome.manyTitle', { count: invites.length })}
              </ThemedText>
              <ThemedText variant="callout" color="inkSecondary">
                {invites.length === 2 ? t('invites.welcome.manyTwo') : t('invites.welcome.manyMore')}
              </ThemedText>
            </View>
            {invites.map((invite) => (
              <ManyInviteCard key={invite.id} invite={invite} busy={busyFor(invite)} onJoin={join} onDecline={decline} />
            ))}
          </Fragment>
        )}
        {one ? (
          <View style={[styles.row, { gap: spacing.md, paddingHorizontal: spacing.sm }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Rule />
            <ThemedText variant="footnote" color="inkSecondary">
              {t('invites.welcome.or')}
            </ThemedText>
            <Rule />
          </View>
        ) : null}
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <Pill dashed icon="plus" label={one ? t('invites.welcome.startOwn') : t('invites.welcome.startOwnInstead')} onPress={startOwn} />
          {one ? (
            <ThemedText variant="footnote" color="inkSecondary" style={styles.centerText}>
              {t('invites.welcome.later')}
            </ThemedText>
          ) : null}
          {footer}
        </View>
      </ScrollView>
      {toast ? (
        <View style={{ paddingBottom: spacing.sm }}>
          <Toast key={toast.key} message={toast.message} actions={[]} onDismiss={dismissToast} />
        </View>
      ) : null}
    </View>
  );
}

function Rule() {
  const { colors } = useTheme();
  return <View style={[styles.flex, { height: StyleSheet.hairlineWidth, backgroundColor: colors.controlBorder }]} />;
}

type CardProps = {
  invite: MyInvite;
  busy: InviteBusy;
  onJoin: (invite: MyInvite) => void;
  onDecline: (invite: MyInvite) => void;
};

/** Mockup A: the one invite, large. */
function OneInviteCard({ invite, busy, onJoin, onDecline }: CardProps) {
  const { spacing } = useTheme();
  const t = useT();
  const household = householdOf(invite, t('invites.card.aHousehold'));
  const inviter = invite.invitedBy?.trim();
  return (
    <Card style={{ padding: spacing.xl, gap: spacing.lg }}>
      <View accessible accessibilityLabel={inviteCardAccessibilityLabel(invite)} style={{ gap: spacing.lg }}>
        <InviteAvatar householdId={invite.householdId} initial={inviteCardInitial(invite)} large />
        <View style={{ gap: spacing.xs }}>
          <ThemedText variant="callout" color="inkSecondary">
            {inviter ? t('invites.welcome.invitedYouTo', { name: inviter }) : t('invites.welcome.invitedYouToUnnamed')}
          </ThemedText>
          <ThemedText variant="screenTitle">{household}</ThemedText>
          <ThemedText variant="amount" color="inkSecondary">
            {t('invites.welcome.members', { count: invite.memberCount })}
          </ThemedText>
        </View>
      </View>
      <ThemedText variant="body">{t('invites.welcome.pitch')}</ThemedText>
      <View style={{ gap: spacing.xs }}>
        <PrimaryButton
          label={t('invites.welcome.join', { household })}
          loading={busy === 'join'}
          disabled={!!busy}
          onPress={() => onJoin(invite)}
        />
        <Button
          variant="plain"
          color="inkSecondary"
          label={t('invites.welcome.decline')}
          accessibilityLabel={t('invites.card.declineLabel', { household })}
          loading={busy === 'decline'}
          disabled={!!busy}
          onPress={() => onDecline(invite)}
        />
      </View>
    </Card>
  );
}

/** Mockup "A, two invites": a card each, with Decline and Join side by side. */
function ManyInviteCard({ invite, busy, onJoin, onDecline }: CardProps) {
  const { spacing } = useTheme();
  const t = useT();
  const household = householdOf(invite, t('invites.card.aHousehold'));
  const inviter = invite.invitedBy?.trim();
  return (
    <Card style={{ padding: spacing.lg, gap: spacing.md }}>
      <View accessible accessibilityLabel={inviteCardAccessibilityLabel(invite)} style={[styles.row, { gap: spacing.md }]}>
        <InviteAvatar householdId={invite.householdId} initial={inviteCardInitial(invite)} large />
        <View style={styles.flex}>
          <ThemedText variant="title">{household}</ThemedText>
          <ThemedText variant="subhead" color="inkSecondary">
            {inviter
              ? t('invites.welcome.from', { name: inviter, count: invite.memberCount })
              : t('invites.welcome.members', { count: invite.memberCount })}
          </ThemedText>
        </View>
      </View>
      <View style={[styles.row, { gap: spacing.sm }]}>
        <View style={styles.flex}>
          <Button
            label={t('invites.card.decline')}
            accessibilityLabel={t('invites.card.declineLabel', { household })}
            loading={busy === 'decline'}
            disabled={!!busy}
            onPress={() => onDecline(invite)}
          />
        </View>
        <View style={styles.flexTwo}>
          <JoinPill busy={busy} onPress={() => onJoin(invite)} />
        </View>
      </View>
    </Card>
  );
}

/** The Join pill: `primary`, 44 pt, a spinner while it runs. */
function JoinPill({ busy, onPress }: { busy: InviteBusy; onPress: () => void }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  const disabled = !!busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('invites.card.join')}
      accessibilityState={{ disabled, busy: busy === 'join' }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.center,
        {
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.xl,
          borderRadius: rounded.full,
          backgroundColor: colors.primary,
          opacity: disabled && busy !== 'join' ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}>
      {busy === 'join' ? (
        <ActivityIndicator color={colors.onPrimary} />
      ) : (
        <ThemedText variant="headline" color="onPrimary">
          {t('invites.card.join')}
        </ThemedText>
      )}
    </Pressable>
  );
}

/**
 * On a list (spec 4.7): the "You're in" card on the household just joined, and the invite still
 * waiting pinned above the rows (mockup C). `onMessage` shows a failure in the list's toast.
 */
export function ListInviteCards({ householdId, onMessage }: { householdId: string; onMessage: (message: string) => void }) {
  const { spacing } = useTheme();
  const joined = useJoinedHousehold();
  const invites = useMyInvites();
  const hidden = useHiddenInviteIds();
  const pinned = pinnedInvite(invites, hidden);
  const showJoined = joined?.householdId === householdId;
  if (!showJoined && !pinned) return null;
  return (
    <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm + spacing.xxs, gap: spacing.sm + spacing.xxs }}>
      {showJoined ? <JoinedCard joined={joined} /> : null}
      {pinned ? <PinnedInviteCard invite={pinned} onMessage={onMessage} /> : null}
    </View>
  );
}

/** Mockup "After Join": "You're in Paschal Home", until ✕. */
function JoinedCard({ joined }: { joined: JoinedHousehold }) {
  const { spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  const household = joined.householdName.trim() || t('invites.card.aHousehold');
  const inviter = joined.invitedBy?.trim();
  return (
    <Card background="primarySoft" style={[styles.row, { paddingVertical: spacing.md, paddingLeft: spacing.lg, paddingRight: spacing.xs, gap: spacing.md }]}>
      <InviteAvatar householdId={joined.householdId} initial={avatarInitial(inviter || household)} />
      <View accessible style={styles.flex}>
        <ThemedText variant="headline" color="onPrimarySoft">
          {t('invites.joined.title', { household })}
        </ThemedText>
        <ThemedText variant="footnote" color="onPrimarySoft">
          {inviter ? t('invites.joined.message', { name: inviter }) : t('invites.joined.messageUnnamed')}
        </ThemedText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('invites.joined.dismiss')}
        onPress={dismissJoined}
        style={({ pressed }) => [
          styles.center,
          { width: sizes.minTapTarget, height: sizes.minTapTarget, borderRadius: rounded.full, opacity: pressed ? opacity.pressed : 1 },
        ]}>
        <Icon name="xmark" color="onPrimarySoft" weight="semibold" />
      </Pressable>
    </Card>
  );
}

/** Mockup C: the invite pinned above the list's rows, with Not now, Decline and Join. */
function PinnedInviteCard({ invite, onMessage }: { invite: MyInvite; onMessage: (message: string) => void }) {
  const { colors, spacing, sizes } = useTheme();
  const t = useT();
  const { join, decline, busyFor } = useInviteActions({ onJoined: openJoinedList, onMessage });
  const busy = busyFor(invite);
  const household = householdOf(invite, t('invites.card.aHousehold'));
  const inviter = invite.invitedBy?.trim();
  return (
    <Card style={{ borderWidth: sizes.focusRing, borderColor: colors.primary, padding: spacing.md, paddingLeft: spacing.lg, gap: spacing.sm }}>
      <View accessible accessibilityLabel={inviteCardAccessibilityLabel(invite)} style={[styles.row, { gap: spacing.md }]}>
        <InviteAvatar householdId={invite.householdId} initial={inviteCardInitial(invite)} />
        <View style={styles.flex}>
          <ThemedText variant="headline">
            {inviter ? t('invites.pinned.title', { name: inviter, household }) : t('invites.pinned.titleUnnamed', { household })}
          </ThemedText>
          <ThemedText variant="footnote" color="inkSecondary">
            {t('invites.pinned.detail', { count: invite.memberCount })}
          </ThemedText>
        </View>
      </View>
      <View style={[styles.row, styles.wrap, { gap: spacing.xs }]}>
        <Button variant="plain" color="inkSecondary" label={t('invites.pinned.notNow')} disabled={!!busy} onPress={() => hideInvite(invite.id)} />
        <View style={styles.flex} />
        <Button
          variant="plain"
          color="danger"
          label={t('invites.card.decline')}
          accessibilityLabel={t('invites.card.declineLabel', { household })}
          loading={busy === 'decline'}
          disabled={!!busy}
          onPress={() => decline(invite)}
        />
        <JoinPill busy={busy} onPress={() => void join(invite)} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexTwo: { flex: 2 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  centerText: { textAlign: 'center' },
});
