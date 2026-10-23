"use server";

import { refresh } from "next/cache";

import { serverMessage } from "@/lib/plans";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";
import type { AdminRevokeDeviceCredentialsResult } from "@/lib/types";

export type RevokeResult = { ok: true; revoked: number } | { ok: false; message: string };

// Revoke device credentials on a user's page (spec 4.12): admin_revoke_device_credentials with the
// note. On success how many it revoked comes back (0 with none) and the page reloads its activity;
// otherwise the server's message ("Note required.").
export async function revokeDeviceCredentials(userId: string, note: string): Promise<RevokeResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_revoke_device_credentials", { p_user_id: userId, p_note: note.trim() });
  forbidIfNotAuthorized(error);
  if (error) return { ok: false, message: serverMessage(error.message) };
  refresh();
  return { ok: true, revoked: (data as AdminRevokeDeviceCredentialsResult).revoked };
}
