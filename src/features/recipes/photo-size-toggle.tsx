import { Pressable, StyleSheet, View } from 'react-native';

import { listHeaderColors } from '@/components/appearance';
import { Icon, type IconName } from '@/components/icon';
import { RECIPE_PHOTO_SIZES, recipePhotoSizeLabel, type RecipePhotoSize } from '@/features/recipes/recipe-photo-size';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

const ICONS: Record<RecipePhotoSize, IconName> = { small: 'list.bullet', large: 'photo' };

/**
 * The Recipes tab's photo-size toggle (spec 4.5): two icon segments, Small photos and Large photos, on a
 * white-wash pill at the end of the header row, the selected one filled `onHeader` with a `header` glyph.
 * Each segment is 44 pt wide and padded to a 44 pt tall hit area. VoiceOver reads it as "Photo size".
 */
export function PhotoSizeToggle({ value, onChange }: { value: RecipePhotoSize; onChange: (size: RecipePhotoSize) => void }) {
  const t = useT();
  const { colors, sizes, spacing, rounded, opacity } = useTheme();
  const look = listHeaderColors(colors).viewButton;
  const segmentHeight = sizes.viewButton - spacing.xxs * 2;
  const slop = (sizes.minTapTarget - segmentHeight) / 2;
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={t('recipes.photoSize.label')}
      style={[styles.pill, { padding: spacing.xxs, borderRadius: rounded.full, backgroundColor: look.fill }]}>
      {RECIPE_PHOTO_SIZES.map((size) => {
        const selected = size === value;
        return (
          <Pressable
            key={size}
            accessibilityRole="tab"
            accessibilityLabel={recipePhotoSizeLabel(size)}
            accessibilityState={{ selected }}
            hitSlop={{ top: slop, bottom: slop }}
            onPress={() => {
              if (!selected) onChange(size);
            }}
            style={({ pressed }) => [
              styles.segment,
              {
                minWidth: sizes.minTapTarget,
                minHeight: segmentHeight,
                borderRadius: rounded.full,
                backgroundColor: selected ? colors.onHeader : 'transparent',
                opacity: pressed && !selected ? opacity.pressed : 1,
              },
            ]}>
            <Icon name={ICONS[size]} tint={selected ? colors.header : look.text} size={sizes.iconSmall + spacing.xs} weight="semibold" />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  segment: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
