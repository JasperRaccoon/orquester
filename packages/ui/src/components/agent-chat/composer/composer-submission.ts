// Ported from T3 Code (MIT): apps/web/src/components/chat/composerSubmission.ts,
// apps/web/src/composer-logic.ts, packages/client-runtime/src/textPaste.ts
/**
 * What Enter means, what a send is allowed to carry, and when a paste stops
 * being text (spec §7.4, §7.8).
 *
 * Pure: the component hands these a description of the draft and renders what
 * comes back. Nothing here touches the host.
 */

import {
  buildPlanImplementationPrompt,
  MAX_TURN_ATTACHMENTS,
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  MAX_TURN_INPUT_CHARS,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES
} from "@orquester/api/agent-chat";
import type { AttachmentRef } from "@orquester/api/agent-chat";
import { imageOrdinal, imagePlaceholder } from "./composer-images";
import { parseStandaloneComposerSlashCommand } from "./composer-trigger";
import type { FollowUpBehavior } from "../../../lib/agent-chat/queue.logic";

// ---------------------------------------------------------------------------
// Enter
// ---------------------------------------------------------------------------

/** Per-device preference: which chord sends. `enter` is the default. */
export type SendShortcut = "enter" | "mod-enter" | "mod-enter-multiline";

/**
 * Per-device preference: what a plain send does while a turn is running.
 *
 * Re-exported from `lib/agent-chat/queue.logic.ts` rather than redeclared —
 * the store, the Settings toggle and this module must be one union or they
 * drift. (`lib/chat-prefs.ts` holds the third spelling; it is the persisted
 * shape and structurally identical.)
 */
export type { FollowUpBehavior } from "../../../lib/agent-chat/queue.logic";

/**
 * `foreground` = send it; `alternate` = the per-message inversion of the
 * follow-up preference; `null` = this keystroke is a newline, not a send.
 *
 * T3's `background` arm is dropped: it only exists for its draft-thread
 * concept, which Orquester has no equivalent of (a new thread is a new tab).
 *
 * *T3: `composer-logic.ts:27-44`.*
 */
export type ComposerSubmissionIntent = "foreground" | "alternate";

/**
 * **Mobile never sends on Enter** (§7.8): the on-screen Return inserts a
 * newline and the send button is the only send. That is the first branch on
 * purpose — no modifier and no setting can talk past it.
 *
 * **An IME composition never sends** either. While a candidate window is open
 * Enter *commits the candidate* and fires `keydown` with `isComposing: true`;
 * acting on it sends a half-converted prompt and swallows the candidate. Some
 * engines report `keyCode === 229` for the same state instead, so both are
 * checked. It lives here rather than only at the call site so the rule is
 * testable and cannot be deleted without a failing test.
 */
export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isRunning: boolean;
  sendShortcut?: SendShortcut;
  prompt?: string;
  /** `event.nativeEvent.isComposing` — an IME candidate window is open. */
  isComposing?: boolean;
  /** The pre-`isComposing` fallback some engines still report. */
  keyCode?: number;
}): ComposerSubmissionIntent | null {
  if (input.isComposing === true || input.keyCode === 229) return null;
  const requiresModifier =
    input.sendShortcut === "mod-enter" ||
    (input.sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(input.prompt ?? ""));

  if (input.isMobileViewport || (requiresModifier && !input.modifierKey)) return null;
  if (input.shiftKey && !(requiresModifier && input.modifierKey && input.isRunning)) return null;
  if (input.isRunning && input.modifierKey && (!requiresModifier || input.shiftKey)) {
    return "alternate";
  }
  return "foreground";
}

/**
 * Steer versus queue is **one setting with a per-message inversion**: a plain
 * send follows the preference, and holding the mod key with Enter does the
 * opposite for that one message.
 *
 * *T3: `ChatView.tsx:7629-7658` — the XOR.*
 */
export function resolveFollowUpDisposition(input: {
  followUpBehavior: FollowUpBehavior;
  intent: ComposerSubmissionIntent;
  isRunning: boolean;
}): "send" | "queue" {
  if (!input.isRunning) return "send";
  return (input.followUpBehavior === "queue") !== (input.intent === "alternate") ? "queue" : "send";
}

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

