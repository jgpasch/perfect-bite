// Small pieces of the Users pages: the avatar initial, the plan badge and a relative date.
import { fullDate, relativeTime } from "@/lib/format";
import { avatarInitial, planBadge } from "@/lib/users";
import { cn } from "@/lib/utils";

export function Avatar({
  displayName,
  email,
  size = "sm",
}: {
  displayName: string | null;
  email: string | null;
  size?: "sm" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-primary-soft font-bold text-on-primary-soft",
        size === "sm" ? "size-8 text-[14px]" : "size-14 text-[24px]",
      )}
    >
      {avatarInitial(displayName, email)}
    </span>
  );
}

export function PlanBadge({ name, assigned }: { name: string; assigned: boolean }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap",
        assigned ? "bg-primary-soft text-on-primary-soft" : "bg-surface-muted text-ink-secondary",
      )}
    >
      {planBadge(name, assigned)}
    </span>
  );
}

/** "3 days ago", with the full date on hover; `empty` when there's no date. */
export function RelativeDate({ iso, empty = "Never" }: { iso: string | null; empty?: string }) {
  if (iso === null) return <span className="text-ink-tertiary">{empty}</span>;
  return (
    <time dateTime={iso} title={fullDate(iso)}>
      {relativeTime(iso)}
    </time>
  );
}
