import { DatePicker, Host } from '@expo/ui/swift-ui';
import { datePickerStyle, disabled as disabledModifier, labelsHidden } from '@expo/ui/swift-ui/modifiers';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, Switch, View } from 'react-native';

import { Card } from '@/components/card';
import { PrimaryButton } from '@/components/button';
import { IconTile } from '@/components/icon-tile';
import { SettingsRow, SettingsSection } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { cameToForeground } from '@/features/categories/catch-up';
import { getPushPermission, requestPushPermission, type PushPermission } from '@/features/push/registration';
import {
  dateAt,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_QUIET_HOURS,
  deviceTimeZone,
  hourMinuteOf,
  loadNotificationSettings,
  QuietHoursError,
  resetNotificationSettings,
  updateNotificationSettings,
  useNotificationSettings,
  validQuietHours,
  type NotificationSettings,
} from '@/features/push/settings';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/hooks/use-theme';
import { i18n, useT } from '@/i18n';

/** The OS permission, read on open and again on coming back (from iOS Settings, say). */
function usePushPermission(): [PushPermission | null, (next: PushPermission) => void] {
  const [permission, setPermission] = useState<PushPermission | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => void getPushPermission().then((p) => live && setPermission(p));
    read();
    let appState = AppState.currentState;
    const app = AppState.addEventListener('change', (next) => {
      if (cameToForeground(appState, next)) read();
      appState = next;
    });
    return () => {
      live = false;
      app.remove();
    };
  }, []);
  return [permission, setPermission];
}

/**
 * Settings > Notifications (spec 4.13): the permission card until notifications are allowed, then
 * the per-kind switches and quiet hours, saved online to `notification_settings` with the device's
 * time zone. Offline, the controls are disabled with "Needs a connection".
 */
