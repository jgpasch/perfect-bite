// A feature's last 40 days as plain SVG bars in its colour (spec 4.12): today at full strength and
// labelled under its bar, the other days lighter, and a dashed line before each 1st of the month
// with its date above.
import { barTitle, chartBars, dayLabel } from "@/lib/ai-usage";
import { featureColors, featureLabel } from "@/lib/features";

const BAR = 6;
const GAP = 2;
const HEIGHT = 56;
/** The bands above (the 1st's date) and below (Today) the bars. */
const LABEL = 14;

export function UsageChart({ feature, daily }: { feature: string; daily: { day: string; used: number }[] }) {
  const bars = chartBars(daily);
  const colors = featureColors(feature);
  const width = Math.max(bars.length * (BAR + GAP) - GAP, 1);
  const base = LABEL + HEIGHT;

  return (
    <svg
      role="img"
      aria-label={`${featureLabel(feature)} per day, last ${bars.length} days`}
      viewBox={`0 0 ${width} ${base + LABEL}`}
      className="h-auto w-full overflow-visible"
    >
      {bars.map((bar, index) => {
        const x = index * (BAR + GAP);
        // A day with any use shows at least a sliver; an empty day a faint stub on the baseline.
        const height = bar.used > 0 ? Math.max(bar.fraction * HEIGHT, 2) : 1;
        return (
          <g key={bar.day}>
            {bar.isMonthStart && (
              <>
                <line
                  x1={x - GAP / 2}
                  x2={x - GAP / 2}
                  y1={LABEL - 3}
                  y2={base}
                  stroke="var(--ink-tertiary)"
                  strokeWidth={0.75}
                  strokeDasharray="2 2"
                />
                <text x={x + 1} y={LABEL - 4} fontSize={9} fill="var(--ink-secondary)">
                  {dayLabel(bar.day)}
                </text>
              </>
            )}
            <rect
              x={x}
              y={base - height}
              width={BAR}
              height={height}
              rx={1.5}
              fill={bar.used > 0 ? colors.color : colors.soft}
              opacity={bar.isToday || bar.used === 0 ? 1 : 0.55}
              stroke={bar.isToday ? colors.strong : undefined}
              strokeWidth={bar.isToday ? 1 : undefined}
            >
              <title>{barTitle(feature, bar)}</title>
            </rect>
            {bar.isToday && (
              <text x={x + BAR} y={base + 11} fontSize={9} fontWeight={700} textAnchor="end" fill={colors.strong}>
                Today
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
