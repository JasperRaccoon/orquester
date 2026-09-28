/**
 * Run now (workflows spec §6.3, §7.2): an optional JSON input — prefilled with
 * the manual trigger's example — checked as JSON before it goes, then the run.
 * An overlap skip is not a failure: it says so and offers "Run anyway".
 */

import React, { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Play } from "lucide-react";

import { cn } from "../../lib/cn";
import { Popover } from "./ui/Popover";
import { SmallButton } from "./ui/controls";

export type RunNowResult = { ok: true; runId: string | null; skipped?: "overlap" | "missed" } | { ok: false; error: string };

export interface RunNowPopoverProps {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
  /** The manual trigger's example input, if any. */
  example: string;
  /** Errors the daemon will refuse the run for (validation). */
  blockingErrors: number;
  onRun: (input: unknown, options: { force: boolean }) => Promise<RunNowResult>;
}

export const RunNowPopover: React.FC<RunNowPopoverProps> = ({ open, anchor, onClose, example, blockingErrors, onRun }) => {
  const [text, setText] = useState(example);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText(example);
    setError(null);
    setSkipped(false);
  }, [open, example]);

  const parse = (): { ok: true; value: unknown } | { ok: false } => {
    if (text.trim() === "") return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (reason) {
      setError(`Not valid JSON: ${reason instanceof Error ? reason.message : String(reason)}`);
      return { ok: false };
    }
  };

  const run = async (force: boolean): Promise<void> => {
    const parsed = parse();
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    const result = await onRun(parsed.value, { force });
    setBusy(false);
    if (!result.ok) setError(result.error);
    else if (result.skipped === "overlap") setSkipped(true);
    else onClose();
  };

  return (
    <Popover open={open} anchor={{ element: anchor }} onClose={onClose} align="end" ariaLabel="Run now" className="w-[340px]">
      <div className="space-y-3 p-3">
        <div>
          <div className="text-[13px] font-medium text-neutral-100">Run now</div>
          <p className="text-[11.5px] leading-4 text-neutral-500">
            Optional input, read as <code className="text-neutral-400">{"{{ trigger.input }}"}</code>. Runs even while the workflow is disabled.
          </p>
        </div>
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void run(false);
            }
          }}
          rows={6}
          spellCheck={false}
          autoFocus
          aria-label="Run input as JSON"
          placeholder={'{ "ticket": "PROJ-123" }'}
          className={cn(
            "w-full resize-y rounded-md border bg-neutral-950/60 px-2.5 py-2 font-mono text-[12px] leading-5 text-neutral-100 placeholder:text-neutral-600 focus:outline-none",
            error ? "border-danger/60" : "border-neutral-800 focus:border-neutral-600"
          )}
        />
        {error ? <p className="text-[11px] leading-4 text-danger">{error}</p> : null}
        {blockingErrors > 0 ? (
          <p className="flex items-start gap-1.5 text-[11px] leading-4 text-warn">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {blockingErrors === 1 ? "1 problem" : `${blockingErrors} problems`} may stop the run — see the red badges.
          </p>
        ) : null}
        {skipped ? (
          <div className="rounded-lg border border-warn/40 bg-warn-soft/20 px-2.5 py-2 text-[11.5px] leading-4 text-warn">
            It is already running, so this run was skipped (overlap: skip).
            <div className="mt-2">
              <SmallButton onClick={() => void run(true)} disabled={busy}>
                Run anyway
              </SmallButton>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] text-neutral-600">⌘/Ctrl Enter</span>
          <SmallButton
            variant="solid"
            icon={busy ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Play size={12} />}
            onClick={() => void run(false)}
            disabled={busy}
          >
            Run
          </SmallButton>
        </div>
      </div>
    </Popover>
  );
};
