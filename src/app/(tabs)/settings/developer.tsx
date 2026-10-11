import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { getList } from '@/features/lists/lists';
import {
  getAppGroupContainer,
  readNativeLog,
  readPendingSiriAdds,
  writeListSnapshot,
  type PendingSiriAdd,
} from '@/features/siri/app-group';
import { useTheme } from '@/hooks/use-theme';

// Fixed ids so Siri's list picker stays stable across rewrites.
const TEST_LISTS = {
  defaultListId: '019a4c10-0000-7000-8000-00000000a001',
  lastOpenedListId: null,
  lists: [
    { id: '019a4c10-0000-7000-8000-00000000a001', name: 'Groceries', householdName: 'Test home' },
    { id: '019a4c10-0000-7000-8000-00000000c057', name: 'Costco', householdName: 'Test home' },
  ],
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

  const listName = (id?: string) =>
    id
      ? (getList(id)?.name ?? TEST_LISTS.lists.find((l) => l.id === id)?.name ?? id)
      : 'Default list';

  return (
    // Cards bring their own 16 pt side margin; everything else gets it here.
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  log: { fontFamily: 'ui-monospace' },
});
