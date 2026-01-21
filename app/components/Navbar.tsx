"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
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
  const [theme, setTheme] = useState("emerald");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } =
    useSoundSettings();
  const { play } = useUISound();

  useEffect(() => {
    const stored = window.localStorage.getItem("mineui-theme");
    const initial = themes.find((item) => item.id === stored)
      ? stored!
      : "emerald";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("mineui-theme", theme);
  }, [theme]);

  const handleNavClick = () => {
    play("click_confirm");
    setMobileMenuOpen(false);
  };

  const handleThemeChange = (newTheme: string) => {
    play("toggle_on");
    setTheme(newTheme);
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
    <nav className="mc-nav">
      <div className="relative mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-6">
        {/* Animated glow background */}
        <motion.div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background:
              "radial-gradient(ellipse at 20% 50%, var(--mc-accent-soft), transparent 50%)",
          }}
          animate={{ opacity: [0.2, 0.5, 0.25] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Logo + Brand */}
        <Link
          href="/"
          className="relative z-10 flex items-center gap-3"
          onClick={handleNavClick}
          onMouseEnter={() => play("hover")}
        >
          <Logo size={28} />
          <span className="font-pixel text-sm tracking-wide text-[var(--mc-accent)]">
            MineUI
          </span>
        </Link>

        {/* Desktop Nav */}
        <div className="relative z-10 hidden items-center gap-1 md:flex">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all ${
                  active
                    ? "text-[var(--mc-accent)]"
                    : "text-[var(--mc-muted)] hover:text-[var(--foreground)]"
                }`}
                onClick={handleNavClick}
                onMouseEnter={() => play("hover")}
              >
                {active && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-lg"
                    style={{ background: "var(--mc-accent-soft)" }}
                    transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                  />
                )}
                <Icon size={16} className="relative z-10" />
                <span className="relative z-10">{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Right controls */}
        <div className="relative z-10 flex items-center gap-2">
          {/* Sound toggle */}
          <button
            onClick={toggleSound}
            className="mc-button px-2 py-2"
            title={soundEnabled ? "Mute sounds" : "Enable sounds"}
            onMouseEnter={() => play("hover")}
          >
            {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>

          {/* Theme selector */}
          <select
            className="mc-select hidden px-2 py-1.5 text-xs md:block"
            value={theme}
            onChange={(event) => handleThemeChange(event.target.value)}
            onMouseEnter={() => play("hover")}
          >
            {themes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>

          {/* Mobile menu toggle */}
          <button
            className="mc-button flex px-2 py-2 md:!hidden"
            onClick={() => {
              play("click_confirm");
              setMobileMenuOpen(!mobileMenuOpen);
            }}
          >
            {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
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
            style={{ borderColor: "var(--mc-panel-border)" }}
          >
            <div className="flex flex-col gap-1 p-4">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm transition-all ${
                      active
                        ? "bg-[var(--mc-accent-soft)] text-[var(--mc-accent)]"
                        : "text-[var(--mc-muted)] hover:bg-[var(--mc-accent-soft)] hover:text-[var(--foreground)]"
                    }`}
                    onClick={handleNavClick}
                  >
                    <Icon size={18} />
                    {item.label}
                  </Link>
                );
              })}
              <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--mc-panel-border)" }}>
                <label className="flex items-center gap-3 text-sm text-[var(--mc-muted)]">
                  Theme:
                  <select
                    className="mc-select flex-1 text-xs"
                    value={theme}
                    onChange={(event) => handleThemeChange(event.target.value)}
                  >
                    {themes.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
