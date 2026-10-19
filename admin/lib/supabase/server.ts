import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { supabaseEnv } from "./env";

// For server components, server actions and route handlers. Make one per request.
export async function createClient() {
  // Cookies first: while prerendering, that's where rendering stops, before the env is needed.
  const cookieStore = await cookies();
  const { url, publishableKey } = supabaseEnv();
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // A server component can't set cookies. That's fine once proxy.ts refreshes the session.
        }
      },
    },
  });
}
