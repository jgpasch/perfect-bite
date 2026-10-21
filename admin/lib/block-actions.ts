"use server";

import { refresh } from "next/cache";

import type { ActionResult } from "@/lib/plan-actions";
import { serverMessage } from "@/lib/plans";
import { createClient } from "@/lib/supabase/server";
import { forbidIfNotAuthorized } from "@/lib/supabase/session";

// Unblock on a user's AI photos card (spec 4.12): admin_unblock_ai_photos with the note. On success
// the page re-renders as not blocked; otherwise the server's message comes back ("Not blocked.").
export async function unblockAiPhotos(userId: string, note: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_unblock_ai_photos", { p_user_id: userId, p_note: note.trim() });
  forbidIfNotAuthorized(error);
  if (error) return { ok: false, message: serverMessage(error.message) };
  refresh();
  return { ok: true };
}
