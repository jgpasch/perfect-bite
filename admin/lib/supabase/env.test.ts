import { describe, expect, it } from "vitest";

import { isLocalSupabaseUrl, readSupabaseEnv } from "./env";

describe("isLocalSupabaseUrl", () => {
  it("is true for 127.0.0.1 and localhost, on any port or scheme", () => {
    expect(isLocalSupabaseUrl("http://127.0.0.1:55321")).toBe(true);
    expect(isLocalSupabaseUrl("http://localhost:55321")).toBe(true);
    expect(isLocalSupabaseUrl("https://localhost")).toBe(true);
    expect(isLocalSupabaseUrl(" http://127.0.0.1:55321/ ")).toBe(true);
  });

  it("is false for hosted Supabase", () => {
    expect(isLocalSupabaseUrl("https://abcdefghijklmnop.supabase.co")).toBe(false);
  });

  it("looks at the host, not the text", () => {
    expect(isLocalSupabaseUrl("https://localhost.example.com")).toBe(false);
    expect(isLocalSupabaseUrl("https://127.0.0.1.nip.io")).toBe(false);
    expect(isLocalSupabaseUrl("https://example.com/localhost")).toBe(false);
    expect(isLocalSupabaseUrl("http://127.0.0.2:55321")).toBe(false);
  });

  it("is false for something that isn't a URL", () => {
    expect(isLocalSupabaseUrl("")).toBe(false);
    expect(isLocalSupabaseUrl("localhost")).toBe(false);
  });
});

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