/**
 * Prompt-length validation measures the **larger of the literal draft and its
 * wire-expanded form**, so a short reference that expands on the wire cannot
 * smuggle the thread past §4.1's bound.
 *
 * Orquester's composer inserts canonical paths literally, so today `expand` is
 * the identity and the two lengths agree. The seam stays because the rule is
 * about the bound, not about today's tokeniser: anything that later expands on
 * the wire must be measured here rather than at the send site.
 *
 * *T3: `composerSubmission.ts:12-23`.*
 */
export function composerPromptLengthValidationMessage(
  prompt: string,
  expand: (text: string) => string = (text) => text
): string | null {
  const normalized = prompt.trim();
  const inputLength = Math.max(normalized.length, expand(normalized).length);
  const excess = inputLength - MAX_TURN_INPUT_CHARS;
  if (excess <= 0) return null;
  const noun = excess === 1 ? "character" : "characters";
  return `Prompt is ${excess.toLocaleString("en-US")} ${noun} over the ${MAX_TURN_INPUT_CHARS.toLocaleString(
    "en-US"
  )}-character limit. Shorten or split it before sending.`;
}

/**
 * **An answer to a pending question is exempt** — it is not a provider turn
 * and never rides the turn input bound.
 *
 * *T3: `composerSubmission.ts:25-31`.*
 */
export function composerSubmissionValidationMessage(input: {
  prompt: string;
  submissionTarget: "provider-turn" | "pending-user-input";
  expand?: (text: string) => string;
}): string | null {
  return input.submissionTarget === "provider-turn"
    ? composerPromptLengthValidationMessage(input.prompt, input.expand)
    : null;
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

/** 32 KiB. *T3: `textPaste.ts:1`.* */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;

export type PastedTextDisposition = "attachment" | "inline";

/** `Cmd/Ctrl+Shift+V` — the escape hatch that keeps a big paste editable. */
export function isPasteAsTextShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  macPlatform: boolean
): boolean {
  return (
    event.key.toLowerCase() === "v" &&
    event.shiftKey &&
    !event.altKey &&
    (macPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

/**
 * Large clipboard text becomes a file so an agent can inspect it selectively.
 *
 * The threshold folds on the character count **or** the UTF-8 byte length,
 * because "character counts substantially understate the context cost of some
 * Unicode-heavy clipboard contents".
 *
 * *T3: `textPaste.ts:19-38`.*
 */
export function pastedTextDisposition(input: {
  text: string;
  canAttach: boolean;
  bypassAutoAttachment?: boolean;
  wouldExceedInputLimit?: boolean;
}): PastedTextDisposition {
  if (input.bypassAutoAttachment || !input.canAttach || input.text.length === 0) return "inline";
  return input.wouldExceedInputLimit ||
    input.text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES ||
    new TextEncoder().encode(input.text).byteLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES
    ? "attachment"
    : "inline";
}

/** Stable, human-readable names when a draft holds several folded pastes. */
export function nextPastedTextFileName(existingNames: readonly string[]): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) return "pasted-text.txt";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `pasted-text-${index}.txt`;
    if (!names.has(candidate)) return candidate;
  }
  return `pasted-text-${Date.now()}.txt`;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES);

