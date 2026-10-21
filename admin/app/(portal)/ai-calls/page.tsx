import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AiCallFilters } from "@/components/ai-call-filters";
import { CallBadge, CallUserLink, PhotoMissing } from "@/components/ai-call-bits";
import { MarkAiFlagsSeen } from "@/components/mark-ai-flags-seen";
import { PageHeader } from "@/components/page-header";
import { AiPhotosBlockedBadge, RelativeDate } from "@/components/user-bits";
import { showsBlockedBadge } from "@/lib/ai-photo-block";
import {
  AI_CALL_KIND_KEYS,
  AI_CALL_KINDS,
  AI_CALLS_PAGE_SIZE,
  aiCallsHref,
  callUser,
  errorFirstLine,
  listArgs,
  parseAiCallsParams,
  PHOTO_URL_SECONDS,
  signedUrlsByPath,
  taskLabel,
  type AiCallsParams,
} from "@/lib/ai-calls";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminAiCallList, AdminAiCallRow } from "@/lib/types";
import { pageRange } from "@/lib/users";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "AI calls · Back office" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// AI calls (spec 4.12), from admin_list_ai_calls: flagged calls, failed calls and the AI photos
// made, newest first, in tabs (`?kind=`), with filters and paging in the URL. Each opens its call;
// opening one is audited, so those links don't prefetch. Viewing Flagged clears the sidebar's badge.
export default function AiCallsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader title="AI calls" />
      <p className="-mt-4 mb-6 text-[15px] text-ink-secondary">Calls are kept for 30 days, flagged ones for 180.</p>
      <Suspense fallback={<p className="text-[15px] text-ink-secondary">Loading AI calls…</p>}>
        <AiCallsResults searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function AiCallsResults({ searchParams }: { searchParams: SearchParams }) {
  const params = parseAiCallsParams(await searchParams);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_ai_calls", listArgs(params));
  forbidIfNotAuthorized(error);
  if (error) throw new Error(`Couldn't load AI calls: ${error.message}`);

  const { calls, total_count: total } = (data ?? { calls: [], total_count: 0 }) as AdminAiCallList;
  const lastPage = Math.max(1, Math.ceil(total / AI_CALLS_PAGE_SIZE));
  const userLabel = params.user === "" ? null : (calls.find((call) => call.user_id === params.user)?.user_email ?? null);

  return (
    <>
      {params.kind === "flagged" && <MarkAiFlagsSeen />}
      <Tabs params={params} />
      <div className="mb-4">
        <AiCallFilters params={params} userLabel={userLabel} />
      </div>
      {calls.length === 0 ? (
        <EmptyState params={params} total={total} />
      ) : (
        <>
          {params.kind === "photos" ? <PhotoGrid calls={calls} /> : <CallTable calls={calls} failed={params.kind === "failed"} />}
          <Pager params={params} lastPage={lastPage} total={total} />
        </>
      )}
    </>
  );
}

function Tabs({ params }: { params: AiCallsParams }) {
  return (
    <nav aria-label="Kinds of call" className="mb-4 flex gap-1 border-b border-border">
      {AI_CALL_KIND_KEYS.map((kind) => {
        const active = kind === params.kind;
        return (
          <Link
            key={kind}
            href={aiCallsHref({ kind, user: params.user })}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-[15px] font-semibold transition-colors",
              active ? "border-primary text-ink" : "border-transparent text-ink-secondary hover:text-ink",
            )}
          >
            {AI_CALL_KINDS[kind].label}
          </Link>
        );
      })}
    </nav>
  );
}

