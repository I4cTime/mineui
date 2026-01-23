"use client";

import { ReactNode, useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { AlertDialog, Button } from "@heroui/react";
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
    <AlertDialog>
      <AlertDialog.Backdrop
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) handleCancel();
        }}
        isDismissable
        isKeyboardDismissDisabled={false}
        variant="blur"
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status={variant === "danger" ? "danger" : "accent"}>
                {variant === "danger" && <AlertTriangle className="size-5" />}
              </AlertDialog.Icon>
              <AlertDialog.Heading className="font-pixel text-sm uppercase tracking-[0.2em]">
                {title}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              {description && <p className="text-sm text-muted">{description}</p>}
              {footer}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                variant="tertiary"
                onPress={handleCancel}
                isDisabled={isLoading}
                onMouseEnter={() => play("hover")}
              >
                {cancelLabel}
              </Button>
              <Button
                variant={variant === "danger" ? "danger" : "primary"}
                onPress={handleConfirm}
                isDisabled={isLoading}
                isPending={isLoading}
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
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
