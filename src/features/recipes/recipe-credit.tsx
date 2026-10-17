import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { openRecipeLink, recipeLinkParts } from '@/features/recipes/recipe-link';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import type { PhotoCredit } from '@/shared/photo-credit';

/**
 * The recipe's source credit (spec 4.5): "From seriouseats.com" (the host without `www.`), a link that
 * opens the original in Safari, as the link row does. VoiceOver: "Recipe from seriouseats.com, link".
 * Nothing unless `sourceUrl` is a link that opens, so removing the link removes the credit.
 * At a card's foot it's a row under a hairline. `onPhoto`: a small caption on a `surface` chip, so `inkSecondary` stays readable over the photo.
 * `underCard`: on the screen's ground under a card (cook mode's last step), lined up with the card's text and no hairline.
 */
export function RecipeCredit({
  sourceUrl,
  onPhoto = false,
  underCard = false,
}: {
  sourceUrl: string | null | undefined;
  onPhoto?: boolean;
  underCard?: boolean;
}) {
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
          : underCard
            ? { minHeight: sizes.minTapTarget, marginHorizontal: spacing.lg, paddingHorizontal: spacing.lg }
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

/**
 * A stock photo's credit (spec 4.5) on the recipe photo's bottom-right corner, where a site photo's
 * source credit sits: "Photo: Jane Doe / Pixabay" (the credit's provider) in `caption` `inkSecondary`
 * on a `surface` chip, a link that opens the photo's page in Safari. VoiceOver: "Photo by Jane Doe on
 * Pixabay, link".
 * Nothing without a credit (a library or camera photo).
 */
export function PhotoCreditChip({ credit }: { credit: PhotoCredit | null | undefined }) {
  const t = useT();
  const { colors, spacing, rounded, opacity } = useTheme();
  if (!credit) return null;
  return (
    <Pressable
      testID="photo-credit"
      onPress={() => void openRecipeLink(credit.pageUrl)}
      accessibilityRole="link"
      accessibilityLabel={t('recipes.photoCredit.label', { author: credit.author, provider: credit.provider })}
      accessibilityHint={t('recipes.photoCredit.hint', { provider: credit.provider })}
      hitSlop={spacing.sm}
      style={({ pressed }) => [
        styles.center,
        {
          position: 'absolute',
          right: spacing.sm,
          bottom: spacing.sm,
          maxWidth: '70%',
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xxs,
          borderRadius: rounded.full,
          backgroundColor: colors.surface,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="caption" color="inkSecondary" numberOfLines={1}>
        {t('recipes.photoCredit.text', { author: credit.author, provider: credit.provider })}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center' },
});
