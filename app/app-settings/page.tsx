"use client";

// App Settings: everything that is about MineUI itself rather than about one
// server — the server list and the look of the app. Per-server settings
// (mode, connection, schedule, backups, RCON) live on /settings. Reached from
// the header's controls zone, not the nav (docs/theme-contract.md §9.1).
import { motion } from "motion/react";
import { SlidersHorizontal } from "lucide-react";
import AppearanceCard from "@/app/components/AppearanceCard";
import PageHeader from "@/app/components/PageHeader";
import ServersCard from "@/app/components/ServersCard";
import { usePageMotion } from "@/app/lib/motion";

export default function AppSettingsPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(circle at top, color-mix(in oklab, var(--accent) 18%, transparent), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-5 pb-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="App Settings" icon={SlidersHorizontal} scope="app" />
        <motion.section variants={cardMotion}>
          <ServersCard />
        </motion.section>
        <motion.section variants={cardMotion}>
          <AppearanceCard />
        </motion.section>
      </motion.main>
    </div>
  );
}
