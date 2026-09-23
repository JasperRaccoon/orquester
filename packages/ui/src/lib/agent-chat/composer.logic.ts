/**
 * Agent chat — composer submission, validation and paste rules (spec §7.4).
 *
 * Ported from T3 Code (MIT): `apps/web/src/composer-logic.ts`
 * (`composerSubmissionIntentForEnter`),
 * `apps/web/src/components/chat/composerSubmission.ts` and
 * `packages/client-runtime/src/textPaste.ts`.
 *
 * No React import.
 */

import {
  MAX_TURN_ATTACHMENTS,
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  MAX_TURN_INPUT_CHARS,
  SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES,
  type AttachmentRef,
  type ComposerContextRecord
} from "@orquester/api/agent-chat";

import type { ComposerSubmissionIntent } from "./queue.logic";

// ---------------------------------------------------------------------------
// Enter
// ---------------------------------------------------------------------------

/**
 * What pressing Enter means.
 *
 * `null` = insert a newline. `"alternate"` = mod+Enter during a live turn,
 * which inverts the steer/queue preference for that one message (§7.4).
 *
 * **Below the narrow breakpoint Enter never sends** (§7.8): the on-screen
 * Return inserts a newline and the send button is the only send.
 *
 * *T3: `composer-logic.ts:27-44`; differs: T3's third intent `"background"`
 * (mod+Enter on a draft thread, which starts the thread in the background) has
 * no analogue — a chat tab is created before its first turn (§6.1).*
 */
export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isRunning: boolean;
  /** `"enter"` (default) or `"mod-enter"`. */
  sendShortcut?: "enter" | "mod-enter";
}): ComposerSubmissionIntent | null {
  const requiresModifier = input.sendShortcut === "mod-enter";
  if (input.isMobileViewport || (requiresModifier && !input.modifierKey)) {
    return null;
  }
  if (input.shiftKey && !(requiresModifier && input.modifierKey && input.isRunning)) {
    return null;
  }
  if (input.isRunning && input.modifierKey && (!requiresModifier || input.shiftKey)) {
    return "alternate";
  }
  return "foreground";
}

// ---------------------------------------------------------------------------
// Validation (§7.4)
// ---------------------------------------------------------------------------

export type ComposerSubmissionTarget = "provider-turn" | "pending-user-input";

/**
 * Prompt-length validation measures the **larger of the literal draft and its
 * wire-expanded form**, so a short reference that expands on the wire cannot
 * smuggle the thread past §4.1's bound.
 *
 * *T3: `composerSubmission.ts:12-23`.*
 */
export function composerPromptLengthValidationMessage(
  prompt: string,
  wireExpandedPrompt?: string
): string | null {
  const literal = prompt.trim();
  const inputLength = Math.max(literal.length, (wireExpandedPrompt ?? literal).length);
  const excess = inputLength - MAX_TURN_INPUT_CHARS;
  if (excess <= 0) {
    return null;
  }
  const label = excess === 1 ? "character" : "characters";
  return `Prompt is ${excess.toLocaleString("en-US")} ${label} over the ${MAX_TURN_INPUT_CHARS.toLocaleString(
    "en-US"
  )}-character limit. Shorten or split it before sending.`;
}

/**
 * **Answers to a pending question are exempt** from the prompt bound, because
 * they are not a provider turn (§7.4).
 *
 * *T3: `composerSubmission.ts:25-31`.*
 */
export function composerSubmissionValidationMessage(input: {
  prompt: string;
  wireExpandedPrompt?: string;
  submissionTarget: ComposerSubmissionTarget;
  attachments?: readonly AttachmentRef[];
}): string | null {
  const attachments = input.attachments ?? [];
  if (attachments.length > MAX_TURN_ATTACHMENTS) {
    return `A turn can carry at most ${MAX_TURN_ATTACHMENTS} attachments.`;
  }
  if (input.submissionTarget !== "provider-turn") {
    return null;
  }
  return composerPromptLengthValidationMessage(input.prompt, input.wireExpandedPrompt);
}

