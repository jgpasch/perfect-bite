import * as Clipboard from 'expo-clipboard';
import * as MailComposer from 'expo-mail-composer';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as SMS from 'expo-sms';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';

import { avatarColors, prominentButtonTint } from '@/components/appearance';
import { Button } from '@/components/button';
import type { IconName } from '@/components/icon';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import { recipeHue, type AisleHue } from '@/domain/aisle-color';
import { avatarInitial, householdsQuery } from '@/features/households/households';
import {
  canSubmitInvite,
  INVITE_EMAIL_FOOTNOTE,
  INVITE_JOINING_LINE,
  inviteChannelLabel,
  inviteChannels,
  inviteSendTitle,
  inviteSheetError,
  inviteSheetReducer,
  inviteSheetTitle,
  inviteSheetStartState,
  inviteSkipNote,
  type InviteChannel,
} from '@/features/households/invite-sheet';
import { createInvite, inviteMailBody, inviteMailSubject, inviteShareMessage } from '@/features/households/invites';
import { useTheme } from '@/hooks/use-theme';
import { pushNow } from '@/sync/push';

const CHANNEL_ICONS: Record<InviteChannel, { name: IconName; hue: AisleHue }> = {
  messages: { name: 'message.fill', hue: 'green' },
  mail: { name: 'envelope.fill', hue: 'blue' },
  copy: { name: 'doc.on.doc', hue: 'amber' },
  more: { name: 'square.and.arrow.up', hue: 'grey' },
};

/**
 * "Invite someone" (spec 4.7, designs S2 and S3), opened from the household screen with `household`
 * and, when the members have loaded, `inviter` (the caller's display name, for the Mail body). Step 1
 * asks for the invitee's email and creates the invite; step 2 offers Messages, Mail, Copy link and
 * More… to tell them. "Share a link instead" makes a link-only invite and opens the share sheet.
 * "Send again" on a pending invite re-creates it first and passes `email` and `link`, opening step 2.
 */
export default function HouseholdInviteSheet() {
  const {
    household: householdId,
    inviter,
    email: resentEmail,
    link: resentLink,
  } = useLocalSearchParams<{ household: string; inviter?: string; email?: string; link?: string }>();
  const { colors, spacing, scheme } = useTheme();
  // A sheet is short-lived: read once rather than live.
  const [householdName] = useState(() => householdsQuery().all().find((h) => h.id === householdId)?.name ?? null);
  const [state, dispatch] = useReducer(inviteSheetReducer, { email: resentEmail, link: resentLink }, inviteSheetStartState);
  const [sharing, setSharing] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const submit = async () => {
    if (!canSubmitInvite(state)) return;
    const email = state.email;
    dispatch({ type: 'submit' });
    try {
      // A household made on this device has to reach the server before it can have invites.
      await pushNow({ force: true });
      dispatch({ type: 'created', link: await createInvite(householdId, email) });
    } catch (err) {
      console.warn(`[households] couldn't create an invite to ${householdId}`, err);
      dispatch({ type: 'failed', message: inviteSheetError(err, { email, householdName }) });
    }
  };

  const shareLink = async () => {
    setSharing(true);
    setLinkError(null);
    try {
      await pushNow({ force: true });
      const link = await createInvite(householdId);
      await Share.share({ message: inviteShareMessage(householdName ?? '', link) });
      router.back();
    } catch (err) {
      console.warn(`[households] couldn't create a link invite to ${householdId}`, err);
      setLinkError(inviteSheetError(err, { householdName }));
      setSharing(false);
    }
  };

  const busy = state.step === 'email' && (state.submitting || sharing);
  const error = state.step === 'email' ? (state.error ?? linkError) : null;

  if (state.step === 'send') {
    return (
      <SendStep
        email={state.email}
        link={state.link}
        householdName={householdName}
        inviter={inviter ?? null}
        onBack={() => dispatch({ type: 'back' })}
      />
    );
  }

  // The scroll view is the screen's root: in a form sheet, react-native-screens sizes a root scroll view
  // to the sheet, but positions one nested in a plain view by the sheet's frame, off-screen on iOS 26.
  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.View hidden={!state.submitting}>
          <ActivityIndicator color={colors.inkSecondary} accessibilityLabel="Creating invite" />
        </Stack.Toolbar.View>
        <Stack.Toolbar.Button
          hidden={state.submitting}
          variant="done"
          tintColor={prominentButtonTint(scheme, colors)}
          disabled={!canSubmitInvite(state) || sharing}
          onPress={submit}>
          Next
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View style={{ paddingHorizontal: spacing.lg + spacing.xs, gap: spacing.xs, paddingBottom: spacing.sm }}>
        <ThemedText variant="title" accessibilityRole="header">
          {inviteSheetTitle(householdName)}
        </ThemedText>
        <ThemedText variant="footnote" color="inkSecondary">
          {INVITE_JOINING_LINE}
        </ThemedText>
      </View>
      <View style={{ paddingHorizontal: spacing.lg }}>
        <TextField
          value={state.email}
          onChangeText={(email) => (dispatch({ type: 'edit', email }), setLinkError(null))}
          placeholder="name@example.com"
          accessibilityLabel="Their email"
          accessibilityHint={INVITE_EMAIL_FOOTNOTE}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="next"
          editable={!busy}
          onSubmitEditing={submit}
        />
      </View>
      {error ? (
        <ThemedText
          variant="footnote"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          {error}
        </ThemedText>
      ) : null}
      <ThemedText
        variant="footnote"
        color="inkSecondary"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
        {INVITE_EMAIL_FOOTNOTE}
      </ThemedText>
      <View style={[styles.start, { paddingHorizontal: spacing.lg, paddingTop: spacing.sm }]}>
        <Button
          label={sharing ? 'Creating link…' : "Don't know their email? Share a link instead"}
          variant="plain"
          color="inkSecondary"
          disabled={busy}
          onPress={shareLink}
        />
      </View>
    </Screen>
  );
}

