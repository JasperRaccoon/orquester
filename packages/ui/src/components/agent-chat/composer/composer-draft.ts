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
 *  - {@link draftAfterReturn} / {@link persistedDraftAfterReturn} — a message
 *    coming back (a queued message returned, a Stop's drain, a rewind) merged
 *    behind the live draft, or behind the persisted one when no composer is
 *    mounted.
 *  - {@link createDraftPersistScheduler} — one write per window while typing,
 *    a synchronous flush for an unmount, a tab switch or a reload.
 *
 * A file coming back is never dropped: every one of these keeps every file —
 * as a chip, or, where a type or a size bound refuses it, as its path in the
 * text — and a draft over the eight is held at the send gate
 * (`attachmentCountBlockSend`) until the user removes enough.
 *
 * Pure and component-free on purpose: the component is untestable here (the
 * package's test glob only walks `*.test.ts`), so everything that can be
 * decided without React is decided in this file.
 */

import type { AttachmentRef, ComposerContextRecord } from "@orquester/api/agent-chat";

import {
  attachmentPathOf,
  EMPTY_DRAFT,
  type ComposerDraft
} from "../../../lib/agent-chat/composer.logic";
import { composerTextForDelivery } from "../../../lib/composer-inbox";
import { textNamesPath } from "./composer-files";
import { removeImagePlaceholder } from "./composer-images";
import {
  decideStagedAttachmentForRef,
  draftAfterSend,
  mergeMessageIntoDraft,
  stagedFieldsForRef,
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
 * A chip for a ref whose bytes are already on the daemon, so ready at once —
 * with a staged decision's fields, or a stored ref's own (`stagedFieldsForRef`).
 */
export function readyChip(
  fields: { key: string; name: string; sizeBytes: number; mimeType: string },
  ref: AttachmentRef
): StagedAttachment {
  return {
    key: fields.key,
    name: fields.name,
    sizeBytes: fields.sizeBytes,
    mimeType: fields.mimeType,
    status: "ready",
    progress: 1,
    ref
  };
}

/**
 * Turn a persisted draft back into a live one.
 *
 * It reuses {@link decideStagedAttachmentForRef}, so a reloaded chip obeys the
 * bounds a live drop does (one chip per ref, the MIME and size bounds) — but
 * it deliberately does **not** go through the composer's `stageAttachment`:
 * that one also writes an `[Image #N]` placeholder at the caret, and the text
 * being restored alongside already contains the placeholders the user saw.
 * Staging through it would duplicate every one of them. The same holds for a
 * file's path: the restored text already carries it.
 *
 * **Never the count** (`enforceCount: false`): every file here was in a
 * message once — a failed send restored ahead of the files staged while it was
 * in flight, two queued messages a Stop returned — and a load that kept the
 * first eight dropped the rest without a word while the text still named
 * them. A draft over the eight loads whole and is held at the send gate
 * (`attachmentCountBlockSend`), which the composer's status line names.
 *
 * Every write of a persisted draft stages only what the MIME and size bounds
 * accept — a returned file they refuse goes into the text as its path
 * ({@link persistedDraftAfterReturn}) — so an entry they refuse here is one a
 * draft written before that rule carried. It is dropped rather than reported:
 * there is no composer notice to render into yet at load time, and the file
 * itself is still on the daemon.
 */
export function loadComposerDraft(persisted: ComposerDraft): LoadedComposerDraft {
  const attachments: StagedAttachment[] = [];
  for (const ref of persisted.attachments) {
    const decision = decideStagedAttachmentForRef({ existing: attachments, ref, enforceCount: false });
    if (decision.kind !== "staged") continue;
    attachments.push(readyChip(decision, ref));
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

/**
 * A message coming BACK into the composer's live draft (§7.4) — a queued
 * message returned, the queue a Stop drained, a rewound message — behind what
 * the draft holds: `mergeMessageIntoDraft` at the back, the merge a failed send
 * makes the other way round, so its `[Image #N]` keep naming its own images
 * and never one the draft already had.
 *
 * Its files come back as chips staged as RETURNING (`enforceCount: false`):
 * each was part of a message once, so the eight never refuse it, and a draft
 * that ends up over them is held at the send gate until the user trims it. A
 * file a bound still refuses — a type or a size the composer never stages — is
 * taken out of the message the way its chip's X would take it (an image's
 * placeholder goes, and the later ones close the gap) and handed back in
 * `unstaged`, for the caller to write into the draft as its path; a file whose
 * path the text already names is in the draft already. Nothing is parked
 * behind the composer: a mounted composer owns its draft, and its next save
 * would write over anything left there.
 */
export function draftAfterReturn(input: {
  draft: { text: string; attachments: readonly StagedAttachment[] };
  message: { text: string; attachments: readonly AttachmentRef[] };
}): { text: string; attachments: StagedAttachment[]; unstaged: AttachmentRef[] } {
  let text = input.message.text;
  const chips: StagedAttachment[] = [];
  const refused: AttachmentRef[] = [];
  for (const ref of input.message.attachments) {
    // Measured against the message's own chips: a file the draft already
    // holds is the merge's to fold into that chip, its placeholder with it.
    const decision = decideStagedAttachmentForRef({ existing: chips, ref, enforceCount: false });
    if (decision.kind === "duplicate") continue;
    if (decision.kind === "rejected") {
      if ((ref.mimeType ?? "").startsWith("image/")) {
        const ordinal = chips.filter((chip) => chip.mimeType.startsWith("image/")).length + 1;
        text = removeImagePlaceholder(text, ordinal);
      }
      refused.push(ref);
      continue;
    }
    chips.push(readyChip(decision, ref));
  }
  const merged = mergeMessageIntoDraft({
    draft: input.draft,
    message: { text, attachments: chips },
    at: "back"
  });
  const unstaged = refused.filter((ref) => {
    const path = attachmentPathOf(ref);
    return path === undefined || !textNamesPath(merged.text, path);
  });
  return { ...merged, unstaged };
}

/**
 * A stored ref as a chip, keyed and typed as `loadComposerDraft` stages it, no
 * bound applied — also how a send the tab's outbox kept comes back as the
 * chips of a failed send (`restoreSend` in the thread store).
 */
export function storedChip(ref: AttachmentRef): StagedAttachment {
  return readyChip(stagedFieldsForRef(ref), ref);
}

/**
 * `refs` written at the end of `text` as their paths — their ids when the
 * host named none — the way a mounted composer's caller appends them
 * (`composerTextForDelivery` through the bridge's `insertText(…, "append")`).
 */
function withPathsAppended(text: string, refs: readonly AttachmentRef[]): string {
  const paths = composerTextForDelivery({ text: "", attachments: [...refs] });
  if (paths.length === 0) return text;
  return text.length > 0 && !/\s$/.test(text) ? `${text} ${paths}` : `${text}${paths}`;
}

/**
 * A message coming back into a thread's PERSISTED draft (§7.4), when no
 * composer is mounted to take it: {@link draftAfterReturn} over the stored
 * refs, with the same bounds and the same fallback a mounted composer's
 * caller applies — a returned file a type or a size bound refuses is written
 * into the text as its path. So no file of the message is dropped here, the
 * count included, nor later: the next mount stages every ref this merge wrote
 * ({@link loadComposerDraft}), and the send gate holds a draft over the eight.
 * The draft's own refs are kept as they are, and the message's context records
 * ride along after the draft's.
 */
export function persistedDraftAfterReturn(input: {
  persisted: ComposerDraft;
  message: ComposerDraft;
}): ComposerDraft {
  const next = draftAfterReturn({
    draft: { text: input.persisted.text, attachments: input.persisted.attachments.map(storedChip) },
    message: input.message
  });
  return {
    text: withPathsAppended(next.text, next.unstaged),
    attachments: persistableAttachmentRefs(next.attachments),
    context: [...input.persisted.context, ...input.message.context]
  };
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
