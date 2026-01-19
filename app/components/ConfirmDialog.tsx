"use client";

import { ReactNode, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useUISound } from "@/app/hooks/useUISound";

type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isLoading?: boolean;
  variant?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  footer?: ReactNode;
};

export default function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  isLoading = false,
  variant = "default",
  onConfirm,
  onCancel,
  footer,
}: ConfirmDialogProps) {
  const { play } = useUISound();

  useEffect(() => {
    if (isOpen) {
      play("notification");
    }
  }, [isOpen, play]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        play("click_back");
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onCancel, play]);

  const handleCancel = () => {
    play("click_back");
    onCancel();
  };

  const handleConfirm = () => {
    play("click_confirm");
    onConfirm();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0"
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
            onClick={handleCancel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Dialog */}
          <motion.div
            className="mc-panel relative z-10 w-full max-w-md p-6"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.4 }}
          >
            <div className="flex items-start gap-4">
              {variant === "danger" && (
                <motion.div
                  className="flex-shrink-0 rounded-full p-2"
                  style={{ background: "var(--mc-accent-soft)" }}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.1, type: "spring", bounce: 0.5 }}
                >
                  <AlertTriangle size={20} style={{ color: "var(--mc-accent)" }} />
                </motion.div>
              )}
              <div className="flex-1">
                <motion.div
                  className="font-pixel text-base tracking-wide"
                  style={{ color: "var(--mc-accent)" }}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.05 }}
                >
                  {title}
                </motion.div>
                {description && (
                  <motion.div
                    className="mt-2 text-sm"
                    style={{ color: "var(--mc-muted)" }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.1 }}
                  >
                    {description}
                  </motion.div>
                )}
              </div>
            </div>

            {footer && (
              <motion.div
                className="mt-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.15 }}
              >
                {footer}
              </motion.div>
            )}

            <motion.div
              className="mt-6 flex items-center justify-end gap-3"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
            >
              <button
                className="mc-button"
                onClick={handleCancel}
                disabled={isLoading}
                onMouseEnter={() => play("hover")}
              >
                {cancelLabel}
              </button>
              <button
                className="mc-button"
                onClick={handleConfirm}
                disabled={isLoading}
                onMouseEnter={() => play("hover")}
              >
                {isLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Working...
                  </>
                ) : (
                  confirmLabel
                )}
              </button>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
