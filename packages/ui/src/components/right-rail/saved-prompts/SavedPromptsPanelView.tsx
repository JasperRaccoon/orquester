/**
 * The Saved prompts panel as drawn: search and the All | Project switch at the
 * top, the Pinned and Prompts sections scrolling between, "New prompt" and the
 * hint pinned at the bottom.
 *
 * Presentational — `SavedPromptsPanel` owns the store, the chat and the
 * editor — so a static render check draws every state from plain props.
 */

import React from "react";
import { Plus, X } from "lucide-react";

import type { SavedPrompt } from "@orquester/api";

import { cn } from "../../../lib/cn";
import type {
  SavedPromptScopeFilter,
  SavedPromptSections,
  SavedPromptsEmptyState
} from "../../../lib/saved-prompts/list.logic";
import { Button } from "../../ui/button";
import { NO_CHAT_TARGET_REASON } from "../chat-target";
import {
  RailEmptyState,
  RailSearchInput,
  RailSectionLabel,
  RailSegmented,
  type RailSegmentOption
} from "../primitives";
import {
  SavedPromptItem,
  type SavedPromptDeliveryAction,
  type SavedPromptFeedback
} from "./SavedPromptItem";

/** What the list does with a prompt; the container wires each to the store, the chat or the editor. */
export interface SavedPromptListActions {
  expand: (id: string | null) => void;
  deliver: (prompt: SavedPrompt, action: SavedPromptDeliveryAction) => void;
  togglePin: (prompt: SavedPrompt) => void;
  edit: (prompt: SavedPrompt) => void;
  duplicate: (prompt: SavedPrompt) => void;
  move: (prompt: SavedPrompt, to: "global" | "project") => void;
  /** Ask to delete: the confirm opens (a dialog docked, on the card in the sheet). */
  remove: (prompt: SavedPrompt) => void;
  /** The card's own confirm (the sheet): delete / keep. */
  confirmRemove: () => void;
  cancelRemove: () => void;
}

interface SavedPromptsPanelViewProps {
  variant: "docked" | "sheet";
  query: string;
  onQueryChange: (query: string) => void;
  scope: SavedPromptScopeFilter;
  onScopeChange: (scope: SavedPromptScopeFilter) => void;
  /** A project is open: the Project scope and "Move to this project" are offered. */
  projectAvailable: boolean;
  sections: SavedPromptSections;
  /** What the list shows instead of rows, or `null`. */
  empty: SavedPromptsEmptyState | null;
  /**
   * A load failure while rows are still shown, as the sentence to show — a
   * refresh over loaded rows, or a first load under rows that arrived by
   * event or with the global list.
   */
  loadError: string | null;
  onRetry: () => void;
  /** The last failed change (pin, move, delete). */
  notice: string | null;
  onDismissNotice: () => void;
  /** A chat is the target of Insert / Send. */
  canDeliver: boolean;
  expandedId: string | null;
  busy: { id: string; action: SavedPromptDeliveryAction } | null;
  feedback: ({ id: string } & SavedPromptFeedback) | null;
  /** The prompt whose delete is being confirmed on its card (the sheet variant only). */
  confirmingDeleteId?: string | null;
  actions: SavedPromptListActions;
  onNewPrompt: () => void;
  /**
   * The scrolling list — focusable by script only, where focus goes when the
   * focused card went away with no card left beside it.
   */
  listRef?: React.Ref<HTMLDivElement>;
}

const NONE_HINT = "Save prompts you reuse — they can use variables like {project} and {branch}.";

