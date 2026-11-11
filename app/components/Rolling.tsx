"use client";

// A number whose digits roll when it changes (NumberFlow). NumberFlow reads
// prefers-reduced-motion itself (respectMotionPreference defaults to true), so
// with reduce-motion on the digits simply swap. Numerals only, so the pixel
// numeral font stays on.
import NumberFlow from "@number-flow/react";

interface RollingProps {
  value: number;
  /** Text after the number, e.g. "ms" or "/20". */
  suffix?: string;
  /** Decimal places to always show. */
  decimals?: number;
  className?: string;
}

export default function Rolling({ value, suffix, decimals = 0, className = "" }: RollingProps) {
  return (
    <NumberFlow
      className={`font-pixel-num ${className}`}
      value={value}
      suffix={suffix}
      format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }}
      respectMotionPreference
    />
  );
}
