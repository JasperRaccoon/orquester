// Ported from T3 Code (MIT): apps/web/src/components/chat/ChatComposer.tsx,
// apps/web/src/components/ChatView.tsx (the composer overlay and its inset)
import React from "react";
import { flushSync } from "react-dom";
import { Paperclip, Wand2 } from "lucide-react";
import type {
  AttachmentRef,
  ComposerContextRecord,
  InteractionMode,
  ModelSelection,
  SelectProviderOptionDescriptor
} from "@orquester/api/agent-chat";
import { MAX_TURN_ATTACHMENTS } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { useMediaQuery } from "../../../hooks/use-media-query";
import { useAppStore } from "../../../store/app";
import { attachmentPathOf } from "../../../lib/agent-chat/composer.logic";
import { useAgentChatDraft } from "../../../lib/agent-chat/hooks";
import { createEscapeSequence, type EscapeSequence } from "../../../lib/agent-chat/rewind.logic";
import type { ChatComposerProps } from "../contracts";
import { AccountChip, ModelChip, OptionChip, PlanChip, RuntimeModeChip } from "./ComposerChips";
import { removeFilePath, textNamesPath } from "./composer-files";
import {
  imageOrdinal,
  imagePlaceholder,
  removeImagePlaceholder,
  revokeImagePreviews,
  withoutPreviews
} from "./composer-images";
import {
  REWIND_ESCAPE_HINT,
  REWIND_ESCAPE_HINT_MS,
  RewindControl,
  rewindPickerEnabled
} from "./RewindControl";
import { ComposerAttachments, type StagedAttachment } from "./ComposerAttachments";
import {
  composerDraftToPersist,
  createDraftPersistScheduler,
  EMPTY_PERSISTED_DRAFT,
  loadComposerDraft,
  persistedDraftsEqual,
  type DraftPersistScheduler
} from "./composer-draft";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerTokenMenu } from "./ComposerTokenMenu";
import { registerComposerHandle } from "./composer-bridge";
import { restoreFailedSendDraft } from "./composer-failed-send";
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
  draftAfterSend,
  hasSendableContent,
  implementationTextResolver,
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  pastedTextDisposition,
  proposedPlanTitle,
  resolveFollowUpDisposition,
  resolvePlanFollowUpSubmission,
  sendComposerTurn,
  submitIsNoOp,
  swallowsStandalonePlanCommand,
  uploadsBlockSend,
  type FailedSendRestore
} from "./composer-submission";
import {
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  isTriggerAtPromptStart,
  replaceTextRange,
  type ComposerTrigger
} from "./composer-trigger";
import { useComposerPathSearch } from "./use-composer-path-search";

/**
 * The **live** draft: what is on screen, including uploads still in flight.
 *
 * The copy that survives this component is the thread store's persisted one
 * (`ComposerDraft`); this one is loaded from it and written back to it — see
 * "The draft is the store's" below.
 */
interface DraftState {
  text: string;
  attachments: StagedAttachment[];
}

const EMPTY_DRAFT: DraftState = { text: "", attachments: [] };

