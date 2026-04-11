import { type ReactNode, useEffect, useRef } from "react";
import { theme } from "../../lib/theme";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string | null;
  confirmStyle?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  confirmStyle = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <>
      <div className={theme.dialogBackdrop} onClick={onCancel} />
      <div className={theme.dialogCard}>
        <div className={theme.dialogTitle}>{title}</div>
        <div className={theme.dialogMessage}>{message}</div>
        <div className="flex justify-end gap-2">
          {cancelLabel !== null && (
            <button onClick={onCancel} className={theme.secondaryBtn}>
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={confirmStyle === "primary" ? theme.primaryBtn : theme.dangerBtn}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
