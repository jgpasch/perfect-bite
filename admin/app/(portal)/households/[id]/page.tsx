import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ChangePlan } from "@/components/change-plan";
import { Avatar, PlanBadge, RelativeDate } from "@/components/user-bits";
import { featureColors } from "@/lib/features";
import { firstMonthBadge, membersCount, planSinceLine, roleLabel } from "@/lib/households";
import { createClient } from "@/lib/supabase/server";
import { loadPlans, planNames, type PlanNames } from "@/lib/supabase/plans";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminHouseholdDetail, AdminPlanList } from "@/lib/types";
import { isUuid, planName, usageRow, whoWording } from "@/lib/users";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Household · Back office" };

type Params = Promise<{ id: string }>;

// One household (spec 4.12), from admin_household_detail: its plan (Change plan, with a required
// note and no "default" choice), this month's use of the two plan features against its limits
// (shared by its members, doubled in its first month), its members and how its plan has changed.
export default function HouseholdPage({ params }: { params: Params }) {
  return (
    <>
      <Link
        href="/households"
        className="mb-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink-secondary hover:text-ink"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Households
      </Link>
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading…</p>}>
        <HouseholdDetail params={params} />
      </Suspense>
    </>
  );
}

async function HouseholdDetail({ params }: { params: Params }) {
  const { id } = await params;
  if (!isUuid(id)) return <NoSuchHousehold />;

  const supabase = await createClient();
  const [{ data, error }, planList] = await Promise.all([
    supabase.rpc("admin_household_detail", { p_household_id: id }),
    loadPlans(supabase),
  ]);
  forbidIfNotAuthorized(error);
  if (error?.code === "P0002") return <NoSuchHousehold />;
  if (error) throw new Error(`Couldn't load the household: ${error.message}`);
  const household = data as AdminHouseholdDetail;
  const plans = planNames(planList);

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <Header household={household} />
      <div className="grid gap-5 md:grid-cols-[1fr_2fr]">
        <PlanCard household={household} planList={planList} />
        <UsageCard household={household} />
      </div>
      <MembersCard household={household} />
      <HistoryCard household={household} plans={plans} />
    </div>
  );
}

function NoSuchHousehold() {
  return (
    <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
      <h1 className="text-[28px] leading-tight text-ink">No such household</h1>
      <p className="mt-1 text-[15px] text-ink-secondary">It may have been deleted when its last member left.</p>
    </div>
  );
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl bg-surface p-5 shadow-sm", className)}>
      <h2 className="mb-3 text-[20px] leading-tight text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Header({ household }: { household: AdminHouseholdDetail }) {
  const firstMonth = firstMonthBadge(household.first_month);
  return (
    <header className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[34px] leading-tight text-ink">{household.name}</h1>
        <PlanBadge name={household.plan?.name ?? null} />
        {firstMonth !== null && (
          <span className="rounded-full bg-pending-soft px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap text-pending">
            {firstMonth}
          </span>
        )}
      </div>
      <p className="mt-1 text-[15px] text-ink-secondary">
        {membersCount(household.members.length)} · Created <RelativeDate iso={household.created_at} />
      </p>
      <p className="mt-0.5 font-mono text-[12px] text-ink-tertiary select-all">{household.household_id}</p>
    </header>
  );
}

function PlanCard({ household, planList }: { household: AdminHouseholdDetail; planList: AdminPlanList }) {
  return (
    <Card title="Plan">
      <p className="text-[22px] font-bold text-ink">{household.plan?.name ?? "No plan"}</p>
      <p className={cn("mt-1 text-[15px]", household.plan === null ? "text-danger" : "text-ink-secondary")}>
        {planSinceLine(household.plan)}
      </p>
      <ChangePlan
        householdId={household.household_id}
        householdName={household.name}
        plans={planList}
        currentPlanId={household.plan?.id ?? null}
      />
    </Card>
  );
}

function UsageCard({ household }: { household: AdminHouseholdDetail }) {
  return (
    <Card title="This month">
      <ul className="flex flex-col gap-3">
        {household.usage.map((usage) => {
          const row = usageRow(usage, household.first_month.doubled);
          const colors = featureColors(usage.feature);
          return (
            <li key={usage.feature} className={cn(!row.inPlan && "opacity-60")}>
              <div className="flex items-baseline justify-between gap-3 text-[15px]">
                <span className="flex items-center gap-2 font-semibold text-ink">
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: row.inPlan ? colors.color : "var(--ink-tertiary)" }}
                  />
                  {row.label}
                </span>
                <span className={cn("text-right", row.inPlan ? "text-ink-secondary" : "text-ink-tertiary")}>
                  {row.text}
                </span>
              </div>
              {row.fraction !== null && (
                <div
                  role="meter"
                  aria-label={`${row.label} this month`}
                  aria-valuemin={0}
                  aria-valuemax={usage.limit ?? 0}
                  aria-valuenow={Math.min(usage.used, usage.limit ?? 0)}
                  className="mt-1.5 h-2 overflow-hidden rounded-full"
                  style={{ backgroundColor: colors.soft }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.round(row.fraction * 100)}%`,
                      backgroundColor: row.atLimit ? "var(--danger)" : colors.color,
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function MembersCard({ household }: { household: AdminHouseholdDetail }) {
  return (
    <Card title="Members">
      {household.members.length === 0 ? (
        <p className="text-[15px] text-ink-secondary">No members.</p>
      ) : (
        <ul className="divide-y divide-border">
          {household.members.map((member) => (
            <li key={member.user_id} className="flex items-center justify-between gap-3 py-2 text-[15px]">
              <span className="flex min-w-0 items-center gap-3">
                <Avatar displayName={member.display_name} email={member.email} />
                <span className="min-w-0">
                  <Link href={`/users/${member.user_id}`} className="font-semibold text-ink hover:underline">
                    {member.display_name ?? member.email ?? member.user_id}
                  </Link>
                  {member.display_name && member.email && (
                    <span className="block truncate text-[13px] text-ink-secondary">{member.email}</span>
                  )}
                </span>
              </span>
              <span className="whitespace-nowrap text-ink-secondary">
                {roleLabel(member.role)} · joined <RelativeDate iso={member.joined_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryCard({ household, plans }: { household: AdminHouseholdDetail; plans: PlanNames }) {
  return (
    <Card title="Plan history">
      {household.plan_history.length === 0 ? (
        <p className="text-[15px] text-ink-secondary">Its plan hasn&apos;t been changed in the portal.</p>
      ) : (
        <table className="w-full text-left text-[15px]">
          <thead className="border-b border-border text-[13px] font-semibold text-ink-secondary">
            <tr>
              <th scope="col" className="py-2 pr-4">From</th>
              <th scope="col" className="px-4 py-2">To</th>
              <th scope="col" className="px-4 py-2">Note</th>
              <th scope="col" className="px-4 py-2">Who</th>
              <th scope="col" className="py-2 pl-4">When</th>
            </tr>
          </thead>
          <tbody>
            {household.plan_history.map((entry) => (
              <tr key={entry.id} className="border-b border-border align-top text-ink last:border-0">
                <td className="py-2 pr-4">{planName(entry.details.from, plans.names)}</td>
                <td className="px-4 py-2">{planName(entry.details.to, plans.names)}</td>
                <td className="px-4 py-2 text-ink-secondary">{entry.note ?? "—"}</td>
                <td className="px-4 py-2 break-all text-ink-secondary">{whoWording(entry)}</td>
                <td className="py-2 pl-4 whitespace-nowrap text-ink-secondary">
                  <RelativeDate iso={entry.created_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
