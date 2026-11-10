/**
 * A block's passes in the run view (spec 2026-11-10 §7.4): a loop ran it
 * again, so the details pane offers one chip per pass (#1, #2, …) — each
 * showing how that pass ended — and picking one shows that pass's status,
 * output, error, report, sessions and decision, and opens its chat. A pass
 * that started from a loop says what the loop brought back (its feedback)
 * and, when it could not continue the previous chat, why it is in a new one.
 */

import React from "react";
import { IterationCcw, MessageSquareWarning } from "lucide-react";

import type { WorkflowBlockRun } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { passChips, passNotes, type PassChip } from "../../../lib/workflows/passes";
import { formatStepDuration } from "../../../lib/workflows/run-view";
import { FOCUS_RING, RunSectionLabel, StatusGlyph, TONE_TEXT } from "./shared";

type ChipNode = Parameters<typeof passChips>[1];

/** One chip per pass; [] (nothing drawn) for a block that ran once. */
export const PassChips: React.FC<{
  /** The block as the run holds it (its latest pass). */
  block: WorkflowBlockRun | undefined;
  node: ChipNode;
  now: number;
  /** The pass shown. */
  selected: number;
  onSelect: (pass: number) => void;
  sheet?: boolean;
  className?: string;
}> = ({ block, node, now, selected, onSelect, sheet = false, className }) => {
  const chips = passChips(block, node, now);
  if (chips.length === 0) return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      <RunSectionLabel aside={<span className="text-[11px] tabular-nums text-neutral-500">{chips.length} passes</span>}>
        Passes
      </RunSectionLabel>
      <div role="group" aria-label="Passes" className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <PassChipButton key={chip.pass} chip={chip} selected={chip.pass === selected} onSelect={onSelect} sheet={sheet} />
        ))}
      </div>
    </div>
  );
};

const PassChipButton: React.FC<{ chip: PassChip; selected: boolean; onSelect: (pass: number) => void; sheet: boolean }> = ({
  chip,
  selected,
  onSelect,
  sheet
}) => {
  const duration = formatStepDuration(chip.durationMs);
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${chip.description}${duration ? ` · ${duration}` : ""}${chip.latest ? " · the latest pass" : ""}`}
      title={chip.description}
      onClick={() => onSelect(chip.pass)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium tabular-nums transition-colors",
        FOCUS_RING,
        sheet ? "h-10 min-w-12 px-3" : "h-7",
        selected
          ? "border-neutral-500 bg-neutral-800 text-neutral-50"
          : "border-neutral-800 text-neutral-300 hover:border-neutral-700 hover:bg-neutral-800/50"
      )}
    >
      <StatusGlyph icon={chip.view.icon} tone={chip.view.tone} size={sheet ? 14 : 12} />
      {chip.label}
      {chip.latest ? <span className={cn("text-[10px] font-normal", selected ? "text-neutral-400" : "text-neutral-500")}>latest</span> : null}
    </button>
  );
};

/** The loop's feedback this pass started with, and why it is in a new chat. Nothing when neither applies. */
export const PassNotes: React.FC<{ block: WorkflowBlockRun | undefined; className?: string }> = ({ block, className }) => {
  const notes = passNotes(block);
  if (!notes.feedback && !notes.sessionNote) return null;
  return (
    <div className={cn("space-y-2", className)}>
      {notes.sessionNote ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-warn/25 bg-warn/5 px-3 py-2 text-xs leading-5 text-warn">
          <MessageSquareWarning size={13} aria-hidden className="mt-[3px] shrink-0" />
          <span className="min-w-0 break-words">{capitalised(notes.sessionNote)}</span>
        </p>
      ) : null}
      {notes.feedback ? (
        <figure className="rounded-lg border border-info/25 bg-info/5 px-3 py-2">
          <figcaption className={cn("flex items-center gap-1.5 text-[11px] font-medium", TONE_TEXT.info)}>
            <IterationCcw size={12} aria-hidden />
            Feedback from the loop
          </figcaption>
          <blockquote className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-neutral-200">
            {notes.feedback}
          </blockquote>
        </figure>
      ) : null}
    </div>
  );
};

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
