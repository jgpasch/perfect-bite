// Delete collection on a collection's screen (board B) pops back, and the screen it lands on (the Recipes
// tab, or the Collections list) shows "Deleted Mom's cookbook" with Undo: the collection screen stores the
// result as it closes, and whichever screen gains focus takes it (or at once, if it's showing).
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import type { ToastAction } from '@/components/toast';
import { i18n } from '@/i18n';

import { restoreCollection } from './collections';

export type DeletedCollectionResult = { id: string; name: string };

let pending: DeletedCollectionResult | null = null;
const listeners = new Set<() => void>();

export function setDeletedCollectionResult(result: DeletedCollectionResult): void {
  pending = result;
  for (const listener of [...listeners]) listener();
}

/** Tells a screen that's already showing about a result set while it shows. */
export function onDeletedCollectionResult(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The pending result, once: taking it clears it. */
export function takeDeletedCollectionResult(): DeletedCollectionResult | null {
  const result = pending;
  pending = null;
  return result;
}

/** While the screen has focus, shows a deleted collection's toast through `onToast`: "Deleted Mom's cookbook", Undo. */
export function useDeletedCollectionToast(
  onToast: (toast: { key: string; message: string; emphasis: string; actions: ToastAction[] } | null) => void,
): void {
  useFocusEffect(
    useCallback(() => {
      const show = () => {
        const result = takeDeletedCollectionResult();
        if (!result) return;
        onToast({
          key: `deleted-collection-${result.id}-${Date.now()}`,
          message: i18n.t('recipes.collections.deleted', { name: result.name }),
          emphasis: result.name,
          actions: [{ label: i18n.t('common.undo'), onPress: () => (restoreCollection(result.id), onToast(null)) }],
        });
      };
      show();
      return onDeletedCollectionResult(show);
    }, [onToast]),
  );
}
