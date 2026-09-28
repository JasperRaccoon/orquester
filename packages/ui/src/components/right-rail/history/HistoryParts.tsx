/**
 * The History panel's small shared pieces: the diff counts, the files chip,
 * the Insert / Send pair (styled as the Saved prompts panel's), the card's
 * secondary actions, its one feedback line, and the inline rewind confirm.
 * Presentational only — every piece takes props, so the render check needs no
 * live store.
 */

import React from "react";
import { ArrowUpRight, Check, LoaderCircle, Undo2 } from "lucide-react";

import type { DiffSummary } from "../../../lib/prompt-history/checkpoints.logic";
import { cn } from "../../../lib/cn";
import { RewindConfirmPanel } from "../../agent-chat/composer/RewindControl";
import { Button } from "../../ui";
import { RailChip } from "../primitives";
import { diffSummaryTitle, filesLabel, previewText, type Feedback } from "./history-format";

/**
 * A disabled button still answers the pointer, so its title — the reason it
 * is disabled — shows on hover (`Button` drops pointer events on `:disabled`;
 * a disabled `<button>` never fires `click` either way). The hover paint is
 * cancelled so it does not read as clickable.
 */
const DISABLED_EXPLAINS_ITSELF = "disabled:pointer-events-auto disabled:cursor-not-allowed";

/** "+20 −4" in the diff colours the timeline's changed-files card uses; zero counts are left out. */
export function DiffStat({
  additions,
  deletions,
  className
}: {
  additions: number;
  deletions: number;
  className?: string;
}): React.ReactElement | null {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span className={cn("ac-tabular shrink-0 font-mono text-[10px]", className)}>
      {additions > 0 ? <span className="text-[color:var(--diff-add-fg)]">+{additions}</span> : null}
      {additions > 0 && deletions > 0 ? " " : null}
      {deletions > 0 ? <span className="text-[color:var(--diff-del-fg)]">−{deletions}</span> : null}
    </span>
  );
}

/** "3 files +20 −4", or "No file changes". */
export function DiffSummaryChip({ summary }: { summary: DiffSummary }): React.ReactElement {
  return (
    <RailChip title={diffSummaryTitle(summary)} className="shrink-0">
      <span>{filesLabel(summary.fileCount)}</span>
      <DiffStat additions={summary.additions} deletions={summary.deletions} />
    </RailChip>
  );
}

/** A spinner for a control whose own request is in flight. */
export function Spinner({ size = 12 }: { size?: number }): React.ReactElement {
  return <LoaderCircle size={size} strokeWidth={1.8} aria-hidden className="shrink-0 animate-spin" />;
}

/**
 * Insert and Send, exactly as the Saved prompts panel offers them: Insert puts
 * the text into the chat's composer at the caret, Send sends it as the user's
 * message. Disabled, saying why, while the whole text is not at hand.
 */
export function DeliveryButtons({
  disabledReason,
  onInsert,
  onSend,
  sheet = false
}: {
  disabledReason: string | null;
  onInsert: () => void;
  onSend: () => void;
  /** On a phone: finger-sized. */
  sheet?: boolean;
}): React.ReactElement {
  const disabled = disabledReason !== null;
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        type="button"
        onClick={onInsert}
        disabled={disabled}
        title={disabledReason ?? "Insert into the chat's message box"}
        className={cn("w-full", sheet && "h-10", DISABLED_EXPLAINS_ITSELF, "disabled:hover:bg-neutral-200")}
      >
        Insert
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={onSend}
        disabled={disabled}
        title={disabledReason ?? "Send to the chat as your message"}
        className={cn("w-full", sheet && "h-10", DISABLED_EXPLAINS_ITSELF, "disabled:hover:bg-transparent")}
      >
        Send
        <ArrowUpRight size={14} aria-hidden />
      </Button>
    </div>
  );
}

export interface CardActionProps {
  icon: React.ReactNode;
  label: string;
  /** The click, with its button — a caller that opens something returns focus to it after. */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** The tooltip — the reason, when disabled. */
  title?: string;
  /** Its own request is in flight: a spinner, and not pressable again. */
  busy?: boolean;
  busyLabel?: string;
  /** On a phone: finger-sized. */
  sheet?: boolean;
}

/** One of a card's small secondary actions: Save as prompt, Jump to, View diff, Rewind to here. */
export const CardAction = React.forwardRef<HTMLButtonElement, CardActionProps>(function CardAction(
  { icon, label, onClick, disabled = false, title, busy = false, busyLabel, sheet = false },
  ref
) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy ? true : undefined}
      title={title ?? label}
      className={cn(
        "gap-1.5 text-xs font-normal text-neutral-400 hover:text-neutral-100",
        sheet ? "h-9 px-2.5" : "h-7 px-2",
        DISABLED_EXPLAINS_ITSELF,
        "disabled:hover:bg-transparent disabled:hover:text-neutral-400"
      )}
    >
      {busy ? <Spinner /> : icon}
      {busy && busyLabel ? busyLabel : label}
    </Button>
  );
});

/**
 * A card's feedback line: `show(feedback, ms)` replaces it, and clears it
 * again after `ms` (success) or never (a refusal stays until the next action).
 */
export function useCardFeedback(): [
  Feedback | null,
  (next: Feedback | null, ms?: number | null) => void
] {
  const [feedback, setFeedback] = React.useState<Feedback | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  const show = React.useCallback((next: Feedback | null, ms: number | null = null) => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setFeedback(next);
    if (next !== null && ms !== null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setFeedback(null);
      }, ms);
    }
  }, []);
  return [feedback, show];
}