export function isSupportedAttachmentImage(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Whether one more file fits, and why not when it does not.
 *
 * **Staged files and in-flight preparations count together** against the same
 * budget (§7.5) — a file whose upload has not finished still occupies a slot.
 *
 * *T3: `questionAttachments.ts:28-36`.*
 */
export function attachmentRejectionReason(input: {
  name: string;
  sizeBytes: number;
  mimeType: string;
  stagedCount: number;
  preparingCount: number;
}): string | null {
  if (input.stagedCount + input.preparingCount >= MAX_TURN_ATTACHMENTS) {
    return `Up to ${MAX_TURN_ATTACHMENTS} attachments per message.`;
  }
  const isImage = input.mimeType.startsWith("image/");
  if (isImage && !isSupportedAttachmentImage(input.mimeType)) {
    return `${input.name}: only GIF, JPEG, PNG and WebP images can be attached.`;
  }
  const limit = isImage ? MAX_TURN_IMAGE_BYTES : MAX_TURN_FILE_BYTES;
  if (input.sizeBytes > limit) {
    return `${input.name} is over the ${Math.round(limit / (1024 * 1024))} MB limit.`;
  }
  return null;
}

/**
 * The minimum a staged attachment has to look like for the decision below.
 * Kept structural so this module stays free of component types.
 */
export interface StagedAttachmentLike {
  key: string;
  status: "uploading" | "ready" | "failed";
  ref?: { id: string };
}

/**
 * What staging an **already-uploaded** reference should do (§7.4, §7.7).
 *
 * A browser element pick, a chat-targeted file drop and a queued message
 * coming back to the composer all arrive as an `AttachmentRef` whose bytes are
 * already on the daemon. They still have to behave exactly like a file the
 * user picked here: count against the eight, show a chip, and be removable.
 * Only the upload is skipped, because it already happened.
 *
 * Three outcomes, so the caller can react honestly:
 *  - `duplicate` — this ref is already staged. Delivering the same pick twice
 *    must not produce two chips, and it is **not** an error.
 *  - `rejected` — the turn bounds refuse it; the caller may fall back to
 *    writing the path into the draft, which is better than losing the file.
 *  - `staged` — the chip's fields, ready to insert.
 *
 * A ref that declares no `mimeType` is deliberately measured as a file rather
 * than guessed into an image subtype: refusing an already-uploaded image for
 * not having declared `image/png` would be inventing a rule the upload route
 * never applied.
 */
export type StageRefDecision =
  | { kind: "duplicate"; key: string }
  | { kind: "rejected"; reason: string }
  | { kind: "staged"; key: string; name: string; sizeBytes: number; mimeType: string };

/** Stable per ref, so re-delivering one is idempotent all the way down. */
export function stagedAttachmentKeyForRef(ref: { id: string }): string {
  return `ref:${ref.id}`;
}

export function decideStagedAttachmentForRef(input: {
  existing: readonly StagedAttachmentLike[];
  ref: AttachmentRef;
}): StageRefDecision {
  const key = stagedAttachmentKeyForRef(input.ref);
  if (input.existing.some((entry) => entry.key === key || entry.ref?.id === input.ref.id)) {
    return { kind: "duplicate", key };
  }
  const mimeType = input.ref.mimeType ?? "application/octet-stream";
  const sizeBytes = input.ref.sizeBytes ?? 0;
  const reason = attachmentRejectionReason({
    name: input.ref.name,
    sizeBytes,
    mimeType,
    stagedCount: input.existing.filter((entry) => entry.status === "ready").length,
    preparingCount: input.existing.filter((entry) => entry.status !== "ready").length
  });
  if (reason) return { kind: "rejected", reason };
  return { kind: "staged", key, name: input.ref.name, sizeBytes, mimeType };
}

/** §7.4: **uploads must finish before send.** */
export function uploadsBlockSend(
  attachments: readonly { status: "uploading" | "ready" | "failed" }[]
): string | null {
  if (attachments.some((attachment) => attachment.status === "failed")) {
    return "Retry or remove the failed attachment before sending.";
  }
  if (attachments.some((attachment) => attachment.status === "uploading")) {
    return "Waiting for attachments to finish uploading.";
  }
  return null;
}

/** A draft with neither text nor a finished attachment has nothing to send. */
export function hasSendableContent(input: {
  text: string;
  attachmentCount: number;
}): boolean {
  return input.text.trim().length > 0 || input.attachmentCount > 0;
}

// ---------------------------------------------------------------------------
// The plan follow-up (§7.5, §7.4 primary actions)
// ---------------------------------------------------------------------------

/**
 * Prefix of the message sent when the user approves a plan, and the message
 * itself: one spelling in `@orquester/api/agent-chat`, shared with the host and
 * the MCP. Re-exported so existing imports from this module keep working.
 * *T3: `proposedPlan.ts:74-77`.*
 */
export { buildPlanImplementationPrompt, PLAN_IMPLEMENTATION_PROMPT_PREFIX };

/** The plan's own title — its first markdown heading — or `null`. */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

/**
 * The primary action's two meanings while a plan is waiting to be implemented.
 *
 * **An empty draft means "Implement"**: the plan goes back as the turn text in
 * `default` mode, which is what leaves plan mode. **Text in the draft means
 * "Refine"**: that text is the turn and the thread STAYS in `plan` mode, so a
 * correction to a plan never accidentally starts the work.
 *
 * *T3: `proposedPlan.ts:80-95` (`resolvePlanFollowUpSubmission`).*
 */
export function resolvePlanFollowUpSubmission(input: {
  draftText: string;
  planMarkdown: string;
}): { text: string; interactionMode: "default" | "plan"; action: "implement" | "refine" } {
  const trimmed = input.draftText.trim();
  if (trimmed.length > 0) {
    return { text: trimmed, interactionMode: "plan", action: "refine" };
  }
  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default",
    action: "implement"
  };
}

