"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { Transition } from "motion/react";
import { transition } from "@/app/lib/motion";
import {
  Archive,
  Boxes,
  Coffee,
  Container,
  Ellipsis,
  Gauge,
  ScrollText,
  Server,
  Settings,
  Shield,
  Sparkles,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  Button,
  Description,
  Dropdown,
  Label,
  ListBox,
  Popover,
  Select,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@heroui/react";
import type { Key } from "@heroui/react";
import Logo from "./Logo";
import { useSoundSettings, useUISound } from "@/app/hooks/useUISound";
import { applyAccentOverride } from "@/app/hooks/useAccentColor";
import { useMode } from "@/app/components/ModeProvider";
import type { Mode } from "@/app/lib/ipc";

// Registry per docs/theme-contract.md §1. Legacy ids (emerald/ember/aether/
// void) have no CSS block anymore and resolve to :root = deepslate; any
// value read back from localStorage that isn't one of these four falls
// back to deepslate below.
const themes = [
  {
    id: "deepslate",
    label: "Deepslate & Emerald",
    description:
      "Deepslate stone, emerald signal — the tool Mojang would ship.",
  },
  {
    id: "phosphor",
    label: "Phosphor Amber",
    description: "Near-black ops console with an amber phosphor glow.",
  },
  {
    id: "quantum",
    label: "Quantum Fluidity",
    description: "Deep-space black, cyan signal, violet glow — the I4C look.",
  },
  {
    id: "softglass",
    label: "Soft Glass",
    description: "Calm, rounded, native-grade — one warm apricot accent.",
  },
] as const;

const THEME_IDS = themes.map((item) => item.id);
const DEFAULT_THEME = "deepslate";

// Select.Value's default render shows the selected ListBox.Item's full
// children (Label + Description both — see HeroUI docs "Custom Value"
// example, which needs this same override to avoid leaking item
// descriptions into the trigger). Render just the theme name so the closed
// trigger stays compact; the Label + Description pair below remains
// dropdown-only.
//
// The rendered span sets its own `text-xs`: HeroUI's `.select__trigger`
// hardcodes `text-sm`, and `.select__value` itself hardcodes
// `text-base sm:text-sm` (16px below the `sm` breakpoint, 14px at/above
// it) — both are direct declarations on those elements, so a `text-xs`
// className on the outer <Select> (inherited, not direct) never wins
// against them. Setting it directly on this span is what actually takes
// effect, and it's also what keeps the trigger's fixed width (below)
// correct on every viewport instead of only above `sm`.
//
// `block w-full` is load-bearing, not decoration: Tailwind's `truncate`
// (overflow-hidden + text-overflow-ellipsis + whitespace-nowrap) only
// clips an element that has a *constrained* width smaller than its
// content. A bare inline <span> ignores `width` entirely, so `truncate`
// alone silently did nothing — the text just overflowed the trigger's
// border with no ellipsis (verified: shrinking the trigger below the
// text's natural width left the label spilling past the rounded box).
// `block w-full` lets the span take its ancestor's (constrained, see
// Select.Value's `min-w-0` at both call sites) width instead of its own
// content width, which is what lets the ellipsis actually engage as the
// safety net the width choices below rely on.
const renderThemeValue = ({
  defaultChildren,
  isPlaceholder,
  state,
}: {
  defaultChildren: React.ReactNode;
  isPlaceholder: boolean;
  state: { selectedItems: { key: React.Key }[] };
}) => {
  if (isPlaceholder || state.selectedItems.length === 0) return defaultChildren;
  const selected = themes.find((item) => item.id === state.selectedItems[0]?.key);
  if (!selected) return defaultChildren;
  return <span className="block w-full truncate text-xs">{selected.label}</span>;
};

// Priority order is load-bearing (docs/theme-contract.md §9.2): the first
// four are the T3 standalone set and the T3 "More" overflow always holds
// exactly items[4:]. Do not re-rank.
const navItems = [
  { href: "/", label: "Dashboard", icon: Server },
  { href: "/status", label: "Status", icon: Gauge },
  { href: "/mods", label: "Mods", icon: Boxes },
  { href: "/players", label: "Players", icon: Users },
  { href: "/rcon", label: "RCON", icon: Shield },
  { href: "/config", label: "Config", icon: ScrollText },
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/settings", label: "Settings", icon: Settings },
];

const PRIORITY_COUNT = 4;

/**
 * Active-item background/shadow/radius treatment — the shared skeleton
 * that renders all four themes' character purely off the --nav-active-*
 * vars (docs/theme-contract.md §9.1, §9.3). Phosphor's fill is transparent
 * by design (its treatment is the underline strip below, not a fill), and
 * per §9.6 it must NOT participate in the shared layoutId slide — it
 * crossfades in at `--motion-fast` instead. The other three themes share
 * a single `layoutId` so the capsule/slot glides between whichever item
 * just became active.
 */
function NavActiveFill({ theme, layoutId }: { theme: string; layoutId: string }) {
  const style: CSSProperties = {
    background: "var(--nav-active-bg)",
    boxShadow: "var(--nav-active-shadow)",
    borderRadius: "var(--nav-active-radius)",
  };

  if (theme === "phosphor") {
    return (
      <motion.span
        key="active-fill"
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={style}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={transition("fast")}
      />
    );
  }

  const navTransition: Transition =
    theme === "softglass"
      ? { type: "spring", stiffness: 220, damping: 26 }
      : transition(theme === "deepslate" ? "fast" : "base");

  return (
    <motion.span
      layoutId={layoutId}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10"
      style={style}
      transition={navTransition}
    />
  );
}

/** The bottom-edge underline strip — zero-height in every theme except
 * phosphor (docs/theme-contract.md §9.1), so this renders as a no-op in
 * the other three. Anchored by its parent's full header height, not the
 * button's own height, so it sits flush with the bar's bottom edge. */
function NavIndicator({ activeKey }: { activeKey: string }) {
  return (
    <AnimatePresence>
      <motion.span
        key={activeKey}
        aria-hidden
        className="pointer-events-none absolute inset-x-1 bottom-0"
        style={{
          height: "var(--nav-indicator-height)",
          background: "var(--nav-indicator)",
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={transition("fast")}
      />
    </AnimatePresence>
  );
}

/** Label span shown in full at T1 (header-full, >=1200px) and hidden
 * (icon-only) at every narrower tier. */
function NavLabel({ children }: { children: ReactNode }) {
  return <span className="relative z-10 hidden header-full:inline">{children}</span>;
}

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = useState<string | null>(DEFAULT_THEME);
  const [showKofi, setShowKofi] = useState(false);
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } =
    useSoundSettings();
  const { play } = useUISound();
  const { mode, switching, setMode } = useMode();
  const currentTheme = typeof theme === "string" ? theme : DEFAULT_THEME;

  useEffect(() => {
    const stored = window.localStorage.getItem("mineui-theme");
    // Legacy ids (emerald/ember/aether/void) and anything unrecognized fall
    // back to deepslate per docs/theme-contract.md §1 — they already
    // resolve to :root in CSS, this just keeps the picker's own state
    // consistent with that.
    const initial = (THEME_IDS as readonly string[]).includes(stored ?? "")
      ? stored!
      : DEFAULT_THEME;
    // Theme must be read from localStorage after hydration; the initial
    // server-rendered value stays deepslate to avoid a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = currentTheme;
    window.localStorage.setItem("mineui-theme", currentTheme);
    // Re-apply the user accent override (covers first mount too): its
    // --accent-foreground pick is derived from the theme's bg/fg tokens,
    // which just changed with data-theme.
    applyAccentOverride();
  }, [currentTheme]);

  const handleNavigate = (href: string) => {
    play("click_confirm");
    router.push(href);
  };

  const handleThemeChange = (newTheme: string | number | null) => {
    if (newTheme === null) return;
    play("toggle_on");
    setTheme(String(newTheme));
  };

  // Simple is the base/"off" state, Advanced is the "on" (more-powered) one —
  // same on/off sense the sound toggle already uses toggle_on/toggle_off for.
  const handleModeChange = (keys: Set<Key>) => {
    const next = Array.from(keys)[0] as Mode | undefined;
    if (!next || next === mode) return;
    play(next === "advanced" ? "toggle_on" : "toggle_off");
    setMode(next);
  };

  const toggleSound = () => {
    const newState = !soundEnabled;
    setSoundEnabled(newState);
    if (newState) {
      // Play a sound to confirm it's on
      setTimeout(() => play("toggle_on"), 50);
    }
  };

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const priorityItems = navItems.slice(0, PRIORITY_COUNT);
  const overflowItems = navItems.slice(PRIORITY_COUNT);
  // T4 (640-699px) folds ALL eight items into "More"; T3 (700-899px) folds
  // only the non-priority four. The priority four's menu-only rendering is
  // therefore only meaningful at T4 — gated with `header-min:hidden` below.
  const activeInOverflowAlways = overflowItems.some((item) => isActive(item.href));
  const activeInPriority = priorityItems.some((item) => isActive(item.href));
  const moreHasActive = activeInOverflowAlways || activeInPriority;

  return (
    <header
      className="sticky z-40"
      style={{
        top: "var(--header-inset)",
        marginInline: "var(--header-inset)",
        marginBottom: "var(--header-inset)",
        height: "var(--header-height)",
        background: "var(--header-bg)",
        backdropFilter: "blur(var(--header-blur))",
        WebkitBackdropFilter: "blur(var(--header-blur))",
        border: "var(--header-border-width) solid var(--header-border)",
        borderRadius: "var(--header-radius)",
        boxShadow: "var(--header-shadow)",
      }}
    >
      {/* Edge strips (docs/theme-contract.md §9.1): solid or gradient per
          theme, transparent = invisible = free. Replaces the old static
          radial-gradient glow decal, which was quantum-flavored and leaked
          into all four themes — quantum's glow now lives entirely in
          --header-shadow / --header-edge-bottom. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: "var(--header-edge-top)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{ background: "var(--header-edge-bottom)" }}
      />

      <div className="relative z-10 flex h-full items-center gap-4 px-4">
        {/* Brand. Wordmark hides below header-mid (900px); logo alone
            carries the brand at T3/T4 per §9.2. */}
        <Link
          href="/"
          className="flex shrink-0 items-center gap-3"
          onClick={() => play("click_confirm")}
          onMouseEnter={() => play("hover")}
        >
          <Logo size={28} />
          <span className="hidden font-display text-sm tracking-wide text-accent header-mid:inline">
            MineUI
          </span>
        </Link>

        {/* Nav zone — the only zone that adapts (§9.1). min-w-0 lets it
            shrink instead of forcing the header wider than the window. */}
        <nav
          aria-label="Primary"
          className="relative flex h-full min-w-0 flex-1 items-center justify-center gap-0.5"
        >
          {priorityItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <div
                key={item.href}
                className="relative hidden h-full items-center header-min:flex!"
              >
                <Tooltip delay={400}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="relative"
                    style={{
                      font: "var(--nav-label-weight) var(--nav-label-size) var(--nav-label-font)",
                      letterSpacing: "var(--nav-label-tracking)",
                      textTransform: "var(--nav-label-case)" as CSSProperties["textTransform"],
                      color: active ? "var(--nav-active-fg)" : "var(--muted)",
                    }}
                    onPress={() => handleNavigate(item.href)}
                    onMouseEnter={() => play("hover")}
                    aria-current={active ? "page" : undefined}
                    // The label span is CSS-hidden below header-full (T2–T4),
                    // and a display:none child contributes nothing to the
                    // accessible name — this is the icon-only tiers' real
                    // name, not decoration.
                    aria-label={item.label}
                  >
                    {active && <NavActiveFill theme={currentTheme} layoutId="nav-active-priority" />}
                    <Icon size={16} className="relative z-10" />
                    <NavLabel>{item.label}</NavLabel>
                  </Button>
                  <Tooltip.Content placement="bottom">{item.label}</Tooltip.Content>
                </Tooltip>
                {active && <NavIndicator activeKey={item.href} />}
              </div>
            );
          })}

          {overflowItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <div
                key={item.href}
                className="relative hidden h-full items-center header-mid:flex!"
              >
                <Tooltip delay={400}>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="relative"
                    style={{
                      font: "var(--nav-label-weight) var(--nav-label-size) var(--nav-label-font)",
                      letterSpacing: "var(--nav-label-tracking)",
                      textTransform: "var(--nav-label-case)" as CSSProperties["textTransform"],
                      color: active ? "var(--nav-active-fg)" : "var(--muted)",
                    }}
                    onPress={() => handleNavigate(item.href)}
                    onMouseEnter={() => play("hover")}
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                  >
                    {active && <NavActiveFill theme={currentTheme} layoutId="nav-active-overflow" />}
                    <Icon size={16} className="relative z-10" />
                    <NavLabel>{item.label}</NavLabel>
                  </Button>
                  <Tooltip.Content placement="bottom">{item.label}</Tooltip.Content>
                </Tooltip>
                {active && <NavIndicator activeKey={item.href} />}
              </div>
            );
          })}

          {/* "More" overflow — a desktop toolbar-overflow Dropdown, not a
              drawer (§9.2). Visible only below header-mid (900px, T3+T4).
              Its menu always contains all eight items; the priority four
              are CSS-hidden inside it except at T4 (<700px), where they
              have no standalone button to live in instead. */}
          <div className="relative flex h-full items-center header-mid:hidden!">
            <Dropdown trigger="press">
              <Tooltip delay={400}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="relative"
                  aria-label="More navigation items"
                  aria-current={moreHasActive ? "page" : undefined}
                  onMouseEnter={() => play("hover")}
                >
                  {activeInOverflowAlways && (
                    <NavActiveFill theme={currentTheme} layoutId="nav-active-more" />
                  )}
                  {activeInPriority && (
                    <span className="absolute inset-0 hidden max-header-min:block">
                      <NavActiveFill theme={currentTheme} layoutId="nav-active-more" />
                    </span>
                  )}
                  <Ellipsis size={16} className="relative z-10" />
                </Button>
                <Tooltip.Content placement="bottom">More</Tooltip.Content>
              </Tooltip>
              <Dropdown.Popover placement="bottom start">
                <Dropdown.Menu onAction={(key) => handleNavigate(String(key))}>
                  {navItems.map((item, index) => {
                    const Icon = item.icon;
                    const active = isActive(item.href);
                    const isPriority = index < PRIORITY_COUNT;
                    return (
                      <Dropdown.Item
                        key={item.href}
                        id={item.href}
                        textValue={item.label}
                        className={isPriority ? "header-min:hidden!" : undefined}
                        {...(active ? { "aria-current": "page" as const } : {})}
                      >
                        <Icon size={16} />
                        <Label>{item.label}</Label>
                      </Dropdown.Item>
                    );
                  })}
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
            {moreHasActive && (
              <span
                className={
                  activeInOverflowAlways ? undefined : "hidden max-header-min:block"
                }
              >
                <NavIndicator activeKey="more" />
              </span>
            )}
          </div>
        </nav>

        {/* Controls zone — fixed, shrink-0 (§9.1). */}
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip delay={400}>
            <Button
              isIconOnly
              variant="ghost"
              onPress={toggleSound}
              aria-label={soundEnabled ? "Mute sounds" : "Enable sounds"}
              onMouseEnter={() => play("hover")}
            >
              {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </Button>
            <Tooltip.Content placement="bottom">
              {soundEnabled ? "Mute sounds" : "Enable sounds"}
            </Tooltip.Content>
          </Tooltip>

          {/* Simple/Advanced mode switch. Persists app-wide via ModeProvider
              (app/components/ModeProvider.tsx). Individual ToggleButtons are
              NOT wrapped in Tooltip here: ToggleButtonGroup inspects its
              direct children (unique `id`s, first/last radius pairing) and
              an intervening Tooltip element breaks that — see the
              objection in the final report. aria-labels are kept so the
              accessible name survives regardless. */}
          <ToggleButtonGroup
            aria-label="App mode"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            isDisabled={switching}
            selectedKeys={[mode]}
            onSelectionChange={handleModeChange}
          >
            <ToggleButton id="simple" isIconOnly aria-label="Switch to Simple mode">
              <Sparkles size={14} />
            </ToggleButton>
            <ToggleButton id="advanced" isIconOnly aria-label="Switch to Advanced mode">
              <ToggleButtonGroup.Separator />
              <Container size={14} />
            </ToggleButton>
          </ToggleButtonGroup>

          {/* Theme selector. Fixed widths (not min-width) so switching
              between theme names never shifts navbar layout. header-mid:w-48
              (>=900px, T1/T2) comfortably fits the longest name, "Deepslate
              & Emerald" (~134px at the text-xs renderThemeValue forces
              below), plus the trigger's px-3 start padding and pe-7
              indicator reserve (HeroUI Select CSS). Below header-mid (T3/T4)
              there isn't enough row width for that, so it's w-32 there and
              leans on the truncate safety net instead — see renderThemeValue
              and its min-w-0 below for why truncation needs both to
              actually engage rather than silently overflowing the
              trigger's border. */}
          <Select
            className="w-32 shrink-0 header-mid:w-48"
            placeholder="Theme"
            value={theme}
            onChange={handleThemeChange}
          >
            <Label className="sr-only">Theme</Label>
            <Select.Trigger onMouseEnter={() => play("hover")}>
              <Select.Value className="min-w-0">{renderThemeValue}</Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox className="w-72">
                {themes.map((item) => (
                  <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
                    <div className="flex flex-col">
                      <Label>{item.label}</Label>
                      <Description className="text-xs">
                        {item.description}
                      </Description>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          {/* Ko-fi popover. Gated to header-full (>=1200px, T1) per §9.2 —
              replaces the old ad-hoc min-[1340px] hack, whose number came
              from the pre-revamp max-w-6xl + full-label math that no
              longer exists. */}
          <Popover isOpen={showKofi} onOpenChange={setShowKofi}>
            <Popover.Trigger className="hidden header-full:block">
              <Tooltip delay={400}>
                <Button
                  isIconOnly
                  variant="ghost"
                  onPress={() => play("click_confirm")}
                  aria-label="Support on Ko-fi"
                  onMouseEnter={() => play("hover")}
                >
                  <Coffee size={16} />
                </Button>
                <Tooltip.Content placement="bottom">Support on Ko-fi</Tooltip.Content>
              </Tooltip>
            </Popover.Trigger>
            <Popover.Content className="p-0" placement="bottom end">
              <Popover.Dialog className="w-85 overflow-hidden rounded-xl">
                <iframe
                  src="https://ko-fi.com/i4ctime/?hidefeed=true&widget=true&embed=true&preview=true"
                  title="i4ctime Ko-fi"
                  sandbox="allow-scripts allow-popups allow-forms allow-same-origin"
                  className="h-142.5 w-full"
                  style={{
                    border: "none",
                    padding: 4,
                    background: "#f9f9f9",
                  }}
                />
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>
      </div>
    </header>
  );
}
