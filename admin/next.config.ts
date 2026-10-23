import type { NextConfig } from "next";

import { targetSupabaseEnv } from "./lib/supabase/env";

const nextConfig: NextConfig = {
  /* config options here */
  // SUPABASE_TARGET=local|hosted in .env.local (or the shell) picks the Supabase project (lib/supabase/env.ts).
  env: targetSupabaseEnv(process.env),
  cacheComponents: true,
  partialPrefetching: true,
  // forbidden() and app/forbidden.tsx, for an admin call that answers 42501 (lib/supabase/session.ts).
  experimental: {
    authInterrupts: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
