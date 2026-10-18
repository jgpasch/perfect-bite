import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * The tab bar's round + (beside the tabs, spec 4.1): it always adds an item to a list. A list's screen claims
 * it with `useAddButton` to open its own add bar; anywhere else it's unclaimed, and + opens the List tab's add
 * field.
 */
let handler: (() => void) | null = null;
let pendingListAdd = false;

/** Makes + call `onPress` while this list screen is focused. A new `onPress` each render just claims it again. */
export function useAddButton(onPress: () => void) {
  useFocusEffect(
    useCallback(() => {
      handler = onPress;
      return () => {
        if (handler === onPress) handler = null;
      };
    }, [onPress]),
  );
}

/** The + was tapped. */
export function pressAddButton() {
  if (handler) {
    handler();
    return;
  }
  pendingListAdd = true;
  router.navigate('/lists');
}

/** True once after + was tapped away from a list: the list should open its add field. */
export function takePendingListAdd(): boolean {
  const pending = pendingListAdd;
  pendingListAdd = false;
  return pending;
}
