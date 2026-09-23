// Ported from T3 Code (MIT): apps/web/src/components/chat/MessagesTimeline.tsx
// (`RevertUserMessageButton`, "Edit from here") and apps/web/src/components/ChatView.tsx
// (the "Edit from here?" confirm on `onRevertToTurnCount`'s path — a popover here, not a
// modal). The picker is the Claude Code CLI's double Escape, which T3 does not have.
import React from "react";
import { History, Paperclip } from "lucide-react";

import { cn } from "../../../lib/cn";
import { rewindTargetPreview, type RewindTarget } from "../../../lib/agent-chat/rewind.logic";
import { ChatIconButton, Kbd } from "../primitives";
import { formatRowTimestamp } from "../timeline/timestamp";
import { ComposerMenuRow, ComposerPopover } from "./ComposerPopover";

/**
 * "Rewind to here" — the surfaces (spec §5.5, §7.3, §7.4).
 *
 * Two ways in, one confirm:
 *
 *  - the per-row button under a user message (T3's "Edit from here"), whose
 *    popover is just {@link RewindConfirmPanel};
 *  - the composer's picker, {@link RewindControl} — the CLI's "press Esc twice
 *    to jump to a previous message": every rewindable message, newest first,
 *    and the same confirm once one is picked.
 *
 * Both read the same `RewindTarget`s (`deriveRewindTargets` over the rows the
 * timeline renders), so the button and the picker never disagree about what is
 * rewindable, and both say out loud what a rewind is: **conversation only**.
 * The turns after the message are removed and the message comes back to the
 * composer for editing; files are never touched (§5.5 — the git tab is where
 * working-tree changes are discarded, if the user wants that).
 */

/** The picker lists at most this many messages, newest first. */
export const REWIND_PICKER_LIMIT = 50;

/** Why a rewind control is disabled, in the one place the copy lives. */
export const REWIND_BUSY_TITLE = "Available when the agent is idle";

/** The composer's hint after the first of two Escapes. */
export const REWIND_ESCAPE_HINT = "Press Esc again to rewind to an earlier message";

/** How long that hint stays up — past the double-press window, so it can be read. */
export const REWIND_ESCAPE_HINT_MS = 1500;

const EMPTY_MESSAGE_LABEL = "(empty message)";

/**
 * A disabled rewind icon button still answers the pointer, so its title — the
 * reason it is disabled — shows on hover. `ChatIconButton` drops pointer
 * events on `:disabled`, which would hide exactly the sentence that explains
 * the control; a disabled `<button>` never fires `click`, so letting the
 * pointer through changes nothing but the tooltip. The ghost hover paint is
 * cancelled so it does not read as clickable.
 */
export const REWIND_DISABLED_EXPLAINS_ITSELF =
  "disabled:pointer-events-auto disabled:cursor-not-allowed " +
  "disabled:hover:bg-transparent disabled:hover:text-neutral-500";

/**
 * Turns a rewind to a message removes: everything the thread has started
 * since it — its own turn included, so never fewer than one. The same count
 * `deriveRewindTargets` stamps on a picker target (`droppedTurnCount`), for a
 * row that has only its `revertTurnCount` and the thread's started turns.
 */
export function rewindDroppedTurnCount(input: {
  startedTurnCount: number;
  targetTurnCount: number;
}): number {
  return Math.max(1, input.startedTurnCount - input.targetTurnCount);
}

/** "1 turn" / "3 turns". */
export function rewindTurnsLabel(count: number): string {
  const turns = Math.max(1, count);
  return `${turns} turn${turns === 1 ? "" : "s"}`;
}

/** The confirm's one sentence: what goes, what stays, where the message ends up. */
export function rewindConfirmSentence(droppedTurnCount: number): string {
  const turns = Math.max(1, droppedTurnCount);
  return (
    `Removes ${turns} later turn${turns === 1 ? "" : "s"} from this chat. ` +
    "Files stay as they are. " +
    "The message returns to the composer so you can edit and resend it."
  );
}

/** A picker row's second line: when it was sent, and what going back to it costs. */
export function rewindTargetHint(target: Pick<RewindTarget, "createdAt" | "droppedTurnCount">): string {
  const when = formatRowTimestamp(target.createdAt);
  const cost = `removes ${rewindTurnsLabel(target.droppedTurnCount)}`;
  return when.length > 0 ? `${when} · ${cost}` : cost;
}

/**
 * Whether the picker can act: something to go back to, and nothing in flight
 * that a rewind would race — a running turn (the host refuses it, §5.5), a
 * revert already rewriting history (§7.5), or a docked request waiting on the
 * user. One expression, shared by the button, the composer's double Escape and
 * the shell's, so the hint is never shown for a picker that will not open.
 */
