"use client";

// Activity's filter: picking an action puts it in `?action=` (back to page 1); "All actions" clears it.
import { useRouter } from "next/navigation";

import { activityHref, actionOptions } from "@/lib/activity";

export function ActionFilter({ action }: { action: string }) {
  const router = useRouter();
  return (
    <select
      aria-label="Filter by action"
      value={action}
      onChange={(event) => router.replace(activityHref(event.target.value, 1), { scroll: false })}
      className="h-10 rounded-lg border border-border bg-surface px-3 text-[15px] text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <option value="">All actions</option>
      {actionOptions(action).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
