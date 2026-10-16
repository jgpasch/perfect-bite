import { useState } from 'react';
import { Alert, Switch } from 'react-native';

import { SettingsRow } from '@/components/settings-group';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { householdActionAlert, setCombineLanguages } from './households';

/**
 * A household's Combine English and Spanish names switch (spec 4.15), in its screen's Household
 * settings. It shows the new value while the server is asked; a failure (offline included) puts it
 * back and says why.
 */
export function CombineLanguagesRow({
  household,
  last,
}: {
  household: { id: string; name: string; combineLanguages: boolean };
  last?: boolean;
}) {
  const { colors } = useTheme();
  const t = useT();
  const [pending, setPending] = useState<boolean | null>(null);
  const change = (on: boolean) => {
    setPending(on);
    setCombineLanguages(household.id, on)
      .catch((err) => {
        const alert = householdActionAlert('combine-languages', err, { householdName: household.name });
        Alert.alert(alert.title, alert.message);
      })
      .finally(() => setPending(null));
  };
  return (
    <SettingsRow
      label={t('settings.combineLanguages')}
      detail={t('settings.combineLanguagesDetail')}
      icon={{ name: 'globe', hue: 'blue' }}
      trailing={
        <Switch
          value={pending ?? household.combineLanguages}
          onValueChange={change}
          disabled={pending !== null}
          trackColor={{ true: colors.primary }}
          accessibilityLabel={t('settings.combineLanguagesLabel', { household: household.name })}
          accessibilityHint={t('settings.combineLanguagesDetail')}
        />
      }
      last={last}
    />
  );
}
