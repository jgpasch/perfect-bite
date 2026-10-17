import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';

import { Button, PrimaryButton } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import {
  acceptInvite,
  InviteError,
  inviteErrorMessage,
  inviteStatusMessage,
  joinTitle,
  previewInvite,
  type InviteErrorKind,
  type InvitePreview,
} from '@/features/households/invites';
import { getAccount } from '@/features/auth/account';
import { deleteReplaced, householdToReplace, replaceHouseholdPrompt } from '@/features/households/my-invites';
import { notePushMoment } from '@/features/push/ask';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
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
  const t = useT();
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

  // With a household of their own and nobody else in it, ask whether to keep it first.
  const join = async (preview: InvitePreview) => {
    setState({ status: 'ready', preview, joining: true });
    const userId = getAccount()?.userId;
    const replacing = userId ? await householdToReplace(preview.householdId, userId) : null;
    if (!replacing) return accept(null);
    const prompt = replaceHouseholdPrompt(preview.householdName, replacing);
    Alert.alert(prompt.title, prompt.message, [
      { text: t('common.cancel'), style: 'cancel', onPress: () => setState({ status: 'ready', preview, joining: false }) },
      { text: prompt.keep, onPress: () => void accept(null) },
      { text: prompt.remove, style: 'destructive', onPress: () => void accept(replacing) },
    ]);
  };

  const accept = async (replacing: { id: string; name: string } | null) => {
    try {
      const accepted = await acceptInvite(token);
      // The new membership syncs the household in; wait for it so its lists are there.
      await pullNow();
      if (accepted.alreadyMember) return openHousehold(accepted.householdId);
      // Now sharing a household: the moment to offer notifications (spec 4.13).
      notePushMoment();
      // Joined first, so deleting it never leaves the user with no household.
      const failed = replacing ? await deleteReplaced(replacing) : null;
      if (failed?.ok && failed.notice) Alert.alert(failed.notice);
      router.replace('/lists');
    } catch (err) {
      console.warn('[invite] accept failed', err);
      setState({ status: 'error', kind: errorKind(err) });
    }
  };

  const padding = { padding: spacing.lg + spacing.xs, gap: spacing.lg };

  if (state.status === 'loading') {
    return (
      <Screen style={[padding, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.inkSecondary} accessibilityLabel={t('invites.join.loading')} />
      </Screen>
    );
  }

  if (state.status === 'error') {
    return (
      <Screen scroll contentContainerStyle={padding}>
        <ThemedText variant="title" accessibilityRole="header">
          {state.kind === 'network' ? t('invites.join.loadFailed') : t('invites.join.cantJoin')}
        </ThemedText>
        <ThemedText variant="lead" color="inkSecondary">
          {inviteErrorMessage(state.kind)}
        </ThemedText>
        <View style={{ gap: spacing.sm }}>
          {state.kind === 'network' ? <PrimaryButton label={t('common.tryAgain')} onPress={load} /> : null}
          <Button label={t('common.close')} variant="plain" onPress={close} />
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
          {t('invites.join.invitedBy', { name: preview.invitedBy })}
        </ThemedText>
      ) : null}
      <ThemedText variant="lead" color="inkSecondary">
        {blocked ?? t('invites.joinBody')}
      </ThemedText>
      <View style={{ gap: spacing.sm }}>
        {preview.status === 'valid' ? (
          <PrimaryButton
            label={joining ? t('invites.join.joining') : t('invites.join.join')}
            disabled={joining}
            onPress={() => void join(preview)}
          />
        ) : preview.status === 'member' ? (
          <PrimaryButton label={t('invites.join.openHousehold')} onPress={() => openHousehold(preview.householdId)} />
        ) : null}
        <Button
          label={preview.status === 'valid' ? t('invites.join.notNow') : t('common.close')}
          variant="plain"
          disabled={joining}
          onPress={close}
        />
      </View>
    </Screen>
  );
}
