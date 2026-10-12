"use client";

// A small trend line under a live number. Colors come from theme tokens;
// animation is off (theme contract §2.6: no motion outside --motion-*).
import { AreaChart } from "@heroui-pro/react/area-chart";

type SparklineProps = {
  data: { at: number; value: number }[];
  /** Accessible summary, e.g. "CPU over the last 20 minutes". */
  label: string;
  /** Semantic color token name. */
  tone?: "accent" | "success" | "warning" | "danger";
  height?: number;
  /** Fixed y range, e.g. [0, 100] for percentages. */
  domain?: [number, number];
};

export default function Sparkline({ data, label, tone = "accent", height = 32, domain }: SparklineProps) {
  // One point draws nothing useful; wait for a second sample.
  if (data.length < 2) return null;
  const color = `var(--${tone})`;
  return (
    <div role="img" aria-label={label} className="w-full">
      <AreaChart data={data} height={height} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <AreaChart.YAxis hide domain={domain ?? ["auto", "auto"]} />
        <AreaChart.Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={color}
          fillOpacity={0.15}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </div>
  );
}
