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

// SUPABASE_TARGET (local or hosted) picks which pair in .env.local becomes NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. next.config.ts calls this at startup. Unset, the plain
// NEXT_PUBLIC_* values are used as they are.
export const supabaseTargets = ["local", "hosted"] as const;
export type SupabaseTarget = (typeof supabaseTargets)[number];

export function targetSupabaseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const target = env.SUPABASE_TARGET?.trim().toLowerCase();
  if (!target) return {};
  if (!(supabaseTargets as readonly string[]).includes(target)) {
    throw new Error(`SUPABASE_TARGET must be ${supabaseTargets.join(" or ")}, not "${env.SUPABASE_TARGET}".`);
  }
  const urlName = `SUPABASE_${target.toUpperCase()}_URL`;
  const keyName = `SUPABASE_${target.toUpperCase()}_PUBLISHABLE_KEY`;
  const url = env[urlName]?.trim();
  const publishableKey = env[keyName]?.trim();
  const missing = [!url && urlName, !publishableKey && keyName].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`SUPABASE_TARGET is ${target} but ${missing.join(" and ")} isn't set in admin/.env.local.`);
  }
  return { NEXT_PUBLIC_SUPABASE_URL: url!, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey! };
}

// Local Supabase (127.0.0.1 or localhost) also gets the email-and-code sign-in, as the app's dev builds do:
// the code goes to the local mail viewer. Hosted is Google only.
export function isLocalSupabaseUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url.trim()).hostname;
  } catch {
    return false;
  }
  return hostname === "127.0.0.1" || hostname === "localhost";
}

// Next.js inlines NEXT_PUBLIC_* only where they're written out in full, so they're read here by name.
export function supabaseEnv(): SupabaseEnv {
  return readSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
