"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { interactiveTransition, transition } from "@/app/lib/motion";
import {
  Archive,
  Boxes,
  Gauge,
  Menu,
  ScrollText,
  Server,
  Settings,
  Shield,
  Users,
  Coffee,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  Button,
  Description,
  Label,
  ListBox,
  Popover,
  Select,
  Separator,
  Surface,
} from "@heroui/react";
import Logo from "./Logo";
import { useSoundSettings, useUISound } from "@/app/hooks/useUISound";

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
  return <span className="truncate">{selected.label}</span>;
};

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

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = useState<string | null>(DEFAULT_THEME);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showKofi, setShowKofi] = useState(false);
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } =
    useSoundSettings();
  const { play } = useUISound();
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
  }, [currentTheme]);

  const handleNavigate = (href: string) => {
    play("click_confirm");
    setMobileMenuOpen(false);
    router.push(href);
  };

  const handleThemeChange = (newTheme: string | number | null) => {
    if (newTheme === null) return;
    play("toggle_on");
    setTheme(String(newTheme));
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

  return (
    <Surface
      className="sticky top-0 z-40 border-b border-border backdrop-blur"
      style={{ background: "color-mix(in oklab, var(--background) 85%, transparent)" }}
    >
      <div className="relative mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-6">
        {/* Static glow background — was an infinite 6s pulse loop running on
            every page (it's in the navbar); the contract forbids ambient
            loops (docs/theme-contract.md §6), so this is now a fixed decal. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            background:
              "radial-gradient(ellipse at 20% 50%, color-mix(in oklab, var(--accent) 25%, transparent), transparent 55%)",
          }}
        />

        {/* Logo + Brand */}
        <Link
          href="/"
          className="relative z-10 flex items-center gap-3"
          onClick={() => play("click_confirm")}
          onMouseEnter={() => play("hover")}
        >
          <Logo size={28} />
          <span className="font-pixel text-sm tracking-wide text-accent">
            MineUI
          </span>
        </Link>

        {/* Desktop Nav */}
        <div className="relative z-10 hidden items-center gap-1 md:flex">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Button
                key={item.href}
                size="sm"
                variant={active ? "secondary" : "ghost"}
                className="relative"
                onPress={() => handleNavigate(item.href)}
                onMouseEnter={() => play("hover")}
                aria-current={active ? "page" : undefined}
              >
                {active && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-lg"
                    style={{
                      background:
                        "color-mix(in oklab, var(--accent) 18%, transparent)",
                    }}
                    transition={interactiveTransition()}
                  />
                )}
                <Icon size={16} className="relative z-10" />
                <span className="relative z-10">{item.label}</span>
              </Button>
            );
          })}
        </div>

        {/* Right controls */}
        <div className="relative z-10 flex items-center gap-2">
          {/* Sound toggle */}
          <Button
            isIconOnly
            variant="ghost"
            onPress={toggleSound}
            aria-label={soundEnabled ? "Mute sounds" : "Enable sounds"}
            onMouseEnter={() => play("hover")}
          >
            {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </Button>

          {/* Theme selector */}
          <Select
            className="text-xs w-36"
            placeholder="Theme"
            value={theme}
            onChange={handleThemeChange}
          >
            <Label className="sr-only">Theme</Label>
            <Select.Trigger onMouseEnter={() => play("hover")}>
              <Select.Value>{renderThemeValue}</Select.Value>
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

          {/* Ko-fi popover */}
          <Popover isOpen={showKofi} onOpenChange={setShowKofi}>
            <Popover.Trigger className="hidden md:block">
              <Button
                isIconOnly
                variant="ghost"
                onPress={() => play("click_confirm")}
                aria-label="Support on Ko-fi"
                onMouseEnter={() => play("hover")}
              >
                <Coffee size={16} />
              </Button>
            </Popover.Trigger>
            <Popover.Content className="p-0" placement="bottom end">
              <Popover.Dialog className="w-85 overflow-hidden rounded-xl">
                <iframe
                  src="https://ko-fi.com/i4cdeath/?hidefeed=true&widget=true&embed=true&preview=true"
                  title="i4cdeath Ko-fi"
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

          {/* Mobile menu toggle */}
          <Button
            isIconOnly
            variant="ghost"
            className="md:hidden!"
            onPress={() => {
              play("click_confirm");
              setMobileMenuOpen(!mobileMenuOpen);
            }}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </Button>
        </div>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition("base")}
            className="overflow-hidden border-t border-border md:hidden"
          >
            <div className="flex flex-col gap-2 p-4">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Button
                    key={item.href}
                    variant={active ? "secondary" : "ghost"}
                    className="justify-start"
                    onPress={() => handleNavigate(item.href)}
                  >
                    <Icon size={18} />
                    {item.label}
                  </Button>
                );
              })}
              <Separator className="my-2" />
              <Select
                className="w-full text-xs"
                placeholder="Theme"
                value={theme}
                onChange={handleThemeChange}
              >
                <Label>Theme</Label>
                <Select.Trigger>
                  <Select.Value>{renderThemeValue}</Select.Value>
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
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
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Surface>
  );
}
