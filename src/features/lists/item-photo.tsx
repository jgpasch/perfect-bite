// The item sheet's photo (spec 4.4, item-requests board G): with none, a dashed Add photo tile that
// opens a native menu of Take photo and Choose from library; with one, the photo full width at 4:3
// in a `Card`, with Replace photo and Remove photo on a long-press or its … button, and a tap opening
// it full screen. Uploading needs a connection; offline those are disabled, "Needs a connection".
import { Button as SwiftButton, ContextMenu, Host, Menu, RNHostView, Text as SwiftText } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel, disabled as disabledModifier } from '@expo/ui/swift-ui/modifiers';
import { Image, type ImageSource } from 'expo-image';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Toast } from '@/components/toast';
import { ThemedText } from '@/components/themed-text';
import { pickPhoto, type PhotoSource } from '@/features/recipes/photo-upload';
import { useMotion } from '@/hooks/use-motion';
import { useOnline } from '@/hooks/use-online';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import {
  dismissItemPhotoChange,
  dismissItemPhotoUpload,
  removeItemPhoto,
  retryItemPhotoUpload,
  undoItemPhotoChange,
  uploadItemPhoto,
  useItemPhoto,
  useItemPhotoChange,
  useItemPhotoUpload,
} from './item-photos';

/** VoiceOver's custom actions on the photo. */
const PHOTO_ACTIONS = ['camera', 'library', 'remove'] as const;
type PhotoAction = (typeof PHOTO_ACTIONS)[number];

/**
 * The item sheet's photo, between the title block and the Amount card, with its toasts under it:
 * "Photo updated" / "Photo removed" with Undo, and "Couldn't upload the photo" with Try again.
 * `name` is the item's name as stored, for VoiceOver ("Photo of za'atar").
 */
export function ItemPhotoSection({ itemId, name, photoPath }: { itemId: string; name: string; photoPath: string | null }) {
  const t = useT();
  const { spacing } = useTheme();
  const online = useOnline();
  const upload = useItemPhotoUpload(itemId);
  const change = useItemPhotoChange(itemId);
  const photo = useItemPhoto(photoPath);
  const [picking, setPicking] = useState(false);
  const [viewing, setViewing] = useState(false);
  // The toasts end when the sheet closes; an upload in flight carries on.
  useEffect(
    () => () => {
      dismissItemPhotoChange();
      dismissItemPhotoUpload();
    },
    [],
  );
  const dismissChange = useCallback(() => dismissItemPhotoChange(change?.key), [change?.key]);
  const dismissUpload = useCallback(() => dismissItemPhotoUpload(upload?.key), [upload?.key]);

  const uploading = upload?.status === 'uploading';
  const label = t('item.photo.label', { name });

  // Picks, then uploads while the sheet shows the photo from the device with a spinner.
  const pick = async (from: PhotoSource) => {
    if (picking || uploading || !online) return;
    setPicking(true);
    try {
      const picked = await pickPhoto(from);
      if (picked.ok) void uploadItemPhoto(itemId, picked.uri);
      else if (picked.reason === 'denied') Alert.alert(t('item.photo.cameraDeniedTitle'), t('item.photo.cameraDenied'));
    } catch (e) {
      console.warn('[item photo] pick failed', e);
    } finally {
      setPicking(false);
    }
  };

  const run = (action: PhotoAction) => {
    if (action === 'remove') removeItemPhoto(itemId);
    else void pick(action);
  };

  let body: ReactNode;
  if (uploading) {
    body = <PhotoCard source={upload.localUri} label={label} uploading />;
  } else if (photoPath) {
    body = (
      <PhotoCard
        source={photo.source}
        label={label}
        onError={photo.onError}
        onOpen={photo.source ? () => setViewing(true) : undefined}
        menu={<PhotoMenuItems online={online} onRun={run} />}
        actions={online ? PHOTO_ACTIONS : ['remove']}
        onAction={run}
      />
    );
  } else {
    body = <AddPhotoTile online={online} onPick={(from) => void pick(from)} />;
  }

  return (
    <View style={{ gap: spacing.md }}>
      {body}
      {viewing && photo.source ? (
        <PhotoViewer source={photo.source} label={label} onClose={() => setViewing(false)} />
      ) : null}
      {change ? (
        <Toast
          key={`photo-${change.key}`}
          message={t(change.next === null ? 'item.photo.removed' : 'item.photo.updated')}
          actions={[{ label: t('common.undo'), onPress: () => undoItemPhotoChange(change) }]}
          onDismiss={dismissChange}
        />
      ) : null}
      {upload?.status === 'failed' ? (
        <Toast
          key={`upload-${upload.key}`}
          message={t('item.photo.uploadFailed')}
          actions={[{ label: t('common.tryAgain'), onPress: () => void retryItemPhotoUpload(upload) }]}
          onDismiss={dismissUpload}
        />
      ) : null}
    </View>
  );
}

