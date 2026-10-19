import { createBrowserClient } from "@supabase/ssr";

import { supabaseEnv } from "./env";

// For client components. The session lives in cookies, so the server client sees the same one.
export function createClient() {
  const { url, publishableKey } = supabaseEnv();
  return createBrowserClient(url, publishableKey);
}
