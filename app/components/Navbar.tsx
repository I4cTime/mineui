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
  Ellipsis,
  Gauge,
  ScrollText,
  Server,
  Settings,
  Shield,
  SlidersHorizontal,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  Button,
  Dropdown,
  Label,
  Popover,
  Tooltip,
} from "@heroui/react";
import Logo from "./Logo";
import ServerSwitcher from "./ServerSwitcher";
import { useSoundSettings, useUISound } from "@/app/hooks/useUISound";
import { applyTheme, useTheme } from "@/app/hooks/useTheme";
import { applyColorMode, useColorMode } from "@/app/hooks/useColorMode";
import { leaveOr } from "@/app/lib/leaveGuard";
import { useMediaQuery } from "@/app/hooks/useMediaQuery";

// Priority order is load-bearing (docs/theme-contract.md §9.2): the first
// four are the T3 standalone set and the T3 "More" overflow always holds
// exactly items[4:]. Do not re-rank.
// `description` is the tooltip body at icon-only tiers (§9.6): what the page
// is for, not a repeat of the label.
const navItems = [
  { href: "/", label: "Dashboard", icon: Server, description: "Start, stop and watch the live log" },
  { href: "/status", label: "Status", icon: Gauge, description: "TPS, resources and the activity log" },
  { href: "/mods", label: "Mods", icon: Boxes, description: "Installed mods and plugins" },
  { href: "/players", label: "Players", icon: Users, description: "Who's on, history and notes" },
  { href: "/rcon", label: "Console", icon: Shield, description: "Send commands to the running server" },
  { href: "/config", label: "Config", icon: ScrollText, description: "Edit server.properties and configs" },
  { href: "/backups", label: "Backups", icon: Archive, description: "World backups and restore" },
  { href: "/settings", label: "Settings", icon: Settings, description: "This server: name, schedule, backups, advanced" },
];

/** Tooltip body for a nav item: label + what the page is for. */
function NavTooltip({ label, description }: { label: string; description: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold">{label}</span>
      <span className="text-muted">{description}</span>
    </span>
  );
}

// §9.2 tiers as media queries (the same `header-full` / `header-mid`
// screens as the CSS variants). Two things must NOT merely be CSS-hidden:
// react-aria's Pressable/PressResponder treat a display:none trigger as
// unfocusable and warn on every mount, so the Ko-fi popover (T1 only) and
// the More overflow (below header-mid only) are rendered conditionally.
// Nav tooltips are likewise disabled at T1, where the label is visible.
const LABELS_VISIBLE_QUERY = "(min-width: 80rem)";
const OVERFLOW_QUERY = "(max-width: 56.24rem)";

const PRIORITY_COUNT = 4;

// App-wide settings (server list, theme) - a controls-zone button, not a
// nav item: the nav holds per-server pages only (§9.1 scope split).
const APP_SETTINGS_HREF = "/app-settings";

/**
 * Active-item background/shadow/radius treatment - the shared skeleton
 * that renders all four themes' character purely off the --nav-active-*
 * vars (docs/theme-contract.md §9.1, §9.3). Phosphor's fill is transparent
 * by design (its treatment is the underline strip below, not a fill), and
 * per §9.6 it must NOT participate in the shared layoutId slide - it
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

/** The bottom-edge underline strip - zero-height in every theme except
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

/** Label span shown in full at T1 (header-full, >=1280px) and hidden
 * (icon-only) at every narrower tier. */
