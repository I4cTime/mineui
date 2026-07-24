import type { Metadata } from "next";
import { MotionConfig } from "motion/react";
import { Toast } from "@heroui/react";

// Fonts are self-hosted via @fontsource (offline-safe for the Tauri
// desktop build — zero runtime network fetches). Which family renders
// is decided per-theme by the CSS vars in app/themes/*.css.
// Contract: docs/theme-contract.md.
import "@fontsource-variable/inter"; // deepslate + quantum sans
import "@fontsource-variable/jetbrains-mono"; // deepslate + quantum mono
import "@fontsource-variable/space-grotesk"; // quantum display
import "@fontsource-variable/ibm-plex-sans"; // phosphor sans
import "@fontsource/ibm-plex-mono/latin-400.css"; // phosphor mono
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "@fontsource-variable/figtree"; // softglass sans
import "@fontsource/commit-mono/latin-400.css"; // softglass mono
import "@fontsource/commit-mono/latin-500.css";
// Monocraft (deepslate pixel numerals) is vendored: app/fonts/ + @font-face in globals.css

import "./globals.css";
import Navbar from "@/app/components/Navbar";

export const metadata: Metadata = {
  title: "MineUI",
  description: "Local Minecraft server control panel",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        {/* Global reduced-motion handling (task: "respect prefers-reduced-
            motion globally"): Motion auto-strips transform/layout animation
            for users with the OS-level preference set, app-wide, without
            every component needing its own useReducedMotion() branch. */}
        <MotionConfig reducedMotion="user">
          <Navbar />
          {children}
          <Toast.Provider placement="bottom end" />
        </MotionConfig>
      </body>
    </html>
  );
}
