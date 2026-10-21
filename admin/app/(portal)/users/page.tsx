import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { BlockedFilter } from "@/components/blocked-filter";
import { PageHeader } from "@/components/page-header";
import { AiPhotosBlockedBadge, Avatar, PlanBadge, RelativeDate } from "@/components/user-bits";
import { UserSearch } from "@/components/user-search";
import { createClient } from "@/lib/supabase/server";
import { loadPlanNames } from "@/lib/supabase/plans";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminUserRow } from "@/lib/types";
import { pageRange, parseBlocked, parsePage, parseQuery, planName, USERS_PAGE_SIZE, usersHref } from "@/lib/users";

export const metadata: Metadata = { title: "Users · Back office" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Users (spec 4.12): search by email, name or id (`?q=`), only blocked users (`?blocked=1`), 50 a
// page (`?page=`), newest first.
export default function UsersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader title="Users" />
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading users…</p>}>
        <UsersResults searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function UsersResults({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = parseQuery(params.q);
  const page = parsePage(params.page);
  const blocked = parseBlocked(params.blocked);

  const supabase = await createClient();
  const [{ data, error }, plans] = await Promise.all([
    supabase.rpc("admin_list_users", {
      p_search: query === "" ? null : query,
      p_limit: USERS_PAGE_SIZE,
      p_offset: (page - 1) * USERS_PAGE_SIZE,
      p_blocked: blocked ? true : null,
    }),
    loadPlanNames(supabase),
  ]);
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't load users: ${error.message}`);

  const rows = (data ?? []) as AdminUserRow[];
  const total = rows[0]?.total_count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <UserSearch query={query} blocked={blocked} />
        <BlockedFilter query={query} blocked={blocked} />
      </div>
      {rows.length === 0 ? (
        <EmptyState query={query} page={page} total={total} blocked={blocked} />
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl bg-surface shadow-sm">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-border text-[13px] font-semibold text-ink-secondary">
                <tr>
                  <th scope="col" className="py-3 pr-4 pl-5">Name</th>
                  <th scope="col" className="px-4 py-3">Email</th>
                  <th scope="col" className="px-4 py-3">Plan</th>
                  <th scope="col" className="px-4 py-3">Joined</th>
                  <th scope="col" className="py-3 pr-5 pl-4">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => (
                  <tr
                    key={user.user_id}
                    className="relative border-b border-border text-ink last:border-0 hover:bg-background"
                  >
                    <td className="py-2.5 pr-4 pl-5">
                      <span className="flex items-center gap-3">
                        <Avatar displayName={user.display_name} email={user.email} />
                        {/* The link covers the row, so the whole row opens the user. */}
                        <Link
                          href={`/users/${user.user_id}`}
                          className="font-semibold after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                        >
                          {user.display_name ?? <span className="text-ink-tertiary">No name</span>}
                        </Link>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">{user.email ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <PlanBadge name={planName(user.plan_id, plans.names)} assigned={user.plan_assigned} />
                        {user.ai_photos_blocked && <AiPhotosBlockedBadge />}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">
                      <RelativeDate iso={user.created_at} />
                    </td>
                    <td className="py-2.5 pr-5 pl-4 text-ink-secondary">
                      <RelativeDate iso={user.last_sign_in_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager query={query} page={page} lastPage={lastPage} total={total} blocked={blocked} />
        </>
      )}
    </>
  );
}

function EmptyState({ query, page, total, blocked }: { query: string; page: number; total: number; blocked: boolean }) {
  let title: string;
  let body: React.ReactNode = null;
  if (total > 0 || page > 1) {
    title = "Nothing on this page";
    body = <Link href={usersHref(query, 1, blocked)} className="font-semibold text-primary hover:underline">Back to the first page</Link>;
  } else if (blocked) {
    title = query === "" ? "No one's AI photos are blocked" : `No blocked users match “${query}”`;
    body = <Link href={usersHref(query, 1)} className="font-semibold text-primary hover:underline">Show all users</Link>;
  } else if (query !== "") {
    title = `No users match “${query}”`;
    body = "Search by email, name, or paste a user id.";
  } else {
    title = "No users yet";
    body = "People show up here once they sign in to the app.";
  }
  return (
    <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
      <p className="text-[17px] font-semibold text-ink">{title}</p>
      {body && <p className="mt-1 text-[15px] text-ink-secondary">{body}</p>}
    </div>
  );
}

function Pager({
  query,
  page,
  lastPage,
  total,
  blocked,
}: {
  query: string;
  page: number;
  lastPage: number;
  total: number;
  blocked: boolean;
}) {
  const linkClass =
    "rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold text-ink transition-colors hover:bg-surface-muted";
  const disabledClass = "rounded-lg border border-border px-3 py-1.5 font-semibold text-ink-tertiary";
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-[14px] text-ink-secondary">
      <span>{pageRange(page, total)}</span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link href={usersHref(query, page - 1, blocked)} className={linkClass}>Previous</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Previous</span>
        )}
        {page < lastPage ? (
          <Link href={usersHref(query, page + 1, blocked)} className={linkClass}>Next</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Next</span>
        )}
      </span>
    </nav>
  );
}
