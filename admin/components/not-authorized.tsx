// Signed in, but not in private.admins (spec 4.12): who they are and a way out, nothing else.
import { Mark } from "@/components/mark";
import { signOut } from "@/lib/auth-actions";

export function NotAuthorized({ email }: { email: string | null }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-sm">
        <Mark />
        <h1 className="mt-4 mb-2 text-[28px] leading-tight text-ink">Not authorized</h1>
        <p className="text-[15px] text-ink-secondary">This account isn&apos;t an admin.</p>
        {email && <p className="mt-4 text-[15px] font-semibold break-all text-ink">{email}</p>}
        <form action={signOut} className="mt-6">
          <button
            type="submit"
            className="h-10 rounded-lg border border-border px-4 text-[15px] font-semibold text-ink transition-colors hover:bg-surface-muted"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
