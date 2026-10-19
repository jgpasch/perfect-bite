"use client";

// Continue with Google, and against local Supabase the dev email-and-code form (spec 4.12). The code
// arrives in the local mail viewer, as for the app's dev builds.
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export function SignInForm({ withCode }: { withCode: boolean }) {
  const router = useRouter();
  const callbackFailed = useSearchParams().get("error") === "callback";
  const [error, setError] = useState<string | null>(callbackFailed ? "Couldn't sign in. Try again." : null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  async function continueWithGoogle() {
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    // On success the browser is already leaving for Google.
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  }

  async function sendCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setCodeSent(true);
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    router.replace("/users");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Button size="lg" className="h-11 text-[15px] font-semibold" disabled={busy} onClick={continueWithGoogle}>
        Continue with Google
      </Button>

      {withCode && (
        <>
          <div className="flex items-center gap-3 text-[13px] text-ink-tertiary">
            <span className="h-px flex-1 bg-border" />
            or, on local Supabase
            <span className="h-px flex-1 bg-border" />
          </div>
          {codeSent ? (
            <form onSubmit={verifyCode} className="flex flex-col gap-2">
              <label htmlFor="code" className="text-[13px] text-ink-secondary">
                The 6-digit code sent to {email.trim()}
              </label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="h-10 tabular-nums"
              />
              <Button type="submit" variant="outline" size="lg" className="h-10" disabled={busy}>
                Sign in
              </Button>
              <button
                type="button"
                className="self-start text-[13px] text-ink-secondary underline-offset-4 hover:underline"
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setError(null);
                }}
              >
                Use another email
              </button>
            </form>
          ) : (
            <form onSubmit={sendCode} className="flex flex-col gap-2">
              <label htmlFor="email" className="text-[13px] text-ink-secondary">
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-10"
              />
              <Button type="submit" variant="outline" size="lg" className="h-10" disabled={busy}>
                Send code
              </Button>
            </form>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
