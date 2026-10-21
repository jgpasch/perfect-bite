"use client";

// A user's activity entries (spec 4.12): grouped by day, each line with its time, its area's icon,
// its sentence and the household as a muted suffix; a fold of one transaction's entries expands to
// them. Load older appends the next page (not audited). The filters remount it (its `key`).
import {
  BookOpen,
  CalendarDays,
  Home,
  type LucideIcon,
  ListChecks,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  Smartphone,
  Sparkles,
  Circle,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { fullDate } from "@/lib/format";
import type { UserActivityEntry } from "@/lib/types";
import { loadOlderUserActivity } from "@/lib/user-activity-actions";
import {
  areaLabel,
  entrySentence,
  foldEntries,
  groupByDay,
  householdSuffix,
  lineSentence,
  timeText,
  type ActivityLine,
  type ActivitySentence,
} from "@/lib/user-activity";

const AREA_ICONS: Record<string, LucideIcon> = {
  lists: ListChecks,
  recipes: BookOpen,
  plan: CalendarDays,
  aisles: ShoppingBasket,
  household: Home,
  settings: Settings,
  devices: Smartphone,
  ai: Sparkles,
  admin: ShieldCheck,
};

function Sentence({ sentence }: { sentence: ActivitySentence }) {
  const words = sentence.parts.map((part, index) =>
    typeof part === "string" ? (
      <span key={index}>{part}</span>
    ) : (
      <span key={index} className="font-semibold">{part.em}</span>
    ),
  );
  return (
    <>
      {sentence.href ? (
        <Link href={sentence.href} prefetch={false} className="text-primary hover:underline">{words}</Link>
      ) : (
        words
      )}
      {sentence.raw && <span className="ml-2 font-mono text-[12px] break-all text-ink-secondary">{sentence.raw}</span>}
      {sentence.note && <span className="block text-[13px] text-ink-secondary">“{sentence.note}”</span>}
    </>
  );
}

function Suffix({ entry }: { entry: UserActivityEntry }) {
  const household = householdSuffix(entry);
  return household === null ? null : <span className="text-ink-tertiary"> · {household}</span>;
}

function Line({ line }: { line: ActivityLine }) {
  const [first] = line.entries;
  const Icon = AREA_ICONS[first.area] ?? Circle;
  const sentence = lineSentence(line);
  return (
    <li className="flex gap-3 py-2 text-[15px] text-ink">
      <time dateTime={first.at} title={fullDate(first.at)} className="w-16 shrink-0 pt-0.5 text-[13px] text-ink-secondary tabular-nums" suppressHydrationWarning>
        {timeText(first.at)}
      </time>
      <Icon size={16} className="mt-1 shrink-0 text-ink-tertiary" aria-label={areaLabel(first.area)} />
      <div className="min-w-0 flex-1">
        {line.entries.length === 1 ? (
          <p>
            <Sentence sentence={sentence} />
            <Suffix entry={first} />
          </p>
        ) : (
          <details>
            <summary className="cursor-pointer">
              <Sentence sentence={sentence} />
              <Suffix entry={first} />
            </summary>
            <ul className="mt-1 border-l border-border pl-3 text-[14px] text-ink-secondary">
              {line.entries.map((entry, index) => (
                <li key={index} className="py-0.5">
                  <Sentence sentence={entrySentence(entry)} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

export function UserActivityList({
  userId,
  search,
  entries: firstEntries,
  nextBefore: firstNextBefore,
}: {
  userId: string;
  /** The filters' search string, for Load older. */
  search: string;
  entries: UserActivityEntry[];
  nextBefore: string | null;
}) {
  const [entries, setEntries] = useState(firstEntries);
  const [nextBefore, setNextBefore] = useState(firstNextBefore);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const loadOlder = () => {
    if (nextBefore === null) return;
    setMessage(null);
    startTransition(async () => {
      const result = await loadOlderUserActivity(userId, search, nextBefore);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setEntries((current) => [...current, ...result.entries]);
      setNextBefore(result.next_before);
    });
  };

  return (
    <>
      {groupByDay(foldEntries(entries)).map((day) => (
        <section key={day.key} className="mt-4 first:mt-0">
          <h3 className="text-[13px] font-semibold text-ink-secondary" suppressHydrationWarning>{day.label}</h3>
          <ul className="divide-y divide-border">
            {day.lines.map((line) => (
              <Line key={line.key} line={line} />
            ))}
          </ul>
        </section>
      ))}
      {nextBefore !== null && (
        <button
          type="button"
          onClick={loadOlder}
          disabled={pending}
          className="mt-4 rounded-lg border border-border bg-surface px-3 py-1.5 text-[14px] font-semibold text-ink transition-colors hover:bg-surface-muted disabled:text-ink-tertiary"
        >
          {pending ? "Loading…" : "Load older"}
        </button>
      )}
      {message && <p role="alert" className="mt-2 text-[14px] text-danger">{message}</p>}
    </>
  );
}
