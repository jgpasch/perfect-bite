import Constants from 'expo-constants';
import { router } from 'expo-router';

import { Button } from '@/components/button';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { Screen } from '@/components/themed-view';
import { signOut, useAccountState } from '@/features/auth/account';
import { useTheme } from '@/hooks/use-theme';

export default function SettingsScreen() {
  const { spacing } = useTheme();
  const account = useAccountState();
  const email = account.status === 'ready' ? account.account.email : undefined;
  const version = Constants.expoConfig?.version ?? '—';

  return (
    <Screen scroll contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}>
      <SettingsSection title="Account">
        <SettingsRow label="Signed in as" value={email ?? '—'} last />
      </SettingsSection>
      <SettingsSection title="Lists">
        <Button label="Section order" variant="plain" onPress={() => router.push('/category-order')} />
      </SettingsSection>
      {/* TODO(M5): sync status (spec 7.5). TODO(M7): households (spec 4.7). */}
      {__DEV__ ? (
        <SettingsSection title="Developer">
          <Button label="Siri spike" variant="plain" onPress={() => router.push('/settings/siri')} />
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
