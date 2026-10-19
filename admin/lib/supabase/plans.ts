import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdminPlanList } from "@/lib/types";

import { forbidIfNotAuthorized } from "./session";

export type PlanNames = {
  /** Plan id → name. */
  names: Map<string, string>;
  /** The default plan's name, or null when no plan is the default. */
  defaultName: string | null;
};

// The plans' names from admin_list_plans, for pages that only have plan ids.
export async function loadPlanNames(supabase: SupabaseClient): Promise<PlanNames> {
  const { data, error } = await supabase.rpc("admin_list_plans");
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't load the plans: ${error.message}`);
  const plans = (data ?? []) as AdminPlanList;
  return {
    names: new Map(plans.map((plan) => [plan.id, plan.name])),
    defaultName: plans.find((plan) => plan.is_default)?.name ?? null,
  };
}
