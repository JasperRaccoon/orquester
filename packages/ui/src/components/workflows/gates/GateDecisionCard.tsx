/**
 * A gate's decision card (spec 2026-11-10 §6.4), the one every surface shows —
 * the gate's block on the run canvas, the block's run details, the workflow's
 * rail card and a phone's bottom sheet: the question, its details (Markdown,
 * collapsed), one button per choice in its colour saying where it leads
 * ("→ Deploy", "↺ Fix", "→ End"), and a comment box for a choice that asks for
 * one (Send stays disabled while a required comment is empty). While an agent
 * decides, it says so — the person can still decide first.
 *
 * Built on `BannerCard`, with the approval card's guards:
 *
 *  - **No autofocus.** Nothing takes focus when it appears; picking a choice
 *    that asks for a comment moves focus into the box (the user's own act).
 *  - **Keyboard delay.** Enter or Space on a choice (and ⌘/Ctrl+Enter in the
 *    box) does nothing for {@link TOOL_APPROVAL_KEYBOARD_GUARD_MS} after the
 *    card appears or changes.
 *  - **Double-click guard.** A click inside `TOOL_APPROVAL_POINTER_GUARD_MS`
 *    of the card appearing or changing is ignored (the second click of a
 *    double click meant for something else), and one decision is in flight
 *    at a time.
 *
 * Presentational: the gate, where its choices lead and how to decide arrive
 * as props (`GateDecision.tsx` wires them to the store).
 */

import React from "react";
import { ChevronDown, Loader2, RotateCcw, ShieldCheck, UserRound } from "lucide-react";
import { TOOL_APPROVAL_KEYBOARD_GUARD_MS } from "@orquester/api/agent-chat";
import type { WorkflowGateChoiceColor, WorkflowGateChoiceView, WorkflowGateState } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { formatAgo } from "../../../lib/workflows/format";
import { commentRule, gateDeciderNote, type ChoiceDestination } from "../../../lib/workflows/gates";
import { formatClock } from "../../../lib/workflows/run-view";
import { toolApprovalClickGuarded } from "../../agent-chat/banners/banner-model";
import { BannerCard } from "../../agent-chat/primitives";
import { ChatMarkdown } from "../../agent-chat/timeline/markdown/ChatMarkdown";

export type GateCardVariant = "docked" | "sheet" | "node";

export type GateDecideResult = { ok: true } | { ok: false; error: string };

export interface GateDecisionCardProps {
  gate: WorkflowGateState;
  /** The card's title (`gateTitle`): the question, or which loop reached its limit. */
  title: string;
  /** Where each choice leads, by choice id (`gateChoiceDestinations`); a missing one shows no destination. */
  destinations: Readonly<Record<string, ChoiceDestination>>;
  /** Names the workflow (the rail card and the sheet, where the run is not on screen). */
  context?: string;
  variant: GateCardVariant;
  now: number;
  /** Decide; resolves once the daemon answered (the toast and the record are the caller's). */
  onDecide: (choice: string, comment: string | undefined) => Promise<GateDecideResult>;
  /** The clock the guards read (tests). */
  clock?: () => number;
  className?: string;
}

const COLOR: Record<WorkflowGateChoiceColor, string> = {
  default: "border border-neutral-700 bg-neutral-900 text-neutral-100 hover:border-neutral-600 hover:bg-neutral-800",
  primary: "bg-neutral-100 text-neutral-900 hover:bg-neutral-50",
  success: "bg-ok/15 text-ok ring-1 ring-inset ring-ok/40 hover:bg-ok/25",
  warning: "bg-warn/15 text-warn ring-1 ring-inset ring-warn/40 hover:bg-warn/25",
  danger: "bg-danger/15 text-danger ring-1 ring-inset ring-danger/40 hover:bg-danger/25"
};

const FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-950";

const systemClock = (): number => Date.now();

/** What "appears or changes" means for the guards: another gate, phase, choice set or open comment box. */
function guardKey(gate: WorkflowGateState, selected: string | null): string {
  return JSON.stringify([gate.runId, gate.gateId, gate.phase, gate.question, gate.choices, selected]);
}

