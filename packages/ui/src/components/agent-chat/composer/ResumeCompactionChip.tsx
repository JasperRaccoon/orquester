import React from "react";
import { Minimize2 } from "lucide-react";

import { cn } from "../../../lib/cn";
import { formatContextTokens } from "../status/context-meter";

const CHIP =
  "ac-press inline-flex h-7 max-w-full items-center gap-1 rounded-md px-2 text-xs " +
  "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-40";

export interface ResumeCompactionChipProps {
  /** The context the expired cache held (`resumeCompactionOffer`). */
  tokens: number;
  /** The user switched it to Full: this message keeps the whole history. */
  keepFullHistory: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/**
 * Idle compaction's "When you return" (`resume-compaction.logic.ts`): **Compact** while sending
 * compacts the chat first, **Full** to keep the whole history for this message.
 * *T3: the composer's resume Compact chip.*
 */
export function ResumeCompactionChip({ tokens, keepFullHistory, disabled, onToggle }: ResumeCompactionChipProps): React.ReactElement {
  const size = formatContextTokens(tokens);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={!keepFullHistory}
      title={
        keepFullHistory
          ? `Send with the full ${size}-token history. Click to compact it first.`
          : `Claude's prompt cache for this chat expired: sending compacts its ${size} tokens first, so the whole history is not re-read. Click to keep the full history.`
      }
      onClick={onToggle}
      className={cn(CHIP, !keepFullHistory && "bg-info-soft/40 text-info-300 hover:bg-info-soft/60 hover:text-info-300")}
    >
      <Minimize2 size={12} aria-hidden className="shrink-0" />
      <span className="truncate">
        {keepFullHistory ? "Full" : "Compact"} <span className="ac-tabular">{size}</span>
      </span>
    </button>
  );
}
