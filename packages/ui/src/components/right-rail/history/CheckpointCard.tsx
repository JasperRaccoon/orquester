import React from "react";
import { ChevronUp, FileDiff } from "lucide-react";

import type { CheckpointFile } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import {
  checkpointRewindPrompt,
  type CheckpointEntry,
  type CheckpointOrigin
} from "../../../lib/prompt-history/checkpoints.logic";
import type { RewindOutcome, RewindPrompt } from "../../../lib/prompt-history/rewind.logic";
import { rewindDroppedTurnCount } from "../../agent-chat/composer/RewindControl";
import { railCardClass } from "../primitives";
import {
  CHECKPOINT_FILES_SHOWN,
  checkpointMetaLabel,
  moreFilesLabel,
  previewText,
  STARTED_BY_AGENT,
  STARTED_BY_PLAN,
  STARTED_BY_UNLISTED,
  type Feedback
} from "./history-format";
import {
  CardAction,
  DiffStat,
  DiffSummaryChip,
  FeedbackLine,
  RewindAction,
  RewindConfirm,
  useCardFeedback,
  useCardFocus,
  useRewindPhase,
  type RewindView
} from "./HistoryParts";

/** The message a rewind goes back to, as its confirm quotes it. */
function rewindConfirmText(origin: CheckpointOrigin): string {
  if (origin.kind === "prompt") return origin.prompt.text;
  return origin.kind === "plan" ? STARTED_BY_PLAN : STARTED_BY_UNLISTED;
}

/** What opened the checkpoint's turn, in one line. */
function OriginLine({ origin }: { origin: CheckpointOrigin }): React.ReactElement {
  if (origin.kind === "prompt") {
    return (
      <span className="mt-0.5 block truncate text-xs leading-5 text-neutral-400">
        {previewText(origin.prompt.text)}
      </span>
    );
  }
  const text =
    origin.kind === "agent" ? STARTED_BY_AGENT : origin.kind === "plan" ? STARTED_BY_PLAN : STARTED_BY_UNLISTED;
  return <span className="mt-0.5 block truncate text-xs italic leading-5 text-neutral-500">{text}</span>;
}

function splitPath(path: string): { name: string; dir: string } {
  const normalized = path.replaceAll("\\", "/");
  const cut = normalized.lastIndexOf("/");
  return cut === -1
    ? { name: normalized, dir: "" }
    : { name: normalized.slice(cut + 1), dir: normalized.slice(0, cut) };
}

