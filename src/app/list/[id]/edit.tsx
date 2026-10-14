import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { Card } from '@/components/card';
import { SettingsRow } from '@/components/settings-group';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { LIST_HUES, listColorName, listHue, type ListHue } from '@/domain/aisle-color';
import { getAccount } from '@/features/auth/account';
import { deleteList, getDefaultListId, getList, renameList, setDefaultList, setListColor } from '@/features/lists/lists';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * Edit list (spec 4.1), from the list's ⋯ menu: its name, colour and whether Siri adds to it, then
 * Delete list. Done saves the name, colour and Siri choice; Cancel drops them. Delete asks first.
 */
export default function EditListSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, sizes, opacity, scheme } = useTheme();
  const t = useT();
  const userId = getAccount()?.userId ?? null;
  // A sheet is short-lived: read once rather than live.
  const [initial] = useState(() => {
    const list = getList(id);
    return list && { name: list.name, hue: listHue(list.color), siri: !!userId && getDefaultListId(userId) === id };
  });
  const [name, setName] = useState(initial?.name ?? '');
  const [hue, setHue] = useState<ListHue | null>(initial?.hue ?? null);
  const [siri, setSiri] = useState(initial?.siri ?? false);

  if (!initial) return <Screen />;

  const save = () => {
    if (name.trim() !== initial.name) renameList(id, name);
    if (hue !== initial.hue) setListColor(id, hue);
    if (siri && !initial.siri && userId) setDefaultList(userId, id);
    router.back();
  };

  const confirmDelete = () => {
    Alert.alert(t('lists.sheet.deleteTitle', { name: initial.name }), t('lists.sheet.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          // The List tab moves on to the next list by itself.
          deleteList(id);
          router.back();
        },
      },
    ]);
  };

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          variant="done"
          tintColor={prominentButtonTint(scheme, colors)}
          disabled={!name.trim()}
          onPress={save}>
          {t('common.done')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.lg }}>
        <View style={{ gap: spacing.sm }}>
          <Label>{t('lists.edit.name')}</Label>
          <TextField
            value={name}
            onChangeText={setName}
            accessibilityLabel={t('lists.edit.name')}
            autoCapitalize="words"
            returnKeyType="done"
            style={{ marginHorizontal: spacing.lg }}
          />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Label>{t('lists.edit.colour')}</Label>
          <Card style={[styles.row, styles.wrap, { gap: spacing.sm, padding: spacing.md }]}>
            {[null, ...LIST_HUES].map((h) => (
              <Swatch key={h ?? 'default'} hue={h} selected={h === hue} onPress={() => setHue(h)} />
            ))}
          </Card>
        </View>

        <Card>
          <SettingsRow
            label={t('lists.edit.siri')}
            last
            trailing={
              <Switch
                value={siri}
                onValueChange={setSiri}
                // Siri always has a default list: it moves by turning it on for another one.
                disabled={initial.siri || !userId}
                trackColor={{ true: colors.primary }}
                accessibilityLabel={t('lists.edit.siri')}
                accessibilityHint={initial.siri ? t('lists.edit.siriHintOn') : t('lists.edit.siriHintOff')}
              />
            }
          />
        </Card>

        <Card>
          <Pressable
            accessibilityRole="button"
            accessibilityHint={t('lists.edit.deleteHint')}
            onPress={confirmDelete}
            style={({ pressed }) => [styles.center, { minHeight: sizes.cardRowMin, opacity: pressed ? opacity.pressed : 1 }]}>
            <ThemedText variant="body" color="danger">
              {t('lists.edit.deleteList')}
            </ThemedText>
          </Pressable>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function Label({ children }: { children: string }) {
  const { spacing } = useTheme();
  return (
    <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
      {children}
    </ThemedText>
  );
}

/**
 * A list colour: the hue's dot, or for Default an empty ring, as in the Your lists sheet. The chosen
 * one is ringed in `primary`. VoiceOver reads the colour's name and whether it's chosen.
 */
function Swatch({ hue, selected, onPress }: { hue: ListHue | null; selected: boolean; onPress: () => void }) {
  const { colors, aisles, sizes, rounded, opacity } = useTheme();
  const ring = sizes.focusRing;
  const outer = sizes.swatch + ring * 4;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={listColorName(hue)}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={(sizes.minTapTarget - outer) / 2}
      style={({ pressed }) => [
        styles.center,
        {
          width: outer,
          height: outer,
          borderRadius: rounded.full,
          borderWidth: ring,
          borderColor: selected ? colors.primary : 'transparent',
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <View
        style={{
          width: sizes.swatch,
          height: sizes.swatch,
          borderRadius: rounded.full,
          backgroundColor: hue ? aisles[hue].dot : 'transparent',
          borderWidth: hue ? 0 : ring,
          borderColor: colors.controlBorder,
        }}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
