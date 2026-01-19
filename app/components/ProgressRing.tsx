"use client";

import { motion } from "motion/react";

interface ProgressRingProps {
  value: number; // 0-100
  size?: number;
  strokeWidth?: number;
  label?: string;
  sublabel?: string;
  colorVar?: string;
}

export default function ProgressRing({
  value,
  size = 100,
  strokeWidth = 8,
  label,
  sublabel,
  colorVar = "--mc-accent",
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(Math.max(value, 0), 100) / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg
        width={size}
        height={size}
        className="mc-progress-ring"
      >
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--mc-panel-border)"
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`var(${colorVar})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
        {/* Glow effect */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`var(${colorVar})`}
          strokeWidth={strokeWidth / 2}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          opacity={0.3}
          filter="blur(4px)"
        />
      </svg>
      <div className="absolute flex flex-col items-center justify-center text-center">
        {label && (
          <motion.span
            className="font-pixel text-lg"
            style={{ color: `var(${colorVar})` }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3 }}
          >
            {label}
          </motion.span>
        )}
        {sublabel && (
          <motion.span
            className="text-xs"
            style={{ color: "var(--mc-muted)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            {sublabel}
          </motion.span>
        )}
      </div>
    </div>
  );
}