export function rewindPickerEnabled(input: {
  targetCount: number;
  isTurnActive: boolean;
  reverting: boolean;
  hasPendingRequest: boolean;
}): boolean {
  return (
    input.targetCount > 0 && !input.isTurnActive && !input.reverting && !input.hasPendingRequest
  );
}

// ---------------------------------------------------------------------------
// The confirm
// ---------------------------------------------------------------------------

export interface RewindConfirmPanelProps {
  /** The message the rewind goes back to, quoted so the user knows which one. */
  text: string;
  /** Turns the rewind removes, the message's own included (`RewindTarget.droppedTurnCount`). */
  droppedTurnCount: number;
  /** A turn or a revert is in flight: Rewind waits for the agent to be idle. */
  busy?: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * The confirm both surfaces share: a clamped quote, the one sentence, and
 * **Rewind** / **Back**. Rewind is focused on mount, so Enter confirms and
 * Escape (the popover's) closes — the CLI's own keys.
 */
export function RewindConfirmPanel({
  text,
  droppedTurnCount,
  busy = false,
  onConfirm,
  onBack
}: RewindConfirmPanelProps): React.ReactElement {
  const quote = text.trim().length > 0 ? text : EMPTY_MESSAGE_LABEL;
  return (
    <div
      data-rewind-confirm="true"
      className="flex flex-col gap-2 px-1 pb-1 pt-0.5"
      onKeyDown={(event) => {
        // A HELD Enter must not carry a pick in the list straight through to
        // this irreversible button: its auto-repeat lands here once the panel
        // swaps in under the key.
        if (event.key === "Enter" && event.repeat) event.preventDefault();
      }}
    >
      <div className="px-1 text-[11px] text-neutral-500">Rewind to here</div>
      <blockquote
        className={cn(
          "line-clamp-3 whitespace-pre-wrap border-l-2 border-neutral-700 pl-2",
          "text-xs leading-relaxed text-neutral-300 [overflow-wrap:anywhere]"
        )}
      >
        {quote}
      </blockquote>
      <p className="px-1 text-[11px] leading-snug text-neutral-400">
        {rewindConfirmSentence(droppedTurnCount)}
      </p>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "ac-press inline-flex h-7 items-center rounded-md px-2.5 text-xs text-neutral-300",
            "hover:bg-neutral-800 hover:text-neutral-100",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          )}
        >
          Back
        </button>
        <button
          type="button"
          data-rewind-confirm-action="rewind"
          // Focused on mount: Enter confirms, as in the CLI.
          autoFocus
          disabled={busy}
          title={busy ? REWIND_BUSY_TITLE : undefined}
          onClick={onConfirm}
          className={cn(
            "ac-press inline-flex h-7 items-center rounded-md bg-neutral-200 px-3 text-xs font-medium",
            "text-neutral-900 hover:bg-neutral-50",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500",
            "focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-900",
            // Keeps the pointer (no `pointer-events-none`), so the title says why.
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-neutral-200"
          )}
        >
          Rewind
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

/** The rows of a list, in DOM order — what the arrow keys walk. */
function menuRows(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
}

function focusRow(row: HTMLElement | undefined): void {
  if (!row) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: "nearest" });
}

interface RewindTargetListProps {
  targets: readonly RewindTarget[];
  /** Focus this target's row on mount (coming Back from its confirm); else the first. */
  focusMessageId: string | null;
  onPick: (target: RewindTarget) => void;
}

function RewindTargetList({
  targets,
  focusMessageId,
  onPick
}: RewindTargetListProps): React.ReactElement {
  const listRef = React.useRef<HTMLDivElement>(null);

  // The keyboard lands in the list the moment it opens — the double Escape
  // opened it, so the arrow keys and Enter are what come next.
  React.useEffect(() => {
    const rows = menuRows(listRef.current);
    const back =
      focusMessageId === null
        ? undefined
        : rows.find((row) => row.dataset.rewindTarget === focusMessageId);
    focusRow(back ?? rows[0]);
    // Mount only: a target list that re-renders must not steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = menuRows(event.currentTarget);
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = current === -1 ? 0 : (current + 1) % rows.length;
        break;
      case "ArrowUp":
        next = current === -1 ? rows.length - 1 : (current - 1 + rows.length) % rows.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      default:
        // Enter is the focused row's own click; Escape is the popover's.
        return;
    }
    event.preventDefault();
    focusRow(rows[next]);
  };

  return (
    <div data-rewind-picker="true">
      <div className="flex items-center justify-between gap-2 px-2 pt-1 text-[11px] text-neutral-500">
        <span>Rewind to an earlier message</span>
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
          <Kbd>Esc</Kbd>
          <Kbd>Esc</Kbd>
        </span>
      </div>
      <p className="px-2 pb-1.5 pt-0.5 text-[11px] leading-snug text-neutral-500">
        The chat goes back to just before the message you pick. Files are not changed.
      </p>
      <div ref={listRef} onKeyDown={onKeyDown}>
        {targets.slice(0, REWIND_PICKER_LIMIT).map((target) => {
          const preview = rewindTargetPreview(target.text, 90);
          return (
            <ComposerMenuRow
              key={target.messageId}
              data-rewind-target={target.messageId}
              hint={rewindTargetHint(target)}
              trailing={
                target.attachmentCount > 0 ? (
                  <span
                    className="ac-tabular inline-flex items-center gap-0.5 text-[11px] text-neutral-500"
                    title={`${target.attachmentCount} attachment${target.attachmentCount === 1 ? "" : "s"}`}
                  >
                    <Paperclip size={11} aria-hidden />
                    {target.attachmentCount}
                    <span className="sr-only">
                      {target.attachmentCount === 1 ? " attachment" : " attachments"}
                    </span>
                  </span>
                ) : undefined
              }
              onClick={() => onPick(target)}
            >
              {preview.length > 0 ? preview : EMPTY_MESSAGE_LABEL}
            </ComposerMenuRow>
          );
        })}
      </div>
    </div>
  );
}