/** Take photo and Choose from library, as native menu buttons. */
function SourceButtons({ onPick }: { onPick: (from: PhotoSource) => void }) {
  const t = useT();
  return (
    <>
      <SwiftButton label={t('item.photo.takePhoto')} systemImage="camera" onPress={() => onPick('camera')} />
      <SwiftButton
        label={t('item.photo.chooseFromLibrary')}
        systemImage="photo.on.rectangle"
        onPress={() => onPick('library')}
      />
    </>
  );
}

/** The photo's menu: Replace photo (its two sources; disabled offline, "Needs a connection") and Remove photo. */
function PhotoMenuItems({ online, onRun }: { online: boolean; onRun: (action: PhotoAction) => void }) {
  const t = useT();
  return (
    <>
      {online ? (
        <Menu label={t('item.photo.replace')} systemImage="arrow.triangle.2.circlepath">
          <SourceButtons onPick={onRun} />
        </Menu>
      ) : (
        // A second Text is the menu item's subtitle.
        <SwiftButton systemImage="arrow.triangle.2.circlepath" modifiers={[disabledModifier(true)]}>
          <SwiftText>{t('item.photo.replace')}</SwiftText>
          <SwiftText>{t('item.photo.needsConnection')}</SwiftText>
        </SwiftButton>
      )}
      <SwiftButton label={t('item.photo.remove')} systemImage="trash" role="destructive" onPress={() => onRun('remove')} />
    </>
  );
}

/**
 * The dashed Add photo tile (like the recipe band's, shorter: `itemPhotoTile` 64): a `photo.badge.plus`
 * glyph and "Add photo" in `inkSecondary`, opening a native menu of Take photo and Choose from library.
 * Offline it's disabled, with "Needs a connection" under the label.
 */
function AddPhotoTile({ online, onPick }: { online: boolean; onPick: (from: PhotoSource) => void }) {
  const t = useT();
  const { colors, sizes, spacing, rounded, opacity, scheme } = useTheme();
  const face = (
    <View
      testID="item-add-photo"
      style={[
        styles.row,
        styles.center,
        {
          minHeight: sizes.itemPhotoTile,
          gap: spacing.sm,
          paddingHorizontal: spacing.lg,
          borderWidth: sizes.checkBorder,
          borderStyle: 'dashed',
          borderColor: colors.controlBorder,
          borderRadius: rounded.md,
          opacity: online ? 1 : opacity.disabled,
        },
      ]}>
      <Icon name="photo.badge.plus" tint={colors.inkSecondary} weight="semibold" />
      <View>
        <ThemedText variant="headline" color="inkSecondary">
          {t('item.photo.add')}
        </ThemedText>
        {online ? null : (
          <ThemedText variant="footnote" color="inkSecondary">
            {t('item.photo.needsConnection')}
          </ThemedText>
        )}
      </View>
    </View>
  );

  if (!online) {
    return (
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t('item.photo.add')}
        accessibilityHint={t('item.photo.needsConnection')}
        accessibilityState={{ disabled: true }}
        style={{ marginHorizontal: spacing.lg }}>
        {face}
      </View>
    );
  }
  return (
    <Host style={{ height: sizes.itemPhotoTile, marginHorizontal: spacing.lg }} colorScheme={scheme} seedColor={colors.primary}>
      <Menu
        label={<RNHostView>{face}</RNHostView>}
        modifiers={[accessibilityLabel(t('item.photo.add')), accessibilityHint(t('item.photo.addHint'))]}>
        <SourceButtons onPick={onPick} />
      </Menu>
    </Host>
  );
}

/**
 * The photo in a `Card` (8 pt in), full width at 4:3, radius `md`, on `surfaceMuted` while it loads
 * (and with a `photo` glyph if it can't). `uploading`: from the device with a spinner, and no menu.
 * Otherwise a long-press (a native context menu) or the … button shows `menu`, and a tap opens it
 * full screen (`onOpen`). VoiceOver reads `label`, with `actions` as custom actions.
 */
