"use client";

// AI calls' filters: task, status and (Flagged only) flag, each into its own `?` param, back to
// page 1. AI photos have none of them. A user filter, set from a user's page, shows as a chip
// that clears it.
import { X } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  aiCallsHref,
  filterOptions,
  FLAG_LABELS,
  STATUS_LABELS,
  TASK_LABELS,
  type AiCallsParams,
} from "@/lib/ai-calls";

const selectClass =
  "h-10 rounded-lg border border-border bg-surface px-3 text-[15px] text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export function AiCallFilters({ params, userLabel }: { params: AiCallsParams; userLabel: string | null }) {
  const router = useRouter();
  const go = (change: Partial<AiCallsParams>) =>
    router.replace(aiCallsHref({ ...params, ...change, page: 1 }), { scroll: false });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {params.kind !== "photos" && (
        <>
          <select
            aria-label="Filter by task"
            value={params.task}
            onChange={(event) => go({ task: event.target.value })}
            className={selectClass}
          >
            <option value="">All tasks</option>
            {filterOptions(TASK_LABELS, params.task).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={params.status}
            onChange={(event) => go({ status: event.target.value })}
            className={selectClass}
          >
            <option value="">All statuses</option>
            {filterOptions(STATUS_LABELS, params.status, params.kind === "failed" ? ["ok"] : []).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </>
      )}
      {params.kind === "flagged" && (
        <select
          aria-label="Filter by flag"
          value={params.flag}
          onChange={(event) => go({ flag: event.target.value })}
          className={selectClass}
        >
          <option value="">All flags</option>
          {filterOptions(FLAG_LABELS, params.flag).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )}
      {params.user !== "" && (
        <button
          type="button"
          onClick={() => go({ user: "" })}
          aria-label={`Stop filtering by ${userLabel ?? "this user"}`}
          className="inline-flex h-10 items-center gap-1.5 rounded-full bg-primary-soft px-3 text-[14px] font-semibold text-on-primary-soft transition-colors hover:bg-surface-muted"
        >
          User: {userLabel ?? params.user}
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
