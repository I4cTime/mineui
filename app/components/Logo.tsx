"use client";

import { motion } from "motion/react";
import { transition } from "@/app/lib/motion";

interface LogoProps {
  size?: number;
  className?: string;
}

/**
 * The "Ore Cube" brand mark (2026-08 rollout — see assets/brand/): a neon
 * isometric voxel with the glowing core on the front-corner junction and
 * one orbit through the cube. Geometry is the canonical 512-grid mark
 * scaled to a 32 viewBox; colors come from the active theme's tokens, so
 * the mark follows theme switches and the user accent override for free.
 */
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
      {/* Voxel: hexagon silhouette + the three internal cube edges. */}
      <g stroke="var(--accent)" strokeLinecap="round" strokeLinejoin="round">
        <path
          d="M16 4.75 L25.74 10.38 L25.74 21.62 L16 27.25 L6.26 21.62 L6.26 10.38 Z"
          strokeWidth="1.7"
        />
        <g strokeWidth="1.1" opacity="0.85">
          <path d="M16 16 L25.74 10.38" />
          <path d="M16 16 L6.26 10.38" />
          <path d="M16 16 L16 27.25" />
        </g>
        {/* Orbit through the cube (−18°, matches the full mark). */}
        <ellipse
          cx="16"
          cy="16"
          rx="9.4"
          ry="3"
          transform="rotate(-18 16 16)"
          strokeWidth="1.1"
          opacity="0.9"
        />
        {/* Core halo */}
        <circle cx="16" cy="16" r="3.4" strokeWidth="1.1" fill="var(--surface)" />
      </g>

      {/* Core — was an infinite pulse in the old logo; single-shot bloom-in
          on mount only (this renders in Navbar on every page). */}
      <motion.circle
        cx="16"
        cy="16"
        r="1.9"
        fill="color-mix(in oklab, var(--accent) 85%, white)"
        initial={{ opacity: 0.5 }}
        animate={{ opacity: 1 }}
        transition={transition("slow")}
      />

      {/* Glow layer — same single-shot fade as the old logo's. */}
      <motion.path
        d="M16 4.75 L25.74 10.38 L25.74 21.62 L16 27.25 L6.26 21.62 L6.26 10.38 Z"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.6"
        strokeLinejoin="round"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.25 }}
        transition={transition("slow")}
      />
    </motion.svg>
  );
}
