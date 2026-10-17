import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * The tab bar's round + (beside the tabs): it adds on whichever tab is showing. The focused screen claims it
 * with `useAddButton`; a tab with nothing to add (Plan, Settings) leaves it unclaimed, and + then opens the
 * List tab's add field.
 */
let handler: (() => void) | null = null;
let pendingListAdd = false;

/** Makes + call `onPress` while this screen is focused. A new `onPress` each render just claims it again. */
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

/** True once after + was tapped on a tab that left it unclaimed: the list should open its add field. */
export function takePendingListAdd(): boolean {
  const pending = pendingListAdd;
  pendingListAdd = false;
  return pending;
}
