import { Button as SwiftButton, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import type { AisleHue } from '@/domain/aisle-color';
import { openRecipeLink, recipeLinkParts } from '@/features/recipes/recipe-link';
import { useTheme } from '@/hooks/use-theme';
import { i18n, useT } from '@/i18n';

/** The link's actions: the long-press menu, and the same as VoiceOver custom actions. */
const LINK_ACTIONS = ['open', 'copy', 'edit', 'remove'] as const;
type LinkAction = (typeof LINK_ACTIONS)[number];

/** An action's label: "Open", "Copy link", "Edit link", "Remove link". */
function linkActionLabel(action: LinkAction): string {
  return i18n.t(`recipes.link.${action}`);
}

/**
 * The recipe band's link row (spec 4.5). A link that opens is a button reading its host (strong
 * tint) and path (secondary), opening Safari on tap, with a long-press menu and a pencil to edit.
 * Text that isn't a link shows as plain text that starts editing on tap. No link, or editing: the
 * text field, saved when editing ends.
 */
export function RecipeLinkRow({
  value,
  hue,
  onSave,
}: {
  /** The stored link (empty for none). */
  value: string;
  hue: AisleHue;
  /** Called with the field's text when editing ends; empty removes the link. */
  onSave: (text: string) => void;
}) {
  const t = useT();
  const { colors, aisles, spacing, typography, sizes, scheme } = useTheme();
  const tint = aisles[hue];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const parts = recipeLinkParts(value);

  const startEditing = () => {
    setDraft(value);
    setEditing(true);
  };
  const endEditing = () => {
    setEditing(false);
    onSave(draft);
  };
  const run = (action: LinkAction) => {
    if (action === 'open') void openRecipeLink(value);
    else if (action === 'copy') void Clipboard.setStringAsync(value);
    else if (action === 'edit') startEditing();
    else onSave('');
  };

  let content: React.ReactNode;
  if (editing || !value) {
    content = (
      <TextInput
        value={editing ? draft : ''}
        onChangeText={(text) => {
          setDraft(text);
          setEditing(true);
        }}
        onFocus={() => {
          if (!editing) startEditing();
        }}
        onEndEditing={endEditing}
        autoFocus={editing}
        placeholder={t('recipes.link.placeholder')}
        placeholderTextColor={colors.inkSecondary}
        selectionColor={tint.strong}
        accessibilityLabel={t('recipes.link.label')}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        style={[typography.amount, styles.flex, { color: tint.strong }]}
      />
    );
  } else if (parts) {
    const link = (
      <Pressable
        onPress={() => run('open')}
        accessibilityRole="link"
        accessibilityLabel={t('recipes.link.row', { link: parts.host })}
        accessibilityHint={t('recipes.link.openHint')}
        accessibilityActions={LINK_ACTIONS.map((name) => ({ name, label: linkActionLabel(name) }))}
        onAccessibilityAction={({ nativeEvent }) => {
          const action = LINK_ACTIONS.find((a) => a === nativeEvent.actionName);
          if (action) run(action);
        }}
        style={[styles.flex, styles.center, { minHeight: sizes.minTapTarget }]}>
        <ThemedText variant="amount" numberOfLines={1} ellipsizeMode="middle" style={{ color: tint.strong }}>
          {parts.host}
          {parts.path ? <ThemedText variant="amount" color="inkSecondary">{parts.path}</ThemedText> : null}
        </ThemedText>
      </Pressable>
    );
    content = (
      // A native context menu on long press; the Host is sized by the row, so the text truncates.
      <Host style={[styles.flex, { height: sizes.minTapTarget }]} colorScheme={scheme} seedColor={tint.strong}>
        <ContextMenu>
          <ContextMenu.Items>
            <SwiftButton label={linkActionLabel('open')} systemImage="safari" onPress={() => run('open')} />
            <SwiftButton label={linkActionLabel('copy')} systemImage="doc.on.doc" onPress={() => run('copy')} />
            <SwiftButton label={linkActionLabel('edit')} systemImage="pencil" onPress={() => run('edit')} />
            <SwiftButton
              label={linkActionLabel('remove')}
              systemImage="trash"
              role="destructive"
              onPress={() => run('remove')}
            />
          </ContextMenu.Items>
          <ContextMenu.Trigger>
            <RNHostView>{link}</RNHostView>
          </ContextMenu.Trigger>
        </ContextMenu>
      </Host>
    );
  } else {
    // Kept as typed but not a link that opens: plain text; tapping it edits.
    content = (
      <Pressable
        onPress={startEditing}
        accessibilityRole="button"
        accessibilityLabel={t('recipes.link.row', { link: value })}
        accessibilityHint={t('recipes.link.editHint')}
        style={[styles.flex, styles.center, { minHeight: sizes.minTapTarget }]}>
        <ThemedText variant="amount" numberOfLines={1} ellipsizeMode="middle">
          {value}
        </ThemedText>
      </Pressable>
    );
  }

  return (
    <View style={[styles.row, { gap: spacing.xs + spacing.xxs, minHeight: sizes.minTapTarget }]}>
      <SymbolView name="link" size={sizes.icon} tintColor={tint.strong} weight="bold" accessible={false} />
      {content}
      {value && !editing ? (
        <Pressable
          onPress={startEditing}
          accessibilityRole="button"
          accessibilityLabel={linkActionLabel('edit')}
          style={[styles.center, { minWidth: sizes.minTapTarget, minHeight: sizes.minTapTarget, alignItems: 'center' }]}>
          <SymbolView name="pencil" size={sizes.icon} tintColor={tint.strong} accessible={false} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
});
