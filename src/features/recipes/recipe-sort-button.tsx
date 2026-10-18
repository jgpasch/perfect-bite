import { Host, Menu, RNHostView, Section, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import {
  recipeGroupLabel,
  recipeSortButtonLabel,
  recipeSortLabel,
  recipeSortPillLabel,
  type RecipeGroup,
  type RecipeSort,
} from '@/features/recipes/recipe-sort';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

type SortChoice = { sort: RecipeSort; group: RecipeGroup };

// Recently added, A–Z and By meal (A–Z grouped by meal), until the menu offers the sort and the grouping apart.
const CHOICES: readonly (SortChoice & { icon: IconName; label: () => string })[] = [
  { sort: 'recent', group: 'none', icon: 'clock', label: () => recipeSortLabel('recent') },
  { sort: 'name', group: 'none', icon: 'textformat', label: () => recipeSortLabel('name') },
  { sort: 'name', group: 'meal', icon: 'fork.knife', label: () => recipeGroupLabel('meal') },
];

/**
 * The Recipes tab's sort pill (spec 4.5): a white-wash pill on the green header reading the current choice,
 * "Recent ⌄", that opens a native "Sort and group" menu, the current choice ticked: a 32 pt pill padded to a
 * 44 pt tap area.
 */
export function RecipeSortButton({ sort, group, onChange }: SortChoice & { onChange: (choice: SortChoice) => void }) {
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
                    {recipeSortPillLabel(sort, group)}
                  </ThemedText>
                  <Icon name="chevron.down" tint={look.text} size={sizes.iconSmall} weight="semibold" />
                </View>
              </View>
            </RNHostView>
          }
          modifiers={[accessibilityLabel(recipeSortButtonLabel(sort, group)), accessibilityHint(t('recipes.sort.buttonHint'))]}>
          <Section title={t('recipes.sort.menuTitle')}>
            {CHOICES.map((choice) => (
              <Toggle
                key={`${choice.sort}:${choice.group}`}
                label={choice.label()}
                systemImage={choice.icon}
                isOn={group === 'none' ? choice.group === 'none' && choice.sort === sort : choice.group === group}
                onIsOnChange={() => onChange({ sort: choice.sort, group: choice.group })}
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
