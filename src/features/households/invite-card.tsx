import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { avatarColors } from '@/components/appearance';
import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import type { ColorToken } from '@/constants/theme';
import { householdColor } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';

import type { MyInvite } from './invites';
import { inviteCardAccessibilityLabel, inviteCardDetail, inviteCardInitial, inviteCardTitle } from './my-invites';

/**
 * An invite sent to the user's email, at the top of the Lists home (design R2b): the inviter's
 * initial, "John invited you" over "to Smith household · 2 members", and Join and Decline, in a
 * `surface` card outlined in `primary`. While `busy`, that button shows a spinner and both are disabled.
 */
export function InviteCard({
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
  const { colors, aisles, spacing, sizes, rounded } = useTheme();
  const avatar = avatarColors(householdColor(invite.householdId), colors, aisles);
  return (
    <Card
      style={{
        padding: spacing.md + spacing.xxs,
        gap: spacing.sm + spacing.xxs,
        borderWidth: sizes.inviteOutline,
        borderColor: colors.primary,
      }}>
      {/* One VoiceOver element for who and where; the buttons follow it. */}
      <View accessible accessibilityLabel={inviteCardAccessibilityLabel(invite)} style={[styles.row, { gap: spacing.sm + spacing.xxs }]}>
        <View
          style={[
            styles.avatar,
            { width: sizes.iconWell, height: sizes.iconWell, borderRadius: rounded.full, backgroundColor: avatar.fill },
          ]}>
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
      <View style={[styles.row, { gap: spacing.sm }]}>
        <CardButton label="Join" fill="primary" text="onPrimary" busy={busy === 'join'} disabled={!!busy} onPress={onJoin} />
        <CardButton
          label="Decline"
          fill="surfaceMuted"
          text="ink"
          busy={busy === 'decline'}
          disabled={!!busy}
          onPress={onDecline}
        />
      </View>
    </Card>
  );
}

function CardButton({
  label,
  fill,
  text,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  fill: ColorToken;
  text: ColorToken;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.lg,
          borderRadius: rounded.full,
          backgroundColor: colors[fill],
          opacity: disabled && !busy ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}>
      {busy ? (
        <ActivityIndicator color={colors[text]} />
      ) : (
        <ThemedText variant="headline" color={text}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  button: { flex: 1, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
