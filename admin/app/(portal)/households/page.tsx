import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { HouseholdSearch } from "@/components/household-search";
import { PageHeader } from "@/components/page-header";
import { PlanBadge, RelativeDate } from "@/components/user-bits";
import { HOUSEHOLDS_PAGE_SIZE, householdHref, householdsHref, membersCount } from "@/lib/households";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminHouseholdRow } from "@/lib/types";
import { pageRange, parsePage, parseQuery } from "@/lib/users";

export const metadata: Metadata = { title: "Households · Back office" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Households (spec 4.12), from admin_list_households: search by name, a member's email or name, or
// the household id (`?q=`), 50 a page (`?page=`), newest first; each row with its members and plan.
export default function HouseholdsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader title="Households" />
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading households…</p>}>
        <HouseholdsResults searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function HouseholdsResults({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = parseQuery(params.q);
  const page = parsePage(params.page);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_households", {
    p_search: query === "" ? null : query,
    p_limit: HOUSEHOLDS_PAGE_SIZE,
    p_offset: (page - 1) * HOUSEHOLDS_PAGE_SIZE,
  });
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't load households: ${error.message}`);

  const rows = (data ?? []) as AdminHouseholdRow[];
  const total = rows[0]?.total_count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / HOUSEHOLDS_PAGE_SIZE));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <HouseholdSearch query={query} />
      </div>
      {rows.length === 0 ? (
        <EmptyState query={query} page={page} total={total} />
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl bg-surface shadow-sm">
            <table className="w-full text-left text-[15px]">
              <thead className="border-b border-border text-[13px] font-semibold text-ink-secondary">
                <tr>
                  <th scope="col" className="py-3 pr-4 pl-5">Name</th>
                  <th scope="col" className="px-4 py-3">Members</th>
                  <th scope="col" className="px-4 py-3">Plan</th>
                  <th scope="col" className="py-3 pr-5 pl-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((household) => (
                  <tr
                    key={household.household_id}
                    className="relative border-b border-border text-ink last:border-0 hover:bg-background"
                  >
                    <td className="py-2.5 pr-4 pl-5">
                      {/* The link covers the row, so the whole row opens the household. */}
                      <Link
                        href={householdHref(household.household_id)}
                        className="font-semibold after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                      >
                        {household.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">{membersCount(household.member_count)}</td>
                    <td className="px-4 py-2.5">
                      <PlanBadge name={household.plan_name ?? household.plan_id} />
                    </td>
                    <td className="py-2.5 pr-5 pl-4 text-ink-secondary">
                      <RelativeDate iso={household.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager query={query} page={page} lastPage={lastPage} total={total} />
        </>
      )}
    </>
  );
}

function EmptyState({ query, page, total }: { query: string; page: number; total: number }) {
  let title: string;
  let body: React.ReactNode;
  if (total > 0 || page > 1) {
    title = "Nothing on this page";
    body = <Link href={householdsHref(query, 1)} className="font-semibold text-primary hover:underline">Back to the first page</Link>;
  } else if (query !== "") {
    title = `No households match “${query}”`;
    body = "Search by name, a member's email or name, or paste a household id.";
  } else {
    title = "No households yet";
    body = "Each person who signs in to the app gets one.";
  }
  return (
    <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
      <p className="text-[17px] font-semibold text-ink">{title}</p>
      <p className="mt-1 text-[15px] text-ink-secondary">{body}</p>
    </div>
  );
}

function Pager({ query, page, lastPage, total }: { query: string; page: number; lastPage: number; total: number }) {
  const linkClass =
    "rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold text-ink transition-colors hover:bg-surface-muted";
  const disabledClass = "rounded-lg border border-border px-3 py-1.5 font-semibold text-ink-tertiary";
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-[14px] text-ink-secondary">
      <span>{pageRange(page, total, HOUSEHOLDS_PAGE_SIZE)}</span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link href={householdsHref(query, page - 1)} className={linkClass}>Previous</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Previous</span>
        )}
        {page < lastPage ? (
          <Link href={householdsHref(query, page + 1)} className={linkClass}>Next</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Next</span>
        )}
      </span>
    </nav>
  );
}
