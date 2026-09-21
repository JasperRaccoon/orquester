import React from "react";
import { FileText, Image as ImageIcon, RotateCcw, X } from "lucide-react";
import type { AttachmentRef } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { ChatIconButton } from "../primitives";

/** One file staged in the draft, with the state of its own upload. */
export interface StagedAttachment {
  key: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  status: "uploading" | "ready" | "failed";
  /** 0–1 while uploading; the chip draws it as a fill, never as a number. */
  progress: number;
  ref?: AttachmentRef;
  error?: string;
}

export interface ComposerAttachmentsProps {
  attachments: readonly StagedAttachment[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  disabled?: boolean;
}

/**
 * The attachment chips.
 *
 * **Upload progress is a fill behind the name, not a percentage.** A number
 * that ticks changes width and makes the whole row twitch; the fill says the
 * same thing and stays still. A failed upload keeps its chip and offers a
 * retry, because the alternative — dropping the file silently — leaves the
 * user sending a message that no longer references what they attached.
 *
 * *T3: `docs/user/composer.md:20-24` — "Uploads begin when you add an
 * attachment. All uploads must finish before the message can send. Retry or
 * remove a failed upload."*
 */
export function ComposerAttachments({
  attachments,
  onRemove,
  onRetry,
  disabled
}: ComposerAttachmentsProps): React.ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <div
      data-chat-composer-attachments="true"
      className="flex flex-wrap items-center gap-1.5 pb-2"
    >
      {attachments.map((attachment) => {
        const isImage = attachment.mimeType.startsWith("image/");
        const failed = attachment.status === "failed";
        return (
          <span
            key={attachment.key}
            title={attachment.error ?? attachment.name}
            className={cn(
              "relative inline-flex h-7 max-w-56 items-center gap-1.5 overflow-hidden rounded-md",
              "border px-2 text-[11px]",
              failed
                ? "border-danger-900/50 bg-danger-soft/40 text-danger-300"
                : "border-neutral-800 bg-neutral-900/60 text-neutral-300"
            )}
          >
            {attachment.status === "uploading" ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-neutral-800/70 transition-[width] duration-200"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, attachment.progress)) * 100)}%` }}
              />
            ) : null}
            <span className="relative shrink-0 text-neutral-500">
              {isImage ? <ImageIcon size={11} aria-hidden /> : <FileText size={11} aria-hidden />}
            </span>
            <span className="relative truncate">{attachment.name}</span>
            {failed ? (
              <ChatIconButton
                label={`Retry ${attachment.name}`}
                size="micro"
                disabled={disabled}
                className="relative"
                onClick={() => onRetry(attachment.key)}
              >
                <RotateCcw size={10} aria-hidden />
              </ChatIconButton>
            ) : null}
            <ChatIconButton
              label={`Remove ${attachment.name}`}
              size="micro"
              disabled={disabled}
              className="relative"
              onClick={() => onRemove(attachment.key)}
            >
              <X size={10} aria-hidden />
            </ChatIconButton>
          </span>
        );
      })}
    </div>
  );
}
