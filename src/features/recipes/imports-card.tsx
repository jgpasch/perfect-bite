import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import type { ColorToken } from '@/constants/theme';
import type { FailedImport } from '@/db';
import { getAccount } from '@/features/auth/account';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import {
  dismissFailedImport,
  failedImportName,
  failedImportPageUris,
  failedImportReason,
  failedImportRetryOn,
  failedImportRowReason,
  failedPhotoDetail,
  needsOtherPhotos,
  photosKeptReason,
  retryFailedImport,
  retryingPhotoDetail,
  tryAgainOnLabel,
} from './failed-imports';
import { openFailedPhotoImport, pickOtherPhotos, retryFailedPhotoImport } from './photo-import-retry';
import { removeQueuedShare, retryShareImport } from './share-reconcile';
import {
  importName,
  importsCardHeading,
  queuedShareDetail,
  shareFailureReason,
  type FailedShareImport,
  type ImportsCardHeading,
  type QueuedShare,
  type ShareQueueStatus,
} from './share-queue-status';

const WELL: Record<ImportsCardHeading['tone'], { ground: ColorToken; glyph: ColorToken; icon: IconName }> = {
  failed: { ground: 'dangerSoft', glyph: 'danger', icon: 'exclamationmark.circle' },
  waiting: { ground: 'pendingSoft', glyph: 'pending', icon: 'clock' },
};

/** How far the second page in a stack is turned (board B). */
const STACK_TURN = '6deg';

/**
 * The Recipes tab's imports card (spec 4.10): shares waiting (on the device or on the server) and
 * imports that failed. The heading says what matters most and expands to a row per import: waiting
 * shares with **Remove** until the server has them (then a spinner), failed shares with **Try
 * again** (the same operation, on the server), failed in-app imports with **Try again** and
 * **Dismiss**. A failed photo import shows its pages as a stack (tapping opens its review sheet),
 * "N pages · to <list>" and, where the same pages can't succeed, a disabled "Try again Nov 1"
 * (`limit_reached`) or **Use other photos** (`not_a_recipe`). With one failed in-app import and
 * nothing else, the collapsed card shows it directly with its Try again (board A), and "Importing 1
 * of 1…" over a spinner on the pages while a photo one runs (board C).
 */
export function ImportsCard({ failed, queue }: { failed: FailedImport[]; queue: ShareQueueStatus }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const [open, setOpen] = useState(false);
  // In-app imports whose Try again is running.
  const [trying, setTrying] = useState<ReadonlySet<string>>(() => new Set());
  const heading = importsCardHeading(failed.length, queue);
  if (!heading) return null;
  const well = WELL[heading.tone];
  const failedCount = failed.length + queue.failed.length;
  const labelled = failedCount > 0 && queue.queued.length > 0;
  const lone = failed.length === 1 && queue.failed.length === 0 && queue.queued.length === 0 ? failed[0] : null;

  const retry = async (row: FailedImport) => {
    const userId = getAccount()?.userId;
    if (!userId || trying.has(row.id)) return;
    setTrying((s) => new Set(s).add(row.id));
    // Success removes the row (and its rows here); a failure updates its reason. A photo import posts
    // Importing and its result, as a new one does.
    const result = row.kind === 'photo' ? await retryFailedPhotoImport(row.id, userId) : await retryFailedImport(row.id, userId);
    if (!result?.ok) {
      setTrying((s) => {
        const next = new Set(s);
        next.delete(row.id);
        return next;
      });
    }
  };

  return (
    <Card style={{ marginBottom: spacing.md }}>
      {lone && !open ? (
        <LoneFailedImport row={lone} trying={trying.has(lone.id)} onRetry={() => retry(lone)} onExpand={() => setOpen(true)} />
      ) : (
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
            <Icon name={well.icon} color={well.glyph} weight="semibold" />
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
      )}
      {open ? (
        <>
          {failedCount > 0 && labelled ? <GroupLabel label={t('recipes.imports.failedGroup')} color="danger" /> : null}
          {queue.failed.map((share, i) => (
            <FailedShareRow key={share.id} share={share} divided={!labelled || i > 0} />
          ))}
          {failed.map((row, i) => (
            <FailedImportRow
              key={row.id}
              row={row}
              trying={trying.has(row.id)}
              onRetry={() => retry(row)}
              divided={!labelled || queue.failed.length + i > 0}
            />
          ))}
          {queue.queued.length > 0 && labelled ? <GroupLabel label={t('recipes.imports.waitingGroup')} color="pending" /> : null}
          {queue.queued.map((share, i) => (
            <QueuedShareRow key={share.id} share={share} divided={!labelled || i > 0} />
          ))}
        </>
      ) : null}
    </Card>
  );
}

