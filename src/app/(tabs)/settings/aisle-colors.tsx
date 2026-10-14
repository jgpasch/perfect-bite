import { useState } from 'react';

import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { AISLE_COLOR_STYLES, ITEM_ROW_STYLES } from '@/features/lists/list-view';
import { getAisleColorStyle, getItemRowStyle, setAisleColorStyle, setItemRowStyle } from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** Settings > Aisle colours: how item rows carry their aisle's colour, and where By aisle shows it, on this device. */
export default function AisleColorsScreen() {
  const { spacing } = useTheme();
  const t = useT();
  const [rowStyle, setRowStyle] = useState(getItemRowStyle);
  const [style, setStyle] = useState(getAisleColorStyle);

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
      <SettingsSection title={t('settings.aisleColors.itemRows')}>
        {ITEM_ROW_STYLES.map((s, i) => (
          <SettingsRow
            key={s.value}
            label={s.label}
            selected={s.value === rowStyle}
            onPress={() => {
              setItemRowStyle(s.value);
              setRowStyle(s.value);
            }}
            last={i === ITEM_ROW_STYLES.length - 1}
          />
        ))}
      </SettingsSection>
      <ThemedText
        variant="footnote"
        color="inkSecondary"
        style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
        {t('settings.aisleColors.itemRowsFootnote')}
      </ThemedText>
      <SettingsSection title={t('settings.aisleColors.inByAisle')}>
        {AISLE_COLOR_STYLES.map((s, i) => (
          <SettingsRow
            key={s.value}
            label={s.label}
            selected={s.value === style}
            onPress={() => {
              setAisleColorStyle(s.value);
              setStyle(s.value);
            }}
            last={i === AISLE_COLOR_STYLES.length - 1}
          />
        ))}
      </SettingsSection>
      <ThemedText
        variant="footnote"
        color="inkSecondary"
        style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
        {t('settings.aisleColors.inByAisleFootnote')}
      </ThemedText>
    </Screen>
  );
}
