// Join and Decline for an invite waiting in the app (spec 4.7), shared by the Your lists sheet's rows
// and the List tab's invite cards, so they ask and fail the same way.
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { getAccount } from '@/features/auth/account';
import { i18n } from '@/i18n';

import type { MyInvite } from './invites';
import {
  declineInvitePrompt,
  declineMyInvite,
  householdToReplace,
  joinMyInvite,
  replaceHouseholdPrompt,
  type MyInviteResult,
} from './my-invites';

export type InviteBusy = 'join' | 'decline' | null;

/**
 * Join (asking first whether to keep a household of their own that nobody else is in) and Decline
 * (confirmed first), with the busy button and a toast for a failure or notice: the hook's own
 * `toast`, or `onMessage` for a screen that shows its own. `onJoined` runs after a successful join,
 * once the household is pulled in.
 */
export function useInviteActions({
  onJoined,
  onMessage,
}: { onJoined?: (invite: MyInvite) => void; onMessage?: (message: string) => void } = {}) {
  const [busy, setBusy] = useState<{ id: string; action: 'join' | 'decline' } | null>(null);
  const [toast, setToast] = useState<{ key: number; message: string } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  const settle = (result: MyInviteResult) => {
    setBusy(null);
    // A new key restarts the toast's timer when one is already showing.
    const message = result.ok ? result.notice : result.message;
    if (!message) return;
    if (onMessage) onMessage(message);
    else setToast((t) => ({ key: (t?.key ?? 0) + 1, message }));
  };
  const joined = (invite: MyInvite) => (result: MyInviteResult) => {
    settle(result);
    if (result.ok) onJoined?.(invite);
  };

  const join = async (invite: MyInvite) => {
    setBusy({ id: invite.id, action: 'join' });
    const userId = getAccount()?.userId ?? null;
    const replacing = userId ? await householdToReplace(invite.householdId, userId) : null;
    if (!replacing) return void joinMyInvite(invite).then(joined(invite));
    const prompt = replaceHouseholdPrompt(invite.householdName, replacing);
    Alert.alert(prompt.title, prompt.message, [
      { text: i18n.t('common.cancel'), style: 'cancel', onPress: () => setBusy(null) },
      { text: prompt.keep, onPress: () => void joinMyInvite(invite).then(joined(invite)) },
      { text: prompt.remove, style: 'destructive', onPress: () => void joinMyInvite(invite, replacing).then(joined(invite)) },
    ]);
  };

  const decline = (invite: MyInvite) => {
    const prompt = declineInvitePrompt(invite);
    Alert.alert(prompt.title, prompt.message, [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('invites.card.decline'),
        style: 'destructive',
        onPress: () => {
          setBusy({ id: invite.id, action: 'decline' });
          void declineMyInvite(invite).then(settle);
        },
      },
    ]);
  };

  const busyFor = (invite: MyInvite): InviteBusy => (busy?.id === invite.id ? busy.action : null);
  return { join, decline, busyFor, toast, dismissToast };
}
