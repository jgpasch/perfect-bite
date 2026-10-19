import { describe, expect, it } from "vitest";

import { readSupabaseEnv } from "./env";

describe("readSupabaseEnv", () => {
  it("returns the URL and key, trimmed", () => {
    expect(
      readSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: " http://127.0.0.1:55321 ",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc\n",
      }),
    ).toEqual({ url: "http://127.0.0.1:55321", publishableKey: "sb_publishable_abc" });
  });

  it("names the missing URL", () => {
    expect(() => readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" })).toThrow(
      "Missing NEXT_PUBLIC_SUPABASE_URL. Copy admin/.env.example to admin/.env.local.",
    );
  });

  it("names a blank key", () => {
    expect(() =>
      readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:55321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "  " }),
    ).toThrow("Missing NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  });

  it("names both when neither is set", () => {
    expect(() => readSupabaseEnv({})).toThrow(
      "Missing NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  });
});