/**
 * The collapsed card with one failed in-app import (board A): its pages (or the link's tile),
 * "Couldn't import 1 recipe" over the reason ("Your photos are kept." after it for a photo) and its
 * Try again; tapping the text expands it (for Dismiss). While a photo one's Try again runs (board
 * C): "Importing 1 of 1…" over "From a photo · to <list>", and a spinner on the pages.
 */
function LoneFailedImport({
  row,
  trying,
  onRetry,
  onExpand,
}: {
  row: FailedImport;
  trying: boolean;
  onRetry: () => void;
  onExpand: () => void;
}) {
  const t = useT();
  const { spacing, sizes, opacity } = useTheme();
  const photo = row.kind === 'photo';
  const userId = getAccount()?.userId ?? null;
  const importing = photo && trying;
  const title = importing
    ? t('recipes.imports.importingOf', { index: 1, count: 1 })
    : t('recipes.imports.couldntImport', { recipes: t('recipes.imports.recipes', { count: 1 }) });
  const subtitle = importing ? retryingPhotoDetail(row, userId) : photo ? photosKeptReason(row) : failedImportReason(row.reason);

  return (
    <View style={[styles.row, { paddingHorizontal: spacing.md + spacing.xxs, paddingVertical: spacing.md, gap: spacing.md }]}>
      {photo ? <PageStack row={row} busy={trying} /> : <IconTile name="link" hue="blue" />}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: false }}
        accessibilityLabel={`${title}, ${subtitle}`}
        onPress={onExpand}
        style={({ pressed }) => [styles.flex, { minHeight: sizes.minTapTarget, justifyContent: 'center', opacity: pressed ? opacity.pressed : 1 }]}>
        <ThemedText variant="headline">{title}</ThemedText>
        <ThemedText variant="footnote" color="inkSecondary" numberOfLines={3}>
          {subtitle}
        </ThemedText>
      </Pressable>
      {importing ? null : <FailedImportAction row={row} trying={trying} onRetry={onRetry} />}
    </View>
  );
}

/**
 * A failed in-app import's main button: Try again (Trying… while it runs), or for a photo whose
 * same pages can't succeed, a disabled "Try again Nov 1" or **Use other photos** (board E).
 */
function FailedImportAction({ row, trying, onRetry }: { row: FailedImport; trying: boolean; onRetry: () => void }) {
  const t = useT();
  if (needsOtherPhotos(row)) {
    return <Pill label={t('recipes.imports.useOtherPhotos')} soft icon="camera" onPress={() => pickOtherPhotos(row.id)} />;
  }
  const retryOn = failedImportRetryOn(row);
  if (retryOn) return <Button label={tryAgainOnLabel(retryOn)} variant="plain" disabled onPress={() => {}} />;
  return (
    <Button
      label={t(trying ? 'recipes.imports.trying' : 'recipes.imports.tryAgain')}
      variant="plain"
      disabled={trying}
      onPress={onRetry}
    />
  );
}

/**
 * A failed photo import's pages as a small stack (board B): the first as a 3:4 thumbnail, a second
 * behind it turned 6°, and a count badge with more than one. Tapping opens the review sheet
 * ("2 pages from a photo, button"); while its Try again runs, a spinner on a `photoScrim` covers it.
 */
