// Ported from T3 Code (MIT): apps/web/src/composerDraftStore.ts — T3 persists
// the composer draft per thread on *every* change (a zustand `persist` store,
// key `t3code:composer-drafts:v1`).
/**
 * The pure half of "what the user has not sent yet survives" (§7.4).
 *
 * The composer holds a live draft — text plus attachment chips, some of them
 * still uploading — and the thread store holds the persisted one
 * ({@link ComposerDraft}, in `localStorage`). This module owns the two
 * translations between them and the policy for *when* the write happens:
 *
 *  - {@link composerDraftToPersist} — a live draft narrowed to what can
 *    outlive the component: text, the refs of the attachments whose bytes are
 *    already on the daemon, and the carried context records.
 *  - {@link loadComposerDraft} — a persisted draft turned back into chips.
 *  - {@link persistedDraftAfterSend} — a failed send put back into a persisted
 *    draft, when no composer shows the thread it was sent from any more.
 *  - {@link createDraftPersistScheduler} — one write per window while typing,
 *    a synchronous flush for an unmount, a tab switch or a reload.
 *
 * Pure and component-free on purpose: the component is untestable here (the
 * package's test glob only walks `*.test.ts`), so everything that can be
 * decided without React is decided in this file.
 */

import type { AttachmentRef, ComposerContextRecord } from "@orquester/api/agent-chat";

import { EMPTY_DRAFT, type ComposerDraft } from "../../../lib/agent-chat/composer.logic";
import {
  decideStagedAttachmentForRef,
  draftAfterSend,
  type ComposerSendOutcome
} from "./composer-submission";
import type { StagedAttachment } from "./ComposerAttachments";

/** The persisted spelling of "nothing to send", re-exported for the composer. */
export const EMPTY_PERSISTED_DRAFT: ComposerDraft = EMPTY_DRAFT;

/** The minimum a live chip has to look like to be narrowed for persistence. */
export interface PersistableAttachment {
  status: "uploading" | "ready" | "failed";
  ref?: AttachmentRef;
}

/**
 * The attachments a persisted draft may carry: the uploaded ones, by
 * reference.
 *
 * **An upload in flight cannot be persisted** — what identifies it is a `File`
 * the browser holds in memory, which no `localStorage` entry survives — so an
 * unmount drops it. The chip is not "lost data" the way text is: its bytes
 * either finished (and it is here, as a ref) or never reached the daemon at
 * all. A failed one is dropped for the same reason: its retry needs the very
 * `File` that is going away.
 */
export function persistableAttachmentRefs(
  attachments: readonly PersistableAttachment[]
): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const attachment of attachments) {
    if (attachment.status !== "ready" || !attachment.ref) continue;
    refs.push(attachment.ref);
  }
  return refs;
}

/** The live draft, narrowed to what is worth persisting. */
export function composerDraftToPersist(input: {
  text: string;
  attachments: readonly PersistableAttachment[];
  context: readonly ComposerContextRecord[];
}): ComposerDraft {
  return {
    text: input.text,
    attachments: persistableAttachmentRefs(input.attachments),
    context: [...input.context]
  };
}

function sameAttachment(a: AttachmentRef, b: AttachmentRef): boolean {
  return a.id === b.id && a.type === b.type && a.name === b.name;
}

function sameContext(a: ComposerContextRecord, b: ComposerContextRecord): boolean {
  return a.kind === b.kind && a.label === b.label && a.ref === b.ref;
}

/**
 * Value equality for two persisted drafts.
 *
 * The composer re-derives its persistable draft on every render that changed
 * the local one; comparing it with what the store already holds is what keeps
 * a mount — which loads and would otherwise immediately write back what it
 * just read — from touching storage at all.
 */
export function persistedDraftsEqual(a: ComposerDraft, b: ComposerDraft): boolean {
  return (
    a.text === b.text &&
    a.attachments.length === b.attachments.length &&
    a.context.length === b.context.length &&
    a.attachments.every((ref, index) => sameAttachment(ref, b.attachments[index]!)) &&
    a.context.every((record, index) => sameContext(record, b.context[index]!))
  );
}

/** What a persisted draft becomes when a composer picks it up. */
export interface LoadedComposerDraft {
  text: string;
  attachments: StagedAttachment[];
  context: ComposerContextRecord[];
}

