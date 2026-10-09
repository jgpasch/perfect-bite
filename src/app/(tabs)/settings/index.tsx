import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';

import { Button } from '@/components/button';
import { SettingsLinkRow, SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { households } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { signOut, useAccountState } from '@/features/auth/account';
import { householdsQuery } from '@/features/households/households';
import { pushLocalData } from '@/features/settings/dev-push';
import { useTheme } from '@/hooks/use-theme';

export default function SettingsScreen() {
  const { spacing } = useTheme();
  const account = useAccountState();
  const email = account.status === 'ready' ? account.account.email : undefined;
  const version = Constants.expoConfig?.version ?? '—';
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households]);
  const [push, setPush] = useState<{ status: 'idle' | 'pushing' | 'done' | 'failed'; message?: string }>({
    status: 'idle',
  });

  const pushToSupabase = () => {
    if (account.status !== 'ready') return;
    setPush({ status: 'pushing' });
    pushLocalData(account.account.userId)
      .then((summary) => {
        const total = summary.reduce((n, s) => n + s.rows, 0);
        setPush({ status: 'done', message: `Pushed ${total} rows across ${summary.length} tables.` });
      })
      .catch((err: unknown) => {
        console.warn('[settings] push failed', err);
        setPush({ status: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
  };

  return (
    <Screen scroll contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}>
      <SettingsSection title="Account">
        <SettingsRow label="Signed in as" value={email ?? '—'} last />
      </SettingsSection>
      <SettingsSection title="Lists">
        <Button label="Section order" variant="plain" onPress={() => router.push('/category-order')} />
      </SettingsSection>
      {householdRows.length > 0 ? (
        <SettingsSection title="Households">
          {householdRows.map((h, i) => (
            <SettingsLinkRow
              key={h.id}
              label={h.name}
              onPress={() => router.push({ pathname: '/settings/households/[id]', params: { id: h.id } })}
              last={i === householdRows.length - 1}
            />
          ))}
        </SettingsSection>
      ) : null}
      {/* TODO(M5): sync status (spec 7.5). */}
      {__DEV__ ? (
        <SettingsSection title="Developer">
          <Button label="Siri spike" variant="plain" onPress={() => router.push('/settings/siri')} />
          <Button
            label={push.status === 'pushing' ? 'Pushing…' : 'Push local data to Supabase'}
            variant="plain"
            disabled={push.status === 'pushing' || account.status !== 'ready'}
            onPress={pushToSupabase}
          />
          {push.message ? (
            <ThemedText
              variant="footnote"
              color={push.status === 'failed' ? 'danger' : 'inkSecondary'}
              style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.sm }}>
              {push.message}
            </ThemedText>
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title="About">
        <SettingsRow label="Version" value={version} last />
      </SettingsSection>
      <Button
        label="Sign out"
        variant="secondary"
        onPress={() => signOut().catch((err) => console.warn('[settings] sign out failed', err))}
      />
    </Screen>
  );
}
