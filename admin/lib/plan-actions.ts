"use server";

import { refresh } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Change plan (spec 4.12): admin_set_user_plan, a plan id or null for the default. On success the
// page re-renders with the new plan and its history row; the server's message comes back otherwise.
export async function setUserPlan(userId: string, planId: string | null, note: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_user_plan", {
    p_user_id: userId,
    p_plan_id: planId,
    p_note: note.trim(),
  });
  forbidIfNotAuthorized(error);
  if (error) return { ok: false, message: error.message };
  refresh();
  return { ok: true };
}