/** Step 2 (S3): who it's for, then the ways to tell them, the skip note and Done. */
function SendStep({
  email,
  link,
  householdName,
  inviter,
  onBack,
}: {
  email: string;
  link: string;
  householdName: string | null;
  inviter: string | null;
  onBack: () => void;
}) {
  const { colors, aisles, spacing, sizes, rounded } = useTheme();
  const [available, setAvailable] = useState<{ sms: boolean | null; mail: boolean | null }>({ sms: null, mail: null });
  const [copied, setCopied] = useState(0);
  const avatar = avatarColors(recipeHue(email), colors, aisles);

  useEffect(() => {
    let live = true;
    const check = (run: () => Promise<boolean>) => run().catch(() => false);
    Promise.all([check(SMS.isAvailableAsync), check(MailComposer.isAvailableAsync)]).then(([sms, mail]) => {
      if (live) setAvailable({ sms, mail });
    });
    return () => {
      live = false;
    };
  }, []);

  const send = async (channel: InviteChannel) => {
    const name = householdName ?? '';
    try {
      switch (channel) {
        case 'messages':
          await SMS.sendSMSAsync([], inviteShareMessage(name, link));
          break;
        case 'mail':
          await MailComposer.composeAsync({
            recipients: [email],
            subject: inviteMailSubject(name),
            body: inviteMailBody({ householdName: name, inviterName: inviter, email, link }),
          });
          break;
        case 'copy':
          await Clipboard.setStringAsync(link);
          setCopied((n) => n + 1);
          break;
        case 'more':
          await Share.share({ message: inviteShareMessage(name, link) });
          break;
      }
    } catch (err) {
      console.warn(`[households] couldn't send an invite with ${channel}`, err);
    }
  };

  const dismissToast = useCallback(() => setCopied(0), []);
  const channels = inviteChannels(available);

  // A root scroll view, as on step 1; Done sits at its foot, pushed down by a spacer.
  return (
    <Screen
      scroll
      contentContainerStyle={{ flexGrow: 1, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="chevron.left" accessibilityLabel="Back" onPress={onBack} />
      </Stack.Toolbar>
      <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
        {inviteSendTitle(email)}
      </ThemedText>
      <View
        accessible
        style={[styles.row, { paddingHorizontal: spacing.lg + spacing.xs, paddingTop: spacing.md, gap: spacing.md }]}>
        <View
          style={[
            styles.avatar,
            { width: sizes.iconWell, height: sizes.iconWell, borderRadius: rounded.full, backgroundColor: avatar.fill },
          ]}>
          <ThemedText variant="initial" maxFontSizeMultiplier={1.5} style={{ color: avatar.text }}>
            {avatarInitial(email)}
          </ThemedText>
        </View>
        <View style={styles.flex}>
          <ThemedText variant="headline">{email}</ThemedText>
          <ThemedText variant="footnote" color="inkSecondary">
            Invite expires in 7 days
          </ThemedText>
        </View>
      </View>
      <SettingsSection title="Send it with">
        {channels.map((channel, i) => (
          <SettingsRow
            key={channel}
            label={inviteChannelLabel(channel)}
            icon={CHANNEL_ICONS[channel]}
            chevron={channel !== 'copy'}
            last={i === channels.length - 1}
            onPress={() => void send(channel)}
          />
        ))}
      </SettingsSection>
      <View
        style={{
          marginHorizontal: spacing.lg,
          marginTop: spacing.md,
          padding: spacing.md,
          borderRadius: rounded.row,
          borderCurve: 'continuous',
          backgroundColor: colors.primarySoft,
        }}>
        <ThemedText variant="footnote" color="onPrimarySoft">
          {inviteSkipNote(email)}
        </ThemedText>
      </View>
      <View style={styles.flex} />
      {copied ? (
        <View style={{ paddingTop: spacing.md }}>
          <Toast key={copied} message="Link copied" actions={[]} onDismiss={dismissToast} />
        </View>
      ) : null}
      <View style={{ alignItems: 'center', paddingTop: spacing.sm }}>
        <Button label="Done" variant="plain" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  start: { alignItems: 'flex-start' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
});