export default function NotificationSettingsScreen() {
  const { colors, spacing } = useTheme();
  const t = useT();
  const online = useOnline();
  const [permission, setPermission] = usePushPermission();
  const store = useNotificationSettings();
  const [asking, setAsking] = useState(false);
  const [quietError, setQuietError] = useState(false);
  // Remounts the pickers after a refused time, so they show the saved one again.
  const [pickerKey, setPickerKey] = useState(0);

  useEffect(() => {
    void loadNotificationSettings();
    return () => resetNotificationSettings();
  }, []);
  // Back online with nothing loaded: try again.
  useEffect(() => {
    if (online && store.status === 'failed') void loadNotificationSettings();
  }, [online, store.status]);

  const settings: NotificationSettings = store.status === 'ready' ? store.settings : DEFAULT_NOTIFICATION_SETTINGS;
  const controlsDisabled = !online || store.status !== 'ready';

  const save = useCallback((patch: Partial<NotificationSettings>) => {
    updateNotificationSettings(patch).then(
      () => setQuietError(false),
      (err) => {
        if (err instanceof QuietHoursError) {
          setQuietError(true);
          setPickerKey((k) => k + 1);
          return;
        }
        console.warn('[push] saving the notification settings failed', err);
        setPickerKey((k) => k + 1);
        Alert.alert(i18n.t('settings.notificationsScreen.saveFailed'), i18n.t('households.errors.failed'));
      },
    );
  }, []);

  const turnOn = () => {
    setAsking(true);
    requestPushPermission()
      .then(setPermission)
      .finally(() => setAsking(false));
  };

  const setTime = (which: 'start' | 'end', date: Date) => {
    const current = settings.quietHours ?? DEFAULT_QUIET_HOURS;
    const next = { ...current, [which]: hourMinuteOf(date) };
    if (!validQuietHours(next)) {
      setQuietError(true);
      setPickerKey((k) => k + 1);
      return;
    }
    save({ quietHours: next });
  };

  const switchProps = (label: string) => ({
    trackColor: { true: colors.primary },
    disabled: controlsDisabled,
    accessibilityLabel: label,
  });

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
      {permission !== null && permission !== 'granted' ? (
        <PermissionCard permission={permission} asking={asking} onTurnOn={turnOn} />
      ) : null}

      {permission === 'granted' ? (
        <>
          <SettingsSection title={t('settings.notificationsScreen.notifyMe')}>
            <SettingsRow
              label={t('settings.notificationsScreen.itemsAdded')}
              icon={{ name: 'plus', hue: 'green' }}
              trailing={
                <Switch
                  value={settings.itemsAdded}
                  onValueChange={(on) => save({ itemsAdded: on })}
                  {...switchProps(t('settings.notificationsScreen.itemsAdded'))}
                />
              }
            />
            <SettingsRow
              label={t('settings.notificationsScreen.shopping')}
              icon={{ name: 'cart', hue: 'blue' }}
              trailing={
                <Switch
                  value={settings.shopping}
                  onValueChange={(on) => save({ shopping: on })}
                  {...switchProps(t('settings.notificationsScreen.shopping'))}
                />
              }
            />
            <SettingsRow
              label={t('settings.notificationsScreen.recipeImports')}
              detail={t('settings.notificationsScreen.recipeImportsDetail')}
              icon={{ name: 'fork.knife', hue: 'orange' }}
              trailing={
                <Switch
                  value={settings.recipeImports}
                  onValueChange={(on) => save({ recipeImports: on })}
                  {...switchProps(t('settings.notificationsScreen.recipeImports'))}
                />
              }
              last
            />
          </SettingsSection>

          <SettingsSection title={t('settings.notificationsScreen.quietHours')}>
            <SettingsRow
              label={t('settings.notificationsScreen.quietHours')}
              detail={t('settings.notificationsScreen.quietHoursDetail')}
              icon={{ name: 'moon', hue: 'plum' }}
              trailing={
                <Switch
                  value={settings.quietHours !== null}
                  onValueChange={(on) => {
                    setQuietError(false);
                    save({ quietHours: on ? DEFAULT_QUIET_HOURS : null });
                  }}
                  {...switchProps(t('settings.notificationsScreen.quietHours'))}
                />
              }
              last={settings.quietHours === null}
            />
            {settings.quietHours ? (
              <>
                <TimeRow
                  key={`start-${pickerKey}`}
                  label={t('settings.notificationsScreen.from')}
                  accessibilityLabel={t('settings.notificationsScreen.fromLabel')}
                  value={settings.quietHours.start}
                  disabled={controlsDisabled}
                  onChange={(date) => setTime('start', date)}
                  testID="quiet-hours-start"
                />
                <TimeRow
                  key={`end-${pickerKey}`}
                  label={t('settings.notificationsScreen.to')}
                  accessibilityLabel={t('settings.notificationsScreen.toLabel')}
                  value={settings.quietHours.end}
                  disabled={controlsDisabled}
                  onChange={(date) => setTime('end', date)}
                  testID="quiet-hours-end"
                  last
                />
              </>
            ) : null}
          </SettingsSection>
          <View style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl, gap: spacing.xs }}>
            {quietError ? (
              <ThemedText variant="footnote" color="danger" accessibilityRole="alert">
                {t('settings.notificationsScreen.sameTimes')}
              </ThemedText>
            ) : null}
            {settings.quietHours ? (
              <ThemedText variant="footnote" color="inkSecondary">
                {t('settings.notificationsScreen.timeZone', { zone: deviceTimeZone() })}
              </ThemedText>
            ) : null}
          </View>
          {!online ? (
            <ThemedText
              variant="footnote"
              color="inkSecondary"
              style={{ textAlign: 'center', paddingTop: spacing.lg, paddingHorizontal: spacing.xl }}>
              {t('settings.notificationsScreen.offline')}
            </ThemedText>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/** The card above the settings while notifications aren't allowed: what you'd get, and the way to allow them. */
function PermissionCard({
  permission,
  asking,
  onTurnOn,
}: {
  permission: Exclude<PushPermission, 'granted'>;
  asking: boolean;
  onTurnOn: () => void;
}) {
  const { spacing, sizes } = useTheme();
  const t = useT();
  const denied = permission === 'denied';
  return (
    <Card style={{ marginTop: spacing.lg, padding: spacing.lg, gap: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <IconTile hue={denied ? 'grey' : 'green'} name={denied ? 'bell.slash' : 'bell.badge'} size={sizes.iconWell} />
        <ThemedText variant="headline" accessibilityRole="header" style={{ flex: 1 }}>
          {denied ? t('settings.notificationsScreen.deniedTitle') : t('settings.notificationsScreen.cardTitle')}
        </ThemedText>
      </View>
      <ThemedText variant="callout" color="inkSecondary">
        {denied
          ? t('settings.notificationsScreen.denied')
          : permission === 'unavailable'
            ? t('settings.notificationsScreen.unavailable')
            : t('settings.notificationsScreen.explain')}
      </ThemedText>
      {permission === 'undetermined' ? (
        <PrimaryButton
          label={t('settings.notificationsScreen.turnOn')}
          icon="bell"
          disabled={asking}
          onPress={onTurnOn}
        />
      ) : null}
      {denied ? (
        <PrimaryButton
          label={t('settings.notificationsScreen.openSettings')}
          icon="gear"
          onPress={() => void Linking.openSettings().catch((err) => console.warn('[push] opening Settings failed', err))}
        />
      ) : null}
    </Card>
  );
}

/** A quiet-hours row: the label, then the native compact time picker. */
function TimeRow({
  label,
  accessibilityLabel,
  value,
  disabled,
  onChange,
  testID,
  last,
}: {
  label: string;
  accessibilityLabel: string;
  value: string;
  disabled: boolean;
  onChange: (date: Date) => void;
  testID: string;
  last?: boolean;
}) {
  return (
    <SettingsRow
      label={label}
      trailing={
        <Host matchContents>
          <DatePicker
            testID={testID}
            title={accessibilityLabel}
            selection={dateAt(value)}
            displayedComponents={['hourAndMinute']}
            onDateChange={onChange}
            modifiers={[datePickerStyle('compact'), labelsHidden(), disabledModifier(disabled)]}
          />
        </Host>
      }
      last={last}
    />
  );
}
