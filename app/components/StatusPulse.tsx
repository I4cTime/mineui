"use client";

// A server's state as a small dot. Running: a soft ring breathes out from a
// success-coloured dot. Starting or stopping: the same ring, faster, in the
// warning colour. Everything else: a plain still dot. The ring is a CSS
// animation (globals.css, .status-ring) that is switched off for
// reduce-motion, so a still dot is all that is left there.
import type { ServerPhase } from "@/app/lib/ipc";
import { phaseDotClass } from "@/app/components/ServerProvider";

interface StatusPulseProps {
  phase: ServerPhase | null | undefined;
  /** Size utility for the dot. Defaults to size-2. */
  className?: string;
}

export default function StatusPulse({ phase, className = "size-2" }: StatusPulseProps) {
  const color = phaseDotClass(phase);
  const rhythm =
    phase === "running" ? "calm" : phase === "starting" || phase === "stopping" ? "busy" : null;
  return (
    <span aria-hidden className={`relative inline-flex shrink-0 ${className}`}>
      {rhythm && <span className={`status-ring rounded-full ${color}`} data-rhythm={rhythm} />}
      <span className={`relative size-full rounded-full ${color}`} />
    </span>
  );
}