function CallTable({ calls, failed }: { calls: AdminAiCallRow[]; failed: boolean }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-surface shadow-sm">
      <table className="w-full text-left text-[15px]">
        <thead className="border-b border-border text-[13px] font-semibold text-ink-secondary">
          <tr>
            <th scope="col" className="py-3 pr-4 pl-5">When</th>
            <th scope="col" className="px-4 py-3">User</th>
            <th scope="col" className="px-4 py-3">Task</th>
            <th scope="col" className="px-4 py-3">Model</th>
            <th scope="col" className="px-4 py-3">{failed ? "Status" : "Flag"}</th>
            {failed && <th scope="col" className="px-4 py-3">Error</th>}
            {failed && <th scope="col" className="px-4 py-3 text-right">HTTP</th>}
            <th scope="col" className="py-3 pr-5 pl-4"><span className="sr-only">Recovered</span></th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => {
            const firstLine = errorFirstLine(call.error);
            return (
              <tr key={call.id} className="relative border-b border-border align-top text-ink last:border-0 hover:bg-background">
                <td className="py-2.5 pr-4 pl-5 whitespace-nowrap">
                  {/* The link covers the row, so the whole row opens the call. */}
                  <Link
                    href={`/ai-calls/${call.id}`}
                    prefetch={false}
                    aria-label={`Open the ${taskLabel(call.task)} call`}
                    className="text-ink-secondary after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                  >
                    <RelativeDate iso={call.created_at} />
                  </Link>
                </td>
                <td className="max-w-56 truncate px-4 py-2.5">
                  <CallUserLink user={callUser(call)} />
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">{taskLabel(call.task)}</td>
                <td className="px-4 py-2.5 font-mono text-[13px] text-ink-secondary">{call.model}</td>
                <td className="px-4 py-2.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <CallBadge call={call} />
                    {showsBlockedBadge(call) && <AiPhotosBlockedBadge />}
                  </span>
                </td>
                {failed && (
                  <td className="max-w-80 truncate px-4 py-2.5 text-ink-secondary" title={call.error ?? undefined}>
                    {firstLine || <span className="text-ink-tertiary">—</span>}
                  </td>
                )}
                {failed && (
                  <td className="px-4 py-2.5 text-right text-ink-secondary">
                    {call.http_status ?? <span className="text-ink-tertiary">—</span>}
                  </td>
                )}
                <td className="py-2.5 pr-5 pl-4 whitespace-nowrap">
                  {call.recovered && (
                    <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-[13px] font-semibold text-on-primary-soft">
                      Recovered
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

async function PhotoGrid({ calls }: { calls: AdminAiCallRow[] }) {
  const paths = calls.flatMap((call) => (call.photo_path ? [call.photo_path] : []));
  let urls = new Map<string, string | null>();
  if (paths.length > 0) {
    const supabase = await createClient();
    // One call for the page; a gone object comes back with an error and no URL.
    const { data } = await supabase.storage.from("recipe-photos").createSignedUrls(paths, PHOTO_URL_SECONDS);
    urls = signedUrlsByPath(paths, data);
  }

  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
      {calls.map((call) => {
        const url = call.photo_path ? (urls.get(call.photo_path) ?? null) : null;
        return (
          <li key={call.id} className="relative overflow-hidden rounded-2xl bg-surface shadow-sm hover:bg-background">
            {url ? (
              // Signed, short-lived URLs from storage: next/image would need the host configured and gains nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt="" className="aspect-square w-full object-cover" />
            ) : (
              <PhotoMissing className="aspect-square w-full" />
            )}
            <div className="flex flex-col gap-0.5 px-3 py-2.5 text-[14px]">
              <Link
                href={`/ai-calls/${call.id}`}
                prefetch={false}
                aria-label="Open this photo's call"
                className="text-ink-secondary after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                <RelativeDate iso={call.created_at} />
              </Link>
              <span className="truncate">
                <CallUserLink user={callUser(call)} />
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ params, total }: { params: AiCallsParams; total: number }) {
  const filtered = params.task !== "" || params.status !== "" || params.flag !== "" || params.user !== "";
  let title: string;
  let body: React.ReactNode = null;
  if (total > 0 || params.page > 1) {
    title = "Nothing on this page";
    body = (
      <Link href={aiCallsHref({ ...params, page: 1 })} className="font-semibold text-primary hover:underline">
        Back to the first page
      </Link>
    );
  } else if (filtered) {
    title = "No calls match these filters";
    body = (
      <Link href={aiCallsHref({ kind: params.kind })} className="font-semibold text-primary hover:underline">
        Clear the filters
      </Link>
    );
  } else {
    title = AI_CALL_KINDS[params.kind].empty;
  }
  return (
    <div className="rounded-2xl bg-surface px-6 py-12 text-center shadow-sm">
      <p className="text-[17px] font-semibold text-ink">{title}</p>
      {body && <p className="mt-1 text-[15px] text-ink-secondary">{body}</p>}
    </div>
  );
}

function Pager({ params, lastPage, total }: { params: AiCallsParams; lastPage: number; total: number }) {
  const { page } = params;
  const linkClass =
    "rounded-lg border border-border bg-surface px-3 py-1.5 font-semibold text-ink transition-colors hover:bg-surface-muted";
  const disabledClass = "rounded-lg border border-border px-3 py-1.5 font-semibold text-ink-tertiary";
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-[14px] text-ink-secondary">
      <span>{pageRange(page, total, AI_CALLS_PAGE_SIZE)}</span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link href={aiCallsHref({ ...params, page: page - 1 })} className={linkClass}>Previous</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Previous</span>
        )}
        {page < lastPage ? (
          <Link href={aiCallsHref({ ...params, page: page + 1 })} className={linkClass}>Next</Link>
        ) : (
          <span aria-disabled="true" className={disabledClass}>Next</span>
        )}
      </span>
    </nav>
  );
}
