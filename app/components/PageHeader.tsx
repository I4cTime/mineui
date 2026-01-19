"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { useUISound } from "@/app/hooks/useUISound";

interface PageHeaderProps {
  title: string;
  icon?: LucideIcon;
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
}

export default function PageHeader({
  title,
  icon: Icon,
  backHref = "/",
  backLabel = "Back to dashboard",
  actions,
}: PageHeaderProps) {
  const { play } = useUISound();

  return (
    <motion.header
      className="flex flex-wrap items-center justify-between gap-4"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-3">
        {Icon && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            <Icon size={22} className="text-[var(--mc-accent)]" />
          </motion.div>
        )}
        <h1 className="mc-title mc-glow">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {actions}
        <Link
          className="mc-button"
          href={backHref}
          onClick={() => play("click_back")}
          onMouseEnter={() => play("hover")}
        >
          <ArrowLeft size={16} />
          {backLabel}
        </Link>
      </div>
    </motion.header>
  );
}