function PhotoCard({
  source,
  label,
  uploading = false,
  onError,
  onOpen,
  menu,
  actions = [],
  onAction,
}: {
  source: ImageSource | string | null;
  label: string;
  uploading?: boolean;
  onError?: (event?: { error?: string }) => void;
  onOpen?: () => void;
  menu?: ReactNode;
  actions?: readonly PhotoAction[];
  onAction?: (action: PhotoAction) => void;
}) {
  const t = useT();
  const { colors, spacing, rounded, sizes, scheme, photoScrim } = useTheme();
  const actionLabel = (a: PhotoAction) =>
    a === 'camera' ? t('item.photo.takePhoto') : a === 'library' ? t('item.photo.chooseFromLibrary') : t('item.photo.remove');

  const photo = (
    <Pressable
      testID="item-photo"
      onPress={onOpen}
      disabled={!onOpen}
      accessibilityRole="imagebutton"
      accessibilityLabel={label}
      accessibilityHint={onOpen ? t('item.photo.openHint') : undefined}
      accessibilityState={uploading ? { busy: true } : undefined}
      accessibilityActions={actions.map((name) => ({ name, label: actionLabel(name) }))}
      onAccessibilityAction={({ nativeEvent }) => {
        const action = actions.find((a) => a === nativeEvent.actionName);
        if (action) onAction?.(action);
      }}
      style={styles.fill}>
      {source ? (
        <Image
          testID="item-photo-image"
          source={source}
          contentFit="cover"
          cachePolicy="disk"
          accessible={false}
          onError={onError}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Icon name="photo" color="inkSecondary" size={sizes.iconWell} />
        </View>
      )}
    </Pressable>
  );

  return (
    <Card style={{ padding: spacing.sm }}>
      <View style={[styles.photo, { borderRadius: rounded.md, backgroundColor: colors.surfaceMuted }]}>
        {menu ? (
          <Host style={StyleSheet.absoluteFill} colorScheme={scheme} seedColor={colors.primary}>
            <ContextMenu>
              <ContextMenu.Items>{menu}</ContextMenu.Items>
              <ContextMenu.Trigger>
                <RNHostView>{photo}</RNHostView>
              </ContextMenu.Trigger>
            </ContextMenu>
          </Host>
        ) : (
          photo
        )}
        {uploading ? (
          <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
            <View
              testID="item-photo-uploading"
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={t('item.photo.uploading')}
              style={{ backgroundColor: colors.toast, borderRadius: rounded.md, padding: spacing.sm }}>
              <ActivityIndicator color={colors.onToast} />
            </View>
          </View>
        ) : null}
        {menu ? (
          // The … button: 32 pt on the photo, in a 44 pt hit area. VoiceOver uses the photo's actions instead.
          <View style={[styles.more, { top: spacing.xs, right: spacing.xs }]}>
            <Host matchContents colorScheme={scheme}>
              <Menu
                label={
                  <RNHostView matchContents>
                    <View style={[styles.center, { width: sizes.minTapTarget, height: sizes.minTapTarget }]}>
                      <View
                        style={[
                          styles.center,
                          {
                            width: sizes.itemPhotoMore,
                            height: sizes.itemPhotoMore,
                            borderRadius: rounded.full,
                            backgroundColor: photoScrim.fill,
                          },
                        ]}>
                        <Icon name="ellipsis" tint={photoScrim.text} weight="bold" />
                      </View>
                    </View>
                  </RNHostView>
                }
                modifiers={[accessibilityLabel(t('item.photo.more'))]}>
                {menu}
              </Menu>
            </Host>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

// Pinching zooms up to this; pulling the unzoomed photo down this far closes the viewer.
const MAX_ZOOM = 4;
export const VIEWER_CLOSE_DISTANCE = 80;

/** Whether a drag that ended here closes the viewer: a pull down past `VIEWER_CLOSE_DISTANCE`, not zoomed in. */
export function viewerDragCloses({ zoomScale, offsetY }: { zoomScale: number; offsetY: number }): boolean {
  return zoomScale <= 1.01 && offsetY <= -VIEWER_CLOSE_DISTANCE;
}

/**
 * The photo full screen on `photoViewer.background`, in a native zooming scroll view: pinch to zoom
 * (and drag around while zoomed), and pull down to close; or the close button, or VoiceOver's
 * escape gesture.
 */
function PhotoViewer({ source, label, onClose }: { source: ImageSource; label: string; onClose: () => void }) {
  const t = useT();
  const { spacing, sizes, rounded, photoScrim, photoViewer } = useTheme();
  const { reduceMotion } = useMotion();

  return (
    <Modal visible animationType={reduceMotion ? 'none' : 'fade'} presentationStyle="overFullScreen" transparent onRequestClose={onClose}>
      <View
        testID="item-photo-viewer"
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={[styles.flex, { backgroundColor: photoViewer.background }]}>
        <ScrollView
          testID="item-photo-zoom"
          style={styles.flex}
          contentContainerStyle={styles.flex}
          minimumZoomScale={1}
          maximumZoomScale={MAX_ZOOM}
          bouncesZoom
          alwaysBounceVertical
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          onScrollEndDrag={(e) => {
            const { zoomScale = 1, contentOffset } = e.nativeEvent;
            if (viewerDragCloses({ zoomScale, offsetY: contentOffset.y })) onClose();
          }}>
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
            accessibilityHint={t('item.photo.viewerHint')}
            style={styles.flex}>
            <Image source={source} contentFit="contain" cachePolicy="disk" accessible={false} style={StyleSheet.absoluteFill} />
          </View>
        </ScrollView>
        <SafeAreaView edges={['top']} style={[styles.close, { right: spacing.lg }]} pointerEvents="box-none">
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('item.photo.close')}
            hitSlop={(sizes.minTapTarget - sizes.itemPhotoMore) / 2}
            style={[
              styles.center,
              {
                marginTop: spacing.sm,
                width: sizes.itemPhotoMore,
                height: sizes.itemPhotoMore,
                borderRadius: rounded.full,
                backgroundColor: photoScrim.fill,
              },
            ]}>
            <Icon name="xmark" tint={photoScrim.text} weight="bold" />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  fill: { width: '100%', height: '100%' },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  photo: { width: '100%', aspectRatio: 4 / 3, overflow: 'hidden', borderCurve: 'continuous' },
  more: { position: 'absolute' },
  close: { position: 'absolute', top: 0 },
});
