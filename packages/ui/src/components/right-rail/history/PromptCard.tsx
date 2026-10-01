import React from "react";
import { BookmarkPlus, ChevronUp, FileDiff, LocateFixed } from "lucide-react";

import { escapePromptVariables } from "@orquester/api";
import type { Checkpoint } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { diffSummaryOf, type DiffSummary } from "../../../lib/prompt-history/checkpoints.logic";
import { usePromptText } from "../../../lib/prompt-history/hooks";
import type { PromptIndexCache } from "../../../lib/prompt-history/index-cache";
import type { HistoryPrompt } from "../../../lib/prompt-history/prompts.logic";
import type {
  RevealResult,
  RewindOutcome,
  RewindPrompt
} from "../../../lib/prompt-history/rewind.logic";
import { rewindDroppedTurnCount } from "../../agent-chat/composer/RewindControl";
import { insertIntoChat, sendToChat } from "../chat-target";
import { railCardClass } from "../primitives";
import { openSavedPromptEditor } from "../saved-prompts/editor-bridge";
import {
  DELIVERY_FEEDBACK_MS,
  deliveryFeedback,
  HOST_CUT_NOTE,
  previewText,
  promptMetaLabel,
  WHOLE_TEXT_LOADING,
  type Feedback
} from "./history-format";
import {
  CardAction,
  DeliveryButtons,
  DiffSummaryChip,
  FeedbackLine,
  RewindAction,
  RewindConfirm,
  Spinner,
  useCardFeedback,
  useCardFocus,
  useRewindPhase,
  type RewindView
} from "./HistoryParts";

/** The text an open card shows and hands on: the prompt's own, or — when the index cut it — the whole one. */
export type WholeText =
  | {
      status: "ready";
      text: string;
      /** Even the host's copy is cut (it keeps 128 K characters of a message). */
      hostCut: boolean;
    }
  | { status: "loading" }
  | { status: "failed"; error: string };

const EDITOR_UNAVAILABLE = "The prompt editor isn't available right now.";

interface PromptCardViewProps {
  prompt: HistoryPrompt;
  /** Docked beside the chat, or on a phone (finger-sized controls). */
  variant: "docked" | "sheet";
  /** "Turn 12 · 14:05" ({@link promptMetaLabel}). */
  meta: string;
  /** The files the turn this prompt started changed — its `ready` checkpoint — or null. */
  diff: DiffSummary | null;
  expanded: boolean;
  onToggle: () => void;
  /** The card's header control, in either state — focus returns to it after a toggle. */
  headerRef?: React.Ref<HTMLButtonElement>;
  whole: WholeText;
  onRetryWhole: () => void;
  feedback: Feedback | null;
  onInsert: () => void;
  onSend: () => void;
  onSaveAsPrompt: () => void;
  /** Absent for a prompt no turn claims. */
  onJump: (() => void) | null;
  jumping: boolean;
  /** Absent unless its turn has a `ready` checkpoint; handed the button, for focus to return to. */
  onViewDiff: ((trigger: HTMLElement) => void) | null;
  /** Absent unless the chat can rewind to this prompt. */
  rewind: RewindView | null;
}

/**
 * One prompt of the thread (the right rail's History). Collapsed: its text in
 * two lines, "Turn 12 · 14:05" and — when its turn changed files — the files
 * chip. Open (click or Enter; one at a time): the whole text, Insert / Send,
 * and the secondary actions.
 */
