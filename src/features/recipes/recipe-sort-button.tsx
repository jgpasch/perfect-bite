import { Host, Menu, RNHostView, Section, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import {
  RECIPE_SORTS,
  recipeSortButtonLabel,
  recipeSortLabel,
  recipeSortPillLabel,
  type RecipeSort,
} from '@/features/recipes/recipe-sort';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

const ICONS: Record<RecipeSort, IconName> = { recent: 'clock', name: 'textformat', meal: 'fork.knife' };

/**
 * The Recipes tab's sort pill (spec 4.5): a white-wash pill on the green header reading the current choice,
 * "Recent ⌄", that opens a native "Sort and group" menu, the current choice ticked. Laid out like the list's
 * view button (`ViewMenuButton`): a 32 pt pill padded to a 44 pt tap area.
 */
export function RecipeSortButton({ value, onChange }: { value: RecipeSort; onChange: (sort: RecipeSort) => void }) {
  const { colors, scheme, sizes, spacing, rounded } = useTheme();
  const t = useT();
  const look = listHeaderColors(colors).viewButton;
  const inset = (sizes.minTapTarget - sizes.viewButton) / 2;
  return (
    <View style={{ marginVertical: -inset }}>
      <Host matchContents colorScheme={scheme} seedColor={colors.primary}>
        <Menu
          label={
            <RNHostView matchContents>
              <View style={[styles.start, { paddingVertical: inset }]}>
                <View
                  style={[
                    styles.pill,
                    {
                      minHeight: sizes.viewButton,
                      borderRadius: rounded.full,
                      paddingLeft: spacing.md,
                      paddingRight: spacing.md - spacing.xxs,
                      gap: spacing.xs,
                      backgroundColor: look.fill,
                    },
                  ]}>
                  <ThemedText variant="amount" style={[styles.label, { color: look.text }]}>
                    {recipeSortPillLabel(value)}
                  </ThemedText>
                  <Icon name="chevron.down" tint={look.text} size={sizes.iconSmall} weight="semibold" />
                </View>
              </View>
            </RNHostView>
          }
          modifiers={[accessibilityLabel(recipeSortButtonLabel(value)), accessibilityHint(t('recipes.sort.buttonHint'))]}>
          <Section title={t('recipes.sort.menuTitle')}>
            {RECIPE_SORTS.map((sort) => (
              <Toggle
                key={sort}
                label={recipeSortLabel(sort)}
                systemImage={ICONS[sort]}
                isOn={sort === value}
                onIsOnChange={() => onChange(sort)}
              />
            ))}
          </Section>
        </Menu>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  start: { alignSelf: 'flex-start' },
  pill: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  label: { flexShrink: 1 },
});