function NavLabel({ children }: { children: ReactNode }) {
  return <span className="relative z-10 hidden header-full:inline">{children}</span>;
}

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme: currentTheme } = useTheme();
  const labelsVisible = useMediaQuery(LABELS_VISIBLE_QUERY);
  const overflowTier = useMediaQuery(OVERFLOW_QUERY);
  const [showKofi, setShowKofi] = useState(false);
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } =
    useSoundSettings();
  const { play } = useUISound();

  // The navbar mounts on every page, so this is where the stored theme is
  // stamped on <html> after hydration (the server render stays deepslate to
  // avoid a mismatch). The picker itself lives in Settings → Appearance.
  useEffect(() => {
    applyTheme(currentTheme);
  }, [currentTheme]);
  // Same for the color mode (dark / light / match system, contract §10);
  // public/theme-init.js already stamped both before first paint.
  const { preference: colorModePreference } = useColorMode();
  useEffect(() => {
    applyColorMode(colorModePreference);
  }, [colorModePreference]);

  const handleNavigate = (href: string) => {
    play("click_confirm");
    leaveOr(() => router.push(href));
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
  // therefore only meaningful at T4 - gated with `header-min:hidden` below.
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
          into all four themes - quantum's glow now lives entirely in
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

        {/* Nav zone - the only zone that adapts (§9.1). min-w-0 lets it
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
                <Tooltip delay={400} isDisabled={labelsVisible}>
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
                    // accessible name - this is the icon-only tiers' real
                    // name, not decoration.
                    aria-label={item.label}
                  >
                    {active && <NavActiveFill theme={currentTheme} layoutId="nav-active-priority" />}
                    <Icon size={16} className="relative z-10" />
                    <NavLabel>{item.label}</NavLabel>
                  </Button>
                  <Tooltip.Content placement="bottom">
                    <NavTooltip label={item.label} description={item.description} />
                  </Tooltip.Content>
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
                <Tooltip delay={400} isDisabled={labelsVisible}>
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
                  <Tooltip.Content placement="bottom">
                    <NavTooltip label={item.label} description={item.description} />
                  </Tooltip.Content>
                </Tooltip>
                {active && <NavIndicator activeKey={item.href} />}
              </div>
            );
          })}

          {/* "More" overflow - a desktop toolbar-overflow Dropdown, not a
              drawer (§9.2). Visible only below header-mid (900px, T3+T4).
              Its menu always contains all eight items; the priority four
              are CSS-hidden inside it except at T4 (<700px), where they
              have no standalone button to live in instead. */}
          {overflowTier && (
          <div className="relative flex h-full items-center header-mid:hidden!">
            {/* Tooltip outside, the Button as the MenuTrigger's direct
                child: react-aria's PressResponder is
                consumed by the very next pressable, and a Tooltip in between
                left it unconsumed ("PressResponder was rendered without a
                pressable child"). The Button still picks up the tooltip's
                focusable props through context. */}
            <Tooltip delay={400}>
              <Dropdown trigger="press">
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
              <Tooltip.Content placement="bottom">
                <NavTooltip label="More" description="RCON, Config, Backups, Settings" />
              </Tooltip.Content>
            </Tooltip>
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
          )}
        </nav>

        {/* Controls zone - fixed, shrink-0 (§9.1). */}
        <div className="flex shrink-0 items-center gap-1">
          {/* This server: which one the pages show (§9.1). How it is run
              (Simple / Advanced) is changed in Server Settings only - a
              one-click header toggle made a server look deleted. */}
          <ServerSwitcher />

          {/* The app: sound, app-wide settings, Ko-fi. */}
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

          <Tooltip delay={400}>
            <Button
              isIconOnly
              variant="ghost"
              onPress={() => handleNavigate(APP_SETTINGS_HREF)}
              aria-label="App settings"
              aria-current={isActive(APP_SETTINGS_HREF) ? "page" : undefined}
              style={
                isActive(APP_SETTINGS_HREF) ? { color: "var(--nav-active-fg)" } : undefined
              }
              onMouseEnter={() => play("hover")}
            >
              <SlidersHorizontal size={16} />
            </Button>
            <Tooltip.Content placement="bottom">
              <NavTooltip label="App settings" description="Servers, theme and accent" />
            </Tooltip.Content>
          </Tooltip>

          {labelsVisible && (
          <Popover isOpen={showKofi} onOpenChange={setShowKofi}>
            {/* Popover.Trigger is HeroUI's pressable (a react-aria Pressable
                around a role="button" div). It needs tabIndex to be
                focusable - omitted, it logs "<Pressable> child must be
                focusable" - and it must be the only interactive element:
                nesting a Button inside it, or wrapping it in a Tooltip,
                leaves the DialogTrigger's PressResponder unconsumed. So the
                trigger is styled as the ghost icon button itself. */}
            <Popover.Trigger
              tabIndex={0}
              aria-label="Support on Ko-fi"
              className="hidden size-8 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 header-full:inline-flex"
              style={{ outlineColor: "var(--focus)" }}
              onClick={() => play("click_confirm")}
              onMouseEnter={() => play("hover")}
            >
              <Coffee size={16} />
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
          )}
        </div>
      </div>
    </header>
  );
}
