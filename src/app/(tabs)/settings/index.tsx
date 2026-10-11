import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { avatarColors } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { recipeHue } from '@/domain/aisle-color';
import { signOut, useAccountState } from '@/features/auth/account';
import { avatarInitial, householdsQuery } from '@/features/households/households';
import { getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import { useSyncStatus } from '@/features/settings/use-sync-status';
import { useTheme } from '@/hooks/use-theme';

/** Settings (board 10): the account card, Shopping and Households cards, then Sign out and the version. */
export default function SettingsScreen() {
  const { colors, aisles, spacing, sizes, rounded } = useTheme();
  const account = useAccountState();
  const userId = account.status === 'ready' ? account.account.userId : undefined;
  const email = account.status === 'ready' ? account.account.email : undefined;
  const version = Constants.expoConfig?.version ?? '—';
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households]);
  // userSettings: so "Siri adds to" follows "Make default for Siri".
  const { data: listRows } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  const siriList = useMemo(() => {
    const id = userId && listRows.length > 0 ? getDefaultListId(userId) : null;
    return listRows.find((l) => l.id === id)?.name;
  }, [userId, listRows]);
  const avatar = avatarColors('amber', colors, aisles);
  const sync = useSyncStatus();

  return (
    // The scroll view sits inside a plain view, as on the other tabs: as the screen's root view the
    // native large title didn't show.
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
        <Card
          accessible
          accessibilityLabel={`Signed in as ${email ?? 'unknown'}, ${sync.label}`}
          style={[styles.row, { padding: spacing.lg, gap: spacing.md + spacing.xxs }]}>
          <View
            style={[
              styles.avatar,
              { width: sizes.accountAvatar, height: sizes.accountAvatar, borderRadius: rounded.full, backgroundColor: avatar.fill },
            ]}>
            {/* One letter in a fixed circle: capped so it stays inside at the largest text sizes. */}
            <ThemedText variant="initial" maxFontSizeMultiplier={1.5} style={{ color: avatar.text }}>
              {avatarInitial(email)}
            </ThemedText>
          </View>
          <View style={styles.flex}>
            <ThemedText variant="headline">{email ?? '—'}</ThemedText>
            <ThemedText variant="footnote" color="inkSecondary">
              Signed in
            </ThemedText>
          </View>
          {/* Badges align to the top of their parent; this keeps it centred beside the name. */}
          <View>
            <Badge label={sync.label} tone={sync.tone} />
          </View>
        </Card>

        <SettingsSection title="Shopping">
          <SettingsRow
            label="Siri adds to"
            value={siriList ?? '—'}
            icon={{ name: 'mic', hue: 'green' }}
            // The Siri screen is still the dev-only M0 spike; M8 replaces it.
            onPress={__DEV__ ? () => router.push('/settings/siri') : undefined}
          />
          <SettingsRow
            label="Aisle order"
            icon={{ name: 'arrow.up.arrow.down', hue: 'blue' }}
            onPress={() => router.push('/category-order')}
          />
          <SettingsRow
            label="Sync status"
            value={sync.label}
            icon={{ name: 'arrow.triangle.2.circlepath', hue: 'grey' }}
            onPress={() => router.push('/settings/sync')}
            last
          />
        </SettingsSection>

        {householdRows.length > 0 ? (
          <SettingsSection title="Households">
            {householdRows.map((h, i) => (
              <SettingsRow
                key={h.id}
                label={h.name}
                icon={{ name: 'house', hue: recipeHue(h.id) }}
                onPress={() => router.push({ pathname: '/settings/households/[id]', params: { id: h.id } })}
                last={i === householdRows.length - 1}
              />
            ))}
          </SettingsSection>
        ) : null}

        <View style={[styles.row, styles.between, { paddingVertical: spacing.lg, paddingHorizontal: spacing.xl }]}>
          <Button
            label="Sign out"
            variant="plain"
            color="danger"
            onPress={() => signOut().catch((err) => console.warn('[settings] sign out failed', err))}
          />
          <ThemedText variant="footnote" color="inkSecondary">
            Version {version}
          </ThemedText>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { justifyContent: 'space-between' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
});