export const SavedPromptsPanelView: React.FC<SavedPromptsPanelViewProps> = (props) => {
  const { sections, actions } = props;
  const sheet = props.variant === "sheet";
  const scopeOptions: RailSegmentOption<SavedPromptScopeFilter>[] = [
    { id: "all", label: "All", title: "Global prompts and this project's own" },
    {
      id: "project",
      label: "Project",
      title: props.projectAvailable ? "Only this project's prompts" : "Open a project to list its prompts",
      disabled: !props.projectAvailable
    }
  ];

  const renderItem = (prompt: SavedPrompt) => (
    <SavedPromptItem
      key={`prompt:${prompt.id}`}
      prompt={prompt}
      expanded={props.expandedId === prompt.id}
      variant={props.variant}
      canDeliver={props.canDeliver}
      busy={props.busy?.id === prompt.id ? props.busy.action : null}
      feedback={props.feedback?.id === prompt.id ? props.feedback : null}
      canMoveToProject={props.projectAvailable}
      confirmingDelete={props.confirmingDeleteId === prompt.id}
      onExpand={() => actions.expand(prompt.id)}
      onCollapse={() => actions.expand(null)}
      onDeliver={(action) => actions.deliver(prompt, action)}
      onTogglePin={() => actions.togglePin(prompt)}
      onEdit={() => actions.edit(prompt)}
      onDuplicate={() => actions.duplicate(prompt)}
      onMove={(to) => actions.move(prompt, to)}
      onDelete={() => actions.remove(prompt)}
      onConfirmDelete={actions.confirmRemove}
      onCancelDelete={actions.cancelRemove}
    />
  );

  // Both sections as ONE keyed list, labels included: a card that pins or
  // unpins changes place among its siblings rather than parents, so React
  // keeps its node — and with it the focus (`SavedPromptsPanel` covers a
  // browser that drops it on a move).
  const rows: React.ReactElement[] = [];
  if (sections.pinned.length > 0) {
    rows.push(<RailSectionLabel key="section:pinned">Pinned</RailSectionLabel>);
    for (const prompt of sections.pinned) rows.push(renderItem(prompt));
  }
  if (sections.others.length > 0) {
    rows.push(
      <RailSectionLabel key="section:others" className={sections.pinned.length > 0 ? "pt-2" : undefined}>
        Prompts
      </RailSectionLabel>
    );
    for (const prompt of sections.others) rows.push(renderItem(prompt));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-1">
        <RailSearchInput
          value={props.query}
          onChange={props.onQueryChange}
          placeholder="Search prompts…"
          label="Search saved prompts"
        />
        <RailSegmented
          label="Which prompts to list"
          options={scopeOptions}
          value={props.scope}
          onChange={props.onScopeChange}
        />
      </div>

      <div
        ref={props.listRef}
        tabIndex={-1}
        aria-label="Saved prompts"
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3 focus:outline-none"
      >
        {!props.canDeliver ? (
          <p className="px-0.5 text-xs text-neutral-500">{NO_CHAT_TARGET_REASON}</p>
        ) : null}
        {props.notice !== null ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-2.5 py-2 text-xs"
          >
            <span className="min-w-0 flex-1 break-words text-danger">{props.notice}</span>
            <button
              type="button"
              title="Dismiss"
              onClick={props.onDismissNotice}
              className="-my-1 -mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <X size={12} aria-hidden />
              <span className="sr-only">Dismiss</span>
            </button>
          </div>
        ) : null}
        {props.loadError !== null && props.empty === null ? (
          <div className="flex items-center gap-2 px-0.5 text-xs text-neutral-500">
            <span className="min-w-0 flex-1 break-words">{props.loadError}</span>
            <button
              type="button"
              onClick={props.onRetry}
              className="shrink-0 rounded px-1 text-neutral-300 underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        ) : null}

        {props.empty !== null ? <EmptyState empty={props.empty} onRetry={props.onRetry} /> : rows}
      </div>

      <div className="shrink-0 space-y-2 border-t border-neutral-800 px-3 py-3">
        <Button
          type="button"
          onClick={props.onNewPrompt}
          className={cn("w-full", sheet && "h-10")}
        >
          <Plus size={14} aria-hidden />
          New prompt
        </Button>
        <p className="text-center text-[11px] text-neutral-500">Open a prompt to insert or send it</p>
      </div>

      {/* The Insert / Send outcome, read out: always mounted, so a new text is
          announced (the card shows the same words). */}
      <div role="status" className="sr-only">
        {props.feedback?.tone === "ok" ? props.feedback.text : ""}
      </div>
      <div role="alert" className="sr-only">
        {props.feedback?.tone === "error" ? props.feedback.text : ""}
      </div>
    </div>
  );
};

const EmptyState: React.FC<{ empty: SavedPromptsEmptyState; onRetry: () => void }> = ({
  empty,
  onRetry
}) => {
  switch (empty.kind) {
    case "loading":
      return <RailEmptyState title="Loading prompts…" />;
    case "error":
      return (
        <RailEmptyState
          title="Couldn't load saved prompts"
          hint={empty.message}
          action={
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      );
    case "none":
      return <RailEmptyState title="No saved prompts yet" hint={NONE_HINT} />;
    case "no-project-prompts":
      return (
        <RailEmptyState
          title="No project prompts yet"
          hint="Prompts saved to this project are listed here."
        />
      );
    case "no-matches":
      return <RailEmptyState title={`No prompts match “${empty.query}”`} />;
  }
};
