"use client";

// The Users list's Blocked filter (spec 4.12): "AI photos blocked" puts `?blocked=1` in the URL
// (back to page 1, keeping the search); "All users" clears it.
import { useRouter } from "next/navigation";

import { AI_PHOTOS_BLOCKED } from "@/lib/ai-photo-block";
import { usersHref } from "@/lib/users";

export function BlockedFilter({ query, blocked }: { query: string; blocked: boolean }) {
  const router = useRouter();
  return (
    <select
      aria-label="Filter users"
      value={blocked ? "blocked" : ""}
      onChange={(event) => router.replace(usersHref(query, 1, event.target.value === "blocked"), { scroll: false })}
      className="h-10 rounded-lg border border-border bg-surface px-3 text-[15px] text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <option value="">All users</option>
      <option value="blocked">{AI_PHOTOS_BLOCKED}</option>
    </select>
  );
}
