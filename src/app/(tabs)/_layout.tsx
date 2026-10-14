import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { failedImports } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { importsBadgeCount, useShareQueueStatus } from '@/features/recipes/share-queue-status';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

export default function TabsLayout() {
  const { colors } = useTheme();
  const t = useT();
  const { data: failed } = useLiveQueryOn(failedImportsQuery(), [failedImports]);
  // Spec 4.10: recipes shared to the app that are waiting or won't import.
  const imports = importsBadgeCount(useShareQueueStatus(), failed.length);

  return (
    <NativeTabs tintColor={colors.primary} iconColor={{ selected: colors.primary }}>
      <NativeTabs.Trigger name="lists">
        <NativeTabs.Trigger.Label>{t('tabs.list')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="checklist" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="recipes">
        <NativeTabs.Trigger.Label>{t('tabs.recipes')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="book" />
        {/* Render conditionally: `hidden` is ignored whenever the badge has text, so "0" would show. */}
        {imports > 0 && <NativeTabs.Trigger.Badge>{String(imports)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>{t('tabs.settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
