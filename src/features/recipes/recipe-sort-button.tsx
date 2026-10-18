import { Host, Menu, RNHostView, Section, Toggle } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { Icon, type IconName } from '@/components/icon';
import { RECIPE_PHOTO_SIZES, recipePhotoSizeLabel, type RecipePhotoSize } from '@/features/recipes/recipe-photo-size';
import { recipeSortLabel, recipeSortMenuLabel, type RecipeGroup, type RecipeSort } from '@/features/recipes/recipe-sort';
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

const PHOTO_SIZE_ICONS: Record<RecipePhotoSize, IconName> = { small: 'list.bullet', large: 'photo' };

/**
 * The Recipes tab's sort button (spec 4.5): a 44 pt round white-wash button on the green header with a
 * `arrow.up.arrow.down` glyph, opening a native "Sort and group" menu: a **Sort** section (Recently added,
 * A–Z), a **Group by** section (None, Meal, Cuisine, Protein, Method, Time, Saved) and a **Photo size**
 * section (Small photos, Large photos), the current choice ticked in each. Picking in one section keeps the
 * others' choices.
 */
export function RecipeSortButton({
  sort,
  group,
  photoSize,
  onSortChange,
  onGroupChange,
  onPhotoSizeChange,
}: {
  sort: RecipeSort;
  group: RecipeGroup;
  photoSize: RecipePhotoSize;
  onSortChange: (sort: RecipeSort) => void;
  onGroupChange: (group: RecipeGroup) => void;
  onPhotoSizeChange: (size: RecipePhotoSize) => void;
}) {
  const { colors, scheme, sizes, rounded } = useTheme();
  const t = useT();
  const look = listHeaderColors(colors).viewButton;
  return (
    <Host matchContents colorScheme={scheme} seedColor={colors.primary}>
      <Menu
        label={
          <RNHostView matchContents>
            <View
              testID="recipes-sort"
              style={[
                styles.button,
                { width: sizes.minTapTarget, height: sizes.minTapTarget, borderRadius: rounded.full, backgroundColor: look.fill },
              ]}>
              <Icon name="arrow.up.arrow.down" tint={look.text} size={sizes.icon} weight="semibold" />
            </View>
          </RNHostView>
        }
        modifiers={[
          accessibilityLabel(recipeSortMenuLabel(sort, group, photoSize)),
          accessibilityHint(t('recipes.sort.buttonHint')),
        ]}>
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
        <Section title={t('recipes.photoSize.label')}>
          {RECIPE_PHOTO_SIZES.map((size) => (
            <Toggle
              key={size}
              label={recipePhotoSizeLabel(size)}
              systemImage={PHOTO_SIZE_ICONS[size]}
              isOn={size === photoSize}
              onIsOnChange={() => onPhotoSizeChange(size)}
            />
          ))}
        </Section>
      </Menu>
    </Host>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center' },
});
