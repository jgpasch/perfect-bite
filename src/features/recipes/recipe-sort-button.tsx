import { Host, Menu, RNHostView, Section, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import {
  recipeSortButtonLabel,
  recipeSortLabel,
  recipeSortPillLabel,
  type RecipeGroup,
  type RecipeSort,
} from '@/features/recipes/recipe-sort';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

const SORTS: readonly { sort: RecipeSort; icon: IconName }[] = [
  { sort: 'recent', icon: 'clock' },
  { sort: 'name', icon: 'textformat' },
];

const GROUPS: readonly { group: RecipeGroup; icon: IconName }[] = [
  { group: 'none', icon: 'list.bullet' },
  { group: 'meal', icon: 'fork.knife' },
  { group: 'cuisine', icon: 'globe.americas' },
  { group: 'protein', icon: 'fish' },
  { group: 'method', icon: 'frying.pan' },
  { group: 'time', icon: 'timer' },
  { group: 'saved', icon: 'heart' },
];

/**
 * The Recipes tab's sort pill (spec 4.5): a white-wash pill on the green header reading the current choice,
 * "Recent ⌄", that opens a native "Sort and group" menu: a **Sort** section (Recently added, A–Z) and a
 * **Group by** section (None, Meal, Cuisine, Protein, Method, Time, Saved), the current choice ticked in each.
 * Picking in one section keeps the other's choice. A 32 pt pill padded to a 44 pt tap area.
 */
export function RecipeSortButton({
  sort,
  group,
  onSortChange,
  onGroupChange,
}: {
  sort: RecipeSort;
  group: RecipeGroup;
  onSortChange: (sort: RecipeSort) => void;
  onGroupChange: (group: RecipeGroup) => void;
}) {
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
          <Section title={t('recipes.sort.sortSection')}>
            {SORTS.map((item) => (
              <Toggle
                key={item.sort}
                label={recipeSortLabel(item.sort)}
                systemImage={item.icon}
                isOn={item.sort === sort}
                onIsOnChange={() => onSortChange(item.sort)}
              />
            ))}
          </Section>
          <Section title={t('recipes.sort.groupSection')}>
            {GROUPS.map((item) => (
              <Toggle
                key={item.group}
                label={t(`recipes.sort.groupItems.${item.group}`)}
                systemImage={item.icon}
                isOn={item.group === group}
                onIsOnChange={() => onGroupChange(item.group)}
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
