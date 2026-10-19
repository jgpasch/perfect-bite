"use server";

import { refresh } from "next/cache";

import { serverMessage } from "@/lib/plans";
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

// The Plans page's edits (spec 4.12). Each sends its note, re-renders the grid on success and
// otherwise returns the server's message as a sentence ("Recipe import needs categorize.").
async function planEdit(fn: string, args: Record<string, unknown>): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  forbidIfNotAuthorized(error);
  if (error) return { ok: false, message: serverMessage(error.message) };
  refresh();
  return { ok: true };
}

export async function setPlanFeature(
  planId: string,
  feature: string,
  enabled: boolean,
  monthlyLimit: number | null,
  note: string,
): Promise<ActionResult> {
  return planEdit("admin_set_plan_feature", {
    p_plan_id: planId,
    p_feature: feature,
    p_enabled: enabled,
    p_monthly_limit: monthlyLimit,
    p_note: note.trim(),
  });
}

export async function setPlanLimit(planId: string, feature: string, monthlyLimit: number | null, note: string): Promise<ActionResult> {
  return planEdit("admin_set_plan_limit", {
    p_plan_id: planId,
    p_feature: feature,
    p_monthly_limit: monthlyLimit,
    p_note: note.trim(),
  });
}

export async function createPlan(id: string, name: string, copyFrom: string | null, note: string): Promise<ActionResult> {
  return planEdit("admin_create_plan", { p_id: id.trim(), p_name: name.trim(), p_copy_from: copyFrom, p_note: note.trim() });
}

export async function renamePlan(id: string, name: string, note: string): Promise<ActionResult> {
  return planEdit("admin_rename_plan", { p_id: id, p_name: name.trim(), p_note: note.trim() });
}

export async function setDefaultPlan(id: string, note: string): Promise<ActionResult> {
  return planEdit("admin_set_default_plan", { p_id: id, p_note: note.trim() });
}

export async function deletePlan(id: string, note: string): Promise<ActionResult> {
  return planEdit("admin_delete_plan", { p_id: id, p_note: note.trim() });
}