/** The changed files, name first (the part worth reading), its folder muted after it. */
function FileList({ files }: { files: readonly CheckpointFile[] }): React.ReactElement | null {
  if (files.length === 0) return null;
  const shown = files.slice(0, CHECKPOINT_FILES_SHOWN);
  const hidden = files.length - shown.length;
  return (
    <div>
      <ul aria-label="Changed files" className="space-y-px">
        {shown.map((file) => {
          const { name, dir } = splitPath(file.path);
          return (
            <li
              key={file.path}
              title={file.path}
              className="flex min-w-0 items-center gap-1.5 py-0.5 font-mono text-[11px] leading-4"
            >
              <span className="max-w-[65%] shrink-0 truncate text-neutral-200">{name}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-500">{dir}</span>
              <DiffStat additions={file.additions} deletions={file.deletions} />
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <p className="mt-0.5 text-[11px] text-neutral-500">{moreFilesLabel(hidden)}</p>
      ) : null}
    </div>
  );
}

interface CheckpointCardViewProps {
  entry: CheckpointEntry;
  /** Docked beside the chat, or on a phone (finger-sized controls). */
  variant: "docked" | "sheet";
  /** "Turn 12 · 14:05" ({@link checkpointMetaLabel}). */
  meta: string;
  expanded: boolean;
  onToggle: () => void;
  headerRef?: React.Ref<HTMLButtonElement>;
  /** Handed the button, for focus to return to when the diff closes. */
  onViewDiff: (trigger: HTMLElement) => void;
  /** Absent unless a user message started the turn and the chat can rewind to it. */
  rewind: RewindView | null;
  feedback: Feedback | null;
}

/**
 * One checkpoint — a turn's captured working tree (§5.4). Collapsed: "Turn 12
 * · 14:05", the files chip, and what started the turn. Open: the changed
 * files, View diff, and "Rewind to here" on the prompt that started it (the
 * conversation-only rewind: files stay as they are).
 */
function CheckpointCardView(props: CheckpointCardViewProps): React.ReactElement {
  const { entry, expanded } = props;
  const sheet = props.variant === "sheet";
  return (
    <div
      className={railCardClass(expanded)}
      data-history-checkpoint={entry.key}
      data-expanded={expanded ? "true" : undefined}
      onKeyDown={
        expanded
          ? (event) => {
              // Escape closes the open card before it may leave the dock or
              // close the sheet.
              if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault();
                event.stopPropagation();
                props.onToggle();
              }
            }
          : undefined
      }
    >
      <button
        ref={props.headerRef}
        type="button"
        aria-expanded={expanded}
        onClick={props.onToggle}
        className={cn(
          "block w-full rounded-xl px-3 text-left",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          sheet ? "py-3" : "py-2.5"
        )}
      >
        <span className="flex items-center gap-2">
          <span className="ac-tabular min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
            {props.meta}
          </span>
          <DiffSummaryChip summary={entry.summary} />
          {expanded ? (
            <ChevronUp size={14} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
          ) : null}
        </span>
        <OriginLine origin={entry.origin} />
      </button>
      {expanded ? (
        <div className="space-y-2 px-3 pb-3">
          <FileList files={entry.checkpoint.files} />
          <div className="-mx-2 flex flex-wrap items-center gap-0.5">
            <CardAction
              sheet={sheet}
              icon={<FileDiff size={13} strokeWidth={1.8} aria-hidden />}
              label="View diff"
              onClick={(event) => props.onViewDiff(event.currentTarget)}
              title="The files this turn changed"
            />
            {props.rewind !== null ? <RewindAction rewind={props.rewind} sheet={sheet} /> : null}
          </div>
          {props.rewind !== null ? (
            <RewindConfirm rewind={props.rewind} text={rewindConfirmText(entry.origin)} />
          ) : null}
          <FeedbackLine feedback={props.feedback} />
        </div>
      ) : null}
    </div>
  );
}

export interface CheckpointCardProps {
  entry: CheckpointEntry;
  variant: "docked" | "sheet";
  expanded: boolean;
  onToggle: (key: string) => void;
  /** The turns a rewind to the turn's prompt keeps; null when it is not offered. */
  rewindTarget: number | null;
  rewindBusyReason: string | null;
  startedTurnCount: number;
  /** Open a turn's diff; `trigger` gets the keyboard back when it closes. */
  onOpenDiff: (turnCount: number, title: string, trigger: HTMLElement | null) => void;
  rewind: (prompt: RewindPrompt) => Promise<RewindOutcome>;
  onRewound: (messageId: string) => void;
  /** A rewind landed in the chat: a phone goes back to the chat for it. */
  onLeave?: () => void;
}

/** {@link CheckpointCardView} with its state: the rewind and its feedback. */
export const CheckpointCard = React.memo(function CheckpointCard(
  props: CheckpointCardProps
): React.ReactElement {
  const { entry, expanded } = props;
  const [feedback, showFeedback] = useCardFeedback();
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

  // A card opens clean — no feedback left from a rewind that answered while it
  // was closed — and closes forgetting any open confirm.
  const { reset: resetRewind } = rewindPhase;
  React.useEffect(() => {
    showFeedback(null);
    if (!expanded) resetRewind();
  }, [expanded, showFeedback, resetRewind]);

  const opener = checkpointRewindPrompt(entry.origin);
  const rewindTarget = props.rewindTarget;
  const rewind: RewindView | null =
    opener === null || rewindTarget === null
      ? null
      : {
          droppedTurnCount: rewindDroppedTurnCount({
            startedTurnCount: props.startedTurnCount,
            targetTurnCount: rewindTarget
          }),
          buttonRef: rewindPhase.buttonRef,
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
              .rewind(opener)
              .then((outcome) => {
                // A rewind that landed took the turn — and this card — out of
                // the thread: the list and the sheet still hear.
                if (outcome.ok) {
                  // Should the card stay, the keyboard lands on its header.
                  noteToggle();
                  props.onRewound(opener.messageId);
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
    <CheckpointCardView
      entry={entry}
      variant={props.variant}
      meta={checkpointMetaLabel(entry.turnNumber, entry.checkpoint.completedAt)}
      expanded={expanded}
      onToggle={() => {
        noteToggle();
        props.onToggle(entry.key);
      }}
      headerRef={headerRef}
      onViewDiff={(trigger) =>
        props.onOpenDiff(entry.checkpoint.checkpointTurnCount, `Turn ${entry.turnNumber}`, trigger)
      }
      rewind={rewind}
      feedback={feedback}
    />
  );
});
