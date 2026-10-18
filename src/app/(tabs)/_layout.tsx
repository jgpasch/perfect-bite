import * as Haptics from 'expo-haptics';
import { router, usePathname } from 'expo-router';
import { Tabs } from 'expo-router/tabs';
import { useEffect, type ReactNode } from 'react';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { TabBar } from '@/components/tab-bar';
import { failedImports } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { onPlanTab, setRecipesSegment, usePlanTabSetting } from '@/features/meal-plan/plan-tab';
import { failedImportsQuery } from '@/features/recipes/failed-imports';
import { importsBadgeCount, useShareQueueStatus } from '@/features/recipes/share-queue-status';
import { pressAddButton } from '@/features/tabs/add-button';
import { ADD_MENU_KEYS, addMenuEntries, showAddMenuSheet } from '@/features/tabs/add-menu';
import { useT } from '@/i18n';

const addLongPress = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

function tabIcon(name: IconName) {
  return function TabIcon({ focused, size }: { focused: boolean; size: number }) {
    return <Icon name={name} color={focused ? 'primary' : 'ink'} size={size} />;
  };
}

/** A tab's screen ends above the tab bar, which takes the bottom safe area itself. */
function AboveTabBar({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <SafeAreaInsetsContext.Provider value={{ ...insets, bottom: 0 }}>{children}</SafeAreaInsetsContext.Provider>;
}

/**
 * The tabs (spec 4.1), drawn by our own `TabBar` rather than the system one, so the round + can sit apart on
 * the right of the tabs: native tabs only set a search tab apart there.
 */
export default function TabsLayout() {
  const t = useT();
  const { data: failed } = useLiveQueryOn(failedImportsQuery(), [failedImports]);
  // Spec 4.10: recipes shared to the app that are waiting or won't import.
  const imports = importsBadgeCount(useShareQueueStatus(), failed.length);
  // Spec 4.16: the Plan tab only while its setting is on. Turned off while on it, Recipes > This week
  // takes over first: the tab stays until then.
  const planTab = usePlanTabSetting();
  const onPlan = onPlanTab(usePathname());
  const leavePlan = !planTab && onPlan;
  useEffect(() => {
    if (!leavePlan) return;
    setRecipesSegment('week');
    router.navigate('/recipes');
  }, [leavePlan]);

  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      screenLayout={({ children }) => <AboveTabBar>{children}</AboveTabBar>}
      tabBar={(props) => (
        <TabBar
          {...props}
          onAdd={pressAddButton}
          addLabel={t('tabs.add')}
          onAddLongPress={addLongPress}
          addMenu={addMenuEntries(ADD_MENU_KEYS)}
          addMoreLabel={t('tabs.addMore')}
          onAddMore={() => showAddMenuSheet(ADD_MENU_KEYS)}
        />
      )}>
      <Tabs.Screen name="lists" options={{ title: t('tabs.list'), tabBarIcon: tabIcon('checklist') }} />
      <Tabs.Screen
        name="recipes"
        options={{
          title: t('tabs.recipes'),
          tabBarIcon: tabIcon('book'),
          tabBarBadge: imports > 0 ? imports : undefined,
        }}
      />
      {/* Spec 4.16: the week plan. */}
      <Tabs.Screen
        name="plan"
        options={{ title: t('tabs.plan'), tabBarIcon: tabIcon('calendar'), href: planTab || onPlan ? undefined : null }}
      />
      <Tabs.Screen name="settings" options={{ title: t('tabs.settings'), tabBarIcon: tabIcon('gearshape') }} />
    </Tabs>
  );
}
