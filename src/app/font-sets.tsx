import { ScrollView } from 'react-native';

import { Card } from '@/components/card';
import { SettingsRow } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { FONT_SETS, FontSetSpecs, typographyFor, type FontSet } from '@/constants/theme';
import { setFontSetSetting } from '@/features/settings/font-set';
import { useFontSet } from '@/hooks/font-set';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * Settings > Design trials > Fonts (DESIGN.md Fonts): the trial's five sets, each named in its own display
 * face over a sample line in its body face, the current one ticked. Picking one switches every screen at
 * once; the sheet stays open to compare.
 */
export default function FontSetsSheet() {
  const { spacing } = useTheme();
  const t = useT();
  const current = useFontSet();

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingTop: spacing.xl, paddingBottom: spacing.xl }}>
        <ThemedText variant="sheetTitle" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingBottom: spacing.sm }}>
          {t('settings.fonts')}
        </ThemedText>
        <Card>
          {FONT_SETS.map((set, i) => (
            <FontSetRow key={set} set={set} selected={set === current} last={i === FONT_SETS.length - 1} />
          ))}
        </Card>
        <ThemedText variant="footnote" color="inkSecondary" style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
          {t('settings.fontsScreen.footnote')}
        </ThemedText>
      </ScrollView>
    </Screen>
  );
}

function FontSetRow({ set, selected, last }: { set: FontSet; selected: boolean; last: boolean }) {
  const t = useT();
  const { sectionTitle, title, body } = typographyFor(set);
  return (
    <SettingsRow
      label={FontSetSpecs[set].display}
      detail={t('settings.fontsScreen.sample', { body: FontSetSpecs[set].body })}
      labelStyle={{ fontFamily: sectionTitle.fontFamily, fontWeight: title.fontWeight }}
      detailStyle={{ fontFamily: body.fontFamily }}
      selected={selected}
      onPress={() => setFontSetSetting(set)}
      last={last}
    />
  );
}
