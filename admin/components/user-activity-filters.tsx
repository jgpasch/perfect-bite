"use client";

// A user's Activity filters (spec 4.12): area chips with counts (several at once; All clears them),
// an action select for the chosen areas, a household select and a date range, each into the user
// page's search params so a filtered view can be linked.
import { useRouter } from "next/navigation";

import {
  ACTIVITY_AREAS,
  AREA_KEYS,
  areaCounts,
  toggleArea,
  userActionOptions,
  userActivityHref,
  type UserActivityParams,
} from "@/lib/user-activity";
import { cn } from "@/lib/utils";

const fieldClass =
  "h-10 rounded-lg border border-border bg-surface px-3 text-[15px] text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

function Chip({ label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] font-semibold transition-colors",
        on ? "bg-primary text-on-primary" : "bg-surface-muted text-ink-secondary hover:text-ink",
      )}
    >
      {label}
      <span className={cn("tabular-nums", on ? "opacity-80" : "text-ink-tertiary")}>{count.toLocaleString("en-US")}</span>
    </button>
  );
}

export function UserActivityFilters({
  userId,
  params,
  counts,
  households,
}: {
  userId: string;
  params: UserActivityParams;
  counts: Record<string, number>;
  households: { id: string; name: string }[];
}) {
  const router = useRouter();
  const go = (next: UserActivityParams) => router.replace(userActivityHref(userId, next), { scroll: false });
  const { all, byArea } = areaCounts(counts);
  const householdOptions =
    params.household !== "" && !households.some((household) => household.id === params.household)
      ? [...households, { id: params.household, name: params.household }]
      : households;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Areas">
        <Chip label="All" count={all} on={params.areas.length === 0} onClick={() => go({ ...params, areas: [] })} />
        {AREA_KEYS.map((area) => (
          <Chip
            key={area}
            label={ACTIVITY_AREAS[area]}
            count={byArea[area]}
            on={params.areas.includes(area)}
            onClick={() => go(toggleArea(params, area))}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by action"
          value={params.action}
          onChange={(event) => go({ ...params, action: event.target.value })}
          className={fieldClass}
        >
          <option value="">All actions</option>
          {userActionOptions(params.areas, params.action).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          aria-label="Filter by household"
          value={params.household}
          onChange={(event) => go({ ...params, household: event.target.value })}
          className={fieldClass}
        >
          <option value="">All households</option>
          {householdOptions.map((household) => (
            <option key={household.id} value={household.id}>{household.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[14px] text-ink-secondary">
          From
          <input
            type="date"
            value={params.from}
            max={params.to || undefined}
            onChange={(event) => go({ ...params, from: event.target.value })}
            className={fieldClass}
          />
        </label>
        <label className="flex items-center gap-1.5 text-[14px] text-ink-secondary">
          To
          <input
            type="date"
            value={params.to}
            min={params.from || undefined}
            onChange={(event) => go({ ...params, to: event.target.value })}
            className={fieldClass}
          />
        </label>
      </div>
    </div>
  );
}
