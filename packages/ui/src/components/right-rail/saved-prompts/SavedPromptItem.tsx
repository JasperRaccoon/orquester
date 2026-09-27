/**
 * One saved prompt in the list: a collapsed row — its body inserts the prompt
 * into the chat, its chevron opens it — or the expanded card, with the pin,
 * the actions (a menu docked, inline buttons in the mobile sheet), the chips,
 * the "Context:" line, and Insert / Send.
 *
 * Presentational: everything it shows and does arrives as props, so a static
 * render check can draw it without a store or a chat. Keeping focus and view
 * across LIST changes (a card moving, a card deleted) is the panel's
 * (`SavedPromptsPanel`); this keeps focus across its own changes only.
 */

import React, { useRef } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  Globe,
  Loader2,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2
} from "lucide-react";

import type { SavedPrompt } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { promptContextLine, promptScopeLabel } from "../../../lib/saved-prompts/list.logic";
import { AdaptiveMenu } from "../../ui/adaptive-menu";
import { Button } from "../../ui/button";
import { DropdownItem, DropdownSeparator } from "../../ui/dropdown";
import { NO_CHAT_TARGET_REASON } from "../chat-target";
import { RailChip, railCardClass } from "../primitives";
import type { SavedPromptDeliveryAction } from "./deliver";
import { useIsomorphicLayoutEffect } from "./layout-effect";

export type { SavedPromptDeliveryAction };

/** The brief line under a prompt after an Insert / Send: it landed, or why not. */
export interface SavedPromptFeedback {
  tone: "ok" | "error";
  text: string;
}

export interface SavedPromptItemProps {
  prompt: SavedPrompt;
  expanded: boolean;
  variant: "docked" | "sheet";
  /** A chat is the target. Without one, Insert, Send and the row's click-to-insert are disabled. */
  canDeliver: boolean;
  /**
   * This prompt's delivery is resolving its variables: a spinner on that
   * button, and both refuse clicks — `aria-disabled`, never `disabled`, which
   * would drop the focus of the button just pressed.
   */
  busy: SavedPromptDeliveryAction | null;
  feedback: SavedPromptFeedback | null;
  /** "Move to this project" needs an open project. */
  canMoveToProject: boolean;
  /**
   * Delete asked, confirmed on the card itself — the mobile sheet's way: a
   * modal confirm would open under the sheet. (Docked, the panel asks in a
   * `ConfirmDialog` instead and this stays false.)
   */
  confirmingDelete?: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onDeliver: (action: SavedPromptDeliveryAction) => void;
  onTogglePin: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onMove: (to: "global" | "project") => void;
  /** Ask to delete (the Delete action). */
  onDelete: () => void;
  onConfirmDelete?: () => void;
  onCancelDelete?: () => void;
}

/**
 * Marks the control that stands for a card when focus has to land on it from
 * outside — its header when open, its row when collapsed (the panel moves
 * focus there when the focused card next to it goes away).
 */
export const CARD_FOCUS_ATTRIBUTE = "data-card-focus";

/** How much of a body the card previews when the prompt has no description. */
const BODY_PREVIEW_CHARS = 600;

const FOCUS_RING = "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

/** Looks and acts disabled while a delivery resolves, yet keeps its focus (see `busy`). */
const BUSY_DISABLED = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

/** The mobile sheet's inline actions: two to a row, 40px tall, a long label wrapping rather than cut. */
const SHEET_ACTION = "h-auto min-h-10 w-full justify-start whitespace-normal px-2.5 py-1.5 text-left text-xs";

const DANGER_ACTION = "text-danger hover:bg-danger-500/10 hover:text-danger";

/**
 * Which menu item a key moves focus to — ArrowDown / ArrowUp wrap around,
 * Home / End jump — or `null` for a key the menu leaves alone. `at` is the
 * focused item's index, -1 when none is (focus on the panel itself).
 */