function PromptCardView(props: PromptCardViewProps): React.ReactElement {
  const { prompt, meta, diff, expanded, whole } = props;
  const sheet = props.variant === "sheet";
  const chip = diff !== null && diff.fileCount > 0 ? <DiffSummaryChip summary={diff} /> : null;

  if (!expanded) {
    return (
      <div className={railCardClass(false)} data-history-prompt={prompt.messageId}>
        <button
          ref={props.headerRef}
          type="button"
          aria-expanded={false}
          onClick={props.onToggle}
          className={cn(
            "block w-full rounded-xl px-3 text-left",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            sheet ? "py-3" : "py-2.5"
          )}
        >
          <span className="line-clamp-2 text-[13px] leading-5 text-neutral-200 [overflow-wrap:anywhere]">
            {previewText(prompt.text)}
          </span>
          <span className="mt-1 flex items-center gap-2">
            <span className="ac-tabular min-w-0 flex-1 truncate text-[11px] text-neutral-500">{meta}</span>
            {chip}
          </span>
        </button>
      </div>
    );
  }

  const wholeText = whole.status === "ready" ? whole.text : null;
  const unavailable =
    whole.status === "ready" ? null : whole.status === "loading" ? WHOLE_TEXT_LOADING : whole.error;

  return (
    <div
      className={railCardClass(true)}
      data-history-prompt={prompt.messageId}
      data-expanded="true"
      onKeyDown={(event) => {
        // Escape closes the open card (focus back on its row) before it may
        // leave the dock or close the sheet.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          props.onToggle();
        }
      }}
    >
      <div className="px-3 pt-2.5">
        <div
          className={cn(
            "max-h-[40vh] select-text overflow-y-auto whitespace-pre-wrap text-[13px] leading-5 [overflow-wrap:anywhere]",
            wholeText !== null ? "text-neutral-100" : "text-neutral-400"
          )}
        >
          {wholeText ?? prompt.text}
        </div>
        {whole.status === "loading" ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-neutral-500">
            <Spinner size={11} />
            {WHOLE_TEXT_LOADING}
          </p>
        ) : whole.status === "failed" ? (
          <p role="alert" className="mt-1.5 text-[11px] leading-4 text-danger">
            {whole.error}{" "}
            <button
              type="button"
              onClick={props.onRetryWhole}
              className="rounded text-neutral-300 underline underline-offset-2 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              Retry
            </button>
          </p>
        ) : whole.hostCut ? (
          <p className="mt-1.5 text-[11px] leading-4 text-neutral-500">{HOST_CUT_NOTE}</p>
        ) : null}
      </div>
      <button
        ref={props.headerRef}
        type="button"
        aria-expanded={true}
        onClick={props.onToggle}
        title="Collapse"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      >
        <span className="ac-tabular min-w-0 flex-1 truncate text-[11px] text-neutral-500">{meta}</span>
        {chip}
        <ChevronUp size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
        <span className="sr-only">Collapse</span>
      </button>
      <div className="space-y-2 px-3 pb-3 pt-0.5">
        <DeliveryButtons
          disabledReason={unavailable}
          onInsert={props.onInsert}
          onSend={props.onSend}
          sheet={sheet}
        />
        <div className="-mx-2 flex flex-wrap items-center gap-0.5">
          <CardAction
            sheet={sheet}
            icon={<BookmarkPlus size={13} strokeWidth={1.8} aria-hidden />}
            label="Save as prompt"
            onClick={props.onSaveAsPrompt}
            disabled={unavailable !== null}
            title={unavailable ?? "Save this text as a reusable prompt"}
          />
          {props.onJump !== null ? (
            <CardAction
              sheet={sheet}
              icon={<LocateFixed size={13} strokeWidth={1.8} aria-hidden />}
              label="Jump to"
              onClick={props.onJump}
              title="Show this turn in the chat"
              busy={props.jumping}
              busyLabel="Jumping…"
            />
          ) : null}
          {props.onViewDiff !== null ? (
            <CardAction
              sheet={sheet}
              icon={<FileDiff size={13} strokeWidth={1.8} aria-hidden />}
              label="View diff"
              onClick={(event) => props.onViewDiff?.(event.currentTarget)}
              title="The files this turn changed"
            />
          ) : null}
          {props.rewind !== null ? <RewindAction rewind={props.rewind} sheet={sheet} /> : null}
        </div>
        {props.rewind !== null ? (
          <RewindConfirm rewind={props.rewind} text={wholeText ?? prompt.text} />
        ) : null}
        <FeedbackLine feedback={props.feedback} />
      </div>
    </div>
  );
}

export interface PromptCardProps {
  prompt: HistoryPrompt;
  variant: "docked" | "sheet";
  expanded: boolean;
  onToggle: (messageId: string) => void;
  /** The chat — the History's source and Insert / Send's target. */
  sessionId: string;
  projectPath: string;
  cache: PromptIndexCache;
  /** The `ready` checkpoint of the turn this prompt started. */
  checkpoint: Checkpoint | null;
  /** The turns a rewind to it keeps; null when it is not offered. */
  rewindTarget: number | null;
  /** Why a rewind must wait right now; null when it may go. */
  rewindBusyReason: string | null;
  startedTurnCount: number;
  /** Open a turn's diff; `trigger` gets the keyboard back when it closes. */
  onOpenDiff: (turnCount: number, title: string, trigger: HTMLElement | null) => void;
  jumpTo: (turnId: string) => Promise<RevealResult>;
  rewind: (prompt: RewindPrompt) => Promise<RewindOutcome>;
  /** The prompt was rewound to: it has left the thread, and the card closes. */
  onRewound: (messageId: string) => void;
  /** An Insert or a Send landed (a phone goes back to the chat on it). */
  onDelivered?: () => void;
  /** A jump or a rewind landed in the chat: a phone goes back to the chat for it. */
  onLeave?: () => void;
}

