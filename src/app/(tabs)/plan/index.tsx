import { usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listHeaderColors } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import type { SlotToast } from '@/features/meal-plan/slot-actions';
import { WeekPlan } from '@/features/meal-plan/week-plan';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The Plan tab (spec 4.16, board 4): "This week" on the green header with the week toolbar on the green,
 * over the week on the tab's ground.
 */
export default function PlanScreen() {
  const t = useT();
  const { spacing, colors, rounded } = useTheme();
  const header = listHeaderColors(colors);
  const onPlan = usePathname() === '/plan';
  const [toast, setToast] = useState<SlotToast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  return (
    <Screen>
      {onPlan ? <StatusBar style="light" /> : null}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.grow, { paddingBottom: spacing.xl }]}>
        <WeekPlan
          onToast={setToast}
          header={(toolbar) => (
            <>
              <View style={{ backgroundColor: header.ground }}>
                {/* Pulling down past the top shows more green, not the tab's ground. */}
                <View style={[styles.overscroll, { backgroundColor: header.ground }]} />
                <View style={{ gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm }}>
                  <ThemedText variant="largeTitle" color="onHeader" accessibilityRole="header" style={{ paddingHorizontal: spacing.xs }}>
                    {t('mealPlan.title')}
                  </ThemedText>
                  {toolbar}
                </View>
                <View style={{ height: rounded.card }} />
              </View>
              {/* The tab's ground: rounded top corners over the bottom of the green. */}
              <View
                style={[
                  styles.sheetTop,
                  {
                    height: rounded.card,
                    marginTop: -rounded.card,
                    marginBottom: spacing.xs,
                    borderTopLeftRadius: rounded.card,
                    borderTopRightRadius: rounded.card,
                    backgroundColor: colors.background,
                  },
                ]}
              />
            </>
          )}
        />
      </ScrollView>
      {toast ? (
        // Above the tab bar: the screen ends there.
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grow: { flexGrow: 1 },
  overscroll: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 1000 },
  sheetTop: { overflow: 'hidden', borderCurve: 'continuous' },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
