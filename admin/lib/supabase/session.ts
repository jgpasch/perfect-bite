import { forbidden } from "next/navigation";
import { cache } from "react";

import { isNotAuthorized } from "@/lib/auth";

import { createClient } from "./server";

// The signed-in user's email from the verified session token, or null signed out. Once per request.
export const sessionEmail = cache(async (): Promise<string | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = data?.claims.email;
  return typeof email === "string" && email !== "" ? email : null;
});

// For the result of any admin_* call in a server component or action: a 42501 (no longer an admin)
// shows Not authorized in place of the page (app/forbidden.tsx); other errors are left to the caller.
export function forbidIfNotAuthorized(error: { code?: string | null } | null | undefined) {
  if (isNotAuthorized(error)) forbidden();
}
