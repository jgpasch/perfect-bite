"use server";

import { refresh } from "next/cache";

import { createClient } from "@/lib/supabase/server";

// Opening the Flagged tab clears the sidebar's badge (spec 4.12): admin_mark_ai_flags_seen, then a
// re-render only when the badge had something to clear. The badge is a nicety, so errors are ignored.
export async function markAiFlagsSeen(): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("admin_mark_ai_flags_seen");
  if (data === true) refresh();
}