/** {@link PromptCardView} with its state: the whole text, the actions and their feedback. */
export const PromptCard = React.memo(function PromptCard(props: PromptCardProps): React.ReactElement {
  const { prompt, expanded, sessionId, checkpoint } = props;
  const [feedback, showFeedback] = useCardFeedback();
  const [jumping, setJumping] = React.useState(false);
  const rewindPhase = useRewindPhase();
  // Set in the effect, not only at creation: StrictMode's rehearsal unmount
  // would otherwise leave it false for the card's whole life.
  const alive = React.useRef(false);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { headerRef, noteToggle } = useCardFocus(expanded);

  // Only an open card of a prompt the index cut asks for the whole text.
  const fetched = usePromptText(
    props.cache,
    sessionId,
    expanded && prompt.truncated ? prompt.messageId : null
  );
  const whole: WholeText = !prompt.truncated
    ? { status: "ready", text: prompt.text, hostCut: false }
    : fetched === undefined || fetched.status === "loading"
      ? { status: "loading" }
      : fetched.status === "failed"
        ? { status: "failed", error: fetched.error }
        : { status: "ready", text: fetched.text, hostCut: fetched.truncated };

  // A card opens clean — no feedback left from a request that answered while
  // it was closed — and closes forgetting any open confirm.
  const { reset: resetRewind } = rewindPhase;
  React.useEffect(() => {
    showFeedback(null);
    if (!expanded) resetRewind();
  }, [expanded, showFeedback, resetRewind]);

  const diff = React.useMemo(
    () => (checkpoint !== null ? diffSummaryOf(checkpoint.files) : null),
    [checkpoint]
  );

  const deliver = (kind: "insert" | "send") => {
    if (whole.status !== "ready") return;
    const delivery =
      kind === "insert" ? insertIntoChat(sessionId, whole.text) : sendToChat(sessionId, whole.text);
    showFeedback(deliveryFeedback(delivery), delivery.ok ? DELIVERY_FEEDBACK_MS : null);
    if (delivery.ok) props.onDelivered?.();
  };

  const turnId = prompt.turnId;
  const jump =
    turnId === null
      ? null
      : () => {
          if (jumping) return;
          setJumping(true);
          showFeedback(null);
          props
            .jumpTo(turnId)
            .then((result) => {
              if (result.shown) props.onLeave?.();
              if (!alive.current) return;
              setJumping(false);
              if (!result.shown) showFeedback({ tone: "error", text: result.reason });
            })
            .catch(() => undefined);
        };

  const viewDiff =
    checkpoint === null
      ? null
      : (trigger: HTMLElement) =>
          props.onOpenDiff(
            checkpoint.checkpointTurnCount,
            `Turn ${prompt.turnOrdinal ?? checkpoint.checkpointTurnCount}`,
            trigger
          );

  const rewindTarget = props.rewindTarget;
  const rewind: RewindView | null =
    rewindTarget === null
      ? null
      : {
          droppedTurnCount: rewindDroppedTurnCount({
            startedTurnCount: props.startedTurnCount,
            targetTurnCount: rewindTarget
          }),
          buttonRef: rewindPhase.buttonRef,
          // While its own rewind runs the thread reads busy (`reverting`); the
          // action then shows its spinner, not the wait reason.
          busyReason: rewindPhase.phase === "running" ? null : props.rewindBusyReason,
          phase: rewindPhase.phase,
          onStart: () => {
            showFeedback(null);
            rewindPhase.confirm();
          },
          onCancel: rewindPhase.cancel,
          onConfirm: () => {
            rewindPhase.run();
            props
              .rewind(prompt)
              .then((outcome) => {
                // A rewind that landed took this prompt out of the thread, and
                // usually this card with it: the list and the sheet still hear.
                if (outcome.ok) {
                  // Should the card stay, the keyboard lands on its row.
                  noteToggle();
                  props.onRewound(prompt.messageId);
                  props.onLeave?.();
                }
                if (!alive.current) return;
                if (outcome.ok) {
                  rewindPhase.land();
                } else {
                  rewindPhase.fail();
                  showFeedback({ tone: "error", text: outcome.reason });
                }
              })
              .catch(() => undefined);
          }
        };

  return (
    <PromptCardView
      prompt={prompt}
      variant={props.variant}
      meta={promptMetaLabel(prompt)}
      diff={diff}
      expanded={expanded}
      onToggle={() => {
        noteToggle();
        props.onToggle(prompt.messageId);
      }}
      headerRef={headerRef}
      whole={whole}
      onRetryWhole={() => props.cache.ensureText(sessionId, prompt.messageId)}
      feedback={feedback}
      onInsert={() => deliver("insert")}
      onSend={() => deliver("send")}
      onSaveAsPrompt={() => {
        if (whole.status !== "ready") return;
        const opened = openSavedPromptEditor({
          mode: "create",
          projectPath: props.projectPath.length > 0 ? props.projectPath : null,
          // Saved prompts render `{variables}`; a `{date}` typed in a sent
          // prompt must come back as written, never as today's date.
          initial: { body: escapePromptVariables(whole.text) }
        });
        showFeedback(opened ? null : { tone: "error", text: EDITOR_UNAVAILABLE });
      }}
      onJump={jump}
      jumping={jumping}
      onViewDiff={viewDiff}
      rewind={rewind}
    />
  );
});
