import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import { getList } from '@/features/lists/lists';
import {
  getAppGroupContainer,
  readNativeLog,
  readPendingSiriAdds,
  writeListSnapshot,
  type PendingSiriAdd,
} from '@/features/siri/app-group';
import { resetAddHint } from '@/features/tabs/add-hint';
import { useTheme } from '@/hooks/use-theme';

// Fixed ids so Siri's list picker stays stable across rewrites.
const TEST_LISTS = {
  defaultListId: '019a4c10-0000-7000-8000-00000000a001',
  lastOpenedListId: null,
  lists: [
    {
      id: '019a4c10-0000-7000-8000-00000000a001',
      name: 'Groceries',
      householdId: '019a4c0f-0000-7000-8000-0000000000a1',
      householdName: 'Test home',
    },
    {
      id: '019a4c10-0000-7000-8000-00000000c057',
      name: 'Costco',
      householdId: '019a4c0f-0000-7000-8000-0000000000a1',
      householdName: 'Test home',
    },
  ],
  households: [{ id: '019a4c0f-0000-7000-8000-0000000000a1', name: 'Test home' }],
};

/**
 * Settings > Developer (dev builds only): Siri debugging from the M0 spike (docs/spikes.md). Writes
 * test lists for the intent's list picker (the real snapshot replaces them on the next list
 * change or launch) and shows what the intent queued and logged.
 */
export default function DeveloperScreen() {
  const { spacing } = useTheme();
  const [adds, setAdds] = useState<PendingSiriAdd[]>([]);
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try {
      setAdds(readPendingSiriAdds().reverse());
      setLog(readNativeLog().trim().split('\n').slice(-20).join('\n'));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useFocusEffect(refresh);

  const [toast, setToast] = useState<{ key: number; message: string } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const showAddHintAgain = () => {
    resetAddHint();
    // A new key restarts the toast's timer when one is already showing.
    setToast((t) => ({ key: (t?.key ?? 0) + 1, message: 'The + hint will show after your next add' }));
  };

  const listName = (id?: string) =>
    id
      ? (getList(id)?.name ?? TEST_LISTS.lists.find((l) => l.id === id)?.name ?? id)
      : 'Default list';

  return (
    <View style={styles.fill}>
      {/* Cards bring their own 16 pt side margin; everything else gets it here. */}
      <Screen scroll contentContainerStyle={{ paddingVertical: spacing.lg, gap: spacing.lg }}>
        <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.lg }}>
          App Group: {getAppGroupContainer() ? 'available' : 'missing (needs a development build)'}
        </ThemedText>
        {error ? (
          <ThemedText variant="footnote" color="danger" style={{ paddingHorizontal: spacing.lg }}>
            {error}
          </ThemedText>
        ) : null}

        <View style={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}>
          <Button
            label="Write test lists (Groceries, Costco)"
            variant="secondary"
            onPress={() => {
              try {
                writeListSnapshot(TEST_LISTS);
                refresh();
              } catch (err) {
                setError(String(err));
              }
            }}
          />
          <Button label="Refresh" variant="plain" onPress={refresh} />
        </View>

        <SettingsSection title={`Siri queue (${adds.length})`}>
          {adds.length === 0 ? (
            <SettingsRow label="Nothing queued" value="" last />
          ) : (
            adds.map((a, i) =>
              a.ok ? (
                <SettingsRow
                  key={a.envelope.id}
                  label={a.envelope.text}
                  value={`${listName(a.envelope.listId)} · ${new Date(a.envelope.createdAt).toLocaleTimeString()}`}
                  last={i === adds.length - 1}
                />
              ) : (
                <SettingsRow key={a.fileName} label={`Invalid: ${a.fileName}`} value={a.error} last={i === adds.length - 1} />
              ),
            )
          )}
        </SettingsSection>

        <SettingsSection title="Native log (last 20 lines)">
          <ThemedText variant="caption" color="inkSecondary" style={[styles.log, { padding: spacing.md }]} selectable>
            {log || '—'}
          </ThemedText>
        </SettingsSection>

        {/* Spec 4.1: the one-time + hint, to see it again. */}
        <SettingsSection title="Tab bar">
          <SettingsRow label="Show the + hint again" onPress={showAddHintAgain} chevron={false} last />
        </SettingsSection>
      </Screen>
      {toast ? (
        <View pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.lg }]}>
          <Toast key={toast.key} message={toast.message} actions={[]} onDismiss={dismissToast} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  log: { fontFamily: 'ui-monospace' },
});
