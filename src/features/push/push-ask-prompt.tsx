import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, PrimaryButton } from '@/components/button';
import { IconTile } from '@/components/icon-tile';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { clearPushMoment, pushAsked, setPushAsked, usePushMomentPending } from './ask';
import { getPushPermission, requestPushPermission } from './registration';

/**
 * The one-time offer to turn on notifications (spec 4.13), as a sheet over the app once a moment is
 * noted (`notePushMoment`). Only while the permission was never asked; it's marked asked as it
 * shows, so it never comes back, whether the answer is Turn on, Not now or a swipe away.
 */
export function PushAskPrompt() {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  const pending = usePushMomentPending();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!pending) return;
    let live = true;
    void getPushPermission().then((permission) => {
      if (!live) return;
      clearPushMoment();
      try {
        if (permission !== 'undetermined' || pushAsked()) return;
        setPushAsked();
      } catch (err) {
        console.warn('[push] the push prompt failed', err);
        return;
      }
      setVisible(true);
    });
    return () => {
      live = false;
    };
  }, [pending]);

  const close = () => setVisible(false);
  const turnOn = () => {
    close();
    void requestPushPermission();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.fill}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: opacity.scrim }]}
          onPress={close}
          accessible={false}
          importantForAccessibility="no"
        />
        <SafeAreaView
          edges={['bottom']}
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.background,
            borderTopLeftRadius: rounded.sheet,
            borderTopRightRadius: rounded.sheet,
            padding: spacing.xl,
            gap: spacing.md,
          }}>
          <IconTile hue="green" name="bell.badge" size={sizes.sheetIcon} />
          <ThemedText variant="title" accessibilityRole="header">
            {t('pushAsk.title')}
          </ThemedText>
          <ThemedText variant="callout" color="inkSecondary">
            {t('settings.notificationsScreen.explain')}
          </ThemedText>
          <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
            <PrimaryButton label={t('pushAsk.turnOn')} icon="bell" onPress={turnOn} />
            <Button label={t('pushAsk.notNow')} variant="plain" color="inkSecondary" onPress={close} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
});
