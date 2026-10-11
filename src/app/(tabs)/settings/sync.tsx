import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useSyncStatus } from '@/features/settings/use-sync-status';
import { useTheme } from '@/hooks/use-theme';
import { formatLastSync, syncNow } from '@/sync/status';

/** How often "5 min ago" is brought up to date. */
const CLOCK_TICK_MS = 30_000;

/**
 * Settings > Sync status (spec 7.5, as stash): the status, changes waiting to send (and any the
 * server refused), the last successful sync, the last error, and Sync now.
 */
export default function SyncStatusScreen() {
  const { spacing } = useTheme();
  const status = useSyncStatus();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Status changes re-render too; the tick only keeps "N min ago" honest while nothing happens.
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const onSyncNow = () => {
    syncNow()
      .catch((err) => console.warn('[sync] sync now failed', err))
      .finally(() => setNow(new Date()));
  };

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
      <SettingsSection title="Status">
        <SettingsRow
          label="Status"
          trailing={
            <View accessible accessibilityLabel={`Status, ${status.label}`}>
              <Badge label={status.label} tone={status.tone} />
            </View>
          }
        />
        <SettingsRow label="Waiting to send" value={String(status.pending)} />
        {status.rejected > 0 ? <SettingsRow label="Not accepted" value={String(status.rejected)} /> : null}
        <SettingsRow label="Last synced" value={formatLastSync(status.lastSuccessAt, now)} last />
      </SettingsSection>

      {status.lastError ? (
        <SettingsSection title="Last error">
          <Card accessible accessibilityLabel={`Last error: ${status.lastError}`} style={{ padding: spacing.lg }}>
            <ThemedText variant="body" color="danger" selectable>
              {status.lastError}
            </ThemedText>
          </Card>
        </SettingsSection>
      ) : null}

      <View style={{ paddingTop: spacing.xl, paddingHorizontal: spacing.lg }}>
        <PrimaryButton
          label={status.state === 'syncing' && !status.canSyncNow ? 'Syncing…' : 'Sync now'}
          icon="arrow.triangle.2.circlepath"
          disabled={!status.canSyncNow}
          onPress={onSyncNow}
        />
      </View>
      {status.state === 'offline' ? (
        <ThemedText
          variant="footnote"
          color="inkSecondary"
          style={{ textAlign: 'center', paddingTop: spacing.sm, paddingHorizontal: spacing.xl }}>
          Changes are kept on this phone and sent when you’re back online.
        </ThemedText>
      ) : null}
    </Screen>
  );
}
