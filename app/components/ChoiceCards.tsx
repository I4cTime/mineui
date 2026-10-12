"use client";

// One radio group of rich option cards (icon, title, description), built on
// HeroUI Pro's RadioButtonGroup so every picker shares the same focus ring,
// selected state and arrow-key handling instead of re-implementing them.
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { RadioButtonGroup } from "@heroui-pro/react";
import { useUISound } from "@/app/hooks/useUISound";

export type ChoiceCardOption<T extends string> = {
  id: T;
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  isDisabled?: boolean;
};

type ChoiceCardsProps<T extends string> = {
  options: readonly ChoiceCardOption<T>[];
  value: T;
  onChange: (next: T) => void;
  isDisabled?: boolean;
  /** Play the toggle sound on change. Off when onChange plays its own. */
  sound?: boolean;
  /** Grid classes for the cards, e.g. "sm:grid-cols-2". */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

export default function ChoiceCards<T extends string>({
  options,
  value,
  onChange,
  isDisabled,
  sound = true,
  className,
  ...aria
}: ChoiceCardsProps<T>) {
  const { play } = useUISound();
  return (
    <RadioButtonGroup
      {...aria}
      layout="grid"
      value={value}
      isDisabled={isDisabled}
      className={`grid w-full gap-2 ${className ?? ""}`}
      onChange={(next: string) => {
        if (next === value) return;
        if (sound) play("toggle_on");
        onChange(next as T);
      }}
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <RadioButtonGroup.Item
            key={option.id}
            value={option.id}
            isDisabled={option.isDisabled}
            onMouseEnter={() => play("hover")}
          >
            {Icon && (
              <RadioButtonGroup.ItemIcon>
                <Icon size={16} />
              </RadioButtonGroup.ItemIcon>
            )}
            <RadioButtonGroup.ItemContent>
              <span className="block text-sm font-semibold">{option.title}</span>
              {option.description && (
                <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
              )}
            </RadioButtonGroup.ItemContent>
            <RadioButtonGroup.Indicator />
          </RadioButtonGroup.Item>
        );
      })}
    </RadioButtonGroup>
  );
}
