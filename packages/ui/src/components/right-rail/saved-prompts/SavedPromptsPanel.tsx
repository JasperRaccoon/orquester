/**
 * The right rail's Saved prompts panel: searchable favourites, global and per
 * project, rendered with their `{variables}` and delivered to the visible
 * chat — Insert into its message box, or Send as the user's message.
 *
 * This is the container: the store (`lib/saved-prompts`), the chat
 * (`chat-target.ts`, through `deliver.ts`), the editor (`editor-bridge.ts`),
 * the delete confirm, and keyboard focus across list changes
 * (`list-focus.ts`). What it draws is `SavedPromptsPanelView`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SavedPrompt } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { activeChatTab } from "../../../lib/agent-chat-active-tab";
import { savedPromptLabels } from "../../../lib/saved-prompts/context";
import { useSavedPrompts } from "../../../lib/saved-prompts/hooks";
import {
  normalizeProjectPath,
  savedPromptSections,
  savedPromptsEmptyState,
  savedPromptsLoadErrorLine,
  type SavedPromptScopeFilter
} from "../../../lib/saved-prompts/list.logic";
import {
  dismissSavedPromptsNotice,
  loadSavedPrompts,
  markSavedPromptUsed,
  removeSavedPrompt,
  toggleSavedPromptPin,
  updateSavedPrompt
} from "../../../lib/saved-prompts/store";
import { resolveSavedPrompt } from "../../../lib/saved-prompts/variables";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { deliveredText, insertIntoChat, sendToChat } from "../chat-target";
import type { RightRailPanelProps } from "../types";
import { createSavedPromptDeliverer, type SavedPromptDeliveryAction } from "./deliver";
import {
  openSavedPromptEditor,
  subscribeSavedPromptSaved,
  type SavedPromptEditorRequest
} from "./editor-bridge";
import { duplicateRequest } from "./editor.logic";
import { useIsomorphicLayoutEffect } from "./layout-effect";
import { planListFocus } from "./list-focus";
import { SavedPromptEditor } from "./SavedPromptEditor";
import { CARD_FOCUS_ATTRIBUTE, type SavedPromptFeedback } from "./SavedPromptItem";
import { SavedPromptsPanelView, type SavedPromptListActions } from "./SavedPromptsPanelView";

/** How long "Inserted" / "Sent" stays on the card; a refusal stays longer, to be read. */
const OK_FEEDBACK_MS = 2_000;
const ERROR_FEEDBACK_MS = 8_000;

/**
 * The scope switch and the open card outlive a remount — the rail closing and
 * opening, the mobile sheet — for this page's life. Memory only: nothing here
 * is persisted, so there is nothing stale to validate on load.
 */
const remembered: { scope: SavedPromptScopeFilter; expandedId: string | null } = {
  scope: "all",
  expandedId: null
};

// A prompt saved while this panel is not on screen — History's "Save as
// prompt" — is the open card when it next is.
subscribeSavedPromptSaved((prompt) => {
  remembered.expandedId = prompt.id;
});

type Feedback = { id: string } & SavedPromptFeedback;

/** The card element listing prompt `id` (compared as an attribute, so no id needs escaping). */
function cardElement(list: HTMLElement, id: string): HTMLElement | null {
  for (const card of list.querySelectorAll<HTMLElement>("[data-saved-prompt]")) {
    if (card.getAttribute("data-saved-prompt") === id) return card;
  }
  return null;
}

/** The focused element inside the list, and the card it belongs to — read before a commit changes the DOM. */
function focusedCard(list: HTMLElement | null): { id: string; element: HTMLElement } | null {
  if (list === null || typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !list.contains(active)) return null;
  const id = active.closest("[data-saved-prompt]")?.getAttribute("data-saved-prompt");
  return id ? { id, element: active } : null;
}

/** Focus the control that stands for a card (its header, or its row), else the list itself. */
function focusCard(list: HTMLElement, id: string): void {
  const card = cardElement(list, id);
  const target =
    card?.querySelector<HTMLElement>(`[${CARD_FOCUS_ATTRIBUTE}]:not([disabled])`) ??
    card?.querySelector<HTMLElement>("button:not([disabled])") ??
    null;
  if (target !== null) target.focus();
  else list.focus({ preventScroll: true });
}

