import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TURN_INPUT_CHARS } from "@orquester/api/agent-chat";

import {
  attachmentRejectionReason,
  composerPromptLengthValidationMessage,
  composerSubmissionIntentForEnter,
  composerSubmissionValidationMessage,
  hasSendableContent,
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  pastedTextDisposition,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  proposedPlanTitle,
  resolveFollowUpDisposition,
  resolvePlanFollowUpSubmission,
  uploadsBlockSend
} from "./composer-submission.ts";

const DESKTOP = { isMobileViewport: false, shiftKey: false, modifierKey: false, isRunning: false };

test("Enter sends on desktop and Shift+Enter is a newline", () => {
  assert.equal(composerSubmissionIntentForEnter(DESKTOP), "foreground");
  assert.equal(composerSubmissionIntentForEnter({ ...DESKTOP, shiftKey: true }), null);
});

test("mobile never sends on Enter, whatever else is held", () => {
  assert.equal(
    composerSubmissionIntentForEnter({ ...DESKTOP, isMobileViewport: true }),
    null
  );
  assert.equal(
    composerSubmissionIntentForEnter({
      ...DESKTOP,
      isMobileViewport: true,
      modifierKey: true,
      isRunning: true
    }),
    null
  );
});

test("mod+Enter during a running turn is the per-message inversion", () => {
  assert.equal(
    composerSubmissionIntentForEnter({ ...DESKTOP, isRunning: true, modifierKey: true }),
    "alternate"
  );
  // Not running: the modifier is not an inversion, it is just a send.
  assert.equal(composerSubmissionIntentForEnter({ ...DESKTOP, modifierKey: true }), "foreground");
});

test("the mod-enter shortcut requires the modifier and makes a bare Enter a newline", () => {
  assert.equal(
    composerSubmissionIntentForEnter({ ...DESKTOP, sendShortcut: "mod-enter" }),
    null
  );
  assert.equal(
    composerSubmissionIntentForEnter({ ...DESKTOP, sendShortcut: "mod-enter", modifierKey: true }),
    "foreground"
  );
});

test("mod-enter-multiline only demands the modifier once the draft has a newline", () => {
  const shortcut = "mod-enter-multiline" as const;
  assert.equal(
    composerSubmissionIntentForEnter({ ...DESKTOP, sendShortcut: shortcut, prompt: "one line" }),
    "foreground"
  );
  assert.equal(
    composerSubmissionIntentForEnter({ ...DESKTOP, sendShortcut: shortcut, prompt: "two\nlines" }),
    null
  );
});

test("steer vs queue is the preference XOR the per-message inversion", () => {
  const running = { isRunning: true } as const;
  assert.equal(
    resolveFollowUpDisposition({ ...running, followUpBehavior: "queue", intent: "foreground" }),
    "queue"
  );
  assert.equal(
    resolveFollowUpDisposition({ ...running, followUpBehavior: "queue", intent: "alternate" }),
    "send"
  );
  assert.equal(
    resolveFollowUpDisposition({ ...running, followUpBehavior: "steer", intent: "foreground" }),
    "send"
  );
  assert.equal(
    resolveFollowUpDisposition({ ...running, followUpBehavior: "steer", intent: "alternate" }),
    "queue"
  );
});

test("nothing queues when no turn is running", () => {
  assert.equal(
    resolveFollowUpDisposition({
      isRunning: false,
      followUpBehavior: "queue",
      intent: "foreground"
    }),
    "send"
  );
});

test("the length message counts the overflow and names the limit", () => {
  assert.equal(composerPromptLengthValidationMessage("hi"), null);
  const over = "x".repeat(MAX_TURN_INPUT_CHARS + 3);
  const message = composerPromptLengthValidationMessage(over);
  assert.ok(message?.startsWith("Prompt is 3 characters over"));
});

test("the larger of the literal and the wire-expanded form is measured", () => {
  const short = "@ref";
  const expand = () => "y".repeat(MAX_TURN_INPUT_CHARS + 1);
  assert.equal(composerPromptLengthValidationMessage(short), null);
  assert.ok(composerPromptLengthValidationMessage(short, expand));
});

test("an answer to a pending question is exempt from the turn input bound", () => {
  const prompt = "x".repeat(MAX_TURN_INPUT_CHARS + 10);
  assert.ok(composerSubmissionValidationMessage({ prompt, submissionTarget: "provider-turn" }));
  assert.equal(
    composerSubmissionValidationMessage({ prompt, submissionTarget: "pending-user-input" }),
    null
  );
});

test("a paste at or over 32 KiB becomes an attachment", () => {
  const big = "a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  assert.equal(pastedTextDisposition({ text: big, canAttach: true }), "attachment");
  assert.equal(
    pastedTextDisposition({ text: "a".repeat(100), canAttach: true }),
    "inline"
  );
});

