import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { setCurrentList } from '@/features/lists/current-list';

/** A link to a list (spec 4.1): it becomes the current list, and the List tab shows it. */
export default function ListLink() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // Once, while rendering, so the List tab already has it when the redirect lands there.
  useState(() => id && setCurrentList(id));
  return <Redirect href="/lists" />;
}
