import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Input, Modal } from ".";
import { cn } from "../../lib/cn";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body message (string or rich node). */
  message: React.ReactNode;
  confirmLabel?: string;
  /** When set, the confirm button is disabled until the user types this exactly. */
  confirmText?: string;
  /** Styles the confirm button + header icon as destructive (default true). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog built on Modal (no confirm primitive exists). Optional
 * `confirmText` adds a typed-name gate for irreversible actions (e.g. deleting
 * a workspace, which rm -rf's all its projects). Layout mirrors AuthModal.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = "Delete",
  confirmText,
  danger = true,
  onConfirm,
  onCancel
}) => {
  const [typed, setTyped] = useState("");

  // Reset the typed gate whenever the dialog (re)opens.
  React.useEffect(() => {
    if (open) {
      setTyped("");
    }
  }, [open]);

  const gateOk = !confirmText || typed === confirmText;

  const confirm = () => {
    if (gateOk) {
      onConfirm();
    }
  };

  return (
    <Modal open={open} onClose={onCancel} className="max-w-sm">
      <div className="w-full p-5">
        <div className="mb-3 flex items-center gap-2">
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md",
              danger ? "bg-red-500/10 text-red-400" : "bg-neutral-800 text-neutral-300"
            )}
          >
            <AlertTriangle size={16} />
          </span>
          <p className="text-sm font-medium text-neutral-100">{title}</p>
        </div>

        <div className="text-sm text-neutral-400">{message}</div>

        {confirmText && (
          <Input
            autoFocus
            className="mt-3"
            placeholder={confirmText}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                confirm();
              }
            }}
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!gateOk}
            onClick={confirm}
            className={cn(
              danger && "bg-red-600 text-white hover:bg-red-500",
              danger && "disabled:bg-red-600/40 disabled:text-white/70"
            )}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