test("the byte length folds a paste the character count would let through", () => {
  // Each emoji is 4 UTF-8 bytes but 2 UTF-16 code units.
  const text = "😀".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES / 4);
  assert.ok(text.length < PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  assert.equal(pastedTextDisposition({ text, canAttach: true }), "attachment");
});

test("a smaller paste still folds when it would blow the input limit", () => {
  assert.equal(
    pastedTextDisposition({ text: "small", canAttach: true, wouldExceedInputLimit: true }),
    "attachment"
  );
});

test("the escape hatch and a composer that cannot attach both keep the paste inline", () => {
  const big = "a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  assert.equal(
    pastedTextDisposition({ text: big, canAttach: true, bypassAutoAttachment: true }),
    "inline"
  );
  assert.equal(pastedTextDisposition({ text: big, canAttach: false }), "inline");
});

test("the paste-as-text chord is platform-specific", () => {
  const event = { key: "V", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
  assert.equal(isPasteAsTextShortcut(event, true), true);
  assert.equal(isPasteAsTextShortcut(event, false), false);
  assert.equal(
    isPasteAsTextShortcut({ ...event, metaKey: false, ctrlKey: true }, false),
    true
  );
});

test("folded pastes get stable, increasing names", () => {
  assert.equal(nextPastedTextFileName([]), "pasted-text.txt");
  assert.equal(nextPastedTextFileName(["pasted-text.txt"]), "pasted-text-2.txt");
  assert.equal(
    nextPastedTextFileName(["pasted-text.txt", "pasted-text-2.txt"]),
    "pasted-text-3.txt"
  );
});

test("the attachment budget counts staged and in-flight together", () => {
  const base = { name: "a.png", sizeBytes: 10, mimeType: "image/png" };
  assert.equal(attachmentRejectionReason({ ...base, stagedCount: 4, preparingCount: 3 }), null);
  assert.ok(attachmentRejectionReason({ ...base, stagedCount: 5, preparingCount: 3 }));
});

test("an unsupported image type and an oversized file are both refused", () => {
  assert.ok(
    attachmentRejectionReason({
      name: "x.bmp",
      sizeBytes: 10,
      mimeType: "image/bmp",
      stagedCount: 0,
      preparingCount: 0
    })
  );
  assert.ok(
    attachmentRejectionReason({
      name: "big.png",
      sizeBytes: 11 * 1024 * 1024,
      mimeType: "image/png",
      stagedCount: 0,
      preparingCount: 0
    })
  );
  // A 11 MB non-image is fine: files get the 50 MiB bound.
  assert.equal(
    attachmentRejectionReason({
      name: "big.bin",
      sizeBytes: 11 * 1024 * 1024,
      mimeType: "application/octet-stream",
      stagedCount: 0,
      preparingCount: 0
    }),
    null
  );
});

test("an unfinished or failed upload blocks send", () => {
  assert.equal(uploadsBlockSend([{ status: "ready" }]), null);
  assert.ok(uploadsBlockSend([{ status: "uploading" }]));
  assert.ok(uploadsBlockSend([{ status: "ready" }, { status: "failed" }]));
});

test("a draft with only whitespace has nothing to send", () => {
  assert.equal(hasSendableContent({ text: "  \n ", attachmentCount: 0 }), false);
  assert.equal(hasSendableContent({ text: "  ", attachmentCount: 1 }), true);
  assert.equal(hasSendableContent({ text: "hi", attachmentCount: 0 }), true);
});

test("an empty draft implements the plan and leaves plan mode", () => {
  const resolved = resolvePlanFollowUpSubmission({
    draftText: "  ",
    planMarkdown: "# Ship it\n\nstep"
  });
  assert.equal(resolved.action, "implement");
  assert.equal(resolved.interactionMode, "default");
  assert.ok(resolved.text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX));
  assert.ok(resolved.text.includes("# Ship it"));
});

test("text in the draft refines the plan and STAYS in plan mode", () => {
  const resolved = resolvePlanFollowUpSubmission({
    draftText: "  add a rollback step ",
    planMarkdown: "# Ship it"
  });
  assert.equal(resolved.action, "refine");
  assert.equal(resolved.interactionMode, "plan");
  assert.equal(resolved.text, "add a rollback step");
});

test("the plan title is its first heading, at any level, or null", () => {
  assert.equal(proposedPlanTitle("### Ship it\nbody"), "Ship it");
  assert.equal(proposedPlanTitle("  ## Indented\n"), "Indented");
  assert.equal(proposedPlanTitle("body only"), null);
  assert.equal(proposedPlanTitle("#"), null);
  // Inherited from T3's regex verbatim: the `\s+` after the hashes may span
  // the newline, so an empty heading borrows the next line. Harmless, and
  // pinned here so a future "tidy-up" of the pattern is a visible decision
  // rather than a silent divergence from the reference.
  assert.equal(proposedPlanTitle("#    \nbody"), "body");
});
