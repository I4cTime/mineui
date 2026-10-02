"use client";

import { motion } from "motion/react";
import { type LucideIcon } from "lucide-react";
import { fadeUp } from "@/app/lib/motion";
import ServerIdentity from "@/app/components/ServerIdentity";

interface PageHeaderProps {
  title: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  /** "server" (default): the page shows one server, which the header names.
   *  "app": the page is about MineUI itself, not any one server. */
  scope?: "server" | "app";
}

/**
 * One compact row (docs/theme-contract.md §9 page header): icon · title ·
 * whose page this is · actions. Wraps before it truncates.
 */
export default function PageHeader({
  title,
  icon: Icon,
  actions,
  scope = "server",
}: PageHeaderProps) {
  return (
    <motion.header
      className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-3"
      initial="hidden"
      animate="show"
      variants={fadeUp("base")}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-2.5">
          {Icon && <Icon size={18} className="shrink-0 text-accent" />}
          <h1 className="font-pixel text-base uppercase tracking-[0.2em] text-accent">
            {title}
          </h1>
        </div>
        <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
        {scope === "server" ? (
          <ServerIdentity />
        ) : (
          <span className="text-xs text-muted">All servers</span>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </motion.header>
  );
}
