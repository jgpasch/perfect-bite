// Wording and the chart's scaling for the AI usage page (spec 4.12, admin_ai_usage).
import { FEATURES, isFeature } from "./features";
import type { AiCallStats, AiCallStatus, AiTaskCalls, MonthlyLimit } from "./types";

const number = new Intl.NumberFormat("en-US");

/** "1,234 names", "1 call": a feature's total in its unit ("calls" for an unknown feature). */
export function usageTotal(feature: string, used: number): string {
  const unit = isFeature(feature) ? FEATURES[feature].unit : "calls";
  const noun = used === 1 ? unit.slice(0, -1) : unit;
  return `${number.format(used)} ${noun}`;
}

/** "No users", "1 user", "1,204 users". */
export function usersLine(users: number): string {
  if (users === 0) return "No users";
  return `${number.format(users)} ${users === 1 ? "user" : "users"}`;
}

/** A Top users row's "23 / 40" or "23 / No limit". */
export function usedOfLimit(used: number, limit: MonthlyLimit): string {
  return `${number.format(used)} / ${limit === null ? "No limit" : number.format(limit)}`;
}

export type ChartBar = {
  day: string;
  used: number;
  /** The bar's height as a share of the tallest, 0 to 1 (all 0 when every day is 0). */
  fraction: number;
  /** The last day of the series, which admin_ai_usage ends on today (UTC). */
  isToday: boolean;
  /** The 1st of a month, marked on the chart. */
  isMonthStart: boolean;
};

/** The daily series (oldest first) as bars scaled to the busiest day. */
export function chartBars(daily: readonly { day: string; used: number }[]): ChartBar[] {
  const max = daily.reduce((top, point) => Math.max(top, point.used), 0);
  return daily.map((point, index) => ({
    day: point.day,
    used: point.used,
    fraction: max > 0 ? Math.max(point.used, 0) / max : 0,
    isToday: index === daily.length - 1,
    isMonthStart: point.day.endsWith("-01"),
  }));
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Oct 1" for a `YYYY-MM-DD` UTC day; the input back when it isn't one. */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : dayFormat.format(date);
}

/** A bar's hover text: "Oct 3: 12 names", "Today: 1 call". */
export function barTitle(feature: string, bar: Pick<ChartBar, "day" | "used" | "isToday">): string {
  return `${bar.isToday ? "Today" : dayLabel(bar.day)}: ${usageTotal(feature, bar.used)}`;
}

const STATUS_ORDER: AiCallStatus[] = ["ok", "api_error", "invalid_output", "timeout", "error"];

/** The calls that didn't answer `ok`, as a share of all of them; null with no calls. */
export function failureRate(stats: Pick<AiCallStats, "total" | "statuses">): number | null {
  if (stats.total <= 0) return null;
  return (stats.total - (stats.statuses.ok ?? 0)) / stats.total;
}

/** "12.5%", "0%", "—" with no calls. */
export function failureRateText(stats: Pick<AiCallStats, "total" | "statuses">): string {
  const rate = failureRate(stats);
  if (rate === null) return "—";
  return `${Number((rate * 100).toFixed(1))}%`;
}

/** The failure rate's hover text: each non-`ok` status with calls, "api_error 2 · timeout 1"; "No failures" otherwise. */
export function failureBreakdown(stats: Pick<AiCallStats, "statuses">): string {
  const known: AiCallStatus[] = STATUS_ORDER.filter((status) => status !== "ok");
  const others = Object.keys(stats.statuses).filter((status) => status !== "ok" && !known.includes(status as AiCallStatus));
  const parts = [...known, ...others]
    .map((status) => [status, stats.statuses[status as AiCallStatus] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${number.format(count)}`);
  return parts.length === 0 ? "No failures" : parts.join(" · ");
}

export type ModelCalls = AiCallStats & { model: string; /** The tasks that used it, by name. */ tasks: string[] };

/** The calls per model across every task (admin_ai_usage gives them per task), by model name. */
export function callsByModel(calls: readonly AiTaskCalls[]): ModelCalls[] {
  const models = new Map<string, ModelCalls>();
  for (const task of calls) {
    for (const stats of task.models ?? []) {
      const row = models.get(stats.model) ?? {
        model: stats.model,
        tasks: [],
        total: 0,
        statuses: { ok: 0, api_error: 0, invalid_output: 0, timeout: 0, error: 0 },
        fallbacks: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
      };
      if (!row.tasks.includes(task.task)) row.tasks.push(task.task);
      row.total += stats.total;
      for (const [status, n] of Object.entries(stats.statuses)) {
        row.statuses[status as AiCallStatus] = (row.statuses[status as AiCallStatus] ?? 0) + n;
      }
      row.fallbacks += stats.fallbacks;
      row.input_tokens += stats.input_tokens;
      row.output_tokens += stats.output_tokens;
      row.cached_input_tokens += stats.cached_input_tokens;
      row.reasoning_tokens += stats.reasoning_tokens;
      models.set(stats.model, row);
    }
  }
  return [...models.values()]
    .map((row) => ({ ...row, tasks: [...row.tasks].sort() }))
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/** A count or token sum with thousands separators. */
export function count(value: number): string {
  return number.format(value);
}
