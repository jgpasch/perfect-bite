// Small pieces of the AI calls pages: a call's status or flag badge, who made it, and the stand-in
// for a photo whose object is gone.
import { ImageOff } from "lucide-react";
import Link from "next/link";

import { callBadge, type CallUser } from "@/lib/ai-calls";
import type { AdminAiCallRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export function CallBadge({ call }: { call: Pick<AdminAiCallRow, "status" | "flag"> }) {
  const badge = callBadge(call);
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap",
        badge.tone === "danger" ? "bg-danger-soft text-danger" : "bg-primary-soft text-on-primary-soft",
      )}
    >
      {badge.label}
    </span>
  );
}

/** The email linking to the user (above a row-covering link), or "Deleted user" / "Dev script". */
export function CallUserLink({ user }: { user: CallUser }) {
  if (user.kind !== "user") return <span className="text-ink-tertiary">{user.label}</span>;
  return (
    <Link href={user.href} className="relative z-10 font-semibold text-primary hover:underline">
      {user.label}
    </Link>
  );
}

export function PhotoMissing({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 bg-surface-muted text-ink-secondary", className)}>
      <ImageOff size={24} aria-hidden="true" />
      <span className="text-[14px]">Photo deleted</span>
    </div>
  );
}
