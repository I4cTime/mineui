"use client";

import { motion } from "motion/react";

interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
}

export function Skeleton({ className = "", width, height }: SkeletonProps) {
  return (
    <div
      className={`mc-skeleton ${className}`}
      style={{ width, height }}
    />
  );
}

export function SkeletonText({
  lines = 1,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={16}
          className="rounded"
          width={i === lines - 1 && lines > 1 ? "60%" : "100%"}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <motion.div
      className={`mc-panel p-5 ${className}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-3">
        <Skeleton width={18} height={18} className="rounded" />
        <Skeleton width={100} height={14} className="rounded" />
      </div>
      <div className="mt-4 space-y-3">
        <Skeleton height={24} className="rounded" width="40%" />
        <SkeletonText lines={3} />
      </div>
    </motion.div>
  );
}

export function SkeletonTable({
  rows = 5,
  cols = 4,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--mc-panel-border)" }}>
      <div className="bg-[var(--mc-panel)] p-4">
        <div className="flex gap-4">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} height={12} className="flex-1 rounded" />
          ))}
        </div>
      </div>
      <div className="divide-y" style={{ borderColor: "var(--mc-panel-border)" }}>
        {Array.from({ length: rows }).map((_, row) => (
          <div key={row} className="flex gap-4 p-4">
            {Array.from({ length: cols }).map((_, col) => (
              <Skeleton key={col} height={16} className="flex-1 rounded" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
