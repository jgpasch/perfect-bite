import { useState } from 'react';

import { Card } from '@/components/card';
import { SettingsRow } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { getLanguageChoice, setLanguageChoice } from '@/features/settings/language';
import { useTheme } from '@/hooks/use-theme';
import { deviceLanguage, type Language, LANGUAGE_NAMES, LANGUAGES, useT } from '@/i18n';

/** Settings > Language: the app's language on this device, or the phone's (spec 4.15). Switches at once. */
export default function LanguageScreen() {
  const { spacing } = useTheme();
  const t = useT();
  const [choice, setChoice] = useState(getLanguageChoice);
  const pick = (language: Language | null) => {
    setLanguageChoice(language);
    setChoice(language);
  };

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
      <Card>
        <SettingsRow
          label={t('settings.languageScreen.phone')}
          detail={LANGUAGE_NAMES[deviceLanguage()]}
          selected={choice === null}
          onPress={() => pick(null)}
        />
        {LANGUAGES.map((language, i) => (
          <SettingsRow
            key={language}
            label={LANGUAGE_NAMES[language]}
            selected={choice === language}
            onPress={() => pick(language)}
            last={i === LANGUAGES.length - 1}
          />
        ))}
      </Card>
      <ThemedText
        variant="footnote"
        color="inkSecondary"
        style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
        {t('settings.languageScreen.footnote')}
      </ThemedText>
    </Screen>
  );
}
