import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/themed-view';

// TODO(M1): lists home (spec 4.1).
export default function ListsScreen() {
  return (
    <Screen>
      <EmptyState message="Your lists will show up here." />
    </Screen>
  );
}
