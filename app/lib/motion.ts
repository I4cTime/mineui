/**
 * Shared Motion presets for MineUI — reads the per-theme `--motion-*` CSS
 * custom properties (docs/theme-contract.md §6) instead of hardcoding
 * durations/easings per component.
 *
 * Themes switch at runtime via `data-theme` on <html> (see Navbar.tsx), so
 * these are **functions**, not module-level constants — call them at
 * render time (or inside an effect keyed on theme) to pick up the value
 * that is current for whatever theme is active *right now*. Module-level
 * constants would freeze in whatever theme happened to be active when the
 * module first evaluated.
 *
 * Fallback values (used during SSR, where `window`/`getComputedStyle` don't
 * exist, and if a var is ever missing) mirror `app/themes/deepslate.css`
 * (deepslate is the `:root` default per the contract).
 */

import type { Easing, Transition, Variants } from "motion/react";

export type DurationName = "fast" | "base" | "slow";

export interface MotionTokens {
  /** Seconds. Micro-feedback: hover/press, focus rings, chip color swaps. */
  fast: number;
  /** Seconds. Standard transitions: card mount, list item enter, tab switch, toast in/out. */
  base: number;
  /** Seconds. Large moves: modal/sheet enter, page-level transitions, signature moments. */
  slow: number;
  /** The theme's default easing curve, parsed from --motion-ease. */
  ease: Easing;
}

/** Deepslate's values — the `:root` default theme (theme-contract.md §4). */
const FALLBACK_MS: Record<DurationName, number> = {
  fast: 120,
  base: 180,
  slow: 260,
};
const FALLBACK_EASE: Easing = [0.2, 0, 0, 1];

function readCssVar(name: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function parseMs(raw: string, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) return fallbackMs;
  // CSS <time> values from our theme files are always "Nms", but tolerate a
  // bare "Ns" too in case a future theme file writes seconds.
  return raw.trim().endsWith("ms") ? value : value * 1000;
}

function parseEase(raw: string, fallback: Easing): Easing {
  const match = raw.match(/cubic-bezier\(([^)]+)\)/);
  if (!match) return fallback;
  const parts = match[1].split(",").map((n) => Number.parseFloat(n.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return fallback;
  const [x1, y1, x2, y2] = parts;
  return [x1, y1, x2, y2];
}

/**
 * Read the *currently active* theme's motion tokens straight off
 * `document.documentElement`. Safe to call during SSR (returns the
 * deepslate fallback) and safe to call on every render — it's a handful of
 * `getPropertyValue` calls, not a subscription.
 */
export function getMotionTokens(): MotionTokens {
  return {
    fast: parseMs(readCssVar("--motion-fast"), FALLBACK_MS.fast) / 1000,
    base: parseMs(readCssVar("--motion-base"), FALLBACK_MS.base) / 1000,
    slow: parseMs(readCssVar("--motion-slow"), FALLBACK_MS.slow) / 1000,
    ease: parseEase(readCssVar("--motion-ease"), FALLBACK_EASE),
  };
}

/**
 * Build a tween transition from the active theme's tokens.
 *
 * @example
 * <motion.div transition={transition("slow")} />
 * <motion.div transition={transition("base", { delay: 0.1 })} />
 */
export function transition(
  speed: DurationName = "base",
  overrides: Partial<Transition> = {},
): Transition {
  const tokens = getMotionTokens();
  return { duration: tokens[speed], ease: tokens.ease, ...overrides };
}

/**
 * Softglass is the one theme whose contract explicitly invites a true
 * spring ("true springs (stiffness ~220, damping ~26) welcome in Motion
 * presets") rather than a tween approximating overshoot. Everywhere else,
 * fall back to the themed tween. Use for interactive/gesture-driven moves
 * (shared layout, active-nav pill, sheet-style entrances) — not for
 * ambient/decorative motion.
 */
export function interactiveTransition(overrides: Partial<Transition> = {}): Transition {
  const activeTheme =
    typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  if (activeTheme === "softglass") {
    return { type: "spring", stiffness: 220, damping: 26, ...overrides };
  }
  return transition("base", overrides);
}

/** Zero-duration transition — the reduced-motion collapse target. */
export const REDUCED: Transition = { duration: 0 };

/**
 * Collapse a transition when the user prefers reduced motion. Most Motion
 * components in this app rely on the global `<MotionConfig
 * reducedMotion="user">` in app/layout.tsx and don't need this — reach for
 * it only where a transform/scale animation is load-bearing enough that
 * you want an explicit, deliberate reduced-motion branch (e.g. a signature
 * moment) rather than relying on MotionConfig's automatic transform-strip.
 */
export function reduced(t: Transition, prefersReducedMotion: boolean | null): Transition {
  return prefersReducedMotion ? REDUCED : t;
}

/** Opacity-only entrance. Cheapest, safest default. */
export function fadeIn(speed: DurationName = "base"): Variants {
  return {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: transition(speed) },
  };
}

/** Fade + rise — the standard content entrance (page sections, cards). */
export function fadeUp(speed: DurationName = "base", distance = 16): Variants {
  return {
    hidden: { opacity: 0, y: distance },
    show: { opacity: 1, y: 0, transition: transition(speed) },
  };
}

/**
 * Fade + rise + scale — for card/KPI mounts and signature "settle" moments
 * (deepslate's contract calls this out by name: "0.96→1 place-pop"). The
 * per-theme easing curve is what actually differentiates the four themes'
 * character here (deepslate: crisp snap; quantum: fluid bloom; softglass:
 * springy overshoot; phosphor: opacity/clip only — see scaleIn's phosphor
 * guard below).
 */
export function scaleIn(speed: DurationName = "base", fromScale = 0.96): Variants {
  const activeTheme =
    typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  // Phosphor's contract is explicit: "opacity/clip only; nothing scales,
  // springs, or loops." Degrade to fadeIn there instead of violating it.
  if (activeTheme === "phosphor") return fadeIn(speed);
  return {
    hidden: { opacity: 0, y: 10, scale: fromScale },
    show: { opacity: 1, y: 0, scale: 1, transition: transition(speed) },
  };
}

/**
 * Stagger container for lists/grids of cards. Children should use
 * `fadeUp()`/`scaleIn()` (or their own `hidden`/`show` variants) and need
 * no transition of their own — timing flows from this parent.
 *
 * @example
 * <motion.section initial="hidden" animate="show" variants={listStagger()}>
 *   {items.map((item, i) => (
 *     <motion.div key={item.id} variants={fadeUp()} custom={i} />
 *   ))}
 * </motion.section>
 */
export function listStagger(stagger: DurationName = "fast", delayChildren = 0): Variants {
  const tokens = getMotionTokens();
  return {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: tokens[stagger], delayChildren },
    },
  };
}