/** The §4.1 per-attachment bounds, checked client-side before upload. */
export function attachmentRejectionReason(file: {
  name: string;
  type?: string;
  size: number;
}): string | null {
  const mime = file.type?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) {
    if (!(SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
      return `${file.name}: only GIF, JPEG, PNG and WebP images can be attached.`;
    }
    if (file.size > MAX_TURN_IMAGE_BYTES) {
      return `${file.name} is over the ${Math.round(MAX_TURN_IMAGE_BYTES / (1024 * 1024))} MB image limit.`;
    }
    return null;
  }
  if (file.size > MAX_TURN_FILE_BYTES) {
    return `${file.name} is over the ${Math.round(MAX_TURN_FILE_BYTES / (1024 * 1024))} MB file limit.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paste (§7.4)
// ---------------------------------------------------------------------------

/** *T3: `textPaste.ts:1`.* */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;

export type PastedTextDisposition = "attachment" | "inline";

/**
 * A paste of 32 KiB or more — measured in UTF-8 **bytes as well as
 * characters** — becomes a text attachment instead of inline text, because
 * character counts substantially understate the context cost of some
 * Unicode-heavy clipboard contents.
 *
 * *T3: `textPaste.ts:19-38`.*
 */
export function pastedTextDisposition(input: {
  text: string;
  canAttach: boolean;
  bypassAutoAttachment?: boolean;
  wouldExceedInputLimit?: boolean;
}): PastedTextDisposition {
  if (input.bypassAutoAttachment || !input.canAttach || input.text.length === 0) {
    return "inline";
  }
  if (input.wouldExceedInputLimit || input.text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES) {
    return "attachment";
  }
  return new TextEncoder().encode(input.text).byteLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES
    ? "attachment"
    : "inline";
}

/** Stable, readable names when a draft holds several folded pastes. *T3: `:40-50`.* */
export function nextPastedTextFileName(existingNames: readonly string[]): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) {
    return "pasted-text.txt";
  }
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `pasted-text-${index}.txt`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  return `pasted-text-${Date.now()}.txt`;
}

// ---------------------------------------------------------------------------
// Inserting external payloads into the draft (§7.4)
// ---------------------------------------------------------------------------

/**
 * **Browser-pick payloads and session uploads targeting a chat tab are written
 * into the draft as text plus attachment, never typed into a pane** (§7.4).
 * Inserted at the caret, with the surrounding whitespace normalised so the
 * result reads as prose rather than as a concatenation.
 *
 * *T3: `apps/web/src/composerDraftStore.ts:3739-3777`.*
 */
export function insertIntoDraftAtCaret(
  text: string,
  cursor: number,
  insertion: string
): { text: string; cursor: number } {
  const at = Math.max(0, Math.min(text.length, Math.floor(cursor)));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const needsLeading = before.length > 0 && !/\s$/.test(before);
  const needsTrailing = after.length > 0 && !/^\s/.test(after);
  const body = `${needsLeading ? "\n" : ""}${insertion}${needsTrailing ? "\n" : ""}`;
  return { text: `${before}${body}${after}`, cursor: at + body.length };
}

// ---------------------------------------------------------------------------
// Drafts (§7.4)
// ---------------------------------------------------------------------------

/**
 * A composer draft: what the user has typed, attached and not sent.
 *
 * Unlike a queued message — a live intent held in memory (§7.4) — this is
 * persisted per thread, and the mounted composer writes it on every change
 * (debounced) so it genuinely survives what the component does not: a tab
 * switch, a switch to a project whose tabs unmount it, and a reload.
 *
 * `attachments` are references whose bytes are already on the daemon; an
 * upload still in flight is identified by a `File` no storage can carry, so it
 * is dropped rather than half-persisted.
 */
export interface ComposerDraft {
  text: string;
  attachments: AttachmentRef[];
  context: ComposerContextRecord[];
}

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [], context: [] };

export function draftIsEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text.trim().length === 0 &&
    draft.attachments.length === 0 &&
    draft.context.length === 0
  );
}

/**
 * The absolute host path an upload answered for a ref (§7.4), or undefined —
 * the `unknown` arm never has one, an older bundle never wrote one.
 */
export function attachmentPathOf(ref: AttachmentRef | undefined): string | undefined {
  if (ref === undefined || !("path" in ref)) return undefined;
  return typeof ref.path === "string" && ref.path.length > 0 ? ref.path : undefined;
}

/**
 * A persisted ref's `path` must be a non-empty string or absent: a malformed
 * one from a stale blob must never reach `removeFilePath` (AGENTS.md: raw
 * `JSON.parse` output never reaches typed code).
 */
function normalisePersistedAttachment(ref: AttachmentRef): AttachmentRef {
  if (!("path" in ref) || attachmentPathOf(ref) !== undefined) return ref;
  const { path: _dropped, ...rest } = ref;
  return rest;
}

const DRAFTS_KEY = "orquester:agent-chat-drafts";
const MAX_PERSISTED_DRAFTS = 50;

function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.type === "image" || record.type === "file" || record.type === "unknown") &&
    typeof record.id === "string" &&
    typeof record.name === "string"
  );
}

function isContextRecord(value: unknown): value is ComposerContextRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string" && typeof record.label === "string";
}

/**
 * Field-wise validation with a fallback, per AGENTS.md: **raw `JSON.parse`
 * output must never reach typed code** — an old bundle's payload outlives a
 * deploy, and one malformed blob must degrade to "no draft", never crash the
 * client on load.
 */
export function parsePersistedDrafts(raw: string | null): Record<string, ComposerDraft> {
  if (!raw) {
    return {};
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return {};
  }
  const result: Record<string, ComposerDraft> = {};
  for (const [sessionId, value] of Object.entries(decoded as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.text !== "string") {
      continue;
    }
    result[sessionId] = {
      text: record.text,
      attachments: Array.isArray(record.attachments)
        ? record.attachments.filter(isAttachmentRef).map(normalisePersistedAttachment)
        : [],
      context: Array.isArray(record.context) ? record.context.filter(isContextRecord) : []
    };
  }
  return result;
}

export function readPersistedDrafts(): Record<string, ComposerDraft> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    return parsePersistedDrafts(localStorage.getItem(DRAFTS_KEY));
  } catch {
    return {};
  }
}

export function writePersistedDrafts(drafts: Record<string, ComposerDraft>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    const entries = Object.entries(drafts).filter(([, draft]) => !draftIsEmpty(draft));
    const bounded = entries.slice(Math.max(0, entries.length - MAX_PERSISTED_DRAFTS));
    if (bounded.length === 0) {
      localStorage.removeItem(DRAFTS_KEY);
      return;
    }
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(bounded)));
  } catch {
    /* private window, blocked storage, quota — a draft is a convenience */
  }
}
