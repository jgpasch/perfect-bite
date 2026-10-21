import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { PlanGrid } from "@/components/plan-grid";
import { SafetyLimitsCard } from "@/components/safety-limits";
import { createClient } from "@/lib/supabase/server";
import { loadPlans, loadSafetyLimits } from "@/lib/supabase/plans";

export const metadata: Metadata = { title: "Plans · Back office" };

// Plans (spec 4.12), from admin_list_plans: what each plan includes and its monthly limits, edited
// cell by cell, and each plan's menu (duplicate, rename, make default, delete). Below, the Safety
// limits card from admin_list_safety_limits: the per-user limits that apply on every plan.
export default function PlansPage() {
  return (
    <>
      <PageHeader title="Plans" />
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading…</p>}>
        <Plans />
      </Suspense>
      <p className="mt-4 max-w-3xl text-[13px] text-ink-secondary">
        Limits are per household and calendar month in UTC, resetting on the 1st, shared by its members. Households in their
        first 30 days get twice the limits. Categorize, step matching and tag suggestions are on every plan, under the
        safety limits.
      </p>
      <div className="mt-8">
        <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading safety limits…</p>}>
          <SafetyLimits />
        </Suspense>
      </div>
    </>
  );
}

async function SafetyLimits() {
  const limits = await loadSafetyLimits(await createClient());
  return <SafetyLimitsCard limits={limits} />;
}

async function Plans() {
  const plans = await loadPlans(await createClient());
  if (plans.length === 0) {
    return (
      <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
        <p className="text-[15px] text-ink-secondary">No plans yet.</p>
      </div>
    );
  }
  return <PlanGrid plans={plans} />;
}
