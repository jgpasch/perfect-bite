import { describe, expect, it } from "vitest";

import {
  barTitle,
  callsByModel,
  chartBars,
  count,
  dayLabel,
  failureBreakdown,
  failureRate,
  failureRateText,
  usageTotal,
  usedOfLimit,
  usersLine,
} from "./ai-usage";
import type { AiCallStats, AiTaskCalls } from "./types";

function series(values: number[], first = "2026-09-10"): { day: string; used: number }[] {
  const start = new Date(`${first}T00:00:00Z`).getTime();
  return values.map((used, i) => ({ day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), used }));
}

function stats(
  partial: Partial<Omit<AiCallStats, "statuses">> & { statuses?: Partial<AiCallStats["statuses"]> } = {},
): AiCallStats {
  return {
    total: 0,
    fallbacks: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    ...partial,
    statuses: { ok: 0, api_error: 0, invalid_output: 0, timeout: 0, error: 0, ...partial.statuses },
  };
}

describe("chartBars", () => {
  it("scales an all-zero series to zero heights, without dividing by zero", () => {
    const bars = chartBars(series(Array(40).fill(0)));
    expect(bars).toHaveLength(40);
    expect(bars.every((bar) => bar.fraction === 0)).toBe(true);
    expect(bars.some((bar) => Number.isNaN(bar.fraction))).toBe(false);
  });

  it("gives a single spike the full height and every other day none", () => {
    const values = Array(40).fill(0);
    values[17] = 250;
    const bars = chartBars(series(values));
    expect(bars[17].fraction).toBe(1);
    expect(bars.filter((bar) => bar.fraction > 0)).toHaveLength(1);
    expect(bars[17].used).toBe(250);
  });

  it("scales the rest to the busiest day", () => {
    const bars = chartBars(series([0, 5, 10, 20]));
    expect(bars.map((bar) => bar.fraction)).toEqual([0, 0.25, 0.5, 1]);
  });

  it("marks the last day as today and only it", () => {
    const bars = chartBars(series([1, 2, 3]));
    expect(bars.map((bar) => bar.isToday)).toEqual([false, false, true]);
  });

  it("marks each 1st of the month", () => {
    // Sep 29 → Oct 2 (the series ending on today, the 2nd).
    const bars = chartBars(series([1, 1, 1, 1], "2026-09-29"));
    expect(bars.map((bar) => bar.day)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(bars.map((bar) => bar.isMonthStart)).toEqual([false, false, true, false]);
  });

  it("marks today when it's the 1st", () => {
    const [bar] = chartBars([{ day: "2026-11-01", used: 0 }]);
    expect(bar).toEqual({ day: "2026-11-01", used: 0, fraction: 0, isToday: true, isMonthStart: true });
  });

  it("handles an empty series", () => {
    expect(chartBars([])).toEqual([]);
  });
});

describe("failureRate", () => {
  it("is null with no calls, shown as a dash", () => {
    expect(failureRate(stats())).toBeNull();
    expect(failureRateText(stats())).toBe("—");
  });

  it("is the share of calls that weren't ok", () => {
    const s = stats({ total: 8, statuses: { ok: 7, timeout: 1 } });
    expect(failureRate(s)).toBe(0.125);
    expect(failureRateText(s)).toBe("12.5%");
  });

  it("reads 0% when every call was ok and 100% when none was", () => {
    expect(failureRateText(stats({ total: 3, statuses: { ok: 3 } }))).toBe("0%");
    expect(failureRateText(stats({ total: 2, statuses: { api_error: 2 } }))).toBe("100%");
  });

  it("rounds to one decimal", () => {
    expect(failureRateText(stats({ total: 3, statuses: { ok: 2, error: 1 } }))).toBe("33.3%");
  });
});

describe("failureBreakdown", () => {
  it("lists each non-ok status with calls, in a fixed order", () => {
    expect(failureBreakdown(stats({ statuses: { ok: 9, timeout: 1, api_error: 2, error: 0 } }))).toBe(
      "api_error 2 · timeout 1",
    );
  });

  it("says so when nothing failed", () => {
    expect(failureBreakdown(stats({ statuses: { ok: 5 } }))).toBe("No failures");
    expect(failureBreakdown(stats())).toBe("No failures");
  });

  it("includes a status this portal doesn't know", () => {
    const s = stats();
    (s.statuses as Record<string, number>).refused = 1200;
    expect(failureBreakdown(s)).toBe("refused 1,200");
  });
});

describe("wording", () => {
  it("gives a feature's total in its unit", () => {
    expect(usageTotal("categorize", 1234)).toBe("1,234 names");
    expect(usageTotal("categorize", 1)).toBe("1 name");
    expect(usageTotal("recipe_import", 0)).toBe("0 calls");
    expect(usageTotal("recipe_import", 1)).toBe("1 call");
    expect(usageTotal("something_new", 3)).toBe("3 calls");
  });

  it("counts users", () => {
    expect(usersLine(0)).toBe("No users");
    expect(usersLine(1)).toBe("1 user");
    expect(usersLine(1204)).toBe("1,204 users");
  });

  it("gives used over the limit", () => {
    expect(usedOfLimit(23, 40)).toBe("23 / 40");
    expect(usedOfLimit(1500, null)).toBe("1,500 / No limit");
    expect(usedOfLimit(3, 0)).toBe("3 / 0");
  });

  it("labels days in UTC", () => {
    expect(dayLabel("2026-10-01")).toBe("Oct 1");
    expect(dayLabel("2026-12-31")).toBe("Dec 31");
    expect(dayLabel("not a day")).toBe("not a day");
  });

  it("titles bars with the day, or Today", () => {
    expect(barTitle("categorize", { day: "2026-10-03", used: 12, isToday: false })).toBe("Oct 3: 12 names");
    expect(barTitle("recipe_tags", { day: "2026-10-19", used: 1, isToday: true })).toBe("Today: 1 call");
  });

  it("formats counts", () => {
    expect(count(0)).toBe("0");
    expect(count(1234567)).toBe("1,234,567");
  });
});

describe("callsByModel", () => {
  it("sums each model across tasks, by model name", () => {
    const calls: AiTaskCalls[] = [
      {
        task: "recipe_import",
        ...stats({ total: 5 }),
        models: [
          { model: "gpt-5-mini", ...stats({ total: 4, statuses: { ok: 3, timeout: 1 }, input_tokens: 100, fallbacks: 0 }) },
          { model: "claude-haiku-5-5", ...stats({ total: 1, statuses: { ok: 1 }, input_tokens: 10, fallbacks: 1 }) },
        ],
      },
      {
        task: "categorize",
        ...stats({ total: 2 }),
        models: [
          {
            model: "gpt-5-mini",
            ...stats({ total: 2, statuses: { ok: 1, api_error: 1 }, input_tokens: 50, output_tokens: 7, cached_input_tokens: 3, reasoning_tokens: 2 }),
          },
        ],
      },
    ];
    const rows = callsByModel(calls);
    expect(rows.map((row) => row.model)).toEqual(["claude-haiku-5-5", "gpt-5-mini"]);
    expect(rows[1]).toEqual({
      model: "gpt-5-mini",
      tasks: ["categorize", "recipe_import"],
      total: 6,
      statuses: { ok: 4, api_error: 1, invalid_output: 0, timeout: 1, error: 0 },
      fallbacks: 0,
      input_tokens: 150,
      output_tokens: 7,
      cached_input_tokens: 3,
      reasoning_tokens: 2,
    });
    expect(rows[0].fallbacks).toBe(1);
    expect(rows[0].tasks).toEqual(["recipe_import"]);
  });

  it("is empty with no calls, or a task without models", () => {
    expect(callsByModel([])).toEqual([]);
    expect(callsByModel([{ task: "x", ...stats(), models: null as unknown as [] }])).toEqual([]);
  });
});
