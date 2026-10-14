import { useState } from 'react';

import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { AISLE_COLOR_STYLES, ITEM_ROW_STYLES } from '@/features/lists/list-view';
import { getAisleColorStyle, getItemRowStyle, setAisleColorStyle, setItemRowStyle } from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';

/** Settings > Aisle colours: how item rows carry their aisle's colour, and where By aisle shows it, on this device. */
export default function AisleColorsScreen() {
  const { spacing } = useTheme();
  const [rowStyle, setRowStyle] = useState(getItemRowStyle);
  const [style, setStyle] = useState(getAisleColorStyle);

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
      <SettingsSection title="Item rows">
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
        Colour bands fill each item with its aisle’s colour. White rows keep items white, with the colour on the
        check.
      </ThemedText>
      <SettingsSection title="In By aisle, colour">
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
        Header only keeps items plain and colours each aisle’s header. Only this device changes.
      </ThemedText>
    </Screen>
  );
}
