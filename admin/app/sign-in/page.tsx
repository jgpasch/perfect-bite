import type { Metadata } from "next";
import { Suspense } from "react";

import { Mark } from "@/components/mark";
import { SignInForm } from "@/components/sign-in-form";
import { isLocalSupabaseUrl } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Sign in · Back office" };

// Google, plus the email-and-code form against local Supabase (spec 4.12).
export default function SignInPage() {
  // Read by name so it's inlined at build; a missing URL is reported when the form calls Supabase.
  const withCode = isLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <Mark />
          <span className="font-heading text-[17px] leading-tight font-extrabold tracking-[-0.025em] text-ink">
            The Perfect Bite
          </span>
          <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-on-primary-soft">
            Back office
          </span>
        </div>
        <h1 className="mb-6 text-[28px] leading-tight text-ink">Sign in</h1>
        <Suspense>
          <SignInForm withCode={withCode} />
        </Suspense>
      </div>
    </main>
  );
}
