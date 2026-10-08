import { EmptyState } from '@/components/empty-state';
import { Screen } from '@/components/themed-view';

// TODO(M4): recipes (spec 4.5).
export default function RecipesScreen() {
  return (
    <Screen>
      <EmptyState message="Your recipes will show up here." />
    </Screen>
  );
}
