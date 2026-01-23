"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
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
  Label,
  ListBox,
  Popover,
  Select,
  Separator,
  Surface,
} from "@heroui/react";
import Logo from "./Logo";
import { useSoundSettings, useUISound } from "@/app/hooks/useUISound";

const themes = [
  { id: "emerald", label: "Emerald" },
  { id: "ember", label: "Ember" },
  { id: "aether", label: "Aether" },
  { id: "void", label: "Void" },
];

const navItems = [
  { href: "/", label: "Dashboard", icon: Server },
  { href: "/status", label: "Status", icon: Gauge },
  { href: "/mods", label: "Mods", icon: Boxes },
  { href: "/players", label: "Players", icon: Users },
  { href: "/rcon", label: "RCON", icon: Shield },
  { href: "/config", label: "Config", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = useState<string | null>("emerald");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showKofi, setShowKofi] = useState(false);
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } =
    useSoundSettings();
  const { play } = useUISound();
  const currentTheme = typeof theme === "string" ? theme : "emerald";

  useEffect(() => {
    const stored = window.localStorage.getItem("mineui-theme");
    const initial = themes.find((item) => item.id === stored)
      ? stored!
      : "emerald";
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
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{ borderColor: "var(--border)", background: "color-mix(in oklab, var(--background) 85%, transparent)" }}
    >
      <div className="relative mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-6">
        {/* Animated glow background */}
        <motion.div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background:
              "radial-gradient(ellipse at 20% 50%, color-mix(in oklab, var(--accent) 25%, transparent), transparent 55%)",
          }}
          animate={{ opacity: [0.2, 0.5, 0.25] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Logo + Brand */}
        <Link
          href="/"
          className="relative z-10 flex items-center gap-3"
          onClick={() => play("click_confirm")}
          onMouseEnter={() => play("hover")}
        >
          <Logo size={28} />
          <span className="font-pixel text-sm tracking-wide text-[var(--accent)]">
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
                    transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
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
            className="text-xs w-26"
            placeholder="Theme"
            value={theme}
            onChange={handleThemeChange}
          >
            <Label className="sr-only">Theme</Label>
            <Select.Trigger onMouseEnter={() => play("hover")}>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {themes.map((item) => (
                  <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
                    {item.label}
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
              <Popover.Dialog className="w-[340px] overflow-hidden rounded-xl">
                <iframe
                  src="https://ko-fi.com/i4cdeath/?hidefeed=true&widget=true&embed=true&preview=true"
                  title="i4cdeath Ko-fi"
                  className="h-[520px] w-full"
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
            className="md:!hidden"
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
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t md:hidden"
            style={{ borderColor: "var(--border)" }}
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
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {themes.map((item) => (
                      <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
                        {item.label}
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
