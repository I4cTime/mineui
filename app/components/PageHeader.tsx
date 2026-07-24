"use client";

import { motion } from "motion/react";
import { type LucideIcon } from "lucide-react";
import { Card } from "@heroui/react";
import { fadeUp, transition } from "@/app/lib/motion";

interface PageHeaderProps {
  title: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
}

export default function PageHeader({ title, icon: Icon, actions }: PageHeaderProps) {
  return (
    <motion.header
      className="w-full"
      initial="hidden"
      animate="show"
      variants={fadeUp("base")}
    >
      <Card variant="transparent" className="w-full">
        <Card.Header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {Icon && (
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={transition("fast", { delay: 0.1 })}
              >
                <Icon size={22} className="text-accent" />
              </motion.div>
            )}
            <div>
              <h1 className="font-pixel text-lg uppercase tracking-[0.2em] text-accent">
                {title}
              </h1>
            </div>
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-3">{actions}</div>
          )}
        </Card.Header>
      </Card>
    </motion.header>
  );
}
