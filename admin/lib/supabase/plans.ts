import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdminPlanList } from "@/lib/types";

import { forbidIfNotAuthorized } from "./session";

export type PlanNames = {
  /** Plan id → name. */
  names: Map<string, string>;
  /** The default plan's name, or null when no plan is the default. */
  defaultName: string | null;
};

// Every plan from admin_list_plans, by id.
export async function loadPlans(supabase: SupabaseClient): Promise<AdminPlanList> {
  const { data, error } = await supabase.rpc("admin_list_plans");
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't load the plans: ${error.message}`);
  return (data ?? []) as AdminPlanList;
}

export function planNames(plans: AdminPlanList): PlanNames {
  return {
    names: new Map(plans.map((plan) => [plan.id, plan.name])),
    defaultName: plans.find((plan) => plan.is_default)?.name ?? null,
  };
}

// The plans' names from admin_list_plans, for pages that only have plan ids.
export async function loadPlanNames(supabase: SupabaseClient): Promise<PlanNames> {
  return planNames(await loadPlans(supabase));
}
