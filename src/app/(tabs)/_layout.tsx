import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { failedImports } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { importsBadgeCount, useShareQueueStatus } from '@/features/recipes/share-queue-status';
import { useTheme } from '@/hooks/use-theme';

export default function TabsLayout() {
  const { colors } = useTheme();
  const { data: failed } = useLiveQueryOn(failedImportsQuery(), [failedImports]);
  // Spec 4.10: recipes shared to the app that are waiting or won't import.
  const imports = importsBadgeCount(useShareQueueStatus(), failed.length);

  return (
    <NativeTabs tintColor={colors.primary} iconColor={{ selected: colors.primary }}>
      <NativeTabs.Trigger name="lists">
        <NativeTabs.Trigger.Label>List</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="checklist" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="recipes">
        <NativeTabs.Trigger.Label>Recipes</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="book" />
        <NativeTabs.Trigger.Badge hidden={imports === 0}>{String(imports)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
