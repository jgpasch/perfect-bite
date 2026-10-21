import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ActionFilter } from "@/components/action-filter";
import { PageHeader } from "@/components/page-header";
import { RelativeDate } from "@/components/user-bits";
import {
  ACTIVITY_PAGE_SIZE,
  actionHref,
  actionLabel,
  actionSummary,
  actionTarget,
  actionWho,
  activityHref,
} from "@/lib/activity";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminActionList } from "@/lib/types";
import { pageRange, parsePage, parseQuery } from "@/lib/users";

export const metadata: Metadata = { title: "Activity · Back office" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Activity (spec 4.12): the audit log from admin_list_actions, newest first, filtered by `?action=`,
// 50 a page (`?page=`).
export default function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader title="Activity" />
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading activity…</p>}>
        <ActivityResults searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function ActivityResults({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const action = parseQuery(params.action);
  const page = parsePage(params.page);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_actions", {
    p_action: action === "" ? null : action,
    p_limit: ACTIVITY_PAGE_SIZE,
    p_offset: (page - 1) * ACTIVITY_PAGE_SIZE,
  });
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't load activity: ${error.message}`);

  const { actions, total_count: total } = (data ?? { actions: [], total_count: 0 }) as AdminActionList;
  const lastPage = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));

  return (
    <>
      <div className="mb-4">
        <ActionFilter action={action} />
      </div>
      {actions.length === 0 ? (
        <EmptyState action={action} page={page} total={total} />
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl bg-surface shadow-sm">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-border text-[13px] font-semibold text-ink-secondary">
                <tr>
                  <th scope="col" className="py-3 pr-4 pl-5">When</th>
                  <th scope="col" className="px-4 py-3">Action</th>
                  <th scope="col" className="px-4 py-3">Target</th>
                  <th scope="col" className="px-4 py-3">Details</th>
                  <th scope="col" className="px-4 py-3">Note</th>
                  <th scope="col" className="py-3 pr-5 pl-4">Who</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((row) => {
                  const target = actionTarget(row);
                  const href = actionHref(row);
                  return (
                    <tr key={row.id} className="border-b border-border align-top text-ink last:border-0">
                      <td className="py-2.5 pr-4 pl-5 whitespace-nowrap text-ink-secondary">
                        <RelativeDate iso={row.created_at} />
                      </td>
                      <td className="px-4 py-2.5 font-semibold whitespace-nowrap">{actionLabel(row.action)}</td>
                      <td className="px-4 py-2.5">
                        {target.kind === "user" ? (
                          <Link href={target.href} className="text-primary hover:underline">{target.label}</Link>
                        ) : target.kind === "household" ? (
                          <Link href={target.href} className="font-mono text-[13px] text-primary hover:underline">
                            {target.label}
                          </Link>
                        ) : target.kind === "none" ? (
                          <span className="text-ink-tertiary">{target.label}</span>
                        ) : (
                          <span className="font-mono text-[13px] text-ink-secondary">{target.label}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {href === null ? (
                          actionSummary(row)
                        ) : (
                          <Link href={href} prefetch={false} className="text-primary hover:underline">{actionSummary(row)}</Link>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-secondary">
                        {row.note ?? <span className="text-ink-tertiary">—</span>}
                      </td>
                      <td className="py-2.5 pr-5 pl-4 text-ink-secondary">{actionWho(row)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager action={action} page={page} lastPage={lastPage} total={total} />
        </>
      )}
    </>
  );
}

function EmptyState({ action, page, total }: { action: string; page: number; total: number }) {
  let title: string;
  let body: React.ReactNode = null;
  if (total > 0 || page > 1) {
    title = "Nothing on this page";
    body = <Link href={activityHref(action, 1)} className="font-semibold text-primary hover:underline">Back to the first page</Link>;
  } else if (action !== "") {
    title = `No “${actionLabel(action)}” yet`;
    body = <Link href={activityHref("", 1)} className="font-semibold text-primary hover:underline">Show all actions</Link>;
  } else {
    title = "No activity yet";
    body = "Changes made in the portal, the dashboard and account deletions show up here.";
  }
  return (
    <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
      <p className="text-[17px] font-semibold text-ink">{title}</p>
      {body && <p className="mt-1 text-[15px] text-ink-secondary">{body}</p>}
    </div>
  );
}

function Pager({ action, page, lastPage, total }: { action: string; page: number; lastPage: number; total: number }) {
  const linkClass =
    "rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold text-ink transition-colors hover:bg-surface-muted";
  const disabledClass = "rounded-lg border border-border px-3 py-1.5 font-semibold text-ink-tertiary";
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-[14px] text-ink-secondary">
      <span>{pageRange(page, total, ACTIVITY_PAGE_SIZE)}</span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link href={activityHref(action, page - 1)} className={linkClass}>Previous</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Previous</span>
        )}
        {page < lastPage ? (
          <Link href={activityHref(action, page + 1)} className={linkClass}>Next</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Next</span>
        )}
      </span>
    </nav>
  );
}
