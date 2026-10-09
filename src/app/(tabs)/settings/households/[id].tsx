import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button } from '@/components/button';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { households } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { useAccountState } from '@/features/auth/account';
import {
  fetchHouseholdMembers,
  householdsQuery,
  memberLabel,
  MEMBERS_ERROR_MESSAGE,
  roleLabel,
  type HouseholdMember,
} from '@/features/households/households';
import { useTheme } from '@/hooks/use-theme';

type MembersState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; members: HouseholdMember[] };

/**
 * A household and its members (spec 4.7), read-only. Members come from the server, so this needs a
 * connection and a registered household; anything else shows the error with Retry.
 * TODO(M7): invites, rename, leave and roles.
 */
export default function HouseholdScreen() {
  const { colors, spacing } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : null;
  const { data } = useLiveQueryOn(householdsQuery(), [households]);
  const household = data.find((h) => h.id === id);

  const [state, setState] = useState<MembersState>({ status: 'loading' });
  const request = useRef(0);

  const load = useCallback(() => {
    const current = ++request.current;
    // Keep showing members already loaded while refreshing on refocus.
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    const done = (next: MembersState) => current === request.current && setState(next);
    if (!userId) {
      done({ status: 'error' });
      return;
    }
    fetchHouseholdMembers(id, userId).then(
      (members) => done({ status: 'ready', members }),
      (err) => {
        console.warn(`[households] couldn't load members of ${id}`, err);
        done({ status: 'error' });
      },
    );
  }, [id, userId]);

  useFocusEffect(
    useCallback(() => {
      load();
      return () => {
        request.current++;
      };
    }, [load]),
  );

  return (
    <Screen scroll contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}>
      <Stack.Screen options={{ title: household?.name ?? '' }} />
      <SettingsSection title="Household">
        <SettingsRow label="Name" value={household?.name ?? '—'} last />
      </SettingsSection>
      <SettingsSection title="Members">
        {state.status === 'loading' ? (
          <View style={{ padding: spacing.lg }}>
            <ActivityIndicator color={colors.inkSecondary} accessibilityLabel="Loading members" />
          </View>
        ) : state.status === 'error' ? (
          <View style={{ padding: spacing.lg, gap: spacing.sm }}>
            <ThemedText variant="body" color="inkSecondary">
              {MEMBERS_ERROR_MESSAGE}
            </ThemedText>
            <Button label="Retry" variant="plain" onPress={load} />
          </View>
        ) : (
          state.members.map((m, i) => (
            <SettingsRow
              key={m.userId}
              label={memberLabel(m)}
              value={roleLabel(m.role)}
              last={i === state.members.length - 1}
            />
          ))
        )}
      </SettingsSection>
    </Screen>
  );
}
