import { Host, List, Section, Text as SwiftText } from '@expo/ui/swift-ui';
import { deleteDisabled, environment } from '@expo/ui/swift-ui/modifiers';
import { router, Stack } from 'expo-router';
import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listRowLook } from '@/components/appearance';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import { households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { listHue } from '@/domain/aisle-color';
import { getAccount } from '@/features/auth/account';
import { householdsQuery } from '@/features/households/households';
import { InviteRow } from '@/features/households/invite-row';
import type { MyInvite } from '@/features/households/invites';
import {
  declineInvitePrompt,
  declineMyInvite,
  householdToReplace,
  joinMyInvite,
  replaceHouseholdPrompt,
  useMyInvites,
  type MyInviteResult,
} from '@/features/households/my-invites';
import { resolveCurrentListId, setCurrentList, useCurrentListVersion } from '@/features/lists/current-list';
import { householdHeaderLabel, listRowAccessibilityLabel, listRowCount, listsOverview } from '@/features/lists/list-view';
import {
  deleteList,
  getDefaultListId,
  listsWithCountsQuery,
  moveList,
  setDefaultList,
  setListArchived,
  type ListSummary,
} from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { useTheme } from '@/hooks/use-theme';
import { i18n, useT } from '@/i18n';

/**
 * Your lists (spec 4.1, boards G and H): opened from the list's name. Invites first, then the lists,
 * grouped per household when there is more than one, the current one ticked. Tapping a list makes it
 * the List tab's list. Edit reorders; long-press renames, archives or deletes.
 */
export default function ListsSheet() {
  const { spacing, scheme, colors } = useTheme();
  const t = useT();
  // userSettings: so the Siri mark follows "Make default for Siri".
  const { data } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  // Live, so joining a household from here shows its lists at once.
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households]);
  const active = useMemo(() => data.filter((l) => l.archivedAt === null), [data]);
  const archived = useMemo(() => data.filter((l) => l.archivedAt !== null), [data]);
  // Oldest first, so the first is the one new lists default to.
  const overview = useMemo(() => listsOverview(householdRows, active, householdRows[0]?.id ?? null), [householdRows, active]);
  const userId = getAccount()?.userId ?? null;
  const version = useCurrentListVersion();
  // Re-read whenever the lists or settings change (`data` is a new array then).
  const defaultListId = useMemo(() => (userId && data.length > 0 ? getDefaultListId(userId) : null), [userId, data]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version`: another screen picked a list
  const currentId = useMemo(() => resolveCurrentListId(active, userId), [active, userId, version]);
  const [reordering, setReordering] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const invites = useMyInvites();
  const [busyInvite, setBusyInvite] = useState<{ id: string; action: 'join' | 'decline' } | null>(null);
  const [toast, setToast] = useState<{ key: number; message: string } | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  const settle = (result: MyInviteResult) => {
    setBusyInvite(null);
    // A new key restarts the toast's timer when one is already showing.
    const message = result.ok ? result.notice : result.message;
    if (message) setToast((t) => ({ key: (t?.key ?? 0) + 1, message }));
  };
  // With a household of their own and nobody else in it, ask whether to keep it first.
  const join = async (invite: MyInvite) => {
    setBusyInvite({ id: invite.id, action: 'join' });
    const replacing = userId ? await householdToReplace(invite.householdId, userId) : null;
    if (!replacing) return void joinMyInvite(invite).then(settle);
    const prompt = replaceHouseholdPrompt(invite.householdName, replacing);
    Alert.alert(prompt.title, prompt.message, [
      { text: t('common.cancel'), style: 'cancel', onPress: () => setBusyInvite(null) },
      { text: prompt.keep, onPress: () => void joinMyInvite(invite).then(settle) },
      { text: prompt.remove, style: 'destructive', onPress: () => void joinMyInvite(invite, replacing).then(settle) },
    ]);
  };
  const decline = (invite: MyInvite) => {
    const prompt = declineInvitePrompt(invite);
    Alert.alert(prompt.title, prompt.message, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('invites.card.decline'),
        style: 'destructive',
        onPress: () => {
          setBusyInvite({ id: invite.id, action: 'decline' });
          void declineMyInvite(invite).then(settle);
        },
      },
    ]);
  };

  const pick = (listId: string) => {
    setCurrentList(listId);
    router.back();
  };
  const create = (householdId?: string) => promptListName(null, '', pick, householdId);

  // SwiftUI's onMove destination is the index to insert before.
  const reorderRows = (group: ListSummary[]) => (
    <List.ForEach
      onMove={(from, destination) => {
        const source = from[0];
        moveList(group, source, destination > source ? destination - 1 : destination);
      }}>
      {group.map((l) => (
        <SwiftText key={l.id} modifiers={[deleteDisabled()]}>{l.emoji ? `${l.emoji} ${l.name}` : l.name}</SwiftText>
      ))}
    </List.ForEach>
  );

  const rows = (group: ListSummary[]) => (
    <Card>
      {group.map((l, i) => (
        <ListRow
          key={l.id}
          list={l}
          first={i === 0}
          current={l.id === currentId}
          isDefault={l.id === defaultListId}
          onPress={() => pick(l.id)}
        />
      ))}
    </Card>
  );

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        {active.length > 1 ? (
          <Stack.Toolbar.Button onPress={() => setReordering((r) => !r)}>{reordering ? t('common.done') : t('common.edit')}</Stack.Toolbar.Button>
        ) : null}
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        {overview.kind === 'multi' ? (
          // Several households: ask which one gets the new list.
          <Stack.Toolbar.Menu
            icon="plus"
            accessibilityLabel={t('lists.sheet.newList')}
            title={t('lists.sheet.newListIn')}
            hidden={reordering}>
            {overview.sections.map((s) => (
              <Stack.Toolbar.MenuAction key={s.householdId} icon="circle.fill" onPress={() => create(s.householdId)}>
                {s.name}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        ) : (
          <Stack.Toolbar.Button
            icon="plus"
            accessibilityLabel={t('lists.sheet.newList')}
            onPress={() => create(overview.householdId ?? undefined)}
            hidden={reordering}
          />
        )}
      </Stack.Toolbar>

      {reordering ? (
        // Native drag handles. With several households each is its own section, so a list can't be
        // dragged into another household.
        <Host style={styles.flex} colorScheme={scheme} seedColor={colors.primary}>
          <List modifiers={[environment('editMode', 'active')]}>
            {overview.kind === 'multi'
              ? overview.sections
                  .filter((s) => s.lists.length > 0)
                  .map((s) => (
                    <Section key={s.householdId} title={s.name}>
                      {reorderRows(s.lists)}
                    </Section>
                  ))
              : reorderRows(active)}
          </List>
        </Host>
      ) : (
        <ScrollView style={styles.flex} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: spacing.xl }}>
          <ThemedText variant="sheetTitle" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingBottom: spacing.sm }}>
            {t('lists.sheet.title')}
          </ThemedText>
          {invites.length > 0 ? (
            <Group label={t('lists.sheet.invite')} labelColor="pending">
              <View style={{ gap: spacing.sm }}>
                {invites.map((invite) => (
                  <InviteRow
                    key={invite.id}
                    invite={invite}
                    busy={busyInvite?.id === invite.id ? busyInvite.action : null}
                    onJoin={() => void join(invite)}
                    onDecline={() => decline(invite)}
                  />
                ))}
              </View>
            </Group>
          ) : null}
          {overview.kind === 'multi' ? (
            overview.sections.map((s) => (
              <Group key={s.householdId} label={s.name} accessibilityLabel={householdHeaderLabel(s.name)}>
                {s.lists.length > 0 ? (
                  rows(s.lists)
                ) : (
                  <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.lg }}>
                    {t('lists.sheet.noLists')}
                  </ThemedText>
                )}
              </Group>
            ))
          ) : active.length > 0 ? (
            <Group>{rows(active)}</Group>
          ) : null}
          {archived.length > 0 ? (
            <Fragment>
              <ArchivedHeader count={archived.length} open={showArchived} onPress={() => setShowArchived((v) => !v)} />
              {showArchived ? <Group>{archivedRows(archived)}</Group> : null}
            </Fragment>
          ) : null}
        </ScrollView>
      )}
      {toast ? (
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} actions={[]} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

function archivedRows(group: ListSummary[]) {
  return (
    <Card>
      {group.map((l, i) => (
        <ListRow key={l.id} list={l} first={i === 0} current={false} isDefault={false} onPress={() => archivedActions(l)} />
      ))}
    </Card>
  );
}

/** A household's label (or "Invite") over its card. No label with one household. */
function Group({
  label,
  labelColor = 'inkSecondary',
  accessibilityLabel,
  children,
}: {
  label?: string;
  labelColor?: 'inkSecondary' | 'pending';
  accessibilityLabel?: string;
  children: ReactNode;
}) {
  const { spacing } = useTheme();
  return (
    <View style={{ paddingTop: spacing.lg }}>
      {label ? (
        <ThemedText
          variant="sectionLabel"
          color={labelColor}
          accessibilityRole="header"
          accessibilityLabel={accessibilityLabel}
          style={{ paddingHorizontal: spacing.xxl, paddingBottom: spacing.sm }}>
          {label}
        </ThemedText>
      ) : null}
      {children}
    </View>
  );
}

function confirmDelete(list: ListSummary) {
  Alert.alert(i18n.t('lists.sheet.deleteTitle', { name: list.name }), i18n.t('lists.sheet.deleteMessage'), [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    { text: i18n.t('common.delete'), style: 'destructive', onPress: () => deleteList(list.id) },
  ]);
}

/** Long-press on a list: Rename, Make default for Siri, Archive, Delete. */
function listActions(list: ListSummary, isDefault: boolean) {
  const userId = getAccount()?.userId;
  const actions: { label: string; run: () => void }[] = [
    { label: i18n.t('lists.sheet.rename'), run: () => promptListName(list.id, list.name) },
    ...(userId && !isDefault ? [{ label: i18n.t('lists.sheet.makeDefault'), run: () => setDefaultList(userId, list.id) }] : []),
    { label: i18n.t('lists.sheet.archive'), run: () => setListArchived(list.id, true) },
    { label: i18n.t('common.delete'), run: () => confirmDelete(list) },
  ];
  showActions(list.name, actions);
}

/** An archived list: Unarchive or Delete. */
function archivedActions(list: ListSummary) {
  showActions(list.name, [
    { label: i18n.t('lists.sheet.unarchive'), run: () => setListArchived(list.id, false) },
    { label: i18n.t('common.delete'), run: () => confirmDelete(list) },
  ]);
}

function showActions(title: string, actions: { label: string; run: () => void }[]) {
  const options = [...actions.map((a) => a.label), i18n.t('common.cancel')];
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options, destructiveButtonIndex: options.indexOf(i18n.t('common.delete')), cancelButtonIndex: actions.length },
    (index) => actions[index]?.run(),
  );
}

function ListRow({
  list,
  first,
  current,
  isDefault,
  onPress,
}: {
  list: ListSummary;
  first: boolean;
  current: boolean;
  isDefault: boolean;
  onPress: () => void;
}) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  const archived = list.archivedAt !== null;
  const look = listRowLook(current, isDefault, listHue(list.color), colors, aisles);
  const label = listRowAccessibilityLabel(list.name, list.uncheckedCount, { isDefault, archived, current });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: current }}
      accessibilityHint={archived ? t('lists.sheet.archivedHint') : undefined}
      accessibilityActions={archived ? undefined : [{ name: 'longpress', label: t('lists.sheet.moreActions') }]}
      onAccessibilityAction={() => listActions(list, isDefault)}
      onPress={onPress}
      onLongPress={archived ? undefined : () => listActions(list, isDefault)}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.cardRowMin + spacing.sm + spacing.xxs,
          paddingHorizontal: spacing.lg,
          gap: spacing.md,
          backgroundColor: look.fill,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: archived ? opacity.disabled : pressed ? opacity.pressed : 1,
        },
      ]}>
      <View
        style={{
          width: sizes.listDot,
          height: sizes.listDot,
          borderRadius: rounded.full,
          backgroundColor: look.dot ?? 'transparent',
          borderWidth: look.ring ? sizes.checkBorder : 0,
          borderColor: look.ring ?? 'transparent',
        }}
      />
      <View style={[styles.row, styles.flex, { gap: spacing.xs + spacing.xxs }]}>
        <ThemedText variant="body" color={look.text} numberOfLines={2} style={[styles.shrink, styles.name]}>
          {list.emoji ? `${list.emoji} ${list.name}` : list.name}
        </ThemedText>
        {isDefault ? <Icon name="mic.fill" color={look.secondary} size={sizes.iconSmall} /> : null}
      </View>
      <ThemedText variant="amount" color={look.secondary}>
        {listRowCount(list.uncheckedCount)}
      </ThemedText>
      <View style={{ width: sizes.icon }}>
        {current ? <Icon name="checkmark" color={look.text} size={sizes.icon} weight="bold" /> : null}
      </View>
    </Pressable>
  );
}

function ArchivedHeader({ count, open, onPress }: { count: number; open: boolean; onPress: () => void }) {
  const { spacing, sizes, opacity } = useTheme();
  const t = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={t('lists.sheet.archivedLabel', { count })}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        styles.center,
        { minHeight: sizes.minTapTarget, marginTop: spacing.lg, gap: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <Icon name="archivebox" color="inkSecondary" size={sizes.iconSmall + spacing.xs} />
      <ThemedText variant="amount" color="inkSecondary">
        {t('lists.sheet.archived', { count })}
      </ThemedText>
      <Icon name={open ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
  name: { fontWeight: '600' },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