function PageStack({ row, busy }: { row: FailedImport; busy: boolean }) {
  const t = useT();
  const { colors, spacing, sizes, rounded, photoScrim, opacity } = useTheme();
  const uris = failedImportPageUris(row);
  const width = sizes.importPageStack;
  const height = (width * 4) / 3;
  const page = { width, height, borderRadius: rounded.sm, borderColor: colors.border, backgroundColor: colors.surfaceMuted };

  return (
    <Pressable
      testID="failed-page-stack"
      accessibilityRole="button"
      accessibilityLabel={t('recipes.imports.pagesFromPhoto', { count: uris.length })}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={() => openFailedPhotoImport(row.id)}
      style={({ pressed }) => ({
        width: width + spacing.md,
        height: height + spacing.sm,
        opacity: pressed ? opacity.pressed : 1,
      })}>
      {uris.length > 1 ? (
        <View style={[styles.page, page, { left: spacing.sm + spacing.xxs, top: 0, transform: [{ rotate: STACK_TURN }] }]}>
          <Image source={uris[1]} contentFit="cover" accessible={false} style={StyleSheet.absoluteFill} />
        </View>
      ) : null}
      <View style={[styles.page, page, { left: 0, top: spacing.sm }]}>
        {uris[0] ? <Image source={uris[0]} contentFit="cover" accessible={false} style={StyleSheet.absoluteFill} /> : null}
        {busy ? (
          <View style={[StyleSheet.absoluteFill, styles.well, { backgroundColor: photoScrim.fill }]}>
            <ActivityIndicator size="small" color={photoScrim.text} accessibilityLabel={t('notifications.importing')} />
          </View>
        ) : null}
      </View>
      {uris.length > 1 ? (
        <View
          style={[
            styles.badge,
            {
              minWidth: sizes.importPageBadge,
              height: sizes.importPageBadge,
              borderRadius: sizes.importPageBadge / 2,
              paddingHorizontal: spacing.xs,
              backgroundColor: colors.ink,
            },
          ]}>
          <ThemedText variant="caption" color="background">
            {String(uris.length)}
          </ThemedText>
        </View>
      ) : null}
    </Pressable>
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

function QueuedShareRow({ share, divided }: { share: QueuedShare; divided: boolean }) {
  const t = useT();
  const { colors, spacing, sizes } = useTheme();
  const name = importName(share);

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
      {share.onServer ? (
        <View style={[styles.well, { width: sizes.minTapTarget, height: sizes.minTapTarget }]}>
          <ActivityIndicator size="small" color={colors.inkSecondary} accessibilityLabel={t('recipes.imports.importing', { name })} />
        </View>
      ) : (
        <Button
          label={t('recipes.imports.remove')}
          variant="plain"
          color="inkSecondary"
          accessibilityLabel={t('recipes.imports.removeLabel', { name })}
          onPress={() => removeQueuedShare(share.id)}
        />
      )}
    </View>
  );
}

/** A share the server couldn't import: its reason and **Try again**, which puts it back on the server. */
function FailedShareRow({ share, divided }: { share: FailedShareImport; divided: boolean }) {
  const t = useT();
  const { colors, spacing } = useTheme();
  const [trying, setTrying] = useState(false);

  const retry = async () => {
    if (trying) return;
    setTrying(true);
    // Taken, the card reads it again and it moves to waiting (this row goes).
    if (!(await retryShareImport(share.id))) setTrying(false);
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
        {importName(share)}
      </ThemedText>
      <ThemedText variant="footnote" color="inkSecondary">
        {shareFailureReason(share.errorCode, share.resetsAt)}
      </ThemedText>
      <View style={styles.row}>
        <Button
          label={t(trying ? 'recipes.imports.trying' : 'recipes.imports.tryAgain')}
          variant="plain"
          disabled={trying}
          onPress={retry}
        />
      </View>
    </View>
  );
}

/** A failed in-app import: its name, a photo's pages and where it goes, the reason, its main button and **Dismiss**. */
function FailedImportRow({
  row,
  trying,
  onRetry,
  divided,
}: {
  row: FailedImport;
  trying: boolean;
  onRetry: () => void;
  divided: boolean;
}) {
  const t = useT();
  const { colors, spacing } = useTheme();
  const photo = row.kind === 'photo';

  return (
    <View
      style={[
        photo ? styles.top : null,
        {
          gap: spacing.md,
          borderTopWidth: divided ? StyleSheet.hairlineWidth : 0,
          borderTopColor: colors.border,
          paddingHorizontal: spacing.md + spacing.xxs,
          paddingTop: spacing.sm + spacing.xxs,
          paddingBottom: spacing.xs,
        },
      ]}>
      {photo ? <PageStack row={row} busy={trying} /> : null}
      <View style={photo ? styles.flex : null}>
        <ThemedText variant="body" numberOfLines={2}>
          {failedImportName(row)}
        </ThemedText>
        {photo ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {failedPhotoDetail(row, getAccount()?.userId ?? null)}
          </ThemedText>
        ) : null}
        <ThemedText variant="footnote" color="inkSecondary">
          {failedImportRowReason(row)}
        </ThemedText>
        <View style={[styles.row, styles.wrap, { gap: spacing.md }]}>
          <FailedImportAction row={row} trying={trying} onRetry={onRetry} />
          <Button
            label={t('recipes.imports.dismiss')}
            variant="plain"
            color="inkSecondary"
            onPress={() => dismissFailedImport(row.id)}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  page: { position: 'absolute', overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center' },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  well: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  wrap: { flexWrap: 'wrap' },
});
