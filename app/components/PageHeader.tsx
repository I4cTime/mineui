"use client";

import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { Button, Card } from "@heroui/react";
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
  const router = useRouter();
  const { play } = useUISound();

  return (
    <motion.header
      className="w-full"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Card variant="transparent" className="w-full">
        <Card.Header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {Icon && (
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1 }}
              >
                <Icon size={22} className="text-[var(--accent)]" />
              </motion.div>
            )}
            <div>
              <h1 className="font-pixel text-lg uppercase tracking-[0.2em] text-[var(--accent)]">
                {title}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {actions}
            <Button
              variant="secondary"
              onPress={() => {
                play("click_back");
                router.push(backHref);
              }}
              onMouseEnter={() => play("hover")}
            >
              <ArrowLeft size={16} />
              {backLabel}
            </Button>
          </div>
        </Card.Header>
      </Card>
    </motion.header>
  );
}
