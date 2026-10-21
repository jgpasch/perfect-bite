import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { UnblockAiPhotos } from "@/components/unblock-ai-photos";
import { AiPhotosBlockedBadge, Avatar, PlanBadge, RelativeDate } from "@/components/user-bits";
import { blockedLine, refusalsHref, refusalsLine } from "@/lib/ai-photo-block";
import { aiCallsHref, aiFlagsLine } from "@/lib/ai-calls";
import { householdHref, membersCount, roleLabel } from "@/lib/households";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminUserDetail } from "@/lib/types";
import { isUuid } from "@/lib/users";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "User · Back office" };

type Params = Promise<{ id: string }>;

// One user (spec 4.12), from admin_user_detail: who they are, whether their AI photos are blocked,
// and their households, each with its plan and linking to its page, where the plan is changed. A
// user has no plan of their own.
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
  const { data, error } = await supabase.rpc("admin_user_detail", { p_user_id: id });
  forbidIfNotAuthorized(error);
  if (error?.code === "P0002") return <NoSuchUser />;
  if (error) throw new Error(`Couldn't load the user: ${error.message}`);
  const user = data as AdminUserDetail;

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <Header user={user} />
      <div className="grid gap-5 md:grid-cols-2">
        <HouseholdsCard user={user} />
        <AiPhotosCard user={user} />
      </div>
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

function Header({ user }: { user: AdminUserDetail }) {
  const flagged = aiFlagsLine(user.ai_flags) !== "None";
  return (
    <header className="flex items-center gap-4">
      <Avatar displayName={user.display_name} email={user.email} size="lg" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[34px] leading-tight text-ink">{user.display_name ?? user.email ?? "No name"}</h1>
          {user.ai_photo_block && <AiPhotosBlockedBadge />}
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

// Their households in their order, each with its plan; the plan is changed on the household's page.
function HouseholdsCard({ user }: { user: AdminUserDetail }) {
  return (
    <Card title="Households">
      {user.households.length === 0 ? (
        <p className="text-[15px] text-ink-secondary">In no household.</p>
      ) : (
        <ul className="divide-y divide-border">
          {user.households.map((household) => (
            <li key={household.id} className="flex items-center justify-between gap-3 py-2 text-[15px]">
              <span className="min-w-0">
                <Link href={householdHref(household.id)} className="font-semibold text-ink hover:underline">
                  {household.name}
                </Link>
                <span className="block text-[13px] text-ink-secondary">
                  {roleLabel(household.role)} · {membersCount(household.member_count)}
                </span>
              </span>
              <PlanBadge name={household.plan_name ?? household.plan_id} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