// ---------------------------------------------------------------------------
// The send step (§7.3, §7.4)
// ---------------------------------------------------------------------------

/**
 * How one send ended, for the composer to render:
 *  - `sent` — the transport took exactly the text it was handed;
 *  - `refused` — nothing was sent, and the draft is left as it is;
 *  - `failed` — the transport rejected. `text` is what goes back to the draft,
 *    with the chips the send carried ({@link draftAfterSend}); it is the only
 *    outcome that writes the draft. It holds the user's own words from a
 *    plain send or a Refine, and `null` from an Implement, whose prompt the
 *    composer generated. The draft is then left as it is and the plan stays
 *    actionable.
 */
export type ComposerSendOutcome =
  | { kind: "sent" }
  | { kind: "refused"; notice: string }
  | { kind: "failed"; text: string | null; notice: string };

/**
 * The `resolveText` of an Implement, and of no other send: the proposal read
 * through `read` (the store's `readFullPlanMarkdown`: as is when intact, read
 * back whole when the wire cut it at 16 KiB, §5.6), built into the
 * implementation prompt at send time.
 *
 * Every Implement gets one, not only a cut plan's, because `resolveText` is
 * how {@link sendComposerTurn} tells a prompt the composer generated from the
 * user's own words. A Refine sends the user's draft, and a plain send has no
 * plan at all.
 */
export function implementationTextResolver<Proposal>(input: {
  action: "implement" | "refine" | null;
  proposal: Proposal | null;
  read: (proposal: Proposal) => Promise<string>;
}): (() => Promise<string>) | undefined {
  const { action, proposal, read } = input;
  if (action !== "implement" || proposal === null) {
    return undefined;
  }
  return () => read(proposal).then(buildPlanImplementationPrompt);
}

/**
 * The step between "the user pressed send" and the wire.
 *
 * A plain send, or a Refine, holds its text: the user's own words. An
 * Implement resolves its prompt here through `resolveText`
 * ({@link implementationTextResolver}), which reads the whole plan even when
 * the wire cut it at 16 KiB (§5.6). When the plan cannot be read, nothing is
 * sent. The resolved prompt is also the one measured against the turn input
 * bound (§4.1) here. The draft was validated on the CUT prompt, and a prompt
 * only the host refuses would come back as a failed send. A plain send was
 * validated before its draft was cleared, and is not measured again.
 *
 * A failed send puts the user's own words back into the draft, never a
 * resolved prompt. Written into the draft, the prompt would turn the primary
 * button into a plan-mode "Refine" that carries the implementation prefix.
 * Left out, the plan stays actionable and Implement is pressed again.
 *
 * `send` is the transport (the store's `sendTurn`), passed in so every branch
 * is testable without a renderer.
 */
export async function sendComposerTurn(input: {
  text: string;
  resolveText?: () => Promise<string>;
  send: (text: string) => Promise<void>;
}): Promise<ComposerSendOutcome> {
  let text = input.text;
  if (input.resolveText) {
    try {
      text = await input.resolveText();
    } catch (error) {
      return {
        kind: "refused",
        notice: error instanceof Error ? error.message : "The full plan could not be loaded."
      };
    }
    const validation = composerSubmissionValidationMessage({
      prompt: text,
      submissionTarget: "provider-turn"
    });
    if (validation) return { kind: "refused", notice: validation };
  }
  try {
    await input.send(text);
    return { kind: "sent" };
  } catch (error) {
    return {
      kind: "failed",
      text: input.resolveText ? null : text,
      notice: error instanceof Error ? error.message : "Could not send the message."
    };
  }
}

/**
 * The minimum a chip has to look like for {@link draftAfterSend}. Structural,
 * like {@link StagedAttachmentLike}; `mimeType` is what numbers an image.
 */
