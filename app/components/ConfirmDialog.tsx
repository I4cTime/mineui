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
  /** Keep the confirm button off until a condition in `footer` is met. */
  isConfirmDisabled?: boolean;
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
  isConfirmDisabled = false,
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

  // Controlled: Backdrop without the <AlertDialog> root, whose DialogTrigger
  // expects a pressable child and logs "PressResponder was rendered without
  // a pressable child" on every mount when there is none.
  return (
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
            {footer && <div className="mt-4">{footer}</div>}
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
              isDisabled={isLoading || isConfirmDisabled}
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
  );
}
