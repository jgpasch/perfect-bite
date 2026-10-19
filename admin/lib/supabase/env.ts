// The portal's only settings: the project URL and its publishable key, the same pair the app uses.
// Never a secret or service-role key: every admin action is checked by the database (spec 4.12).

export type SupabaseEnv = { url: string; publishableKey: string };

export function readSupabaseEnv(env: {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
}): SupabaseEnv {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const missing = [
    !url && "NEXT_PUBLIC_SUPABASE_URL",
    !publishableKey && "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(" and ")}. Copy admin/.env.example to admin/.env.local.`);
  }
  return { url: url!, publishableKey: publishableKey! };
}

// Next.js inlines NEXT_PUBLIC_* only where they're written out in full, so they're read here by name.
export function supabaseEnv(): SupabaseEnv {
  return readSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
