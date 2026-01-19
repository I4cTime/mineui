"use client";

import { motion } from "motion/react";

interface LogoProps {
  size?: number;
  className?: string;
}

export default function Logo({ size = 32, className = "" }: LogoProps) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
    >
      {/* Outer block */}
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="4"
        fill="var(--mc-panel)"
        stroke="var(--mc-accent)"
        strokeWidth="2"
      />

      {/* Inner grid pattern (minecraft block texture hint) */}
      <rect x="6" y="6" width="8" height="8" fill="var(--mc-accent)" opacity="0.8" />
      <rect x="18" y="6" width="8" height="8" fill="var(--mc-accent)" opacity="0.6" />
      <rect x="6" y="18" width="8" height="8" fill="var(--mc-accent)" opacity="0.6" />
      <rect x="18" y="18" width="8" height="8" fill="var(--mc-accent)" opacity="0.8" />

      {/* Center accent */}
      <motion.rect
        x="12"
        y="12"
        width="8"
        height="8"
        fill="var(--mc-accent-strong)"
        animate={{ opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Glow effect */}
      <motion.rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="4"
        fill="none"
        stroke="var(--mc-accent)"
        strokeWidth="1"
        opacity="0.3"
        animate={{ opacity: [0.2, 0.5, 0.2] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />
    </motion.svg>
  );
}
