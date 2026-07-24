"use client";

import { motion } from "motion/react";
import { transition } from "@/app/lib/motion";

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
        fill="var(--surface)"
        stroke="var(--accent)"
        strokeWidth="2"
      />

      {/* Inner grid pattern (minecraft block texture hint) */}
      <rect x="6" y="6" width="8" height="8" fill="var(--accent)" opacity="0.8" />
      <rect x="18" y="6" width="8" height="8" fill="var(--accent)" opacity="0.6" />
      <rect x="6" y="18" width="8" height="8" fill="var(--accent)" opacity="0.6" />
      <rect x="18" y="18" width="8" height="8" fill="var(--accent)" opacity="0.8" />

      {/* Center accent — was an infinite 2s pulse loop (renders in Navbar on
          every page); now a single-shot bloom-in on mount only. */}
      <motion.rect
        x="12"
        y="12"
        width="8"
        height="8"
        fill="color-mix(in oklab, var(--accent) 80%, white)"
        initial={{ opacity: 0.5 }}
        animate={{ opacity: 1 }}
        transition={transition("slow")}
      />

      {/* Glow effect — was an infinite 3s pulse loop; same fix. */}
      <motion.rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="4"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.3 }}
        transition={transition("slow")}
      />
    </motion.svg>
  );
}
