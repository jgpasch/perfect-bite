"use server";

import { serverMessage } from "@/lib/plans";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminUserActivity } from "@/lib/types";
import { parseUserActivityParams, userActivityArgs } from "@/lib/user-activity";
import { isUuid } from "@/lib/users";

export type OlderActivityResult =
  | { ok: true; entries: AdminUserActivity["entries"]; next_before: string | null }
  | { ok: false; message: string };

// Load older on a user's Activity card (spec 4.12): the page before `before` (the last page's
// `next_before`) with the card's filters, given as its search string. A later page isn't audited.
export async function loadOlderUserActivity(userId: string, search: string, before: string): Promise<OlderActivityResult> {
  if (!isUuid(userId) || Number.isNaN(new Date(before).getTime())) return { ok: false, message: "Couldn't load older activity." };
  const params = parseUserActivityParams(Object.fromEntries(new URLSearchParams(search)));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_user_activity", userActivityArgs(userId, params, before));
  forbidIfNotAuthorized(error);
  if (error) return { ok: false, message: serverMessage(error.message) };
  const page = data as AdminUserActivity;
  return { ok: true, entries: page.entries, next_before: page.next_before };
}