export const SavedPromptsPanel: React.FC<RightRailPanelProps> = ({
  sessionId,
  projectPath,
  variant,
  onDelivered
}) => {
  const api = useApi();
  const view = useSavedPrompts(projectPath);
  const projectAvailable = normalizeProjectPath(projectPath).length > 0;

  const [query, setQuery] = useState("");
  const [scope, setScopeState] = useState<SavedPromptScopeFilter>(() => remembered.scope);
  const [expandedId, setExpandedIdState] = useState<string | null>(() => remembered.expandedId);
  const [busy, setBusy] = useState<{ id: string; action: SavedPromptDeliveryAction } | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SavedPrompt | null>(null);
  // The editor normally opens in the rail's one host; this is the fallback
  // for a panel mounted without it, so "New prompt" never does nothing.
  const [localEditor, setLocalEditor] = useState<{
    key: number;
    request: SavedPromptEditorRequest;
  } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The client and project a delivery renders with, read when it runs.
  const latest = useRef({ api, projectPath });
  useIsomorphicLayoutEffect(() => {
    latest.current = { api, projectPath };
  });
  const [deliverer] = useState(() =>
    createSavedPromptDeliverer({
      resolve: (body, target, signal) => {
        const { api: client, projectPath: path } = latest.current;
        return resolveSavedPrompt({
          body,
          projectPath: path,
          sessionId: target,
          api: client,
          ...savedPromptLabels(path, target),
          signal
        });
      },
      activeTarget: activeChatTab,
      insert: insertIntoChat,
      send: sendToChat,
      markUsed: (id) => void markSavedPromptUsed(latest.current.api, id)
    })
  );

  const setScope = useCallback((next: SavedPromptScopeFilter) => {
    remembered.scope = next;
    setScopeState(next);
  }, []);
  const expand = useCallback((id: string | null) => {
    remembered.expandedId = id;
    setExpandedIdState(id);
    // A delete asked on a card (the sheet) is withdrawn when that card closes.
    setPendingDelete(null);
  }, []);

  const showFeedback = useCallback((next: Feedback | null) => {
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = null;
    setFeedback(next);
    if (next !== null) {
      feedbackTimer.current = setTimeout(
        () => {
          feedbackTimer.current = null;
          setFeedback((current) => (current === next ? null : current));
        },
        next.tone === "ok" ? OK_FEEDBACK_MS : ERROR_FEEDBACK_MS
      );
    }
  }, []);

  // A delivery still resolving when the panel goes (the sheet closed, the
  // rail switched panels) lands nowhere; a pending timer fires at nothing.
  useEffect(
    () => () => {
      deliverer.dispose();
      if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    },
    [deliverer]
  );

  // A prompt the editor just saved opens in the list, scrolled into view.
  useEffect(() => subscribeSavedPromptSaved((prompt) => expand(prompt.id)), [expand]);

  const effectiveScope: SavedPromptScopeFilter = projectAvailable ? scope : "all";
  const sections = useMemo(
    () => savedPromptSections(view.prompts, { scope: effectiveScope, projectPath, query }),
    [view.prompts, effectiveScope, projectPath, query]
  );
  const empty = savedPromptsEmptyState({
    status: view.status,
    error: view.error,
    scope: effectiveScope,
    sections,
    query
  });

  // Keyboard focus across list changes (`list-focus.ts`): which card had it is
  // read while rendering, before this commit touches the DOM, and the plan is
  // applied in the same commit.
  const order = useMemo(
    () => [...sections.pinned, ...sections.others].map((prompt) => prompt.id),
    [sections]
  );
  const orderBefore = useRef<readonly string[]>(order);
  // A delete confirmed in the dialog: the card whose focus the dialog took
  // away — its neighbour gets focus when it goes, whether or not the dialog
  // gave focus back to the card first.
  const deletedFromDialog = useRef<string | null>(null);
  const focusedAtRender = focusedCard(listRef.current);
  useIsomorphicLayoutEffect(() => {
    const before = orderBefore.current;
    orderBefore.current = order;
    const list = listRef.current;
    const deleted = deletedFromDialog.current;
    const deletedNow = deleted !== null && before.includes(deleted) && !order.includes(deleted);
    if (deletedNow) deletedFromDialog.current = null;
    const focusedId = focusedAtRender?.id ?? (deletedNow ? deleted : null);
    if (list === null || focusedId === null) return;
    const active = document.activeElement;
    const dropped = active === null || active === document.body;
    const plan = planListFocus(before, order, focusedId);
    if (plan.kind === "keep") {
      // A browser may drop the focus of a node React moves; the control is still there.
      if (dropped && focusedAtRender !== null && focusedAtRender.element.isConnected) {
        focusedAtRender.element.focus({ preventScroll: true });
      }
      if (plan.moved) cardElement(list, plan.id)?.scrollIntoView?.({ block: "nearest" });
    } else if (dropped && plan.kind === "neighbour") {
      focusCard(list, plan.id);
    } else if (dropped && plan.kind === "list") {
      list.focus({ preventScroll: true });
    }
  }, [order]);

  const openEditor = useCallback((request: SavedPromptEditorRequest) => {
    if (!openSavedPromptEditor(request)) setLocalEditor({ key: Date.now(), request });
  }, []);

  const confirmDelete = useCallback(() => {
    setPendingDelete(null);
    if (pendingDelete === null) return;
    const id = pendingDelete.id;
    if (variant === "docked") deletedFromDialog.current = id;
    void removeSavedPrompt(api, id).then((result) => {
      // Refused: the card stays, and nothing waits for it to go.
      if (!result.ok && deletedFromDialog.current === id) deletedFromDialog.current = null;
    });
  }, [api, pendingDelete, variant]);

  const deliver = useCallback(
    async (prompt: SavedPrompt, action: SavedPromptDeliveryAction) => {
      // The chat on screen at the click: the prompt is rendered for it, and
      // goes to it only if it is still the one on screen once rendered.
      const target = sessionId;
      setBusy(target === null ? null : { id: prompt.id, action });
      showFeedback(null);
      const outcome = await deliverer.deliver(prompt, action, target);
      if (outcome.status === "superseded") return;
      setBusy(null);
      if (outcome.status === "refused") {
        showFeedback({ id: prompt.id, tone: "error", text: outcome.reason });
        return;
      }
      showFeedback({ id: prompt.id, tone: "ok", text: deliveredText(outcome.delivery) });
      onDelivered?.();
    },
    [deliverer, onDelivered, sessionId, showFeedback]
  );

  const actions = useMemo<SavedPromptListActions>(
    () => ({
      expand,
      deliver: (prompt, action) => void deliver(prompt, action),
      togglePin: (prompt) => void toggleSavedPromptPin(api, prompt.id),
      edit: (prompt) => openEditor({ mode: "edit", projectPath: projectPath || null, prompt }),
      duplicate: (prompt) => openEditor(duplicateRequest(prompt, projectPath || null)),
      move: (prompt, to) =>
        void updateSavedPrompt(
          api,
          prompt.id,
          { projectPath: to === "global" ? null : projectPath },
          { failure: "Couldn't move the prompt" }
        ),
      remove: (prompt) => setPendingDelete(prompt),
      confirmRemove: confirmDelete,
      cancelRemove: () => setPendingDelete(null)
    }),
    [api, confirmDelete, deliver, expand, openEditor, projectPath]
  );

  // Docked, Delete asks in a dialog. In the mobile sheet a dialog would open
  // UNDER the sheet (z-[100] < z-[110]), so the card asks itself.
  const confirmOnCard = variant === "sheet";

  return (
    <>
      <SavedPromptsPanelView
        variant={variant}
        query={query}
        onQueryChange={setQuery}
        scope={effectiveScope}
        onScopeChange={setScope}
        projectAvailable={projectAvailable}
        sections={sections}
        empty={empty}
        loadError={savedPromptsLoadErrorLine(view.status, view.error)}
        onRetry={() => void loadSavedPrompts(api, projectPath || null, { force: true })}
        notice={view.notice}
        onDismissNotice={dismissSavedPromptsNotice}
        canDeliver={sessionId !== null}
        expandedId={expandedId}
        busy={busy}
        feedback={feedback}
        confirmingDeleteId={confirmOnCard ? (pendingDelete?.id ?? null) : null}
        actions={actions}
        listRef={listRef}
        onNewPrompt={() =>
          openEditor({
            mode: "create",
            projectPath: projectPath || null,
            initial: { scope: effectiveScope === "project" ? "project" : "global" }
          })
        }
      />
      <ConfirmDialog
        open={!confirmOnCard && pendingDelete !== null}
        title="Delete prompt"
        message={
          <>
            Delete <span className="font-medium text-neutral-200">{pendingDelete?.title}</span>? It is
            removed for every device connected to this server.
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
      {localEditor !== null ? (
        <SavedPromptEditor
          key={localEditor.key}
          request={localEditor.request}
          onClose={() => setLocalEditor(null)}
        />
      ) : null}
    </>
  );
};
