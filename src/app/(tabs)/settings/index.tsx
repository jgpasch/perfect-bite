import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { avatarColors } from '@/components/appearance';
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
import { pushLocalData } from '@/features/settings/dev-push';
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
  const [push, setPush] = useState<{ status: 'idle' | 'pushing' | 'done' | 'failed'; message?: string }>({
    status: 'idle',
  });
  const avatar = avatarColors('amber', colors, aisles);

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
    // The scroll view sits inside a plain view, as on the other tabs: as the screen's root view the
    // native large title didn't show.
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
        {/* TODO(M5): a "Synced" badge when the outbox is empty (spec 7.5). */}
        <Card
          accessible
          accessibilityLabel={`Signed in as ${email ?? 'unknown'}`}
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

        {__DEV__ ? (
          <SettingsSection title="Developer">
            <SettingsRow
              label={push.status === 'pushing' ? 'Pushing…' : 'Push local data to Supabase'}
              labelColor="primary"
              chevron={false}
              onPress={push.status === 'pushing' || account.status !== 'ready' ? undefined : pushToSupabase}
              last={!push.message}
            />
            {push.message ? (
              <ThemedText
                variant="footnote"
                color={push.status === 'failed' ? 'danger' : 'inkSecondary'}
                style={{ padding: spacing.lg }}>
                {push.message}
              </ThemedText>
            ) : null}
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
