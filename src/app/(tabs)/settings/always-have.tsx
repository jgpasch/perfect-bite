import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActionSheetIOS, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import {
  ALWAYS_HAVE_EMPTY,
  addStapleFromText,
  setStaple,
  staplesQuery,
  STAPLES_QUERY_TABLES,
} from '@/features/households/staples';
import { SuggestionChips } from '@/features/lists/suggestion-chips';
import { getSuggestions, suggestionChips } from '@/features/lists/suggestions';
import { hideFromSuggestions } from '@/features/lists/usage';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { displayItemName, parseQuantity } from '@/shared';

type Staple = { ingredientName: string; displayName: string };

/**
 * Settings > household > Always have (spec 4.7): the household's staples, live, so another member's change shows at
 * once. The field at the top marks a name as a staple (read as the add bar reads it, amount ignored), with the add
 * bar's history and catalog chips. Swipe left, or Edit and the minus, removes one with no confirm and a "Removed
 * Salt" toast with Undo.
 */
export default function AlwaysHaveScreen() {
  const { spacing } = useTheme();
  const { household = '' } = useLocalSearchParams<{ household: string }>();
  const { data: staples } = useLiveQueryOn(staplesQuery(household), STAPLES_QUERY_TABLES, [household]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [removed, setRemoved] = useState<Staple | null>(null);
  // Bumped after "Remove from suggestions" and after an add, so suggestions are read again.
  const [version, setVersion] = useState(0);
  const dismissToast = useCallback(() => setRemoved(null), []);
  const userId = getAccount()?.userId ?? null;

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version only forces a re-read
  const suggestions = useMemo(() => getSuggestions(household, text), [household, text, version]);
  const chips = suggestionChips(text, { recipes: [], suggestions });

  const add = (value: string) => {
    if (!value.trim()) return;
    addStapleFromText(household, value, userId);
    setText('');
    setVersion((n) => n + 1);
  };

  const remove = (staple: Staple) => {
    setStaple(household, staple.ingredientName, false, userId);
    setRemoved(staple);
  };

  const removeMenu = ({ key, label }: { key: string; label: string }) => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: label, options: ['Remove from suggestions', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (index) => {
        if (index !== 0) return;
        hideFromSuggestions(household, key);
        setVersion((n) => n + 1);
      },
    );
  };

  const isEditing = editing && staples.length > 0;

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        {staples.length > 0 ? (
          <Stack.Toolbar.Button onPress={() => setEditing((e) => !e)}>{isEditing ? 'Done' : 'Edit'}</Stack.Toolbar.Button>
        ) : null}
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.grow, { paddingTop: spacing.sm, paddingBottom: spacing.xl }]}>
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
          <TextField
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => add(text)}
            submitBehavior="submit"
            returnKeyType="done"
            // As the add bar: names are shown in sentence case, and the chips do autocomplete.
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            placeholder="Add an ingredient"
            accessibilityLabel="Add an ingredient"
          />
          {chips.length > 0 ? (
            <SuggestionChips
              chips={chips}
              typed={parseQuantity(text).name}
              onPressItem={(chip) => add(chip.text)}
              onPressRecipe={() => {}}
              onRemove={(chip) => removeMenu({ key: chip.key, label: chip.label })}
            />
          ) : null}
        </View>
        {staples.length === 0 ? (
          <EmptyState message={ALWAYS_HAVE_EMPTY} />
        ) : (
          <Card style={{ marginTop: spacing.lg }}>
            {staples.map((s, i) => (
              <StapleRow
                key={s.ingredientName}
                staple={s}
                editing={isEditing}
                last={i === staples.length - 1}
                onDelete={() => remove(s)}
              />
            ))}
          </Card>
        )}
      </ScrollView>
      {removed ? (
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast
            key={removed.ingredientName}
            message={`Removed ${displayItemName(removed.displayName)}`}
            actions={[
              {
                label: 'Undo',
                onPress: () => {
                  setStaple(household, removed.ingredientName, true, userId);
                  setRemoved(null);
                },
              },
            ]}
            onDismiss={dismissToast}
          />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

/** A staple: its name in sentence case. Swipe left, or in Edit the minus, to remove; VoiceOver: a text with Delete. */
function StapleRow({
  staple,
  editing,
  last,
  onDelete,
}: {
  staple: Staple;
  editing: boolean;
  last: boolean;
  onDelete: () => void;
}) {
  const { colors, spacing, sizes, opacity } = useTheme();
  const { entering, exiting, layout } = useMotion();
  const name = displayItemName(staple.displayName);
  return (
    <Animated.View entering={entering} exiting={exiting} layout={layout}>
      <ReanimatedSwipeable
        enabled={!editing}
        // Follows the finger, and only a swipe past half the row commits (the default threshold).
        friction={1}
        overshootRight={false}
        onSwipeableOpen={() => onDelete()}
        renderRightActions={() => (
          <View style={[styles.action, { backgroundColor: colors.danger, paddingHorizontal: spacing.xl }]}>
            <Icon name="trash" color="onPrimary" />
          </View>
        )}>
        <View
          style={[
            styles.row,
            {
              minHeight: sizes.cardRowMin,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              gap: spacing.md,
              borderBottomColor: colors.border,
              borderBottomWidth: last ? 0 : 1,
              backgroundColor: colors.surface,
            },
          ]}>
          {editing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${name}`}
              onPress={onDelete}
              hitSlop={(sizes.minTapTarget - sizes.icon) / 2}
              style={({ pressed }) => ({ opacity: pressed ? opacity.pressed : 1 })}>
              <Icon name="minus.circle.fill" color="danger" />
            </Pressable>
          ) : null}
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={name}
            accessibilityActions={[{ name: 'delete', label: 'Delete' }]}
            onAccessibilityAction={({ nativeEvent }) => nativeEvent.actionName === 'delete' && onDelete()}
            style={styles.label}>
            <ThemedText variant="body">{name}</ThemedText>
          </View>
        </View>
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { flex: 1 },
  action: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
