import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, PrimaryButton } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import {
  acceptInvite,
  InviteError,
  inviteErrorMessage,
  inviteStatusMessage,
  JOIN_BODY,
  joinTitle,
  previewInvite,
  type InviteErrorKind,
  type InvitePreview,
} from '@/features/households/invites';
import { useTheme } from '@/hooks/use-theme';
import { pullNow } from '@/sync/pull';

type State =
  | { status: 'loading' }
  | { status: 'error'; kind: InviteErrorKind }
  | { status: 'ready'; preview: InvitePreview; joining: boolean };

const errorKind = (err: unknown): InviteErrorKind => (err instanceof InviteError ? err.kind : 'network');

/**
 * The join screen (spec 4.7), opened by an invite link (`perfectbite://invite/<token>`): "Join
 * Test home?" with Join and Not now. Joining adds the user on the server, pulls the household in
 * and opens the Lists tab. An invite to a household the user is already in says so and opens it.
 */
export default function JoinHouseholdScreen() {
  const { colors, spacing } = useTheme();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });
  const request = useRef(0);

  const load = useCallback(() => {
    const current = ++request.current;
    setState({ status: 'loading' });
    previewInvite(token).then(
      (preview) => current === request.current && setState({ status: 'ready', preview, joining: false }),
      (err) => {
        console.warn('[invite] preview failed', err);
        if (current === request.current) setState({ status: 'error', kind: errorKind(err) });
      },
    );
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      load();
      return () => {
        request.current++;
      };
    }, [load]),
  );

  const close = () => (router.canGoBack() ? router.back() : router.replace('/lists'));

  const openHousehold = (householdId: string) =>
    router.replace({ pathname: '/settings/households/[id]', params: { id: householdId } });

  const join = async (preview: InvitePreview) => {
    setState({ status: 'ready', preview, joining: true });
    try {
      const accepted = await acceptInvite(token);
      // The new membership syncs the household in; wait for it so its lists are there.
      await pullNow();
      if (accepted.alreadyMember) openHousehold(accepted.householdId);
      else router.replace('/lists');
    } catch (err) {
      console.warn('[invite] accept failed', err);
      setState({ status: 'error', kind: errorKind(err) });
    }
  };

  const padding = { padding: spacing.lg + spacing.xs, gap: spacing.lg };

  if (state.status === 'loading') {
    return (
      <Screen style={[padding, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.inkSecondary} accessibilityLabel="Loading invite" />
      </Screen>
    );
  }

  if (state.status === 'error') {
    return (
      <Screen scroll contentContainerStyle={padding}>
        <ThemedText variant="title" accessibilityRole="header">
          {state.kind === 'network' ? "Couldn't load the invite" : "Can't join"}
        </ThemedText>
        <ThemedText variant="lead" color="inkSecondary">
          {inviteErrorMessage(state.kind)}
        </ThemedText>
        <View style={{ gap: spacing.sm }}>
          {state.kind === 'network' ? <PrimaryButton label="Try again" onPress={load} /> : null}
          <Button label="Close" variant="plain" onPress={close} />
        </View>
      </Screen>
    );
  }

  const { preview, joining } = state;
  const blocked = inviteStatusMessage(preview.status, preview.householdName);

  return (
    <Screen scroll contentContainerStyle={padding}>
      <ThemedText variant="title" accessibilityRole="header">
        {preview.status === 'valid' ? joinTitle(preview.householdName) : preview.householdName}
      </ThemedText>
      {preview.status === 'valid' && preview.invitedBy ? (
        <ThemedText variant="amount" color="inkSecondary">
          {`Invited by ${preview.invitedBy}`}
        </ThemedText>
      ) : null}
      <ThemedText variant="lead" color="inkSecondary">
        {blocked ?? JOIN_BODY}
      </ThemedText>
      <View style={{ gap: spacing.sm }}>
        {preview.status === 'valid' ? (
          <PrimaryButton
            label={joining ? 'Joining…' : 'Join'}
            disabled={joining}
            onPress={() => join(preview)}
          />
        ) : preview.status === 'member' ? (
          <PrimaryButton label="Open household" onPress={() => openHousehold(preview.householdId)} />
        ) : null}
        <Button label={preview.status === 'valid' ? 'Not now' : 'Close'} variant="plain" disabled={joining} onPress={close} />
      </View>
    </Screen>
  );
}