export function menuFocusIndex(key: string, count: number, at: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return last;
    case "ArrowDown":
      return at < 0 || at >= last ? 0 : at + 1;
    case "ArrowUp":
      return at <= 0 || at > last ? last : at - 1;
    default:
      return null;
  }
}

/**
 * Arrow keys, Home and End move between the actions menu's items — the
 * dropdown focuses its first item when it opens (`focusOnOpen`), and a menu
 * promises the arrow keys.
 */
function moveMenuFocus(event: React.KeyboardEvent<HTMLElement>): void {
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
  );
  const next = menuFocusIndex(event.key, items.length, items.indexOf(document.activeElement as HTMLElement));
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

export const SavedPromptItem: React.FC<SavedPromptItemProps> = (props) => {
  const { prompt, expanded, variant } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteActionRef = useRef<HTMLButtonElement>(null);
  // Opening or closing from the keyboard swaps the element that had focus for
  // another one; hand focus to its counterpart rather than dropping it on body.
  const pendingFocus = useRef<"header" | "chevron" | null>(null);
  const confirmingBefore = useRef(false);

  // In the commit itself, so the dock's safety net (`dock-keyboard.ts`) never
  // sees focus on `<body>` in between.
  useIsomorphicLayoutEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (expanded) {
      rootRef.current?.scrollIntoView?.({ block: "nearest" });
      if (target === "header") headerRef.current?.focus({ preventScroll: true });
    } else if (target === "chevron") {
      chevronRef.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

  // The card's own delete confirmation (the sheet): its Cancel takes focus as
  // it appears; withdrawn, focus goes back to the Delete that asked, if the
  // Cancel took it along.
  const confirming = props.confirmingDelete === true;
  useIsomorphicLayoutEffect(() => {
    const was = confirmingBefore.current;
    confirmingBefore.current = confirming;
    if (confirming && !was) {
      cancelDeleteRef.current?.focus({ preventScroll: true });
    } else if (!confirming && was) {
      const active = document.activeElement;
      if (active === null || active === document.body) deleteActionRef.current?.focus({ preventScroll: true });
    }
  }, [confirming]);

  const sheet = variant === "sheet";
  const deliverTitle = props.canDeliver ? undefined : NO_CHAT_TARGET_REASON;
  const busy = props.busy !== null;

  if (!expanded) {
    const feedback = props.feedback;
    return (
      <div ref={rootRef} data-saved-prompt={prompt.id} className={railCardClass(false)}>
        <div className="flex items-stretch">
          <button
            type="button"
            data-card-focus=""
            disabled={!props.canDeliver}
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              if (!busy) props.onDeliver("insert");
            }}
            title={props.canDeliver ? "Click to insert into the chat" : NO_CHAT_TARGET_REASON}
            className={cn(
              "min-w-0 flex-1 pl-3 pr-1 text-left disabled:cursor-default aria-disabled:cursor-default",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
              feedback ? "rounded-tl-xl" : "rounded-l-xl",
              sheet ? "py-3" : "py-2.5"
            )}
          >
            <span className="sr-only">Insert: </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-neutral-100">{prompt.title}</span>
              {prompt.pinned ? (
                <span className="shrink-0" title="Pinned">
                  <Star size={11} aria-hidden className="fill-neutral-500 text-neutral-500" />
                  <span className="sr-only">(pinned)</span>
                </span>
              ) : null}
              {busy ? (
                <Loader2 size={12} aria-hidden className="shrink-0 animate-spin text-neutral-400" />
              ) : null}
            </span>
            {prompt.description ? (
              <span className="mt-0.5 block truncate text-xs text-neutral-400">{prompt.description}</span>
            ) : null}
          </button>
          <button
            ref={chevronRef}
            type="button"
            aria-expanded={false}
            title="Show details"
            onClick={() => {
              pendingFocus.current = "header";
              props.onExpand();
            }}
            className={cn(
              "flex shrink-0 items-center justify-center text-neutral-500 transition-colors hover:text-neutral-200",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
              feedback ? "rounded-tr-xl" : "rounded-r-xl",
              sheet ? "w-11" : "w-9"
            )}
          >
            <ChevronRight size={15} aria-hidden />
            <span className="sr-only">Show details for {prompt.title}</span>
          </button>
        </div>
        {/* Beside the buttons, not inside one: it is not part of the row's name. */}
        {feedback ? <FeedbackLine feedback={feedback} className="-mt-1 px-3 pb-2.5" /> : null}
      </div>
    );
  }

  const context = promptContextLine(prompt.body);
  const scope = promptScopeLabel(prompt);
  const iconButton = cn(
    "inline-flex shrink-0 items-center justify-center rounded-md transition-colors hover:bg-neutral-800",
    FOCUS_RING,
    sheet ? "-my-1.5 h-10 w-10" : "-my-0.5 h-6 w-6"
  );

  return (
    <div
      ref={rootRef}
      data-saved-prompt={prompt.id}
      className={cn(railCardClass(true), "space-y-2.5 p-3")}
    >
      <div className="flex items-start gap-1">
        <button
          ref={headerRef}
          type="button"
          data-card-focus=""
          aria-expanded
          title="Collapse"
          onClick={() => {
            pendingFocus.current = "chevron";
            props.onCollapse();
          }}
          className={cn(
            "min-w-0 flex-1 break-words rounded text-left text-[13px] font-medium leading-5 text-neutral-100",
            FOCUS_RING
          )}
        >
          {prompt.title}
        </button>
        {/* One label, "Pin"; whether it is pinned is `aria-pressed` (and the filled star). */}
        <button
          type="button"
          aria-pressed={prompt.pinned}
          title="Pin"
          onClick={props.onTogglePin}
          className={iconButton}
        >
          <Star
            size={14}
            aria-hidden
            className={prompt.pinned ? "fill-neutral-300 text-neutral-300" : "text-neutral-500"}
          />
          <span className="sr-only">Pin</span>
        </button>
        {sheet ? null : (
          <AdaptiveMenu
            align="right"
            width="w-52"
            title={prompt.title}
            focusOnOpen
            trigger={
              // A span, not a button: the menu wraps its trigger in its own <button>.
              <span title="More actions" className={cn(iconButton, "text-neutral-400 hover:text-neutral-100")}>
                <MoreHorizontal size={15} aria-hidden />
                <span className="sr-only">More actions for {prompt.title}</span>
              </span>
            }
          >
            <div role="none" onKeyDown={moveMenuFocus}>
              <DropdownItem icon={<Pencil size={14} />} onClick={props.onEdit}>
                Edit
              </DropdownItem>
              <DropdownItem icon={<Copy size={14} />} onClick={props.onDuplicate}>
                Duplicate
              </DropdownItem>
              {prompt.projectPath === null ? (
                <DropdownItem
                  icon={<FolderInput size={14} />}
                  disabled={!props.canMoveToProject}
                  onClick={() => props.onMove("project")}
                >
                  Move to this project
                </DropdownItem>
              ) : (
                <DropdownItem icon={<Globe size={14} />} onClick={() => props.onMove("global")}>
                  Move to Global
                </DropdownItem>
              )}
              <DropdownSeparator />
              <DropdownItem icon={<Trash2 size={14} />} onClick={props.onDelete} className={DANGER_ACTION}>
                Delete
              </DropdownItem>
            </div>
          </AdaptiveMenu>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {prompt.tags.map((tag, index) => (
          <RailChip key={`${index}:${tag}`}>{tag}</RailChip>
        ))}
        <RailChip
          title={scope === "Global" ? "Available in every project" : "Saved to this project"}
        >
          {scope === "Global" ? <Globe size={10} aria-hidden /> : <Folder size={10} aria-hidden />}
          {scope}
        </RailChip>
      </div>

      {prompt.description ? (
        <p className="break-words text-[13px] leading-5 text-neutral-300">{prompt.description}</p>
      ) : (
        <p className="line-clamp-4 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-neutral-400">
          {prompt.body.slice(0, BODY_PREVIEW_CHARS)}
        </p>
      )}
      {context !== null ? <p className="text-xs text-neutral-500">{context}</p> : null}

      {confirming ? (
        // In place of Insert / Send (and the actions) while it asks: one decision at a time.
        <div
          role="group"
          aria-label="Delete prompt"
          className="space-y-2 rounded-lg border border-neutral-700 bg-neutral-950/40 p-2.5"
        >
          <p className="text-xs leading-5 text-neutral-300">
            Delete this prompt? It is removed for every device connected to this server.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              ref={cancelDeleteRef}
              type="button"
              variant="outline"
              onClick={props.onCancelDelete}
              className={cn("w-full", sheet && "h-10")}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={props.onConfirmDelete}
              className={cn("w-full bg-danger-600 text-white hover:bg-danger-500", sheet && "h-10")}
            >
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            disabled={!props.canDeliver}
            aria-disabled={busy ? true : undefined}
            title={deliverTitle ?? "Insert into the chat's message box"}
            onClick={() => {
              if (!busy) props.onDeliver("insert");
            }}
            className={cn("w-full", BUSY_DISABLED, sheet && "h-10")}
          >
            {props.busy === "insert" ? <Loader2 size={14} aria-hidden className="animate-spin" /> : null}
            Insert
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!props.canDeliver}
            aria-disabled={busy ? true : undefined}
            title={deliverTitle ?? "Send to the chat as your message"}
            onClick={() => {
              if (!busy) props.onDeliver("send");
            }}
            className={cn("w-full", BUSY_DISABLED, sheet && "h-10")}
          >
            {props.busy === "send" ? <Loader2 size={14} aria-hidden className="animate-spin" /> : null}
            Send
            <ArrowUpRight size={14} aria-hidden />
          </Button>
        </div>
      )}

      {sheet && !confirming ? (
        // The sheet shows its actions in place: a menu there would be a second
        // bottom sheet stacked on the first.
        <div role="group" aria-label={`Actions for ${prompt.title}`} className="grid grid-cols-2 gap-1.5">
          <Button type="button" variant="ghost" onClick={props.onEdit} className={SHEET_ACTION}>
            <Pencil size={14} aria-hidden className="shrink-0" />
            Edit
          </Button>
          <Button type="button" variant="ghost" onClick={props.onDuplicate} className={SHEET_ACTION}>
            <Copy size={14} aria-hidden className="shrink-0" />
            Duplicate
          </Button>
          {prompt.projectPath === null ? (
            <Button
              type="button"
              variant="ghost"
              disabled={!props.canMoveToProject}
              onClick={() => props.onMove("project")}
              className={SHEET_ACTION}
            >
              <FolderInput size={14} aria-hidden className="shrink-0" />
              Move to this project
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => props.onMove("global")} className={SHEET_ACTION}>
              <Globe size={14} aria-hidden className="shrink-0" />
              Move to Global
            </Button>
          )}
          <Button
            ref={deleteActionRef}
            type="button"
            variant="ghost"
            onClick={props.onDelete}
            className={cn(SHEET_ACTION, DANGER_ACTION)}
          >
            <Trash2 size={14} aria-hidden className="shrink-0" />
            Delete
          </Button>
        </div>
      ) : null}

      {props.feedback ? <FeedbackLine feedback={props.feedback} /> : null}
    </div>
  );
};

/**
 * What the card shows after an Insert / Send. Visual only: the panel reads the
 * same words out through its own live regions, which are always mounted — a
 * region that appears together with its text is not reliably announced.
 */
const FeedbackLine: React.FC<{ feedback: SavedPromptFeedback; className?: string }> = ({
  feedback,
  className
}) =>
  feedback.tone === "error" ? (
    <span className={cn("block break-words text-xs text-danger", className)}>{feedback.text}</span>
  ) : (
    <span className={cn("flex items-center gap-1 text-xs text-neutral-400", className)}>
      <Check size={12} aria-hidden className="shrink-0" />
      {feedback.text}
    </span>
  );