/**
 * Turn a persisted draft back into a live one.
 *
 * It reuses {@link decideStagedAttachmentForRef}, so a reloaded chip obeys
 * exactly the bounds a live drop does (eight per message, one chip per ref) —
 * but it deliberately does **not** go through the composer's `stageAttachment`:
 * that one also writes an `[Image #N]` placeholder at the caret, and the text
 * being restored alongside already contains the placeholders the user saw.
 * Staging through it would duplicate every one of them. The same holds for a
 * file's path: the restored text already carries it.
 *
 * An entry the bounds refuse is dropped rather than reported: there is no
 * composer notice to render into yet at load time, and the file itself is
 * still on the daemon.
 */
export function loadComposerDraft(persisted: ComposerDraft): LoadedComposerDraft {
  const attachments: StagedAttachment[] = [];
  for (const ref of persisted.attachments) {
    const decision = decideStagedAttachmentForRef({ existing: attachments, ref });
    if (decision.kind !== "staged") continue;
    attachments.push({
      key: decision.key,
      name: decision.name,
      sizeBytes: decision.sizeBytes,
      mimeType: decision.mimeType,
      status: "ready",
      progress: 1,
      ref
    });
  }
  return { text: persisted.text, attachments, context: [...persisted.context] };
}

/**
 * A send that did not go out, put back into a thread's PERSISTED draft
 * (§7.4) — for when no composer shows the thread it was sent from any more,
 * so there is no live draft to put it back into.
 *
 * The restore a live draft gets, on the persisted one: loaded exactly as a
 * composer mount loads it ({@link loadComposerDraft}), then `draftAfterSend`
 * puts the send's text and chips back ahead of what it already held — what
 * was typed there since stays, behind them — and the result is narrowed back
 * for storage ({@link composerDraftToPersist}) with the draft's context
 * records as they were. `null` when the send gives nothing back: a refusal,
 * or a failed Implement.
 */
export function persistedDraftAfterSend(input: {
  outcome: ComposerSendOutcome;
  /** The chips the send carried, in tray order. */
  sent: readonly StagedAttachment[];
  /** The thread's persisted draft as it is now. */
  persisted: ComposerDraft;
}): ComposerDraft | null {
  const loaded = loadComposerDraft(input.persisted);
  const next = draftAfterSend({ outcome: input.outcome, sent: input.sent, draft: loaded });
  if (next === null) return null;
  return composerDraftToPersist({
    text: next.text,
    attachments: next.attachments,
    context: loaded.context
  });
}

// ---------------------------------------------------------------------------
// When the write happens
// ---------------------------------------------------------------------------

/** How long a keystroke may stay unpersisted. */
export const DRAFT_PERSIST_DELAY_MS = 300;

export interface DraftPersistScheduler {
  /** Persist this draft at the end of the current window. */
  schedule(draft: ComposerDraft): void;
  /** Persist the pending draft now, synchronously. */
  flush(): void;
  /** Persist this draft now and forget anything the window still held. */
  write(draft: ComposerDraft): void;
  /** Forget the pending draft without writing it. */
  cancel(): void;
}

export interface DraftPersistSchedulerOptions {
  delayMs?: number;
  /** Test seams; the defaults are the window's timers. */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * A **trailing throttle**, not a resetting debounce.
 *
 * The distinction is the whole point: a debounce that restarts on every
 * keystroke never fires while someone is typing, so a reload mid-sentence —
 * which runs no React cleanup — would lose everything since the last pause.
 * This one opens a window on the first change and writes the newest draft when
 * it closes, so continuous typing still reaches storage every
 * {@link DRAFT_PERSIST_DELAY_MS} and a reload can lose at most that much.
 *
 * `flush()` is the unmount/tab-switch/`pagehide` path and `write()` the
 * "cleared, and it must not come back" one — a send that raced a pending
 * window would otherwise resurrect the message the user just sent.
 */
export function createDraftPersistScheduler(
  commit: (draft: ComposerDraft) => void,
  options: DraftPersistSchedulerOptions = {}
): DraftPersistScheduler {
  const delayMs = options.delayMs ?? DRAFT_PERSIST_DELAY_MS;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let pending: ComposerDraft | null = null;
  let timer: unknown = null;

  const stopTimer = (): void => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const take = (): ComposerDraft | null => {
    const draft = pending;
    pending = null;
    return draft;
  };

  return {
    schedule(draft) {
      pending = draft;
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        const next = take();
        if (next) commit(next);
      }, delayMs);
    },
    flush() {
      stopTimer();
      const next = take();
      if (next) commit(next);
    },
    write(draft) {
      stopTimer();
      pending = null;
      commit(draft);
    },
    cancel() {
      stopTimer();
      pending = null;
    }
  };
}