export const GateDecisionCard: React.FC<GateDecisionCardProps> = ({
  gate,
  title,
  destinations,
  context,
  variant,
  now,
  onDecide,
  clock = systemClock,
  className
}) => {
  const node = variant === "node";
  const sheet = variant === "sheet";
  const [selected, setSelected] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [sending, setSending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const commentRef = React.useRef<HTMLTextAreaElement | null>(null);
  const focusComment = React.useRef(false);
  const ids = React.useId();

  // A choice that no longer exists (the gate changed under the card) closes its box.
  const selectedChoice = selected ? (gate.choices.find((choice) => choice.id === selected) ?? null) : null;
  React.useEffect(() => {
    if (selected !== null && selectedChoice === null) setSelected(null);
  }, [selected, selectedChoice]);

  const key = guardKey(gate, selectedChoice?.id ?? null);
  const shownAt = React.useRef(clock());
  const lastKey = React.useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    shownAt.current = clock();
  }

  React.useEffect(() => {
    if (!focusComment.current) return;
    focusComment.current = false;
    commentRef.current?.focus({ preventScroll: node });
  }, [selected, node]);

  const keyboardGuarded = (): boolean => clock() - shownAt.current < TOOL_APPROVAL_KEYBOARD_GUARD_MS;
  const clickGuarded = (): boolean => toolApprovalClickGuarded({ now: clock(), shownAt: shownAt.current });

  const send = async (choice: WorkflowGateChoiceView, text: string | undefined): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(choice.id);
    setError(null);
    try {
      const result = await onDecide(choice.id, text);
      if (!result.ok) setError(result.error);
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "The decision did not go through. Try again.");
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  };

  const pick = (choice: WorkflowGateChoiceView): void => {
    if (inFlight.current) return;
    if (commentRule(choice, "").asks) {
      if (selected === choice.id) return;
      focusComment.current = true;
      setSelected(choice.id);
      setError(null);
      return;
    }
    void send(choice, undefined);
  };

  const submitComment = (): void => {
    if (!selectedChoice) return;
    const rule = commentRule(selectedChoice, comment);
    if (!rule.canSend) return;
    const text = comment.trim();
    void send(selectedChoice, text.length > 0 ? text : undefined);
  };

  const choiceKeys = {
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === "Enter" || event.key === " ") && keyboardGuarded()) event.preventDefault();
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " && keyboardGuarded()) event.preventDefault();
    }
  };

  const deciderNote = gateDeciderNote(gate);
  const asked = formatAgo(gate.openedAt, now);
  const until = gate.phase === "person" && gate.phaseDeadlineAt ? formatClock(gate.phaseDeadlineAt, now) : "";
  const description = [context, gate.pass && gate.pass > 1 ? `pass ${gate.pass}` : null, asked ? `asked ${asked}` : null, until ? `until ${until}` : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const Icon = gate.source === "loop_limit" ? RotateCcw : ShieldCheck;
  const details = gate.details?.trim() ?? "";
  // Why the agent handed it over (its comment, its failure, its silence), in the daemon's words.
  const escalationReason = gate.escalationReason?.trim() ?? "";
  const rule = selectedChoice ? commentRule(selectedChoice, comment) : null;
  const busy = sending !== null;

  return (
    <div
      role="group"
      aria-label={`Decision: ${title}`}
      data-gate-card={gate.gateId}
      className={cn(node && "nodrag nopan nowheel cursor-default", className)}
    >
      <BannerCard
        variant={gate.phase === "agent" ? "info" : "warning"}
        density={node ? "compact" : "spacious"}
        noEnterAnimation={node}
        icon={<Icon size={node ? 13 : 15} aria-hidden />}
        title={title}
        description={node ? undefined : description || undefined}
        // A standalone card, not a drawer pulled out of a composer.
        className="rounded-xl border-b"
      >
        <div className="space-y-2.5">
          {deciderNote ? (
            <p className={cn("flex items-start gap-1.5 leading-4 text-info", node ? "text-[11px]" : "text-[12px]")}>
              <Loader2 size={12} aria-hidden className="mt-0.5 shrink-0 motion-safe:animate-spin" />
              <span className="min-w-0">{deciderNote}</span>
            </p>
          ) : gate.escalated && !node ? (
            <p className="flex items-start gap-1.5 text-[12px] leading-4 text-neutral-400">
              <UserRound size={12} aria-hidden className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">
                {gate.decider.label} handed this to you{escalationReason ? `: ${escalationReason}` : "."}
              </span>
            </p>
          ) : null}

          {details && !node ? (
            <div>
              <button
                type="button"
                aria-expanded={detailsOpen}
                aria-controls={detailsOpen ? `${ids}-details` : undefined}
                onClick={() => setDetailsOpen(!detailsOpen)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1 text-[12px] font-medium text-neutral-300 hover:text-neutral-100",
                  FOCUS,
                  sheet ? "min-h-10" : "min-h-6"
                )}
              >
                <ChevronDown size={13} aria-hidden className={cn("transition-transform motion-reduce:transition-none", !detailsOpen && "-rotate-90")} />
                Details
              </button>
              {detailsOpen ? (
                <div
                  id={`${ids}-details`}
                  className="mt-1.5 max-h-72 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2"
                >
                  <ChatMarkdown text={details} remoteImages="click" className="text-[12.5px] text-neutral-200" />
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            role="group"
            aria-label="Choices"
            className={cn("flex gap-1.5", sheet ? "flex-col" : "flex-wrap")}
          >
            {gate.choices.length === 0 ? (
              <p className="text-[12px] text-neutral-500">This gate offers no choice to make.</p>
            ) : null}
            {gate.choices.map((choice) => {
              const destination = destinations[choice.id];
              const on = selected === choice.id;
              return (
                <button
                  key={choice.id}
                  type="button"
                  aria-label={destination ? `${choice.label}, ${destination.spoken}` : choice.label}
                  aria-expanded={commentRule(choice, "").asks ? on : undefined}
                  aria-controls={on ? `${ids}-comment` : undefined}
                  disabled={busy}
                  onClick={(event) => {
                    if (clickGuarded()) {
                      event.preventDefault();
                      return;
                    }
                    pick(choice);
                  }}
                  {...choiceKeys}
                  className={cn(
                    "ac-press inline-flex min-w-0 items-center gap-1.5 rounded-lg font-medium transition-colors",
                    "disabled:pointer-events-none disabled:opacity-60",
                    FOCUS,
                    COLOR[choice.color ?? "default"],
                    on && "ring-2 ring-neutral-300",
                    node ? "min-h-7 px-2 text-[11px]" : sheet ? "min-h-11 w-full justify-between px-3.5 text-[13.5px]" : "min-h-8 px-3 text-xs"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {sending === choice.id ? <Loader2 size={12} aria-hidden className="shrink-0 motion-safe:animate-spin" /> : null}
                    <span className="truncate">{choice.label}</span>
                  </span>
                  {destination ? (
                    <span aria-hidden className={cn("min-w-0 truncate font-normal opacity-75", node ? "text-[10px]" : "text-[11px]")}>
                      {destination.text}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {selectedChoice && rule ? (
            <div id={`${ids}-comment`} className="space-y-1.5">
              <label htmlFor={`${ids}-comment-input`} className={cn("block font-medium text-neutral-300", node ? "text-[11px]" : "text-[12px]")}>
                {rule.required ? `Why “${selectedChoice.label}”? (required)` : `Add a comment to “${selectedChoice.label}” (optional)`}
              </label>
              <textarea
                ref={commentRef}
                id={`${ids}-comment-input`}
                value={comment}
                rows={node ? 2 : 3}
                maxLength={2000}
                aria-required={rule.required || undefined}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
                    event.preventDefault();
                    if (!event.repeat && !keyboardGuarded()) submitComment();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setSelected(null);
                  }
                }}
                placeholder={rule.required ? "Say why — the next step reads it." : "Anything the next step should know"}
                className={cn(
                  "w-full resize-y rounded-md border border-neutral-800 bg-neutral-950/60 px-2.5 py-1.5 text-neutral-100",
                  "placeholder:text-neutral-600 hover:border-neutral-700 focus:border-neutral-600 focus:outline-none",
                  node ? "text-[11.5px]" : sheet ? "text-[16px]" : "text-[13px]"
                )}
              />
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  disabled={busy}
                  className={cn(
                    "inline-flex items-center rounded-md px-2.5 text-xs font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50",
                    FOCUS,
                    sheet ? "min-h-11" : node ? "min-h-7" : "min-h-8"
                  )}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!rule.canSend || busy}
                  title={rule.canSend ? undefined : "Write a comment first"}
                  onClick={(event) => {
                    if (clickGuarded()) {
                      event.preventDefault();
                      return;
                    }
                    submitComment();
                  }}
                  {...choiceKeys}
                  className={cn(
                    "ac-press inline-flex items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors",
                    "disabled:pointer-events-none disabled:opacity-50",
                    FOCUS,
                    COLOR[selectedChoice.color ?? "default"],
                    sheet ? "min-h-11" : node ? "min-h-7" : "min-h-8"
                  )}
                >
                  {sending === selectedChoice.id ? <Loader2 size={12} aria-hidden className="motion-safe:animate-spin" /> : null}
                  Send {selectedChoice.label}
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-[12px] leading-4 text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </BannerCard>
    </div>
  );
};
