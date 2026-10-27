import { router } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { Button, PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/themed-view';
import { households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { InviteWelcome } from '@/features/households/invite-cards';
import { useMyInvites } from '@/features/households/my-invites';
import { openList, resolveCurrentListId, useCurrentListVersion } from '@/features/lists/current-list';
import { ListScreen } from '@/features/lists/list-screen';
import { listsWithCountsQuery } from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The List tab (spec 4.1, board E): the current list itself, the one last shown on this device, else
 * the default list, else the first. Its name opens the Your lists sheet to switch. Deleting or
 * archiving it moves on to the next one.
 */
export default function ListTab() {
  // userSettings: the default list falls back to the first one when it's archived or deleted.
  const { data, loading } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  const userId = getAccount()?.userId ?? null;
  const version = useCurrentListVersion();
  // Re-resolved whenever lists or settings change (`data` is a new array then), so a new default list
  // counts too. The screen is keyed by id, so it only remounts when the list itself changes.
  const currentId = useMemo(
    () => resolveCurrentListId(data.filter((l) => l.archivedAt === null), userId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version`: another screen picked a list
    [data, userId, version],
  );

  if (currentId) return <ListScreen key={currentId} id={currentId} />;
  // Not while the first read is in flight, or every mount flashes "make a list".
  if (loading) return <Screen />;
  return <NoLists hasOthers={data.length > 0} />;
}

/**
 * No open lists. While invites are waiting (an invited new user, spec 4.7): the invite cards.
 * Otherwise make one. Either way, archived lists are a button away in the Your lists sheet.
 */
function NoLists({ hasOthers }: { hasOthers: boolean }) {
  const { spacing } = useTheme();
  const t = useT();
  const invites = useMyInvites();
  const yourLists = hasOthers ? (
    <Button label={t('lists.noLists.yourLists')} variant="plain" onPress={() => router.push('/lists-sheet')} />
  ) : null;
  if (invites.length > 0) {
    return (
      <Screen>
        <InviteWelcome invites={invites} footer={yourLists} />
      </Screen>
    );
  }
  return (
    <Screen>
      <EmptyState
        message={t('lists.noLists.message')}
        action={
          <View style={{ gap: spacing.sm }}>
            <PrimaryButton label={t('lists.noLists.newList')} onPress={() => promptListName(null, '', openList)} />
            {yourLists}
          </View>
        }
      />
    </Screen>
  );
}