/**
 * Keep the keyboard on a card across its own toggle: open and closed render
 * different header controls, so the one that was pressed unmounts. After a
 * toggle the card asked for ({@link noteToggle}), focus moves to the new
 * header and the card scrolls into view — never after another card's toggle
 * closed this one.
 */
export function useCardFocus(expanded: boolean): {
  headerRef: React.RefObject<HTMLButtonElement>;
  noteToggle: () => void;
} {
  const headerRef = React.useRef<HTMLButtonElement>(null);
  const requested = React.useRef(false);
  React.useEffect(() => {
    if (!requested.current) return;
    requested.current = false;
    const header = headerRef.current;
    if (header === null) return;
    header.focus({ preventScroll: true });
    header.parentElement?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);
  const noteToggle = React.useCallback(() => {
    requested.current = true;
  }, []);
  return { headerRef, noteToggle };
}

/** The card's one line of feedback: what the last action did, or why it could not. */
export function FeedbackLine({ feedback }: { feedback: Feedback | null }): React.ReactElement | null {
  if (feedback === null) return null;
  return feedback.tone === "error" ? (
    <p role="alert" className="block break-words text-xs text-danger">
      {feedback.text}
    </p>
  ) : (
    <p role="status" className="flex items-center gap-1 text-xs text-neutral-400">
      <Check size={12} aria-hidden className="shrink-0" />
      {feedback.text}
    </p>
  );
}

/** Where a card's "Rewind to here" stands. */
export type RewindPhase = "idle" | "confirm" | "running";

export interface RewindView {
  /** Turns the rewind removes, the prompt's own included. */
  droppedTurnCount: number;
  /** The "Rewind to here" action: focus comes back to it when the confirm closes. */
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** Why it must wait right now (a turn running, a rewind in flight, a request pending); null when it may go. */
  busyReason: string | null;
  phase: RewindPhase;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export interface RewindPhaseControls {
  phase: RewindPhase;
  /** For {@link RewindView.buttonRef}. */
  buttonRef: React.RefObject<HTMLButtonElement>;
  /** "Rewind to here" pressed: the confirm opens. */
  confirm: () => void;
  /** Back, or Escape: the confirm closes and the keyboard returns to the action. */
  cancel: () => void;
  /** Rewind pressed in the confirm. */
  run: () => void;
  /** The rewind failed: its reason shows by the action, which gets the keyboard back. */
  fail: () => void;
  /** The rewind landed; the card closes (and usually leaves), so nothing is focused here. */
  land: () => void;
  /** The card closed: an open confirm goes, a running rewind keeps running. */
  reset: () => void;
}

/**
 * A card's rewind: the confirm's phase, and the "Rewind to here" action's
 * ref, focused again whenever the confirm closes without the card leaving —
 * Back, Escape, a failure — so the keyboard stays where the user was.
 */
export function useRewindPhase(): RewindPhaseControls {
  const [phase, setPhase] = React.useState<RewindPhase>("idle");
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const refocus = React.useRef(false);
  React.useEffect(() => {
    if (phase !== "idle" || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus({ preventScroll: true });
  }, [phase]);
  // Stable for the card's life: an effect may depend on them.
  const transitions = React.useMemo(
    () => ({
      confirm: () => setPhase("confirm"),
      cancel: () => {
        refocus.current = true;
        setPhase("idle");
      },
      run: () => setPhase("running"),
      fail: () => {
        refocus.current = true;
        setPhase("idle");
      },
      land: () => setPhase("idle"),
      reset: () => setPhase((current: RewindPhase) => (current === "running" ? current : "idle"))
    }),
    []
  );
  return { phase, buttonRef, ...transitions };
}

/** The "Rewind to here" action: disabled with the reason while busy, spinning while it runs. */
export function RewindAction({
  rewind,
  sheet = false
}: {
  rewind: RewindView;
  sheet?: boolean;
}): React.ReactElement {
  return (
    <CardAction
      ref={rewind.buttonRef}
      sheet={sheet}
      icon={<Undo2 size={13} strokeWidth={1.8} aria-hidden />}
      label="Rewind to here"
      onClick={rewind.onStart}
      disabled={rewind.busyReason !== null || rewind.phase === "confirm"}
      title={rewind.busyReason ?? "Rewind the chat to just before this prompt"}
      busy={rewind.phase === "running"}
      busyLabel="Rewinding…"
    />
  );
}

/**
 * The confirm, inline in the card — the timeline's and the composer picker's
 * own panel and sentence: which turns go, that files stay as they are, and
 * that the prompt comes back to the composer.
 */
export function RewindConfirm({
  rewind,
  text
}: {
  rewind: RewindView;
  /** The prompt the rewind goes back to, quoted so the user knows which one. */
  text: string;
}): React.ReactElement | null {
  if (rewind.phase !== "confirm") return null;
  return (
    <div
      className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-1.5"
      onKeyDown={(event) => {
        // Escape takes the confirm back, and only that: stopped here, it
        // neither closes the card nor leaves the dock or closes the sheet.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          rewind.onCancel();
        }
      }}
    >
      <RewindConfirmPanel
        text={previewText(text)}
        droppedTurnCount={rewind.droppedTurnCount}
        busy={rewind.busyReason !== null}
        onBack={rewind.onCancel}
        onConfirm={rewind.onConfirm}
      />
    </div>
  );
}
