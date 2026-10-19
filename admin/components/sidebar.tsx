"use client";

// The portal's deep-green sidebar (spec 4.12, "Look"): the mark, "The Perfect Bite" with its
// "Back office" pill, and the sections.
import { Activity, LayoutGrid, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Mark } from "@/components/mark";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/users", label: "Users", icon: Users },
  { href: "/plans", label: "Plans", icon: LayoutGrid },
  { href: "/ai-usage", label: "AI usage", icon: Sparkles },
  { href: "/activity", label: "Activity", icon: Activity },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-sidebar-green text-on-sidebar">
      <div className="flex items-center gap-2.5 px-5 pt-6 pb-8">
        <Mark />
        <span className="font-heading text-[17px] leading-tight font-extrabold tracking-[-0.025em]">
          The Perfect Bite
        </span>
        <span className="rounded-full bg-sidebar-active px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-on-sidebar-secondary">
          Back office
        </span>
      </div>
      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-3">
        {SECTIONS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] font-semibold text-on-sidebar-secondary transition-colors hover:bg-sidebar-hover hover:text-on-sidebar",
                active && "bg-sidebar-active text-on-sidebar",
              )}
            >
              <Icon size={18} aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
