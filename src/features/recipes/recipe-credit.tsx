import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { openRecipeLink, recipeLinkParts } from '@/features/recipes/recipe-link';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The recipe's source credit (spec 4.5): "From seriouseats.com" (the host without `www.`), a link that
 * opens the original in Safari, as the link row does. VoiceOver: "Recipe from seriouseats.com, link".
 * Nothing unless `sourceUrl` is a link that opens, so removing the link removes the credit.
 * At a card's foot it's a row under a hairline. `onPhoto`: a small caption on a `surface` chip, so `inkSecondary` stays readable over the photo.
 */
export function RecipeCredit({ sourceUrl, onPhoto = false }: { sourceUrl: string | null | undefined; onPhoto?: boolean }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const parts = recipeLinkParts(sourceUrl);
  if (!sourceUrl || !parts) return null;

  return (
    <Pressable
      testID={onPhoto ? 'recipe-credit-photo' : 'recipe-credit'}
      onPress={() => void openRecipeLink(sourceUrl)}
      accessibilityRole="link"
      accessibilityLabel={t('recipes.credit.label', { host: parts.host })}
      accessibilityHint={t('recipes.link.openHint')}
      hitSlop={onPhoto ? spacing.sm : undefined}
      style={({ pressed }) => [
        styles.center,
        onPhoto
          ? {
              position: 'absolute',
              right: spacing.sm,
              bottom: spacing.sm,
              paddingHorizontal: spacing.sm,
              paddingVertical: spacing.xxs,
              borderRadius: rounded.full,
              backgroundColor: colors.surface,
            }
          : {
              minHeight: sizes.minTapTarget,
              paddingHorizontal: spacing.lg,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
            },
        { opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <ThemedText variant={onPhoto ? 'caption' : 'footnote'} color="inkSecondary" numberOfLines={1}>
        {t('recipes.credit.text', { host: parts.host })}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center' },
});
