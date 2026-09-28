/**
 * The agent's global instruction file as one card at the top of the list —
 * "CLAUDE.md · 42 lines · edited 2h ago" — opening the instructions editor.
 * Its warnings (a Codex override file that shadows it, a dead Grok `GROK.md`)
 * are amber chips on the card. In a narrow panel (`compact`) the file icon
 * gives its room to the text.
 */

import React from "react";
import { AlertTriangle, ChevronRight, FileText } from "lucide-react";

import type { ProfileInstructionsInfo } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { railCardClass } from "../primitives";
import { instructionsLine } from "./list.logic";

/**
 * An amber warning. It wraps rather than truncates: a phone has no tooltip
 * to read the rest in, and the message is the whole point of the chip.
 */
export const WarningChip: React.FC<{ message: string; className?: string }> = ({ message, className }) => (
  <span
    className={cn(
      "inline-flex min-w-0 max-w-full items-start gap-1 rounded-md border border-warn-500/40 bg-warn-500/10 px-1.5 py-px text-[11px] leading-4 text-warn",
      className
    )}
  >
    <AlertTriangle size={10} aria-hidden className="mt-[3px] shrink-0" />
    <span className="min-w-0 break-words">{message}</span>
  </span>
);

export const InstructionsCard: React.FC<{
  info: ProfileInstructionsInfo;
  now: number;
  sheet: boolean;
  /** A narrow panel: no file icon. */
  compact?: boolean;
  onOpen: () => void;
}> = ({ info, now, sheet, compact = false, onOpen }) => {
  const { fileName, detail } = instructionsLine(info, now);
  return (
    <button
      type="button"
      data-profile-instructions=""
      title={info.path ? `Edit ${info.path}` : "Edit the instructions"}
      onClick={onOpen}
      className={cn(
        railCardClass(false),
        "group flex w-full items-center gap-3 pl-3 pr-1 text-left",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        sheet ? "min-h-14 py-2.5" : "min-h-12 py-2"
      )}
    >
      {compact ? null : (
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800/80 text-neutral-300 ring-1 ring-neutral-700/60"
        >
          <FileText size={15} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-neutral-100">
          {fileName}
          <span className="sr-only">, the agent's instructions</span>
        </span>
        <span className={cn("block truncate text-xs", info.exists ? "text-neutral-500" : "text-neutral-400")}>
          {detail}
        </span>
        {info.warnings.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1">
            {info.warnings.map((warning, index) => (
              <WarningChip key={`${index}:${warning.code}`} message={warning.message} />
            ))}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center self-stretch text-neutral-500 transition-colors group-hover:text-neutral-200",
          sheet ? "w-10" : compact ? "w-6" : "w-8"
        )}
      >
        <ChevronRight size={15} />
      </span>
    </button>
  );
};
