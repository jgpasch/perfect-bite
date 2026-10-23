import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { getAccount } from '@/features/auth/account';
import { canSaveName, getMyName, NAME_MAX, SaveNameError, saveMyName } from '@/features/settings/name';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * Settings > Name (spec 4.7, board 10): the user's first and last name, prefilled from the cache.
 * Save writes their `profiles` row (it needs a connection), reloads the members' names and goes back;
 * offline or a failure shows under the fields and keeps the edits.
 */
export default function NameScreen() {
  const { colors, spacing, scheme } = useTheme();
  const t = useT();
  const userId = getAccount()?.userId ?? null;
  // Read once: the fields are the user's draft.
  const [saved] = useState(() => getMyName(userId));
  const [firstName, setFirstName] = useState(saved?.firstName ?? '');
  const [lastName, setLastName] = useState(saved?.lastName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = !!userId && !saving && canSaveName({ firstName, lastName }, saved);
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await saveMyName(userId, firstName, lastName);
      router.back();
    } catch (err) {
      setSaving(false);
      setError(
        err instanceof SaveNameError && err.kind === 'offline'
          ? t('settings.nameScreen.offline')
          : t('settings.nameScreen.failed'),
      );
    }
  };
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl, gap: spacing.sm }}>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.View hidden={!saving}>
          <ActivityIndicator color={colors.inkSecondary} />
        </Stack.Toolbar.View>
        <Stack.Toolbar.Button
          hidden={saving}
          variant="done"
          tintColor={prominentButtonTint(scheme, colors)}
          disabled={!canSave}
          onPress={() => void save()}>
          {t('settings.nameScreen.save')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <ThemedText variant="sectionLabel" color="inkSecondary" style={inset}>
        {t('settings.nameScreen.firstName')}
      </ThemedText>
      <View style={{ paddingHorizontal: spacing.lg }}>
        <TextField
          value={firstName}
          onChangeText={(text) => (setFirstName(text), setError(null))}
          accessibilityLabel={t('settings.nameScreen.firstName')}
          textContentType="givenName"
          autoComplete="given-name"
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={NAME_MAX}
          returnKeyType="next"
          editable={!saving}
        />
      </View>
      <ThemedText variant="sectionLabel" color="inkSecondary" style={[inset, { paddingTop: spacing.sm }]}>
        {t('settings.nameScreen.lastName')}
      </ThemedText>
      <View style={{ paddingHorizontal: spacing.lg }}>
        <TextField
          value={lastName}
          onChangeText={(text) => (setLastName(text), setError(null))}
          accessibilityLabel={t('settings.nameScreen.lastName')}
          placeholder={t('settings.nameScreen.optional')}
          textContentType="familyName"
          autoComplete="family-name"
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={NAME_MAX}
          returnKeyType="done"
          editable={!saving}
          onSubmitEditing={() => void save()}
        />
      </View>
      {error ? (
        <ThemedText
          variant="footnote"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={inset}>
          {error}
        </ThemedText>
      ) : null}
      <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.xxl }}>
        {t('settings.nameScreen.footnote')}
      </ThemedText>
    </Screen>
  );
}
