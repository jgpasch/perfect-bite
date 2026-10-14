import { useMemo } from 'react';

import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { households, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { useAccountState } from '@/features/auth/account';
import { getDefaultListId, listsWithCountsQuery, setDefaultList } from '@/features/lists/lists';
import { buildListSnapshot, siriListChoices } from '@/features/siri/list-snapshot';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** Settings > Siri adds to (spec 4.1, 4.9): pick the default list, the one Siri adds to unless you name another. */
export default function SiriDefaultListScreen() {
  const { spacing } = useTheme();
  const t = useT();
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : undefined;
  // userSettings: so the tick follows a new default.
  const { data: rows } = useLiveQueryOn(listsWithCountsQuery(), [lists, households, userSettings]);
  const choices = useMemo(
    () => siriListChoices(buildListSnapshot(rows, userId && rows.length > 0 ? getDefaultListId(userId) : null)),
    [userId, rows],
  );

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
      <SettingsSection title={t('settings.siriAddsTo')}>
        {choices.length === 0 ? (
          <SettingsRow label={t('settings.siriList.noLists')} last />
        ) : (
          choices.map((c, i) => (
            <SettingsRow
              key={c.id}
              label={c.name}
              value={c.householdName}
              selected={c.selected}
              onPress={userId ? () => setDefaultList(userId, c.id) : undefined}
              last={i === choices.length - 1}
            />
          ))
        )}
      </SettingsSection>
      <ThemedText
        variant="footnote"
        color="inkSecondary"
        style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
        {t('settings.siriList.example')}
      </ThemedText>
    </Screen>
  );
}