export interface RewindPickerPanelProps {
  /** Newest first, as `deriveRewindTargets` returns them. */
  targets: readonly RewindTarget[];
  /** Something is in flight: the confirm's Rewind waits for idle. */
  busy?: boolean;
  /** A confirmed pick. The caller closes the popover first. */
  onRewind: (target: RewindTarget) => void;
}

/**
 * The picker's panel: the list, then the confirm for the row picked, and Back
 * to the list. Mounted fresh on every open (the popover renders its panel only
 * while open), so a closed picker always reopens on the list.
 */
export function RewindPickerPanel({
  targets,
  busy = false,
  onRewind
}: RewindPickerPanelProps): React.ReactElement {
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const [cameBackFrom, setCameBackFrom] = React.useState<string | null>(null);
  // Resolved against the LIVE list: a target that stopped existing while its
  // confirm was open (another client rewound first) drops back to the list
  // instead of confirming a rewind to a message that is gone.
  const picked =
    pickedId === null ? null : (targets.find((target) => target.messageId === pickedId) ?? null);

  if (picked) {
    return (
      <RewindConfirmPanel
        text={picked.text}
        droppedTurnCount={picked.droppedTurnCount}
        busy={busy}
        onBack={() => {
          setCameBackFrom(picked.messageId);
          setPickedId(null);
        }}
        onConfirm={() => onRewind(picked)}
      />
    );
  }
  return (
    <RewindTargetList
      targets={targets}
      focusMessageId={cameBackFrom}
      onPick={(target) => setPickedId(target.messageId)}
    />
  );
}

export interface RewindControlProps {
  /** Newest first. Empty renders nothing at all. */
  targets: readonly RewindTarget[];
  isTurnActive: boolean;
  reverting: boolean;
  hasPendingRequest: boolean;
  onRewind: (target: RewindTarget) => void;
  /** Focus returns here when the picker closes — the composer, like every chip. */
  returnFocusTo?: () => HTMLElement | null;
}

/**
 * The composer's rewind picker: an icon button in the resting controls,
 * carrying the `rewind` token so the double Escape reaches it through
 * `openControl("rewind")` (§7.4's convention — a token without a chord, like
 * the account chip). Absent when there is nothing to rewind to.
 */
export function RewindControl({
  targets,
  isTurnActive,
  reverting,
  hasPendingRequest,
  onRewind,
  returnFocusTo
}: RewindControlProps): React.ReactElement | null {
  if (targets.length === 0) return null;
  const enabled = rewindPickerEnabled({
    targetCount: targets.length,
    isTurnActive,
    reverting,
    hasPendingRequest
  });
  return (
    <ComposerPopover
      label="Rewind"
      width="w-96"
      returnFocusTo={returnFocusTo}
      renderTrigger={(triggerProps) => (
        <ChatIconButton
          {...triggerProps}
          size="sm"
          label="Rewind to an earlier message"
          title={enabled ? "Rewind to an earlier message (Esc Esc)" : REWIND_BUSY_TITLE}
          data-composer-shortcut="rewind"
          disabled={!enabled}
          className={cn("disabled:opacity-40", REWIND_DISABLED_EXPLAINS_ITSELF)}
        >
          <History size={14} aria-hidden />
        </ChatIconButton>
      )}
    >
      {(close) => (
        <RewindPickerPanel
          targets={targets}
          busy={!enabled}
          onRewind={(target) => {
            close();
            onRewind(target);
          }}
        />
      )}
    </ComposerPopover>
  );
}
