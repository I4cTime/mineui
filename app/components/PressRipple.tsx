"use client";

// Ripple on press for a Button or card (Pro PressableFeedback.Ripple). The
// ripple and its hover tint are not Motion, so MotionConfig does not cover
// them: with reduce-motion on, nothing is rendered at all.
import { useReducedMotion } from "motion/react";
import { PressableFeedback } from "@heroui-pro/react";

export default function PressRipple() {
  const reduce = useReducedMotion();
  if (reduce) return null;
  return <PressableFeedback.Ripple />;
}
