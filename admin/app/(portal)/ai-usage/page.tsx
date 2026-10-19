import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { UsageChart } from "@/components/usage-chart";
import {
  callsByModel,
  count,
  failureBreakdown,
  failureRateText,
  usageTotal,
  usedOfLimit,
  usersLine,
} from "@/lib/ai-usage";
import { featureColors, featureLabel } from "@/lib/features";
import { createClient } from "@/lib/supabase/server";
import { loadPlanNames, type PlanNames } from "@/lib/supabase/plans";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminAiUsage, AdminFeatureUsageSummary, AiCallStats } from "@/lib/types";
import { planName } from "@/lib/users";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "AI usage · Back office" };

// AI usage (spec 4.12), from admin_ai_usage: per feature this month's total and users, the last 40
// days day by day and the top users; then the last 30 days of model calls per task and per model.
export default function AiUsagePage() {
  return (
    <>
      <PageHeader title="AI usage" />
      <p className="-mt-4 mb-6 text-[15px] text-ink-secondary">
        Usage is kept for 40 days, so this shows this month and the 40 days before today.
      </p>
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading…</p>}>
        <Usage />
      </Suspense>
    </>
  );
}

async function Usage() {
  const supabase = await createClient();
  const [{ data, error }, plans] = await Promise.all([supabase.rpc("admin_ai_usage"), loadPlanNames(supabase)]);
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't load AI usage: ${error.message}`);
  const usage = data as AdminAiUsage;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-5 lg:grid-cols-2">
        {(usage.features ?? []).map((feature) => (
          <FeatureCard key={feature.feature} feature={feature} plans={plans} />
        ))}
      </div>
      <Calls usage={usage} />
    </div>
  );
}

function FeatureCard({ feature, plans }: { feature: AdminFeatureUsageSummary; plans: PlanNames }) {
  const colors = featureColors(feature.feature);
  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-sm">
      <div className="rounded-xl px-4 py-3" style={{ backgroundColor: colors.soft }}>
        <h2 className="flex items-center gap-2 text-[17px] leading-tight" style={{ color: colors.strong }}>
          <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: colors.color }} />
          {featureLabel(feature.feature)}
        </h2>
        <p className="mt-1 text-[28px] leading-tight font-bold text-ink">{usageTotal(feature.feature, feature.used)}</p>
        <p className="text-[13px] text-ink-secondary">This month · {usersLine(feature.users)}</p>
      </div>
      <UsageChart feature={feature.feature} daily={feature.daily ?? []} />
      <div>
        <h3 className="mb-1 text-[15px] text-ink">Top users</h3>
        {feature.top_users.length === 0 ? (
          <p className="text-[14px] text-ink-secondary">No one has used it this month.</p>
        ) : (
          <table className="w-full text-left text-[14px]">
            <thead className="border-b border-border text-[12px] font-semibold text-ink-secondary">
              <tr>
                <th scope="col" className="py-1.5 pr-3">Email</th>
                <th scope="col" className="px-3 py-1.5">Plan</th>
                <th scope="col" className="py-1.5 pl-3 text-right">Used / limit</th>
              </tr>
            </thead>
            <tbody>
              {feature.top_users.map((user) => (
                <tr key={user.user_id} className="border-b border-border last:border-0">
                  <td className="max-w-0 truncate py-1.5 pr-3">
                    <Link href={`/users/${user.user_id}`} className="font-semibold text-ink hover:underline">
                      {user.email ?? user.user_id}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-ink-secondary">
                    {planName(user.plan_id, plans.names)}
                  </td>
                  <td className="py-1.5 pl-3 text-right whitespace-nowrap text-ink">
                    {usedOfLimit(user.used, user.limit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Calls({ usage }: { usage: AdminAiUsage }) {
  const calls = usage.calls ?? [];
  const models = callsByModel(calls);
  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="text-[28px] leading-tight text-ink">AI calls</h2>
        <p className="text-[15px] text-ink-secondary">Last 30 days</p>
      </div>
      {calls.length === 0 ? (
        <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
          <p className="text-[15px] text-ink-secondary">No AI calls in the last 30 days.</p>
        </div>
      ) : (
        <>
          <StatsTable
            caption="By task"
            nameHeader="Task"
            rows={calls.map((task) => ({ key: task.task, name: task.task, stats: task }))}
          />
          <StatsTable
            caption="By model"
            nameHeader="Model"
            small
            rows={models.map((model) => ({
              key: model.model,
              name: model.model,
              detail: model.tasks.join(", "),
              stats: model,
            }))}
          />
        </>
      )}
    </section>
  );
}

type StatsRow = { key: string; name: string; detail?: string; stats: AiCallStats };

function StatsTable({
  caption,
  nameHeader,
  rows,
  small = false,
}: {
  caption: string;
  nameHeader: string;
  rows: StatsRow[];
  small?: boolean;
}) {
  const cell = small ? "px-3 py-1.5" : "px-4 py-2.5";
  return (
    <div className={cn("overflow-x-auto rounded-2xl bg-surface shadow-sm", small && "max-w-4xl")}>
      <table className={cn("w-full text-left", small ? "text-[13px]" : "text-[15px]")}>
        <caption className={cn("text-left font-semibold text-ink", small ? "px-3 pt-3 text-[15px]" : "px-4 pt-4 text-[17px]")}>
          {caption}
        </caption>
        <thead className="border-b border-border text-[13px] font-semibold text-ink-secondary">
          <tr>
            <th scope="col" className={cell}>{nameHeader}</th>
            <th scope="col" className={cn(cell, "text-right")}>Calls</th>
            <th scope="col" className={cn(cell, "text-right")}>Failure rate</th>
            <th scope="col" className={cn(cell, "text-right")}>Fallbacks</th>
            <th scope="col" className={cn(cell, "text-right")}>Input</th>
            <th scope="col" className={cn(cell, "text-right")}>Output</th>
            <th scope="col" className={cn(cell, "text-right")}>Cached</th>
            <th scope="col" className={cn(cell, "text-right")}>Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, detail, stats }) => (
            <tr key={key} className="border-b border-border text-ink last:border-0">
              <th scope="row" className={cn(cell, "font-mono font-normal")}>
                {name}
                {detail && <span className="block font-sans text-[12px] text-ink-tertiary">{detail}</span>}
              </th>
              <td className={cn(cell, "text-right")}>{count(stats.total)}</td>
              <td className={cn(cell, "text-right")}>
                <span title={failureBreakdown(stats)} className="cursor-help underline decoration-dotted underline-offset-2">
                  {failureRateText(stats)}
                </span>
              </td>
              <td className={cn(cell, "text-right")}>{count(stats.fallbacks)}</td>
              <td className={cn(cell, "text-right")}>{count(stats.input_tokens)}</td>
              <td className={cn(cell, "text-right")}>{count(stats.output_tokens)}</td>
              <td className={cn(cell, "text-right")}>{count(stats.cached_input_tokens)}</td>
              <td className={cn(cell, "text-right")}>{count(stats.reasoning_tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
