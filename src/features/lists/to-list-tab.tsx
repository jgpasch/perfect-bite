import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * Goes to the List tab, like `<Redirect href="/lists" />`, but back to the tabs already under this
 * screen (the root stack always starts with them, `initialRouteName`) rather than replacing this
 * screen with a second set. Two sets mean two list screens on the same list: two presence channels
 * knocking each other off, and two sets of NEW badges.
 */
export function ToListTab() {
  useFocusEffect(useCallback(() => router.dismissTo('/lists'), []));
  return null;
}
