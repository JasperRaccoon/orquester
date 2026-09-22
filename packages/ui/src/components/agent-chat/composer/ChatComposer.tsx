// Ported from T3 Code (MIT): apps/web/src/components/chat/ChatComposer.tsx,
// apps/web/src/components/ChatView.tsx (the composer overlay and its inset)
import React from "react";
import { flushSync } from "react-dom";
import { Paperclip, Wand2 } from "lucide-react";
import type {
  AttachmentRef,
  InteractionMode,
  ModelSelection,
  SelectProviderOptionDescriptor
} from "@orquester/api/agent-chat";
import { MAX_TURN_ATTACHMENTS } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { useMediaQuery } from "../../../hooks/use-media-query";
import { useAppStore } from "../../../store/app";
import { useAgentChatDraft } from "../../../lib/agent-chat/hooks";
import type { ChatComposerProps } from "../contracts";
import { AccountChip, ModelChip, OptionChip, PlanChip, RuntimeModeChip } from "./ComposerChips";
import { ComposerAttachments, type StagedAttachment } from "./ComposerAttachments";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerTokenMenu } from "./ComposerTokenMenu";
import { registerComposerHandle } from "./composer-bridge";
import {
  blockedProviderCommandMessage,
  buildSkillMenuItems,
  buildSlashMenuItems,
  compactCommandAvailable,
  menuItemReplacement,
  type ComposerMenuItem
} from "./composer-menu";
import {
  applyEffortArgument,
  findReasoningDescriptor,
  optionDescriptors,
  resolveSelectedModel
} from "./composer-model";
import { isComposerCollapsedMobile, resolveComposerTimelineInset } from "./composer-inset";
import { composerOwnsEscape, isChatTabListenerActive } from "./tab-visibility";
import {
  findComposerShortcutTarget,
  resolveChatShortcut,
  type ComposerShortcutCommand
} from "./composer-shortcuts";
import {
  attachmentRejectionReason,
  composerSubmissionIntentForEnter,
  composerSubmissionValidationMessage,
  decideStagedAttachmentForRef,
  hasSendableContent,
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  pastedTextDisposition,
  proposedPlanTitle,
  resolveFollowUpDisposition,
  resolvePlanFollowUpSubmission,
  submitIsNoOp,
  swallowsStandalonePlanCommand,
  uploadsBlockSend
} from "./composer-submission";
import {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  isTriggerAtPromptStart,
  replaceTextRange,
  type ComposerTrigger
} from "./composer-trigger";
import { useComposerPathSearch } from "./use-composer-path-search";

/** What survives a tab switch: everything the user has not sent yet. */
interface DraftState {
  text: string;
  attachments: StagedAttachment[];
}

const EMPTY_DRAFT: DraftState = { text: "", attachments: [] };

/** 70px → 200px, T3's prompt bounds. *T3: `ComposerPromptEditorTiptap.tsx:729-736`.* */
const PROMPT_MIN_PX = 70;
const PROMPT_MAX_PX = 200;

/** `/effort <id>`: see the note on {@link effortArgumentFromDraft}. */
const EFFORT_ARGUMENT = /^\/effort\s+(\S+)$/i;

/**
 * §4.6.5(a) says `/effort <id>` "applies directly", and §4.6.7's trigger dies
 * at the first space — so an argument can never reach the menu through
 * `detectComposerTrigger`. This is the narrow bridge between the two: when the
 * whole draft is `/effort <id>`, the menu stays open with a single row that
 * applies it. The submit path is untouched, so typing it and pressing Enter
 * with the menu closed still sends ordinary text, exactly as §4.6.5(a) says
 * for `/model` and `/effort`.
 */
function effortArgumentFromDraft(text: string): string | null {
  return EFFORT_ARGUMENT.exec(text.trim())?.[1] ?? null;
}

/**
 * Which chord sends. T3 makes this a setting; Orquester has no UI for it yet,
 * so it is pinned to the default rather than persisted behind a toggle nobody
 * can reach. `composerSubmissionIntentForEnter` already takes the other two.
 */
const SEND_SHORTCUT = "enter" as const;

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");
}

export interface ChatComposerExtraProps {
  /**
   * `true` when the thread has something to compact — the `/compact` menu row
   * is hidden until it does (§4.6.7). Defaults to `true` so a caller that has
   * not wired it cannot hide a command that would have worked.
   */
  threadHasContent?: boolean;
  /** Overrides the root the `@` search walks; defaults to the session's cwd. */
  searchRoot?: string;
  /**
   * `false` while this tab is open but not the visible one. **Every global
   * keyboard listener gates on it** — `MainView` keeps hidden tabs mounted, so
   * without it one chord acts on every open thread at once (Q2-1).
   */
  active?: boolean;
}

