import { Pressable, StyleSheet, View } from 'react-native';

import { avatarColors } from '@/components/appearance';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { memberHue } from '@/domain/aisle-color';
import { avatarInitial } from '@/features/households/households';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { NEWS_AVATARS_SHOWN, newsCardLabel, newsItemsLine, newsSinceLine, newsTitle, type ListNews } from './list-news';

/**
 * "Since you looked" (spec 4.1, board 1 A): at the top of a list that opened with news, the members'
 * avatars, "Alex added 4 items", when the list was last seen, and the first few names, with ✕. One
 * VoiceOver element, with Dismiss as its action.
 */
export function NewsCard({
  news,
  names,
  onDismiss,
}: {
  news: ListNews;
  /** The members' short names, in `news.members`' order. */
  names: string[];
  onDismiss: () => void;
}) {
  const now = news.at;
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  return (
    <Card
      accessible
      accessibilityLabel={newsCardLabel(news, names, now)}
      accessibilityActions={[{ name: 'dismiss', label: t('common.dismiss') }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === 'dismiss') onDismiss();
      }}
      style={[styles.row, { paddingLeft: spacing.lg, paddingVertical: spacing.md, gap: spacing.md }]}>
      <View style={styles.avatars}>
        {news.members.slice(0, NEWS_AVATARS_SHOWN).map((userId, i) => {
          const look = avatarColors(memberHue(userId), colors, aisles);
          return (
            <View
              key={userId}
              testID={`news-avatar-${userId}`}
              style={[
                styles.avatar,
                {
                  width: sizes.iconWell,
                  height: sizes.iconWell,
                  borderRadius: rounded.full,
                  borderWidth: sizes.avatarRing,
                  borderColor: colors.surface,
                  backgroundColor: look.fill,
                  // Overlapping by 10 pt, as the household band's.
                  marginLeft: i === 0 ? 0 : -(spacing.sm + spacing.xxs),
                },
              ]}>
              <ThemedText variant="caption" maxFontSizeMultiplier={1.5} style={{ color: look.text }}>
                {avatarInitial(names[i])}
              </ThemedText>
            </View>
          );
        })}
      </View>
      <View style={[styles.text, { gap: spacing.xxs }]}>
        <ThemedText variant="headline">{newsTitle(names, news.items.length)}</ThemedText>
        <ThemedText variant="footnote" color="inkSecondary">
          {newsSinceLine(news.since, now)}
        </ThemedText>
        <ThemedText variant="callout">{newsItemsLine(news.items)}</ThemedText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.dismiss')}
        onPress={onDismiss}
        style={({ pressed }) => [
          styles.center,
          { width: sizes.minTapTarget, height: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
        ]}>
        <Icon name="xmark" color="inkSecondary" size={sizes.iconSmall} weight="semibold" />
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  avatars: { flexDirection: 'row' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