export interface RestorableAttachment {
  key: string;
  mimeType: string;
  ref?: { id: string };
}

/** An `[Image #N]`, as `imagePlaceholder` writes it. */
const IMAGE_PLACEHOLDER = /\[Image #(\d+)\]/g;

/**
 * What a settled send does to the draft: the draft to show next, or `null`
 * to leave it as it is.
 *
 * `submit` empties the draft, tray included, before the send goes out. Only
 * a FAILED send writes anything back, and then the chips it carried come back
 * WITH its text: restoring the words alone is how a resend went out without
 * the files. Everything else leaves the draft alone. A sent message is gone,
 * a refusal sent nothing, and a failed Implement (`text: null`) carried the
 * composer's prompt and no chip, since a chip in the tray turns Implement back
 * into a plain send.
 *
 * What was typed or staged while the send was in flight stays, behind what
 * comes back: its text after the restored text, its chips after the restored
 * chips. Chips merge by `key`, or by the upload's ref id as
 * {@link decideStagedAttachmentForRef} has it, so a chip delivered again
 * meanwhile is not staged twice. An image's `[Image #N]` is its position among
 * the staged images, so the restored text keeps naming its images, and each
 * placeholder the meanwhile text wrote for one of its own images follows that
 * image to where it lands. A number that names none of them is the user's own
 * text and stays as typed.
 */
export function draftAfterSend<A extends RestorableAttachment>(input: {
  outcome: ComposerSendOutcome;
  /** The chips the send carried, in tray order. */
  sent: readonly A[];
  /** The draft as it is now, holding what was typed or staged meanwhile. */
  draft: { text: string; attachments: readonly A[] };
}): { text: string; attachments: A[] } | null {
  const { outcome, sent, draft } = input;
  if (outcome.kind !== "failed" || outcome.text === null) return null;

  const sentCopyOf = (entry: A): A | undefined =>
    sent.find(
      (candidate) =>
        candidate.key === entry.key ||
        (candidate.ref !== undefined && candidate.ref.id === entry.ref?.id)
    );
  const attachments = [
    ...sent,
    ...draft.attachments.filter((entry) => sentCopyOf(entry) === undefined)
  ];

  const meanwhileImages = draft.attachments.filter((entry) => entry.mimeType.startsWith("image/"));
  const meanwhileText = draft.text.replace(IMAGE_PLACEHOLDER, (placeholder, digits: string) => {
    const image = meanwhileImages[Number(digits) - 1];
    if (image === undefined) return placeholder;
    const ordinal = imageOrdinal(attachments, (sentCopyOf(image) ?? image).key);
    return ordinal === null ? placeholder : imagePlaceholder(ordinal);
  });

  const restored = outcome.text;
  const text =
    meanwhileText.trim().length === 0
      ? restored
      : restored.trim().length === 0
        ? meanwhileText
        : `${restored}\n\n${meanwhileText}`;
  return { text, attachments };
}

// ---------------------------------------------------------------------------
// The submit-path guards (V1: R7-3 and R2-3 had no honest test)
// ---------------------------------------------------------------------------

/**
 * Whether `submit` bails before dispatching anything.
 *
 * **The plan is resolved BEFORE this runs.** An empty draft is exactly the
 * input "Implement" is defined on — the plan supplies the text — so guarding
 * on emptiness alone made the enabled Implement button a silent no-op (R7-3).
 */
export function submitIsNoOp(input: {
  hasSendableContent: boolean;
  hasActionablePlan: boolean;
}): boolean {
  return !input.hasSendableContent && !input.hasActionablePlan;
}

/**
 * Whether a standalone `/plan` or `/default` is swallowed client-side.
 *
 * §4.6.5(a) scopes it to providers that show the toggle. With the toggle
 * hidden (OpenCode, Grok) the draft is ordinary text and goes to the wire —
 * OpenCode genuinely dispatches `/plan` natively, and swallowing it left the
 * user with a cleared composer and nothing happening (R2-3).
 */
export function swallowsStandalonePlanCommand(input: {
  text: string;
  showPlanModeToggle: boolean;
  attachmentCount: number;
}): "plan" | "default" | null {
  if (!input.showPlanModeToggle) return null;
  if (input.attachmentCount > 0) return null;
  return parseStandaloneComposerSlashCommand(input.text);
}