/**
 * The composer.
 *
 * **A `<textarea>`, not a rich-text editor** (§7.4, and the spec's "differs"
 * note): T3's Tiptap document buys inline atom chips and costs three cursor
 * coordinate spaces. A textarea plus a token overlay buys `@` and `/` for a
 * fraction of that, at the cost of chips being plain text — which is exactly
 * the trade the spec takes.
 *
 * It is an overlay pinned to the bottom of the timeline and **it publishes its
 * measured height**, so the list uses it as a bottom content inset
 * (`composer-inset.ts` owns the policy — a resting composer keeps the taller
 * reservation so expanding again moves nothing above it).
 *
 * Focus never leaves it: the banners dock above it, the token menu is a
 * `listbox` the textarea owns through `aria-activedescendant`, and every
 * popover returns focus here on close. It goes `inert` for exactly one
 * reason — while a revert is running (§7.5).
 *
 * *T3: `ChatView.tsx:9987-9998` (the overlay), `:5900-5917` (the republished
 * height), `ChatComposer.tsx:5880-5901` (`openControl`).*
 */
export function ChatComposer({
  sessionId,
  provider,
  modelSelection,
  runtimeMode,
  interactionMode,
  showPlanModeToggle,
  accountLabel,
  isTurnActive,
  hasPendingRequest,
  queue,
  activePlan,
  actionableProposedPlan,
  reverting,
  actions,
  onHeightChange,
  threadHasContent = true,
  searchRoot,
  active
}: ChatComposerProps & ChatComposerExtraProps): React.ReactElement {
  const isMobile = !useMediaQuery("(min-width: 640px)");
  const sessionCwd = useAppStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.cwd ?? null
  );
  const root = searchRoot ?? sessionCwd;
  // The store's fallback draft, drained once on mount (see the effect below).
  const { actions: storeDraftActions } = useAgentChatDraft(sessionId);
  /**
   * The per-device composer preferences, read live from the app store.
   *
   * Deliberately NOT a local copy: Settings writes these (`setChatPrefs`), and
   * a snapshot taken once at mount would leave the two toggles apparently
   * broken until the tab was reopened. `lib/chat-prefs.ts` owns the persisted
   * shape and its default.
   */
  const chatPrefs = useAppStore((state) => state.chatPrefs);

  const shellRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const draftsRef = React.useRef(new Map<string, DraftState>());
  const draftRef = React.useRef<DraftState>(EMPTY_DRAFT);
  const insetRef = React.useRef(0);
  const restingRef = React.useRef(true);
  const retryFilesRef = React.useRef(new Map<string, File>());
  /** Latched by the paste-as-text chord; read and cleared by the next paste. */
  const bypassPasteRef = React.useRef(false);
  const menuId = React.useId();

  const [draft, setDraft] = React.useState<DraftState>(EMPTY_DRAFT);
  const [cursor, setCursor] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [menuDismissed, setMenuDismissed] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);

  draftRef.current = draft;

  // ---------------------------------------------------------------------
  // Per-tab drafts (§7.1)
  // ---------------------------------------------------------------------
  // One `AgentChatView` serves every chat tab in a project, so this component's
  // identity survives a tab switch and the draft has to be swapped by hand —
  // otherwise switching tabs would hand thread B thread A's message.
  const previousSessionRef = React.useRef(sessionId);
  React.useLayoutEffect(() => {
    const previous = previousSessionRef.current;
    if (previous === sessionId) return;
    draftsRef.current.set(previous, draftRef.current);
    previousSessionRef.current = sessionId;
    const next = draftsRef.current.get(sessionId) ?? EMPTY_DRAFT;
    setDraft(next);
    setCursor(next.text.length);
    setNotice(null);
    setSending(false);
    setMenuDismissed(false);
  }, [sessionId]);

  // ---------------------------------------------------------------------
  // Height publishing (§7.4)
  // ---------------------------------------------------------------------
  const resting = !focused && draft.text.length === 0 && draft.attachments.length === 0;
  restingRef.current = resting;

  const publishHeight = React.useCallback(
    (height: number) => {
      const next = Math.ceil(height);
      if (next <= 0) return;
      const inset = resolveComposerTimelineInset({
        currentInset: insetRef.current,
        overlayHeight: next,
        isResting: restingRef.current
      });
      if (inset === insetRef.current) return;
      insetRef.current = inset;
      onHeightChange(inset);
    },
    [onHeightChange]
  );

  React.useLayoutEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    // A held reservation belongs to the previous thread's draft: rebuild it
    // from this thread's overlay so a tall draft elsewhere does not pad it.
    insetRef.current = 0;
    publishHeight(element.getBoundingClientRect().height);
  }, [publishHeight, sessionId]);

  React.useLayoutEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    const update = () => publishHeight(element.getBoundingClientRect().height);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [publishHeight]);

  const collapsed = isComposerCollapsedMobile({
    isMobileViewport: isMobile,
    isFocused: focused,
    hasMultilineDraft: draft.text.includes("\n"),
    hasAttachments: draft.attachments.length > 0,
    hasDockedBanner: hasPendingRequest || actionableProposedPlan !== null
  });

  // Auto-grow. `field-sizing` would do this in CSS but is not in every engine
  // the web client ships to, and a textarea that does not grow is the single
  // most noticeable way a composer feels unfinished.
  React.useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    const min = collapsed ? 32 : PROMPT_MIN_PX;
    element.style.height = `${Math.min(PROMPT_MAX_PX, Math.max(min, element.scrollHeight))}px`;
  }, [collapsed, draft.text]);

  // ---------------------------------------------------------------------
  // Draft insertion, shared with every other surface (§7.4)
  // ---------------------------------------------------------------------
  const focusAtEnd = React.useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const end = element.value.length;
    element.setSelectionRange(end, end);
    setCursor(end);
  }, []);

  const applyCaret = React.useCallback((at: number) => {
    // After paint: the textarea's own value has to land before the caret does.
    queueMicrotask(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(at, at);
    });
    setCursor(at);
  }, []);

  /**
   * Insert text into the draft.
   *
   * **Batch-safe**, exactly as `stageAttachment` below is and for the same
   * reason: `draftRef.current` is refreshed in the render body, so several
   * calls in one synchronous tick would otherwise all read the same pre-batch
   * text and the last write would win. `drainQueueToComposer` calls this once
   * per queued message in a loop, so a non-batch-safe version silently drops
   * every returned message but the last — the exact data loss §7.4 forbids.
   *
   * The optimistic `draftRef.current` write is what makes the *next* call in
   * the same tick see this one's text.
   */
  const insertText = React.useCallback(
    (text: string, mode: "cursor" | "append" = "cursor") => {
      if (!text) return;
      const current = draftRef.current;
      const at =
        mode === "append" ? current.text.length : Math.min(cursor, current.text.length);
      const gap =
        at > 0 && !/\s$/.test(current.text.slice(0, at)) && !/^\s/.test(text) ? " " : "";
      const applied = replaceTextRange(current.text, at, at, `${gap}${text}`);
      draftRef.current = { ...current, text: applied.text };
      setDraft((state) =>
        state.text === applied.text ? state : { ...state, text: applied.text }
      );
      applyCaret(applied.cursor);
    },
    [applyCaret, cursor]
  );

  const openControl = React.useCallback((command: ComposerShortcutCommand) => {
    // `flushSync` so the control exists in the DOM before we query for it: an
    // un-collapsing composer renders its chips in the same commit.
    flushSync(() => setFocused(true));
    const target = findComposerShortcutTarget(shellRef.current, command);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.click();
  }, []);

  /**
   * Stage an attachment whose bytes are already on the daemon — a browser
   * element pick, a chat-targeted drop, a queued message coming back.
   *
   * The optimistic write to `draftRef` is what makes a *batch* of these
   * correct: a delivery carrying three files calls this three times in one
   * tick, and without it every call would measure the budget against the same
   * pre-batch draft and let a ninth attachment through.
   */
  const stageAttachment = React.useCallback((ref: AttachmentRef): boolean => {
    const current = draftRef.current;
    const decision = decideStagedAttachmentForRef({ existing: current.attachments, ref });
    if (decision.kind === "duplicate") return true;
    if (decision.kind === "rejected") {
      setNotice(decision.reason);
      return false;
    }
    const entry: StagedAttachment = {
      key: decision.key,
      name: decision.name,
      sizeBytes: decision.sizeBytes,
      mimeType: decision.mimeType,
      status: "ready",
      progress: 1,
      ref
    };
    draftRef.current = { ...current, attachments: [...current.attachments, entry] };
    setDraft((state) =>
      state.attachments.some((existing) => existing.key === entry.key)
        ? state
        : { ...state, attachments: [...state.attachments, entry] }
    );
    return true;
  }, []);

  /**
   * R8-m12: §7.8 suppresses autofocus **on mobile only** — "a keyboard on every
   * navigation is worse than a tap". On a desktop viewport opening a thread
   * should put the caret in the composer, which is what T3 does; without this
   * every desktop tab switch cost a click. Skipped while a request is docked,
   * so the caret never lands behind a card the user has to read first.
   */
  React.useEffect(() => {
    if (isMobile || active === false || hasPendingRequest || reverting) return;
    textareaRef.current?.focus({ preventScroll: true });
    // One shot per thread, not per keystroke: `sessionId` is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isMobile, active]);

  React.useEffect(
    () =>
      registerComposerHandle(sessionId, {
        insertText,
        stageAttachment,
        focusAtEnd,
        openControl
      }),
    [focusAtEnd, insertText, openControl, sessionId, stageAttachment]
  );

  /**
   * Drain the store's **fallback** draft once per thread (§7.4).
   *
   * That draft is where a queued message returned by an interrupt lands while
   * this tab's composer was not mounted — and, because the bridge only carries
   * text, it is also where the *attachments* of a returned message land even
   * when a composer **is** mounted. Without this drain those files are held by
   * the store and never become chips, so the user sees the text come back
   * without its attachments.
   *
   * `takeDraft` is take-and-clear: the store draft is persisted, so a read that
   * left it behind would re-apply the same text on the next open. It runs
   * after the handle is registered, so anything the drain itself routes back
   * through the bridge finds a live composer.
   */
  React.useEffect(() => {
    const drained = storeDraftActions.takeDraft();
    if (drained.text.trim().length > 0) {
      insertText(drained.text, "append");
    }
    for (const attachment of drained.attachments) {
      stageAttachment(attachment);
    }
    // Keyed on the thread only: one drain per tab, not one per action identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ---------------------------------------------------------------------
  // Provider catalog, scoped to this thread's cwd (§4.6.4)
  // ---------------------------------------------------------------------
  const workspaceSnapshot = React.useMemo(
    () => provider?.workspaceSnapshots?.find((snapshot) => snapshot.cwd === root),
    [provider, root]
  );
  /**
   * The per-cwd overlay wins, **per array and only when it is non-empty**
   * (R2-1, defence in depth).
   *
   * `??` alone falls back on `undefined` but not on `[]`, and an adapter whose
   * overlay carries skills but drops `slashCommands` (Claude's did) therefore
   * blanked the provider half of the `/` menu from the first turn onward — no
   * `/init`, no `/review`, no user `.claude/commands`. The machine snapshot is
   * still the right answer for an array the overlay does not speak to, so the
   * two arrays fall back independently rather than as one object.
   */
  const slashCommands = workspaceSnapshot?.slashCommands?.length
    ? workspaceSnapshot.slashCommands
    : (provider?.slashCommands ?? []);
  const skills = workspaceSnapshot?.skills?.length
    ? workspaceSnapshot.skills
    : (provider?.skills ?? []);
  const models = provider?.models ?? [];
  const selectedModel = resolveSelectedModel(models, modelSelection);
  const selectDescriptors = optionDescriptors(selectedModel).filter(
    (descriptor): descriptor is SelectProviderOptionDescriptor => descriptor.type === "select"
  );
  const reasoningDescriptor = findReasoningDescriptor(selectedModel);

  const applyModelSelectionChange = React.useCallback(
    (selection: ModelSelection) => {
      void actions.setMode({ modelSelection: selection }).catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : "Could not change the model.");
      });
    },
    [actions]
  );

  const setPlanMode = React.useCallback(
    (mode: InteractionMode) => actions.setInteractionMode(mode),
    [actions]
  );

  // ---------------------------------------------------------------------
  // Trigger + menu (§4.6.7)
  // ---------------------------------------------------------------------
  const effortArgument = reasoningDescriptor ? effortArgumentFromDraft(draft.text) : null;
  const trigger: ComposerTrigger | null = !focused
    ? null
    : (detectComposerTrigger(draft.text, cursor) ??
      (effortArgument
        ? {
            kind: "slash-command",
            query: `effort ${effortArgument}`,
            rangeStart: 0,
            rangeEnd: draft.text.length
          }
        : null));

  const pathQuery = trigger?.kind === "path" ? trigger.query : null;
  const pathSearch = useComposerPathSearch(pathQuery === null ? null : root, pathQuery);

  const menuItems = React.useMemo<ComposerMenuItem[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === "path") {
      return pathSearch.entries.map((entry) => ({
        id: `path:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        pathKind: "file" as const,
        label: entry.name,
        description: entry.directory
      }));
    }
    if (trigger.kind === "skill") return buildSkillMenuItems(skills, trigger.query);
    if (effortArgument && reasoningDescriptor) {
      return [
        {
          id: "host:effort-argument",
          type: "host-command",
          command: "effort",
          label: `/effort ${effortArgument}`,
          description: `Set ${reasoningDescriptor.label.toLowerCase()} for this thread`
        }
      ];
    }
    return buildSlashMenuItems({
      slashCommands,
      skills,
      showPlanModeToggle,
      hasEffortOption: reasoningDescriptor !== null,
      compactAvailable: compactCommandAvailable({
        threadHasContent,
        textBeforeTrigger: draft.text.slice(0, trigger.rangeStart),
        textAfterTrigger: draft.text.slice(trigger.rangeEnd),
        attachmentCount: draft.attachments.length,
        contextCount: 0
      }),
      showSkillsInSlashMenu: chatPrefs.showSkillsInSlashMenu,
      isAtPromptStart: isTriggerAtPromptStart(trigger),
      query: trigger.query
    });
  }, [
    draft.attachments.length,
    draft.text,
    effortArgument,
    pathSearch.entries,
    chatPrefs.showSkillsInSlashMenu,
    reasoningDescriptor,
    showPlanModeToggle,
    skills,
    slashCommands,
    threadHasContent,
    trigger
  ]);

  const triggerKind = trigger?.kind ?? null;
  const triggerStart = trigger?.rangeStart ?? null;
  React.useEffect(() => setHighlightedIndex(0), [triggerKind, trigger?.query]);
  // A menu dismissed with Escape stays dismissed until the trigger moves, so
  // the user can finish typing `/not-a-command` in peace.
  React.useEffect(() => setMenuDismissed(false), [triggerKind, triggerStart]);

  const menuOpen = trigger !== null && (menuItems.length > 0 || pathSearch.loading);
  const showMenu = menuOpen && !menuDismissed;

  const pickMenuItem = React.useCallback(
    (item: ComposerMenuItem) => {
      if (!trigger) return;
      const replacement = menuItemReplacement(item);
      const rangeEnd = extendReplacementRangeForTrailingSpace(
        draft.text,
        trigger.rangeEnd,
        replacement
      );
      const applied = replaceTextRange(draft.text, trigger.rangeStart, rangeEnd, replacement);
      setDraft((state) => ({ ...state, text: applied.text }));
      applyCaret(applied.cursor);

      // §4.6.5(a): a host command never reaches the draft — the trigger is
      // erased above (its replacement is "") and the action happens here.
      if (item.type !== "host-command") return;
      if (item.command === "plan" || item.command === "default") {
        setPlanMode(item.command === "plan" ? "plan" : "default");
        return;
      }
      if (item.command === "effort" && effortArgument && reasoningDescriptor) {
        const next = applyEffortArgument(
          modelSelection ?? { model: selectedModel?.slug ?? "" },
          reasoningDescriptor,
          effortArgument
        );
        if (next) applyModelSelectionChange(next);
        else setNotice(`“${effortArgument}” is not one of this model's ${reasoningDescriptor.label.toLowerCase()} levels.`);
        return;
      }
      openControl(item.command === "effort" ? "effort" : "model");
    },
    [
      applyCaret,
      applyModelSelectionChange,
      draft.text,
      effortArgument,
      modelSelection,
      openControl,
      reasoningDescriptor,
      selectedModel?.slug,
      setPlanMode,
      trigger
    ]
  );

  // ---------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------
  const uploadOne = React.useCallback(
    async (key: string, file: File) => {
      try {
        const ref: AttachmentRef = await actions.uploadAttachment(file, {
          name: file.name,
          type: file.type
        });
        setDraft((state) => ({
          ...state,
          attachments: state.attachments.map((entry) =>
            entry.key === key ? { ...entry, status: "ready" as const, progress: 1, ref } : entry
          )
        }));
      } catch (error) {
        setDraft((state) => ({
          ...state,
          attachments: state.attachments.map((entry) =>
            entry.key === key
              ? {
                  ...entry,
                  status: "failed" as const,
                  error: error instanceof Error ? error.message : "Upload failed"
                }
              : entry
          )
        }));
      }
    },
    [actions]
  );

  const stageFiles = React.useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const existing = draftRef.current.attachments;
      // Staged and in-flight count together against the same budget, and the
      // running `preparing` tally is what makes a multi-file drop refuse the
      // ninth file rather than accept all of them against a stale count.
      const staged = existing.filter((entry) => entry.status === "ready").length;
      let preparing = existing.filter((entry) => entry.status !== "ready").length;
      const accepted: Array<{ entry: StagedAttachment; file: File }> = [];
      let rejection: string | null = null;

      for (const file of files) {
        const reason = attachmentRejectionReason({
          name: file.name,
          sizeBytes: file.size,
          mimeType: file.type,
          stagedCount: staged,
          preparingCount: preparing
        });
        if (reason) {
          rejection ??= reason;
          continue;
        }
        preparing += 1;
        accepted.push({
          file,
          entry: {
            key: `${file.name}:${file.size}:${Date.now()}:${accepted.length}:${Math.random()}`,
            name: file.name,
            sizeBytes: file.size,
            mimeType: file.type,
            status: "uploading",
            progress: 0
          }
        });
      }

      setNotice(rejection);
      if (accepted.length === 0) return;
      setDraft((state) => ({
        ...state,
        attachments: [...state.attachments, ...accepted.map(({ entry }) => entry)]
      }));
      for (const { entry, file } of accepted) {
        retryFilesRef.current.set(entry.key, file);
        void uploadOne(entry.key, file);
      }
    },
    [uploadOne]
  );

  const removeAttachment = React.useCallback((key: string) => {
    retryFilesRef.current.delete(key);
    setDraft((state) => ({
      ...state,
      attachments: state.attachments.filter((entry) => entry.key !== key)
    }));
  }, []);

  const retryAttachment = React.useCallback(
    (key: string) => {
      const file = retryFilesRef.current.get(key);
      if (!file) return;
      setDraft((state) => ({
        ...state,
        attachments: state.attachments.map((entry) =>
          entry.key === key ? { ...entry, status: "uploading" as const, progress: 0 } : entry
        )
      }));
      void uploadOne(key, file);
    },
    [uploadOne]
  );

  // ---------------------------------------------------------------------
  // Send (§7.4)
  // ---------------------------------------------------------------------
  const uploadBlock = uploadsBlockSend(draft.attachments);
  const sendable = hasSendableContent({
    text: draft.text,
    attachmentCount: draft.attachments.length
  });
  const sendDisabledReason = reverting
    ? "A revert is running."
    : hasPendingRequest
      ? "Answer the request above first."
      : uploadBlock;

  const runSend = React.useCallback(
    async (text: string, mode: InteractionMode, refs: AttachmentRef[]) => {
      setSending(true);
      try {
        await actions.sendTurn({
          text,
          ...(refs.length > 0 ? { attachments: refs } : {}),
          interactionMode: mode,
          ...(modelSelection ? { modelSelection } : {})
        });
        // The keyboard is worse than a lost second on mobile: dismiss it only
        // once the send actually succeeded.
        if (isMobile) textareaRef.current?.blur();
      } catch (error) {
        // A failed send goes back to the FRONT of the draft, ahead of anything
        // typed since, so nothing the user wrote while it was in flight is
        // reordered behind it.
        setDraft((state) => ({
          ...state,
          text: state.text.trim().length > 0 ? `${text}\n\n${state.text}` : text
        }));
        setNotice(error instanceof Error ? error.message : "Could not send the message.");
      } finally {
        setSending(false);
      }
    },
    [actions, isMobile, modelSelection]
  );

  const submit = React.useCallback(
    (intent: "foreground" | "alternate") => {
      if (reverting || sending) return;
      const text = draft.text;

      // §4.6.5(a): `/plan` and `/default` are re-recognised on submit, but only
      // when the whole trimmed draft is that command and nothing is attached.
      // §4.6.5(a): swallowed client-side ONLY where the toggle exists. On
      // OpenCode/Grok the provider may dispatch `/plan` natively, so with the
      // toggle hidden the draft is ordinary text and goes to the wire.
      const standalone = swallowsStandalonePlanCommand({
        text,
        showPlanModeToggle,
        attachmentCount: draft.attachments.length
      });
      if (standalone) {
        setPlanMode(standalone);
        setDraft((state) => ({ ...state, text: "" }));
        applyCaret(0);
        return;
      }

      // R7-3: the plan is resolved BEFORE the emptiness guard, because an
      // empty draft is exactly the input "Implement" is defined on — the plan
      // supplies the text. Guarding first made the enabled Implement button a
      // silent no-op.
      const plan = actionableProposedPlan
        ? resolvePlanFollowUpSubmission({
            draftText: text,
            planMarkdown: actionableProposedPlan.planMarkdown
          })
        : null;

      if (submitIsNoOp({ hasSendableContent: sendable, hasActionablePlan: plan !== null })) {
        return;
      }
      if (sendDisabledReason) {
        setNotice(sendDisabledReason);
        return;
      }

      // §4.6.5(c): Grok's `/always-approve` would desynchronise the host's
      // runtime mode. Refuse on the SEND path, not just in the menu — the user
      // can type it by hand. (Absorbed from W11's slash-commands.logic.ts.)
      const blocked = blockedProviderCommandMessage(provider?.id, text);
      if (blocked) {
        setNotice(blocked);
        return;
      }
      const outgoing = plan?.text ?? text.trim();
      const outgoingMode = plan?.interactionMode ?? interactionMode;

      const validation = composerSubmissionValidationMessage({
        prompt: outgoing,
        submissionTarget: "provider-turn"
      });
      if (validation) {
        setNotice(validation);
        return;
      }

      const refs = draft.attachments
        .map((entry) => entry.ref)
        .filter((ref): ref is AttachmentRef => ref !== undefined);
      const disposition = resolveFollowUpDisposition({
        followUpBehavior: chatPrefs.followUpBehavior,
        intent,
        // A plan follow-up is the answer to a settled turn: never queued.
        isRunning: isTurnActive && plan === null
      });

      setDraft(EMPTY_DRAFT);
      applyCaret(0);
      setNotice(null);
      // The retry map holds the original `File` objects; a sent draft can no
      // longer be retried, so let them go rather than pinning every file the
      // session ever attached in memory.
      retryFilesRef.current.clear();

      if (disposition === "queue") {
        actions.queueMessage({
          text: outgoing,
          attachments: refs,
          context: [],
          interactionMode: outgoingMode,
          // The client store owns the tool boundary a queued message anchors
          // to — the composer does not observe activities, so it anchors to
          // "whatever is current" and lets the queue re-anchor it.
          queuedAfterToolActivityId: null,
          holdUntilUserAction: false
        });
        return;
      }
      void runSend(outgoing, outgoingMode, refs);
    },
    [
      actionableProposedPlan,
      actions,
      applyCaret,
      draft.attachments,
      draft.text,
      interactionMode,
      isTurnActive,
      chatPrefs.followUpBehavior,
      reverting,
      runSend,
      sendDisabledReason,
      sendable,
      sending,
      setPlanMode
    ]
  );

  /**
   * Escape interrupts a running turn — and **returns every queued message to
   * the composer first**, because a Stop that silently discards what the user
   * queued is indistinguishable from losing it.
   */
  const interrupt = React.useCallback(() => {
    // The store's own `interrupt()` drains the queue back into the composer
    // (§7.4), one `appendToDraft` per message, each routed through the bridge
    // into `insertText` above. This used to ALSO join the queue locally and
    // then call `drainQueueToComposer()` itself — two writers for one draft,
    // where the store's per-message writes landed a microtask later and
    // clobbered the local join. One path only.
    void actions.interrupt().catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : "Could not stop the turn.");
    });
  }, [actions]);

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Q2-1: every open chat tab keeps this listener alive (MainView hides
      // inactive tabs with a class, it does not unmount them), so without this
      // gate one chord fires on every thread at once.
      if (!isChatTabListenerActive(active, shellRef.current)) return;
      const shortcut = resolveChatShortcut(event);
      if (!shortcut) return;
      if (shortcut.kind === "steer-queued") {
        const head = queue[0];
        if (!head) return;
        event.preventDefault();
        void actions.sendQueuedNow(head.id).catch((error: unknown) => {
          setNotice(error instanceof Error ? error.message : "Could not send the queued message.");
        });
        return;
      }
      /*
       * R7-7: Escape must stop a running turn from anywhere in the thread, not
       * only while the textarea has focus — the user clicks a tool row to
       * expand it and the chord goes dead. The textarea branch keeps first
       * refusal (an open token menu consumes Escape there and stops
       * propagation), so this only ever sees the events it did not take.
       * `scroll-to-end` stays the timeline's.
       */
      if (shortcut.kind === "interrupt") {
        // V1 §10.1: the shell registers a second window Escape listener. It
        // owns everything OUTSIDE this composer shell; we own inside it, minus
        // the textarea (whose own handler gives the token menu first refusal).
        // `stopPropagation` cannot silence a sibling on the same node, so both
        // sides gate on `defaultPrevented` and on disjoint scopes — otherwise
        // one Escape sent two interrupts.
        const target = event.target;
        const insideComposerShell =
          target instanceof Node && shellRef.current?.contains(target) === true;
        if (
          !composerOwnsEscape({
            defaultPrevented: event.defaultPrevented,
            insideComposerShell,
            isTextarea: target === textareaRef.current,
            isTurnActive
          })
        ) {
          return;
        }
        event.preventDefault();
        interrupt();
        return;
      }
      if (shortcut.kind !== "control") return;
      // Only swallow the chord when a control actually answers to it, so a
      // composer without a plan toggle leaves its key to whoever wants it.
      if (!findComposerShortcutTarget(shellRef.current, shortcut.command)) return;
      event.preventDefault();
      event.stopPropagation();
      openControl(shortcut.command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actions, active, interrupt, isTurnActive, openControl, queue]);

  const onTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isPasteAsTextShortcut(event, isApplePlatform())) bypassPasteRef.current = true;
    // An IME candidate window is open: Enter COMMITS the candidate and Escape
    // CANCELS the composition. Acting on either here sends a half-converted
    // prompt or kills the composition. `composerSubmissionIntentForEnter` also
    // refuses on its own (tested there); this early return additionally keeps
    // Escape and the menu keys out of a live composition.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (showMenu) {
      const count = Math.max(1, menuItems.length);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((index) => (index + 1) % count);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((index) => (index - 1 + count) % count);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = menuItems[highlightedIndex];
        if (item) {
          event.preventDefault();
          pickMenuItem(item);
          return;
        }
      }
      if (event.key === "Escape") {
        // The menu takes Escape before the turn does: closing a menu the user
        // just opened must not also stop the agent.
        event.preventDefault();
        event.stopPropagation();
        setMenuDismissed(true);
        return;
      }
    }

    if (event.key === "Escape" && isTurnActive) {
      event.preventDefault();
      interrupt();
      return;
    }
    if (event.key !== "Enter") return;

    const intent = composerSubmissionIntentForEnter({
      isMobileViewport: isMobile,
      shiftKey: event.shiftKey,
      modifierKey: event.metaKey || event.ctrlKey,
      isRunning: isTurnActive,
      sendShortcut: SEND_SHORTCUT,
      prompt: draft.text,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode
    });
    if (intent === null) return;
    event.preventDefault();
    submit(intent);
  };

  // ---------------------------------------------------------------------
  // Paste and drop
  // ---------------------------------------------------------------------
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      stageFiles(files);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const macPlatform = isApplePlatform();
    // A `paste` event carries no modifier state, so the escape hatch has to be
    // latched by the keydown that produced it — the chord and the paste are
    // two separate events and only the first one knows which keys were held.
    const bypass = bypassPasteRef.current;
    bypassPasteRef.current = false;
    const disposition = pastedTextDisposition({
      text,
      canAttach: draft.attachments.length < MAX_TURN_ATTACHMENTS,
      bypassAutoAttachment: bypass
    });
    if (disposition === "inline") return;
    event.preventDefault();
    const name = nextPastedTextFileName(draft.attachments.map((entry) => entry.name));
    stageFiles([new File([text], name, { type: "text/plain" })]);
    setNotice(
      `Long paste attached as ${name}. Paste with ${macPlatform ? "⌘" : "Ctrl"}+Shift+V to keep it in the message instead.`
    );
  };

  const planTitle = actionableProposedPlan
    ? proposedPlanTitle(actionableProposedPlan.planMarkdown)
    : null;
  const willQueue =
    resolveFollowUpDisposition({
      followUpBehavior: chatPrefs.followUpBehavior,
      intent: "foreground",
      isRunning: isTurnActive
    }) === "queue";

  return (
    <div
      ref={shellRef}
      // The ONE reason the composer goes inert (§7.5).
      {...(reverting ? { inert: "" } : {})}
      data-agent-chat-composer-shell={sessionId}
      data-slot="composer-shell"
      className="pointer-events-auto w-full min-w-0 px-2 pb-2 sm:px-4 sm:pb-3"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        stageFiles(files);
      }}
    >
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        {showMenu ? (
          <ComposerTokenMenu
            id={menuId}
            items={menuItems}
            highlightedIndex={highlightedIndex}
            onHighlight={setHighlightedIndex}
            onPick={pickMenuItem}
            loading={pathSearch.loading}
            emptyLabel={
              triggerKind === "path" ? "No matching files." : "No matching commands or skills."
            }
          />
        ) : null}

        <form
          data-chat-composer-form="true"
          onSubmit={(event) => {
            event.preventDefault();
            submit("foreground");
          }}
          className={cn(
            // Opaque on purpose: the timeline scrolls BEHIND this overlay, and
            // a translucent surface would show rows sliding through the draft.
            "rounded-[1.375rem] border border-neutral-800 bg-neutral-900",
            "px-3 pb-2 pt-3 shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] sm:px-4 sm:pt-3.5",
            focused && "border-neutral-700",
            collapsed && "py-1.5"
          )}
        >
          <ComposerAttachments
            attachments={draft.attachments}
            onRemove={removeAttachment}
            onRetry={retryAttachment}
            disabled={reverting}
          />

          <label className="sr-only" htmlFor={`${menuId}-input`}>
            Message
          </label>
          <textarea
            id={`${menuId}-input`}
            ref={textareaRef}
            value={draft.text}
            rows={1}
            spellCheck
            role="combobox"
            aria-expanded={showMenu}
            aria-controls={showMenu ? menuId : undefined}
            aria-activedescendant={showMenu ? `${menuId}-option-${highlightedIndex}` : undefined}
            aria-autocomplete="list"
            placeholder={
              isTurnActive
                ? willQueue
                  ? "Queue a follow-up…"
                  : "Steer the agent…"
                : planTitle
                  ? `Refine “${planTitle}” — or press Implement`
                  : "Ask, or describe the change…"
            }
            onChange={(event) => {
              setDraft((state) => ({ ...state, text: event.target.value }));
              setCursor(event.target.selectionStart ?? event.target.value.length);
              if (notice) setNotice(null);
            }}
            onSelect={(event) =>
              setCursor((event.target as HTMLTextAreaElement).selectionStart ?? 0)
            }
            onKeyDown={onTextareaKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className={cn(
              "ac-scroll-thin block w-full resize-none overflow-y-auto bg-transparent",
              "text-neutral-100 placeholder:text-neutral-600 focus:outline-none",
              // ≥16px on a coarse pointer is not a style choice: iOS Safari
              // zooms the viewport on focus of anything smaller, and the zoom
              // does not undo itself.
              "text-base sm:text-sm"
            )}
          />

          {notice ? (
            <p className="pt-1 text-[11px] leading-snug text-warn-300" role="status">
              {notice}
            </p>
          ) : null}

          <div className="flex items-end justify-between gap-2 pt-2">
            <div
              data-chat-composer-resting-controls="true"
              className="flex min-w-0 flex-wrap items-center gap-0.5"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  stageFiles(files);
                }}
              />
              <button
                type="button"
                data-composer-shortcut="attach"
                aria-label="Attach files"
                title="Attach files"
                disabled={reverting || draft.attachments.length >= MAX_TURN_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "ac-press inline-flex h-7 w-7 items-center justify-center rounded-md",
                  "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  "disabled:pointer-events-none disabled:opacity-40"
                )}
              >
                <Paperclip size={14} aria-hidden />
              </button>

              <ModelChip
                models={models}
                selection={modelSelection}
                selectedModel={selectedModel}
                disabled={reverting}
                onChange={applyModelSelectionChange}
                returnFocusTo={() => textareaRef.current}
              />
              {selectDescriptors.map((descriptor) => (
                <OptionChip
                  key={descriptor.id}
                  descriptor={descriptor}
                  selection={modelSelection}
                  fallbackModelSlug={selectedModel?.slug ?? ""}
                  disabled={reverting}
                  onChange={applyModelSelectionChange}
                  returnFocusTo={() => textareaRef.current}
                />
              ))}
              <RuntimeModeChip
                mode={runtimeMode}
                disabled={reverting}
                onChange={(mode) => {
                  void actions.setMode({ runtimeMode: mode }).catch((error: unknown) => {
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : "Could not change the permission mode."
                    );
                  });
                }}
                returnFocusTo={() => textareaRef.current}
              />
              {showPlanModeToggle ? (
                <PlanChip
                  interactionMode={interactionMode}
                  disabled={reverting}
                  onChange={setPlanMode}
                />
              ) : null}
              {accountLabel ? <AccountChip label={accountLabel} /> : null}
            </div>

            <ComposerPrimaryActions
              isRunning={isTurnActive}
              showPlanFollowUp={actionableProposedPlan !== null}
              promptHasText={draft.text.trim().length > 0}
              hasSendableContent={sendable}
              isSendBusy={sending}
              sendDisabledReason={sendDisabledReason}
              willQueue={willQueue}
              onInterrupt={interrupt}
            />
          </div>
        </form>

        {activePlan && activePlan.steps.length > 0 ? (
          <p className="ac-tabular flex items-center gap-1 px-2 pt-1 text-[11px] text-neutral-500">
            <Wand2 size={11} aria-hidden />
            Plan: {activePlan.steps.filter((step) => step.status === "completed").length}/
            {activePlan.steps.length} steps
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default ChatComposer;
