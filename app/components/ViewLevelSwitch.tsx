"use client";

// The Simple / Advanced view switch (header and App Settings). View level
// only: it changes what MineUI shows, never a server or a setting.
import { Segment } from "@heroui-pro/react";
import { Tooltip } from "@heroui/react";
import { firstKey } from "@/app/lib/keys";
import { useUISound } from "@/app/hooks/useUISound";
import {
  VIEW_LEVELS,
  VIEW_LEVEL_HINT,
  useViewLevel,
  type ViewLevel,
} from "@/app/components/ViewLevelProvider";

export default function ViewLevelSwitch({
  withTooltip = false,
}: {
  withTooltip?: boolean;
}) {
  const { level, setLevel } = useViewLevel();
  const { play } = useUISound();

  const segment = (
    <Segment
      aria-label="How much MineUI shows"
      size="sm"
      selectedKey={level}
      onSelectionChange={(key: unknown) => {
        const next = firstKey(key) as ViewLevel | null;
        if (!next || next === level) return;
        play(next === "advanced" ? "toggle_on" : "toggle_off");
        setLevel(next);
      }}
    >
      {VIEW_LEVELS.map((option) => (
        <Segment.Item
          key={option.id}
          id={option.id}
          onMouseEnter={() => play("hover")}
        >
          {option.label}
        </Segment.Item>
      ))}
    </Segment>
  );

  if (!withTooltip) return segment;
  return (
    <Tooltip delay={400}>
      <span className="inline-flex">{segment}</span>
      <Tooltip.Content placement="bottom" className="max-w-64">
        {VIEW_LEVEL_HINT}
      </Tooltip.Content>
    </Tooltip>
  );
}