/** What goes on the wire for the staged chips: their uploaded references. */
function attachmentRefs(attachments: readonly StagedAttachment[]): AttachmentRef[] {
  return attachments
    .map((entry) => entry.ref)
    .filter((ref): ref is AttachmentRef => ref !== undefined);
}

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
  accountOptions,
  accountId,
  accountSwitchEnabled,
  isTurnActive,
  hasPendingRequest,
  queue,
  activePlan,
  actionableProposedPlan,
  reverting,
  rewindTargets,
  onRewind,
  actions,
  onHeightChange,
  onDraftAttachmentCountChange,
  threadHasContent = true,
  searchRoot,
  active
}: ChatComposerProps & ChatComposerExtraProps): React.ReactElement {
  const isMobile = !useMediaQuery("(min-width: 640px)");
  const sessionCwd = useAppStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.cwd ?? null
  );
  const root = searchRoot ?? sessionCwd;
  /**
   * The thread store's persisted draft — the durable copy of everything the
   * user has not sent yet, and the only one that outlives this component.
   * Read on mount and on a thread swap, written back on every change.
   */
  const { draft: storeDraft, actions: storeDraftActions } = useAgentChatDraft(sessionId);
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
  const draftRef = React.useRef<DraftState>(EMPTY_DRAFT);
  const caretRef = React.useRef(0);
  /** A caret `applyCaret` still owes the textarea; whichever lands last, its microtask or the commit, clears it. */
  const pendingCaretRef = React.useRef<{ at: number; focus: boolean } | null>(null);
  const storeDraftRef = React.useRef(storeDraft);
  storeDraftRef.current = storeDraft;
  /**
   * The context records a persisted draft carried in (§4.1). The composer has
   * no context UI, so they ride along untouched — loaded with the draft,
   * persisted with it, cleared with it — rather than being dropped on the
   * floor the moment a draft is picked up.
   */
  const carriedContextRef = React.useRef<ComposerContextRecord[]>([]);
  const persistRef = React.useRef<DraftPersistScheduler | null>(null);
  /**
   * The thread whose draft the live draft holds, or `null` once this composer
   * is unmounted — what a send reads when it settles, to put a failure back
   * into the thread it was sent from (`runSend`). Written only by the draft
   * scheduler's layout effect, the same step that flushes that thread's writes.
   */
  const liveThreadRef = React.useRef<string | null>(null);
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

  /**
   * The CLI's double Escape — "press Esc twice to jump to a previous message"
   * (§5.5) — counted on THIS composer's own sequence for the Escapes its
   * textarea receives. The shell counts the ones landing outside the composer
   * on a sequence of its own (`resolveChatEscape`), so one Escape can never
   * advance both.
   */
  const escapeSequenceRef = React.useRef<EscapeSequence | null>(null);
  if (escapeSequenceRef.current === null) escapeSequenceRef.current = createEscapeSequence();
  const escapeSequence = escapeSequenceRef.current;
  /** Clears the "Press Esc again…" hint; its own, so it never wipes another notice. */
  const rewindHintTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  draftRef.current = draft;
  caretRef.current = cursor;

  // ---------------------------------------------------------------------
  // The draft is the store's (§7.1, §7.4)
  // ---------------------------------------------------------------------
  // Each chat tab owns its composer: `MainView` mounts an `AgentChatView` per
  // tab, keyed by the tab id — the session id — and a tab switch only hides
  // it, so `sessionId` never changes under a mounted composer, and every
  // branch that handles a thread swap (the load below, a failed send's
  // restore) is defensive. But focusing a session of another project swaps
  // the whole tab set and unmounts it, and a reload destroys it outright. A
  // draft held in component state (as a hand-swapped per-tab map once was) is
  // lost to both.
  //
  // So the thread store's persisted draft is the owner: this loads it on mount
  // (and on a thread swap, should one come), and the two effects below write
  // it back. The load deliberately does NOT go through `stageAttachment` —
  // that one also writes an `[Image #N]` placeholder at the caret, and the
  // text being restored already contains the placeholders the user saw. The
  // same holds for a file's path: the restored text already carries it.
  const previousSessionRef = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    if (previousSessionRef.current === sessionId) return;
    previousSessionRef.current = sessionId;
    // The previous thread's previews die with its live draft; the persisted one never held them.
    revokeImagePreviews(draftRef.current.attachments);
    const loaded = loadComposerDraft(storeDraftRef.current);
    carriedContextRef.current = loaded.context;
    const next: DraftState = { text: loaded.text, attachments: loaded.attachments };
    draftRef.current = next;
    setDraft(next);
    setCursor(next.text.length);
    setNotice(null);
    setSending(false);
    setMenuDismissed(false);
    // A half-finished double Escape belongs to the thread it was pressed in.
    escapeSequenceRef.current?.reset();
  }, [sessionId]);
  React.useEffect(() => () => revokeImagePreviews(draftRef.current.attachments), []);

  /**
   * One scheduler per thread, and its cleanup is the flush.
   *
   * The cleanup closes over the OUTGOING thread's actions, which is what makes
   * a swap safe: React runs every cleanup for a commit before any new effect,
   * so the tail of thread A is written to thread A even though `sessionId`
   * already names B. `pagehide`/`visibilitychange` cover what React never sees
   * at all — a reload or a backgrounded tab runs no cleanup.
   *
   * A LAYOUT effect, and the one writer of `liveThreadRef`: the cleanup that
   * stops this composer holding a thread's draft — a swap, an unmount — is the
   * one that flushes that thread's pending write, in the same commit as the
   * swap's draft load. So a send that settles afterwards (`runSend`) finds its
   * thread either still here or with its persisted draft complete: it never
   * reads that draft while its last keystrokes are in neither place.
   */
  React.useLayoutEffect(() => {
    const scheduler = createDraftPersistScheduler((draft) => storeDraftActions.saveDraft(draft));
    persistRef.current = scheduler;
    liveThreadRef.current = sessionId;
    const flush = (): void => scheduler.flush();
    const flushIfHidden = (): void => {
      if (document.visibilityState === "hidden") scheduler.flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushIfHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushIfHidden);
      scheduler.flush();
      if (persistRef.current === scheduler) persistRef.current = null;
      liveThreadRef.current = null;
    };
  }, [sessionId, storeDraftActions]);

  /**
   * Every change to the live draft schedules a write.
   *
   * Keyed on the local draft alone — never on the store's — so a write can
   * never feed back into a load: this component reads the persisted draft at
   * mount and at a thread swap, and at no other time. The equality check keeps
   * the mount itself (which loads, then renders, then lands here with exactly
   * what it read) from writing anything back.
   */
  React.useEffect(() => {
    const scheduler = persistRef.current;
    if (!scheduler) return;
    const next = composerDraftToPersist({
      text: draft.text,
      attachments: draft.attachments,
      context: carriedContextRef.current
    });
    if (persistedDraftsEqual(next, storeDraftRef.current)) {
      scheduler.cancel();
      return;
    }
    scheduler.schedule(next);
  }, [draft]);

  /** Clear or overwrite the persisted draft now, ahead of the debounce. */
  const persistNow = React.useCallback((text: string, attachments: StagedAttachment[]) => {
    persistRef.current?.write(
      composerDraftToPersist({ text, attachments, context: carriedContextRef.current })
    );
  }, []);

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

  // ---------------------------------------------------------------------
  // The last plan-ready condition (§7.3): an empty attachment tray
  // ---------------------------------------------------------------------
  // The shell owns every other term of `shouldShowPlanFollowUpPrompt` and
  // hands over `null` when one fails. This one it cannot evaluate — the draft
  // is state in here — so the count goes back out (the shell gates the docked
  // banner with it) and is applied here as well, which is what keeps the
  // primary action from reading "Implement" for the frame between the file
  // landing in the tray and the shell's re-render.
  //
  // Why it matters beyond the label: `submit` resolves the plan follow-up
  // BEFORE the emptiness guard, so an ungated Implement on a draft that is
  // empty *except for files* would send the plan prompt and leave plan mode
  // with the attachments riding along — a message the user never composed.
  const hasAttachments = draft.attachments.length > 0;
  const planFollowUp = hasAttachments ? null : actionableProposedPlan;

  React.useEffect(() => {
    onDraftAttachmentCountChange?.(draft.attachments.length);
  }, [draft.attachments.length, onDraftAttachmentCountChange]);

  const collapsed = isComposerCollapsedMobile({
    isMobileViewport: isMobile,
    isFocused: focused,
    hasMultilineDraft: draft.text.includes("\n"),
    hasAttachments,
    hasDockedBanner: hasPendingRequest || planFollowUp !== null
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

  /**
   * Whether the composer already owns focus. An insert that is not the
   * composer's own input — any bridge insert, user event or not, and a finished
   * upload's path — places the caret but never takes focus by itself (§7.4).
   */
  const isTextareaFocused = React.useCallback(
    () => typeof document !== "undefined" && document.activeElement === textareaRef.current,
    []
  );

  // `focus: false` places the caret without taking focus. An insert that is not
  // the composer's own input never takes focus by itself — every bridge insert,
  // whether or not a user event triggered it (a queued row's X, a question
  // card's option click, an interrupt's drain, a delivered ref), and a finished
  // upload's path: focusing there pops the soft keyboard on a phone or pulls
  // focus out of the card, chip popover or modal the user is in. A surface that
  // wants the composer focused asks explicitly (`focusAtEnd`, the bridge's
  // `focusComposer`), as the queued row's return does.
  const applyCaret = React.useCallback((at: number, options?: { focus?: boolean }) => {
    const focus = options?.focus ?? true;
    pendingCaretRef.current = { at, focus };
    // After paint: the textarea's own value has to land before the caret does.
    queueMicrotask(() => {
      const element = textareaRef.current;
      if (!element) return;
      if (focus) element.focus({ preventScroll: true });
      element.setSelectionRange(at, at);
      // The value is already the draft's — the commit landed first, or the
      // text never moved — so the layout effect below owes nothing, and a
      // stale target must not fire on the next keystroke's commit. A caller
      // from a promise continuation must have written `draftRef.current.text`
      // before calling `applyCaret`, as `insertText` does, or this clears the
      // target too early.
      if (element.value === draftRef.current.text) pendingCaretRef.current = null;
    });
    setCursor(at);
  }, []);

  // The commit half of `applyCaret`, covering both orders. A commit that
  // PRECEDES the microtask — a discrete event's insert (a paste, a menu pick)
  // or `uploadOne`'s `flushSync` one — has the caret land here, and the
  // microtask then only confirms it. A default-lane commit that FOLLOWS the
  // microtask (a returned queued message, `appendToDraft` after an interrupt)
  // finds that the microtask placed the caret on the OLD value and the
  // commit's `node.value = …` threw it to the end, so it is placed again here.
  // Whichever lands last leaves the caret after the insert.
  React.useLayoutEffect(() => {
    const pending = pendingCaretRef.current;
    if (pending === null) return;
    pendingCaretRef.current = null;
    const element = textareaRef.current;
    if (!element) return;
    if (pending.focus) element.focus({ preventScroll: true });
    element.setSelectionRange(pending.at, pending.at);
  }, [draft.text]);

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
   * The caret comes from `caretRef` — synced from state on render, advanced
   * optimistically here — never from the closure: a call that lands late (a
   * file's path arrives when its upload completes) inserts at the caret the
   * user has NOW, and two inserts in one tick land in order rather than both
   * at the pre-batch caret.
   *
   * `options.focus` is `applyCaret`'s: an insert that is not the composer's
   * own input passes `isTextareaFocused()`, so it places the caret without
   * taking focus unless the textarea already had it.
   */
  const insertText = React.useCallback(
    (text: string, mode: "cursor" | "append" = "cursor", options?: { focus?: boolean }) => {
      if (!text) return;
      const current = draftRef.current;
      const at =
        mode === "append" ? current.text.length : Math.min(caretRef.current, current.text.length);
      const gap =
        at > 0 && !/\s$/.test(current.text.slice(0, at)) && !/^\s/.test(text) ? " " : "";
      const applied = replaceTextRange(current.text, at, at, `${gap}${text}`);
      draftRef.current = { ...current, text: applied.text };
      caretRef.current = applied.cursor;
      setDraft((state) =>
        state.text === applied.text ? state : { ...state, text: applied.text }
      );
      applyCaret(applied.cursor, options);
    },
    [applyCaret]
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
    // An image gets its `[Image #N]` at the caret, as the CLI does on paste,
    // so the text can name it. A file gets its absolute path — unless the text
    // already names it, as a returned queued message's text does (§7.4).
    const ordinal = imageOrdinal(draftRef.current.attachments, entry.key);
    const path = attachmentPathOf(ref);
    if (ordinal !== null) {
      insertText(imagePlaceholder(ordinal), "cursor", { focus: isTextareaFocused() });
    } else if (path !== undefined && !textNamesPath(draftRef.current.text, path)) {
      insertText(path, "cursor", { focus: isTextareaFocused() });
    }
    return true;
  }, [insertText, isTextareaFocused]);

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

  /**
   * Put a send that did not go out back into the LIVE draft (§7.4): its text
   * and chips ahead of anything typed or staged since (`draftAfterSend`), its
   * notice with them — when this composer shows `thread`, the one the send
   * left from. Its own send, or one a composer that no longer shows the thread
   * hands over through the bridge. `false` when it does not show `thread`, so
   * the caller goes on to that thread's persisted draft.
   *
   * `flushSync`: the check and the write are one step, and the restore is
   * committed and its write scheduled before any later swap or unmount
   * renders. A promise continuation's update is not sync-lane: an unmount (a
   * project switch) rendered first would drop it with the component, and a
   * swap (defensive, above) would load the next thread's draft over it — the
   * restore would be on no screen and in no thread's store.
   */
  const restoreIntoLiveDraft = React.useCallback(
    (thread: string, restore: FailedSendRestore<StagedAttachment>): boolean => {
      if (liveThreadRef.current !== thread) return false;
      flushSync(() => {
        setDraft((state) => {
          const next = draftAfterSend({ outcome: restore.outcome, sent: restore.sent, draft: state });
          return next === null ? state : { ...state, ...next };
        });
        setNotice(restore.outcome.notice);
      });
      return true;
    },
    []
  );

  // A LAYOUT effect, as the draft load and the draft scheduler are: the handle
  // names this composer's thread from the commit that loads that thread's
  // draft to the one that lets it go, so a failed send that settles in between
  // finds the composer that shows its thread (§7.4) — never a stale handle,
  // and never nothing while a composer that has just mounted already shows it.
  React.useLayoutEffect(
    () =>
      registerComposerHandle(sessionId, {
        // A bridge insert never takes focus by itself, whether or not a user
        // event triggered it (a queued row's X, a card's option click, an
        // interrupt's drain, a delivered ref): place the caret, keep focus
        // where it is. A surface that wants the composer focused asks for it
        // explicitly (`focusAtEnd` / `focusComposer`).
        insertText: (text, mode) => insertText(text, mode, { focus: isTextareaFocused() }),
        stageAttachment,
        focusAtEnd,
        openControl,
        restoreFailedSend: (restore) => restoreIntoLiveDraft(sessionId, restore)
      }),
    [
      focusAtEnd,
      insertText,
      isTextareaFocused,
      openControl,
      restoreIntoLiveDraft,
      sessionId,
      stageAttachment
    ]
  );

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
        // The chip may be gone — removed while the bytes were still going up.
        // A late success must neither resurrect it nor write its path.
        if (!draftRef.current.attachments.some((entry) => entry.key === key)) return;
        const ready = (entries: StagedAttachment[]): StagedAttachment[] =>
          entries.map((entry) =>
            entry.key === key ? { ...entry, status: "ready" as const, progress: 1, ref } : entry
          );
        draftRef.current = { ...draftRef.current, attachments: ready(draftRef.current.attachments) };
        // A file's path is known only now, so this is where it reaches the
        // prompt — at the live caret, as the terminal-era upload typed it into
        // the PTY (`composer-files.ts`). Images already have `[Image #N]`.
        const path = attachmentPathOf(ref);
        const insertPath =
          !file.type.startsWith("image/") &&
          path !== undefined &&
          !textNamesPath(draftRef.current.text, path)
            ? path
            : undefined;
        // The caret is placed; focus is kept only where it already was.
        const focus = isTextareaFocused();
        // `flushSync`: a promise continuation's update is not sync-lane, so a
        // keystroke arriving before it committed would rebase over the insert
        // and drop the path. The status and the path land in ONE commit, so a
        // Remove can never see one without the other.
        flushSync(() => {
          setDraft((state) => ({ ...state, attachments: ready(state.attachments) }));
          if (insertPath !== undefined) insertText(insertPath, "cursor", { focus });
        });
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
    [actions, insertText, isTextareaFocused]
  );

  /** A reloaded or delivered image chip has no local `File`; its preview comes from §6.3's read-back. */
  const resolvePreview = React.useCallback(
    async (attachment: StagedAttachment): Promise<string | null> => {
      if (!attachment.ref) return null;
      try {
        const bytes = await actions.fetchAttachmentBytes(attachment.ref.id);
        return URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
      } catch {
        return null;
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
            progress: 0,
            // The thumbnail and hover preview, from the bytes already in hand.
            ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {})
          }
        });
      }

      setNotice(rejection);
      if (accepted.length === 0) return;
      const attachments = [...draftRef.current.attachments, ...accepted.map(({ entry }) => entry)];
      draftRef.current = { ...draftRef.current, attachments };
      setDraft((state) => ({
        ...state,
        attachments: [...state.attachments, ...accepted.map(({ entry }) => entry)]
      }));
      // Every accepted image gets its `[Image #N]` at the caret, in order.
      for (const { entry } of accepted) {
        const ordinal = imageOrdinal(attachments, entry.key);
        if (ordinal !== null) insertText(imagePlaceholder(ordinal), "cursor");
      }
      for (const { entry, file } of accepted) {
        retryFilesRef.current.set(entry.key, file);
        void uploadOne(entry.key, file);
      }
    },
    [insertText, uploadOne]
  );

  const removeAttachment = React.useCallback((key: string) => {
    retryFilesRef.current.delete(key);
    const current = draftRef.current;
    const entry = current.attachments.find((candidate) => candidate.key === key);
    if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    // Its `[Image #N]` — or, for a file, its path — leaves with it; the later
    // images close the gap.
    const ordinal = imageOrdinal(current.attachments, key);
    const path = attachmentPathOf(entry?.ref);
    const strip = (text: string): string =>
      ordinal !== null
        ? removeImagePlaceholder(text, ordinal)
        : path !== undefined
          ? removeFilePath(text, path)
          : text;
    draftRef.current = {
      ...current,
      text: strip(current.text),
      attachments: current.attachments.filter((candidate) => candidate.key !== key)
    };
    setDraft((state) => ({
      ...state,
      text: strip(state.text),
      attachments: state.attachments.filter((candidate) => candidate.key !== key)
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
    async (
      text: string,
      mode: InteractionMode,
      attachments: readonly StagedAttachment[],
      resolveText?: () => Promise<string>
    ) => {
      // The thread this message leaves FROM. A failure goes back into its
      // draft, whichever thread — if any — this composer shows by the time
      // the send settles.
      const sentFrom = sessionId;
      setSending(true);
      try {
        const refs = attachmentRefs(attachments);
        const outcome = await sendComposerTurn({
          text,
          ...(resolveText ? { resolveText } : {}),
          send: (resolved) =>
            actions.sendTurn({
              text: resolved,
              ...(refs.length > 0 ? { attachments: refs } : {}),
              interactionMode: mode,
              ...(modelSelection ? { modelSelection } : {})
            })
        });
        if (outcome.kind === "sent") {
          // The keyboard is worse than a lost second on mobile: dismiss it only
          // once the send actually succeeded.
          if (isMobile) textareaRef.current?.blur();
          return;
        }
        // A failed send comes back whole, its chips with its text, to the
        // FRONT of the draft: ahead of anything typed or staged since, so
        // nothing the user wrote while it was in flight is reordered behind it
        // (`draftAfterSend`). A refusal sent nothing and leaves the draft
        // alone: a plan that could not be read back, or read back over the
        // bound, is still actionable, so Implement is still there to press
        // again. A failed Implement (`text: null`) leaves the draft alone for
        // the same reason: its prompt is the composer's, and in the draft it
        // would read as a plan-mode Refine carrying the implementation prefix.
        // `submit` revoked the sent chips' preview URLs; a restored image chip
        // resolves its preview again, as a reloaded one does.
        //
        // And it comes back to the thread it was sent FROM, never to the one
        // on screen when it settles: this live draft while this composer
        // still shows that thread, else the live draft of the composer that
        // shows it now, else that thread's persisted draft, where the next
        // composer to show it loads it (`restoreFailedSendDraft`). Its notice
        // goes only where its draft does.
        restoreFailedSendDraft({
          sentFrom,
          liveThread: liveThreadRef.current,
          restore: { outcome, sent: withoutPreviews(attachments) },
          restoreLive: (restore) => restoreIntoLiveDraft(sentFrom, restore)
        });
      } finally {
        setSending(false);
      }
    },
    [actions, isMobile, modelSelection, restoreIntoLiveDraft, sessionId]
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
        // Immediately, not on the debounce: a command that never became a
        // message must not come back on the next mount. (`swallowsStandalone…`
        // already guarantees the tray is empty.)
        persistNow("", []);
        applyCaret(0);
        return;
      }

      // R7-3: the plan is resolved BEFORE the emptiness guard, because an
      // empty draft is exactly the input "Implement" is defined on — the plan
      // supplies the text. Guarding first made the enabled Implement button a
      // silent no-op.
      const plan = planFollowUp
        ? resolvePlanFollowUpSubmission({
            draftText: text,
            planMarkdown: planFollowUp.planMarkdown
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
      // Implement resolves its prompt at send time through the store's read:
      // as is when intact, read back whole when §5.6 cut it at 16 KiB. It sends
      // nothing when the plan cannot be read, or when the whole prompt is over
      // the bound the cut one passed below. A failed Implement never writes its
      // prompt into the draft (`sendComposerTurn`).
      const implementationText = implementationTextResolver({
        action: plan?.action ?? null,
        proposal: planFollowUp,
        read: (proposal) => actions.readFullPlanMarkdown(proposal)
      });

      const validation = composerSubmissionValidationMessage({
        prompt: outgoing,
        submissionTarget: "provider-turn"
      });
      if (validation) {
        setNotice(validation);
        return;
      }

      const sentAttachments = draft.attachments;
      const disposition = resolveFollowUpDisposition({
        followUpBehavior: chatPrefs.followUpBehavior,
        intent,
        // A plan follow-up is the answer to a settled turn: never queued.
        isRunning: isTurnActive && plan === null
      });

      revokeImagePreviews(draft.attachments);
      setDraft(EMPTY_DRAFT);
      // The persisted draft is cleared NOW rather than on the debounce: a
      // reload between the send and the next window would otherwise resurrect
      // a message that is already on its way (§7.4).
      carriedContextRef.current = [];
      persistRef.current?.write(EMPTY_PERSISTED_DRAFT);
      applyCaret(0);
      setNotice(null);
      // The retry map holds the original `File` objects; a sent draft can no
      // longer be retried, so let them go rather than pinning every file the
      // session ever attached in memory.
      retryFilesRef.current.clear();

      if (disposition === "queue") {
        actions.queueMessage({
          text: outgoing,
          attachments: attachmentRefs(sentAttachments),
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
      void runSend(outgoing, outgoingMode, sentAttachments, implementationText);
    },
    [
      planFollowUp,
      actions,
      applyCaret,
      draft.attachments,
      draft.text,
      interactionMode,
      isTurnActive,
      chatPrefs.followUpBehavior,
      persistNow,
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
  // Esc Esc — the rewind picker (§5.5, the CLI's "jump to a previous message")
  // ---------------------------------------------------------------------
  /** The picker can act — the same gate its button renders with. */
  const rewindEnabled = rewindPickerEnabled({
    targetCount: rewindTargets.length,
    isTurnActive,
    reverting,
    hasPendingRequest
  });

  /** Drop the "Press Esc again…" hint — only that hint, never another notice. */
  const clearRewindHint = React.useCallback(() => {
    if (rewindHintTimerRef.current !== null) {
      clearTimeout(rewindHintTimerRef.current);
      rewindHintTimerRef.current = null;
    }
    setNotice((current) => (current === REWIND_ESCAPE_HINT ? null : current));
  }, []);

  // The hint's timer never outlives the composer.
  React.useEffect(
    () => () => {
      if (rewindHintTimerRef.current !== null) clearTimeout(rewindHintTimerRef.current);
    },
    []
  );

  /**
   * One idle Escape in the textarea. The first of two says what a second one
   * will do — and only when it will do it, so the hint never promises a picker
   * that is disabled — and the second opens the picker through the same
   * `openControl` the keybinding handler drives every control with.
   */
  const pressRewindEscape = (): void => {
    if (escapeSequence.press(Date.now())) {
      clearRewindHint();
      if (rewindEnabled) openControl("rewind");
      return;
    }
    if (!rewindEnabled) return;
    if (rewindHintTimerRef.current !== null) clearTimeout(rewindHintTimerRef.current);
    setNotice(REWIND_ESCAPE_HINT);
    rewindHintTimerRef.current = setTimeout(clearRewindHint, REWIND_ESCAPE_HINT_MS);
  };

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
       * Escape is SHARED with the shell, by scope — never by order.
       *
       * Two capture-phase `window` listeners exist for this key and exactly
       * one may act. They cannot be ordered: this effect's deps include
       * `queue`, so it re-registers on every queue mutation and changes place
       * with the shell's, and `stopPropagation()` does not silence a sibling
       * on the same node. Whichever ran first won — two interrupts when both
       * fired, and a stopped turn instead of a closed drill-in when this one
       * went first.
       *
       * So the scopes are disjoint and target-based: the shell
       * (`resolveChatEscape`) owns every Escape whose target is OUTSIDE this
       * composer shell — that is the one that leaves a drill-in — and this arm
       * owns the inside, minus the textarea, whose own handler gives an open
       * token menu first refusal. `scroll-to-end` stays the timeline's.
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
    // Esc Esc is two CONSECUTIVE Escapes: any other key in between starts the
    // count over (and so does an Escape something else consumes, below).
    if (event.key !== "Escape") escapeSequence.reset();
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
        // just opened must not also stop the agent — nor count as the first
        // half of a rewind.
        event.preventDefault();
        event.stopPropagation();
        setMenuDismissed(true);
        escapeSequence.reset();
        return;
      }
    }

    if (event.key === "Escape" && isTurnActive) {
      event.preventDefault();
      // This Escape stopped the turn; it is nobody's first press.
      escapeSequence.reset();
      interrupt();
      return;
    }
    if (event.key === "Escape") {
      // Idle, no menu: the CLI's double Escape opens the rewind picker. A
      // held key's auto-repeat is one press, not two.
      event.preventDefault();
      if (!event.repeat) pressRewindEscape();
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

  const planTitle = planFollowUp ? proposedPlanTitle(planFollowUp.planMarkdown) : null;
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
            resolvePreview={resolvePreview}
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
              {/* The rewind picker — the double Escape's destination (§5.5).
                  Renders nothing while there is no message to go back to. */}
              <RewindControl
                targets={rewindTargets}
                isTurnActive={isTurnActive}
                reverting={reverting}
                hasPendingRequest={hasPendingRequest}
                onRewind={onRewind}
                returnFocusTo={() => textareaRef.current}
              />

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
              {accountLabel ? (
                <AccountChip
                  label={accountLabel}
                  {...(accountOptions ? { options: accountOptions } : {})}
                  {...(accountId !== undefined ? { selectedId: accountId } : {})}
                  canSwitch={accountSwitchEnabled === true && !reverting}
                  {...(accountOptions
                    ? {
                        onChange: (next: string) => {
                          void actions.setAccount({ accountId: next }).catch((error: unknown) => {
                            setNotice(
                              error instanceof Error
                                ? error.message
                                : "Could not switch the account."
                            );
                          });
                        }
                      }
                    : {})}
                  returnFocusTo={() => textareaRef.current}
                />
              ) : null}
            </div>

            <ComposerPrimaryActions
              isRunning={isTurnActive}
              showPlanFollowUp={planFollowUp !== null}
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
