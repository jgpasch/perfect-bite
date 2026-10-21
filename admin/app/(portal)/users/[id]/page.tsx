import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ChangePlan } from "@/components/change-plan";
import { UnblockAiPhotos } from "@/components/unblock-ai-photos";
import { AiPhotosBlockedBadge, Avatar, PlanBadge, RelativeDate } from "@/components/user-bits";
import { blockedLine, refusalsHref, refusalsLine } from "@/lib/ai-photo-block";
import { aiCallsHref, aiFlagsLine } from "@/lib/ai-calls";
import { featureColors } from "@/lib/features";
import { mediumDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { loadPlans, planNames, type PlanNames } from "@/lib/supabase/plans";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminPlanList, AdminUserDetail } from "@/lib/types";
import { historyPlan, isUuid, planName, usageRow, whoWording } from "@/lib/users";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "User · Back office" };

type Params = Promise<{ id: string }>;

// One user (spec 4.12), from admin_user_detail: who they are, their plan, this month's usage per
// feature, whether their AI photos are blocked, their households and how their plan has changed.
// Change plan is on the Plan card, Unblock on the AI photos card.
export default function UserPage({ params }: { params: Params }) {
  return (
    <>
      <Link
        href="/users"
        className="mb-4 inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink-secondary hover:text-ink"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Users
      </Link>
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading…</p>}>
        <UserDetail params={params} />
      </Suspense>
    </>
  );
}

async function UserDetail({ params }: { params: Params }) {
  const { id } = await params;
  if (!isUuid(id)) return <NoSuchUser />;

  const supabase = await createClient();
  const [{ data, error }, planList] = await Promise.all([
    supabase.rpc("admin_user_detail", { p_user_id: id }),
    loadPlans(supabase),
  ]);
  forbidIfNotAuthorized(error);
  if (error?.code === "P0002") return <NoSuchUser />;
  if (error) throw new Error(`Couldn't load the user: ${error.message}`);
  const user = data as AdminUserDetail;
  const plans = planNames(planList);

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <Header user={user} plans={plans} />
      <div className="grid gap-5 md:grid-cols-[1fr_2fr]">
        <PlanCard user={user} plans={plans} planList={planList} />
        <UsageCard user={user} />
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <AiPhotosCard user={user} />
        <HouseholdsCard user={user} />
      </div>
      <HistoryCard user={user} plans={plans} />
    </div>
  );
}

function NoSuchUser() {
  return (
    <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
      <h1 className="text-[28px] leading-tight text-ink">No such user</h1>
      <p className="mt-1 text-[15px] text-ink-secondary">They may have deleted their account.</p>
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

function Header({ user, plans }: { user: AdminUserDetail; plans: PlanNames }) {
  const flagged = aiFlagsLine(user.ai_flags) !== "None";
  return (
    <header className="flex items-center gap-4">
      <Avatar displayName={user.display_name} email={user.email} size="lg" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[34px] leading-tight text-ink">{user.display_name ?? user.email ?? "No name"}</h1>
          <PlanBadge name={planName(user.plan.id, plans.names)} assigned={user.plan.assigned} />
          {user.ai_photo_block && <AiPhotosBlockedBadge />}
          {user.first_month.doubled && user.first_month.ends_at && (
            <span className="rounded-full bg-pending-soft px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap text-pending">
              First month · 2× limits until {mediumDate(user.first_month.ends_at)}
            </span>
          )}
        </div>
        <p className="mt-1 text-[15px] text-ink-secondary">
          {user.display_name && user.email ? `${user.email} · ` : ""}
          Joined <RelativeDate iso={user.created_at} /> · Last sign-in <RelativeDate iso={user.last_sign_in_at} />
        </p>
        <p className="mt-0.5 font-mono text-[12px] text-ink-tertiary select-all">{user.user_id}</p>
        <p className="mt-1 text-[15px] text-ink-secondary">
          AI flags:{" "}
          <Link
            href={aiCallsHref({ kind: "flagged", user: user.user_id })}
            className={cn("font-semibold hover:underline", flagged ? "text-danger" : "text-primary")}
          >
            {aiFlagsLine(user.ai_flags)}
          </Link>
        </p>
      </div>
    </header>
  );
}

function PlanCard({ user, plans, planList }: { user: AdminUserDetail; plans: PlanNames; planList: AdminPlanList }) {
  return (
    <Card title="Plan">
      <p className="text-[22px] font-bold text-ink">{user.plan.name ?? planName(user.plan.id, plans.names)}</p>
      <p className="mt-1 text-[15px] text-ink-secondary">
        {user.plan.assigned ? (
          user.plan.assigned_at ? (
            <>
              Assigned <RelativeDate iso={user.plan.assigned_at} />
            </>
          ) : (
            "Assigned"
          )
        ) : user.plan.id === null ? (
          "No plan is the default, so no features"
        ) : (
          "The default plan (none of their own)"
        )}
      </p>
      <ChangePlan
        userId={user.user_id}
        email={user.email}
        plans={planList}
        currentPlanId={user.plan.assigned ? user.plan.id : null}
      />
    </Card>
  );
}

function UsageCard({ user }: { user: AdminUserDetail }) {
  return (
    <Card title="This month">
      <ul className="flex flex-col gap-3">
        {user.usage.map((usage) => {
          const row = usageRow(usage, user.first_month.doubled);
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

// AI photos (spec 4.12, 6.11): blocked after too many refused prompts, with the refusals and
// Unblock; otherwise how close they are.
function AiPhotosCard({ user }: { user: AdminUserDetail }) {
  const block = user.ai_photo_block;
  const refusals = refusalsLine(user.ai_photo_refusals_30d);
  const linkClass = "font-semibold text-primary hover:underline";
  return (
    <Card title="AI photos">
      {block ? (
        <>
          <p className="text-[15px] font-semibold text-danger">{blockedLine(block)}</p>
          <p className="mt-1 text-[15px]">
            <Link href={refusalsHref(user.user_id)} className={linkClass}>
              See the refused prompts
            </Link>
          </p>
          <UnblockAiPhotos userId={user.user_id} email={user.email} />
        </>
      ) : (
        <>
          <p className="text-[15px] font-semibold text-ink">Not blocked</p>
          {refusals !== null && (
            <p className="mt-1 text-[15px]">
              <Link href={refusalsHref(user.user_id)} className={linkClass}>
                {refusals}
              </Link>
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function HouseholdsCard({ user }: { user: AdminUserDetail }) {
  return (
    <Card title="Households">
      {user.households.length === 0 ? (
        <p className="text-[15px] text-ink-secondary">In no household.</p>
      ) : (
        <ul className="divide-y divide-border">
          {user.households.map((household) => (
            <li key={household.id} className="flex items-center justify-between gap-3 py-2 text-[15px]">
              <span className="font-semibold text-ink">{household.name}</span>
              <span className="text-ink-secondary">
                {household.role === "owner" ? "Owner" : "Member"} · {household.member_count}{" "}
                {household.member_count === 1 ? "member" : "members"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HistoryCard({ user, plans }: { user: AdminUserDetail; plans: PlanNames }) {
  return (
    <Card title="Plan history">
      {user.plan_history.length === 0 ? (
        <p className="text-[15px] text-ink-secondary">Their plan hasn&apos;t been changed.</p>
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
            {user.plan_history.map((entry) => (
              <tr key={entry.id} className="border-b border-border align-top text-ink last:border-0">
                <td className="py-2 pr-4">{historyPlan(entry.details.from, plans.names, plans.defaultName)}</td>
                <td className="px-4 py-2">{historyPlan(entry.details.to, plans.names, plans.defaultName)}</td>
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
