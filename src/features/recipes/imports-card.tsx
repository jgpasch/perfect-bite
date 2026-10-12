import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { ColorToken } from '@/constants/theme';
import type { FailedImport } from '@/db';
import { getAccount } from '@/features/auth/account';
import { useTheme } from '@/hooks/use-theme';

import { dismissFailedImport, failedImportName, failedImportReason, retryFailedImport } from './failed-imports';
import { removeQueuedShare } from './share-drain';
import {
  importName,
  importsCardHeading,
  queuedShareDetail,
  type ImportsCardHeading,
  type QueuedShare,
  type ShareQueueStatus,
} from './share-queue-status';

const WELL: Record<ImportsCardHeading['tone'], { ground: ColorToken; glyph: ColorToken; icon: IconName | null }> = {
  failed: { ground: 'dangerSoft', glyph: 'danger', icon: 'exclamationmark.circle' },
  importing: { ground: 'primarySoft', glyph: 'onPrimarySoft', icon: null },
  waiting: { ground: 'pendingSoft', glyph: 'pending', icon: 'clock' },
};

/**
 * The Recipes tab's imports card (spec 4.10): shares importing now, waiting in the queue, or that
 * won't import. The heading says what matters most and expands to a row per share: waiting ones
 * with **Remove**, failed ones with **Try again** (into the default list) and **Dismiss**.
 */
export function ImportsCard({ failed, queue }: { failed: FailedImport[]; queue: ShareQueueStatus }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const [open, setOpen] = useState(false);
  const heading = importsCardHeading(failed.length, queue);
  if (!heading) return null;
  const well = WELL[heading.tone];
  const labelled = failed.length > 0 && queue.queued.length > 0;

  return (
    <Card style={{ marginBottom: spacing.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[heading.title, heading.subtitle].filter(Boolean).join(', ')}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [
          styles.row,
          {
            minHeight: sizes.cardRowMin,
            paddingHorizontal: spacing.md + spacing.xxs,
            paddingVertical: spacing.md,
            gap: spacing.md,
            opacity: pressed ? opacity.pressed : 1,
          },
        ]}>
        <View
          style={[
            styles.well,
            { width: sizes.iconWell, height: sizes.iconWell, borderRadius: rounded.md, backgroundColor: colors[well.ground] },
          ]}>
          {well.icon ? (
            <Icon name={well.icon} color={well.glyph} weight="semibold" />
          ) : (
            <ActivityIndicator size="small" color={colors[well.glyph]} />
          )}
        </View>
        <View style={styles.flex}>
          <ThemedText variant="headline">{heading.title}</ThemedText>
          {heading.subtitle ? (
            <ThemedText variant="footnote" color="inkSecondary" numberOfLines={2}>
              {heading.subtitle}
            </ThemedText>
          ) : null}
        </View>
        <Icon name={open ? 'chevron.down' : 'chevron.right'} color="inkTertiary" size={sizes.iconSmall} />
      </Pressable>
      {open ? (
        <>
          {failed.length > 0 && labelled ? <GroupLabel label="Couldn't import" color="danger" /> : null}
          {failed.map((row, i) => (
            <FailedImportRow key={row.id} row={row} divided={!labelled || i > 0} />
          ))}
          {queue.queued.length > 0 && labelled ? <GroupLabel label="Waiting" color="pending" /> : null}
          {queue.queued.map((share, i) => (
            <QueuedShareRow
              key={share.id}
              share={share}
              importing={queue.importing?.id === share.id}
              divided={!labelled || i > 0}
            />
          ))}
        </>
      ) : null}
    </Card>
  );
}

function GroupLabel({ label, color }: { label: string; color: ColorToken }) {
  const { colors, spacing } = useTheme();
  return (
    <ThemedText
      variant="caption"
      color={color}
      accessibilityRole="header"
      style={{
        textTransform: 'uppercase',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
        paddingHorizontal: spacing.md + spacing.xxs,
        paddingTop: spacing.sm + spacing.xxs,
      }}>
      {label}
    </ThemedText>
  );
}

function QueuedShareRow({ share, importing, divided }: { share: QueuedShare; importing: boolean; divided: boolean }) {
  const { colors, spacing, sizes } = useTheme();
  const name = importName(share);

  const remove = () => {
    const userId = getAccount()?.userId;
    if (userId) removeQueuedShare(share.id, userId);
  };

  return (
    <View
      style={[
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          gap: spacing.md,
          borderTopWidth: divided ? StyleSheet.hairlineWidth : 0,
          borderTopColor: colors.border,
          paddingLeft: spacing.md + spacing.xxs,
          paddingRight: spacing.sm,
          paddingVertical: spacing.sm,
        },
      ]}>
      <View style={styles.flex}>
        <ThemedText variant="body" numberOfLines={2}>
          {name}
        </ThemedText>
        <ThemedText variant="footnote" color="inkSecondary">
          {queuedShareDetail(share)}
        </ThemedText>
      </View>
      {importing ? (
        <View style={[styles.well, { width: sizes.minTapTarget, height: sizes.minTapTarget }]}>
          <ActivityIndicator size="small" color={colors.inkSecondary} accessibilityLabel={`Importing ${name}`} />
        </View>
      ) : (
        <Button label="Remove" variant="plain" color="inkSecondary" accessibilityLabel={`Remove ${name}`} onPress={remove} />
      )}
    </View>
  );
}

function FailedImportRow({ row, divided }: { row: FailedImport; divided: boolean }) {
  const { colors, spacing } = useTheme();
  const [trying, setTrying] = useState(false);

  const retry = async () => {
    const userId = getAccount()?.userId;
    if (!userId || trying) return;
    setTrying(true);
    // Success removes the row (and this component); a failure updates its reason.
    const result = await retryFailedImport(row.id, userId);
    if (!result?.ok) setTrying(false);
  };

  return (
    <View
      style={{
        borderTopWidth: divided ? StyleSheet.hairlineWidth : 0,
        borderTopColor: colors.border,
        paddingHorizontal: spacing.md + spacing.xxs,
        paddingTop: spacing.sm + spacing.xxs,
        paddingBottom: spacing.xs,
      }}>
      <ThemedText variant="body" numberOfLines={2}>
        {failedImportName(row)}
      </ThemedText>
      <ThemedText variant="footnote" color="inkSecondary">
        {failedImportReason(row.reason)}
      </ThemedText>
      <View style={[styles.row, { gap: spacing.md }]}>
        <Button label={trying ? 'Trying…' : 'Try again'} variant="plain" disabled={trying} onPress={retry} />
        <Button label="Dismiss" variant="plain" color="inkSecondary" onPress={() => dismissFailedImport(row.id)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  well: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
