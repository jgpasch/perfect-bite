import { useState } from 'react';

import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { AISLE_COLOR_STYLES } from '@/features/lists/list-view';
import { getAisleColorStyle, setAisleColorStyle } from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';

/** Settings > Aisle colours: where By aisle shows each aisle's colour, on this device. */
export default function AisleColorsScreen() {
  const { spacing } = useTheme();
  const [style, setStyle] = useState(getAisleColorStyle);

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
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
