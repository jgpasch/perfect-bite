import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { avatarColors } from '@/components/appearance';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { householdColor } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import type { MyInvite } from './invites';
import {
  inviteCardAccessibilityLabel,
  inviteCardDetail,
  inviteCardInitial,
  inviteCardTitle,
  declineInviteLabel,
} from './my-invites';

/**
 * An invite sent to the user's email, at the top of the Your lists sheet (board H): the inviter's
 * initial, "John invited you" over "to Smith household · 2 members", a round Decline and a Join pill.
 * While `busy`, that button shows a spinner and both are disabled.
 */
export function InviteRow({
  invite,
  busy,
  onJoin,
  onDecline,
}: {
  invite: MyInvite;
  busy: 'join' | 'decline' | null;
  onJoin: () => void;
  onDecline: () => void;
}) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  const avatar = avatarColors(householdColor(invite.householdId), colors, aisles);
  const disabled = !!busy;
  const buttonOpacity = (pressed: boolean, isBusy: boolean) => (disabled && !isBusy ? opacity.disabled : pressed ? opacity.pressed : 1);
  return (
    <Card style={[styles.row, { padding: spacing.md, gap: spacing.md }]}>
      {/* One VoiceOver element for who and where; the buttons follow it. */}
      <View accessible accessibilityLabel={inviteCardAccessibilityLabel(invite)} style={[styles.row, styles.flex, { gap: spacing.md }]}>
        <View
          style={[styles.center, { width: sizes.iconWell, height: sizes.iconWell, borderRadius: rounded.full, backgroundColor: avatar.fill }]}>
          <ThemedText variant="initial" maxFontSizeMultiplier={1.5} style={{ color: avatar.text }}>
            {inviteCardInitial(invite)}
          </ThemedText>
        </View>
        <View style={styles.flex}>
          <ThemedText variant="headline">{inviteCardTitle(invite)}</ThemedText>
          <ThemedText variant="footnote" color="inkSecondary">
            {inviteCardDetail(invite)}
          </ThemedText>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={declineInviteLabel(invite)}
        accessibilityState={{ disabled, busy: busy === 'decline' }}
        disabled={disabled}
        onPress={onDecline}
        style={({ pressed }) => [
          styles.center,
          {
            width: sizes.minTapTarget,
            height: sizes.minTapTarget,
            borderRadius: rounded.full,
            backgroundColor: colors.surfaceMuted,
            opacity: buttonOpacity(pressed, busy === 'decline'),
          },
        ]}>
        {busy === 'decline' ? <ActivityIndicator color={colors.ink} /> : <Icon name="xmark" weight="semibold" />}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('invites.card.join')}
        accessibilityState={{ disabled, busy: busy === 'join' }}
        disabled={disabled}
        onPress={onJoin}
        style={({ pressed }) => [
          styles.center,
          {
            minHeight: sizes.minTapTarget,
            paddingHorizontal: spacing.lg,
            borderRadius: rounded.full,
            backgroundColor: colors.primary,
            opacity: buttonOpacity(pressed, busy === 'join'),
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
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
