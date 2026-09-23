import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TURN_INPUT_CHARS } from "@orquester/api/agent-chat";

import {
  attachmentRejectionReason,
  buildPlanImplementationPrompt,
  composerPromptLengthValidationMessage,
  composerSubmissionIntentForEnter,
  composerSubmissionValidationMessage,
  decideStagedAttachmentForRef,
  draftAfterSend,
  hasSendableContent,
  implementationTextResolver,
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  pastedTextDisposition,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  proposedPlanTitle,
  resolveFollowUpDisposition,
  resolvePlanFollowUpSubmission,
  sendComposerTurn,
  stagedAttachmentKeyForRef,
  submitIsNoOp,
  swallowsStandalonePlanCommand,
  uploadsBlockSend,
  type ComposerSendOutcome,
  type StagedAttachmentLike
} from "./composer-submission.ts";
import type { StagedAttachment } from "./ComposerAttachments";

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

// ---------------------------------------------------------------------------
// Staging an already-uploaded reference (§7.4, §7.7)
// ---------------------------------------------------------------------------

const READY: StagedAttachmentLike = { key: "k", status: "ready", ref: { id: "/tmp/a.png" } };

test("an uploaded ref is staged with the fields a chip needs", () => {
  const decision = decideStagedAttachmentForRef({
    existing: [],
    ref: { type: "image", id: "/tmp/shot.png", name: "shot.png", mimeType: "image/png", sizeBytes: 12 }
  });
  assert.deepEqual(decision, {
    kind: "staged",
    key: stagedAttachmentKeyForRef({ id: "/tmp/shot.png" }),
    name: "shot.png",
    sizeBytes: 12,
    mimeType: "image/png"
  });
});

test("re-delivering the same ref is a duplicate, not a second chip and not an error", () => {
  const ref = { type: "file", id: "/tmp/a.png", name: "a.png", sizeBytes: 1 } as const;
  assert.deepEqual(decideStagedAttachmentForRef({ existing: [READY], ref }), {
    kind: "duplicate",
    key: stagedAttachmentKeyForRef(ref)
  });
});

test("a ref that arrives under a different key is still matched by its id", () => {
  const existing: StagedAttachmentLike[] = [
    { key: "picked-by-hand", status: "ready", ref: { id: "/tmp/b.txt" } }
  ];
  const decision = decideStagedAttachmentForRef({
    existing,
    ref: { type: "file", id: "/tmp/b.txt", name: "b.txt", sizeBytes: 3 }
  });
  assert.equal(decision.kind, "duplicate");
});

test("staging counts against the same eight as a picked file", () => {
  const existing: StagedAttachmentLike[] = Array.from({ length: 8 }, (_, index) => ({
    key: `k${index}`,
    status: "ready" as const,
    ref: { id: `/tmp/${index}` }
  }));
  const decision = decideStagedAttachmentForRef({
    existing,
    ref: { type: "file", id: "/tmp/new", name: "new.txt", sizeBytes: 1 }
  });
  assert.equal(decision.kind, "rejected");
});

test("an in-flight upload occupies a slot against a staged ref too", () => {
  const existing: StagedAttachmentLike[] = Array.from({ length: 8 }, (_, index) => ({
    key: `k${index}`,
    status: index === 0 ? ("uploading" as const) : ("ready" as const)
  }));
  assert.equal(
    decideStagedAttachmentForRef({
      existing,
      ref: { type: "file", id: "/tmp/new", name: "new.txt", sizeBytes: 1 }
    }).kind,
    "rejected"
  );
});

test("a ref with no declared mimeType is measured as a file, never guessed into an image", () => {
  // 20 MB: over the 10 MiB image bound, under the 50 MiB file bound. Refusing
  // it would invent a rule the upload route never applied.
  const decision = decideStagedAttachmentForRef({
    existing: [],
    ref: { type: "unknown", id: "/tmp/big", name: "big.bin", sizeBytes: 20 * 1024 * 1024 }
  });
  assert.equal(decision.kind, "staged");
  assert.equal(decision.kind === "staged" && decision.mimeType, "application/octet-stream");
});

test("a ref with no declared size is staged as zero rather than refused", () => {
  const decision = decideStagedAttachmentForRef({
    existing: [],
    ref: { type: "unknown", id: "/tmp/x", name: "x" }
  });
  assert.equal(decision.kind, "staged");
  assert.equal(decision.kind === "staged" && decision.sizeBytes, 0);
});

test("a declared image over the image bound is still refused", () => {
  const decision = decideStagedAttachmentForRef({
    existing: [],
    ref: {
      type: "image",
      id: "/tmp/huge.png",
      name: "huge.png",
      mimeType: "image/png",
      sizeBytes: 11 * 1024 * 1024
    }
  });
  assert.equal(decision.kind, "rejected");
});

test("a staged ref does not block send: it is already uploaded", () => {
  const decision = decideStagedAttachmentForRef({
    existing: [],
    ref: { type: "file", id: "/tmp/a", name: "a", sizeBytes: 1 }
  });
  assert.equal(decision.kind, "staged");
  assert.equal(uploadsBlockSend([{ status: "ready" }]), null);
});

// ---------------------------------------------------------------------------
// Fix wave
// ---------------------------------------------------------------------------

/**
 * R7-3 / R8-B1: "Implement" is defined on an EMPTY draft — the plan supplies
 * the text. `ChatComposer.submit` used to return on `!sendable` before ever
 * resolving the plan, so the enabled button was a silent no-op. The composer
 * now resolves the plan first and guards with `!sendable && plan === null`;
 * this pins the resolver half of that contract.
 */
test("R7-3: an empty draft with an actionable plan still produces a submission", () => {
  const plan = resolvePlanFollowUpSubmission({ draftText: "", planMarkdown: "# Ship it\n\nstep" });
  assert.equal(plan.action, "implement");
  assert.equal(plan.interactionMode, "default");
  assert.ok(plan.text.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX));
  // The guard the composer now uses: sendable is false, but plan is not null.
  assert.equal(hasSendableContent({ text: "", attachmentCount: 0 }), false);
  assert.notEqual(plan, null);
});

test("Q2-5: Enter during an IME composition is not a send", () => {
  // Deleting the guard makes this fail: the same input differs only by
  // `isComposing`, and the composing one must resolve to null.
  const base = {
    isMobileViewport: false,
    shiftKey: false,
    modifierKey: false,
    isRunning: false
  } as const;
  assert.equal(composerSubmissionIntentForEnter(base), "foreground");
  assert.equal(composerSubmissionIntentForEnter({ ...base, isComposing: true }), null);
});

test("Q2-5: the keyCode 229 fallback is honoured for engines without isComposing", () => {
  const base = {
    isMobileViewport: false,
    shiftKey: false,
    modifierKey: false,
    isRunning: false
  } as const;
  assert.equal(composerSubmissionIntentForEnter({ ...base, keyCode: 229 }), null);
  // A normal Enter carries keyCode 13 and must still send.
  assert.equal(composerSubmissionIntentForEnter({ ...base, keyCode: 13 }), "foreground");
});

test("Q2-5: a composition beats every other send path, including mod+Enter steering", () => {
  assert.equal(
    composerSubmissionIntentForEnter({
      isMobileViewport: false,
      shiftKey: false,
      modifierKey: true,
      isRunning: true,
      isComposing: true
    }),
    null
  );
});

test("R7-3: an empty draft with an actionable plan is NOT a no-op submit", () => {
  // The bug: `if (!sendable) return;` ran before the plan was resolved, so the
  // enabled Implement button did nothing. Deleting the `hasActionablePlan`
  // term makes this fail.
  assert.equal(submitIsNoOp({ hasSendableContent: false, hasActionablePlan: true }), false);
  assert.equal(submitIsNoOp({ hasSendableContent: false, hasActionablePlan: false }), true);
  assert.equal(submitIsNoOp({ hasSendableContent: true, hasActionablePlan: false }), false);
});

test("R2-3: /plan is swallowed only where the toggle is shown", () => {
  const base = { text: "/plan", attachmentCount: 0 };
  assert.equal(swallowsStandalonePlanCommand({ ...base, showPlanModeToggle: true }), "plan");
  // OpenCode/Grok: the toggle is hidden, so it goes to the wire as text.
  assert.equal(swallowsStandalonePlanCommand({ ...base, showPlanModeToggle: false }), null);
});

test("R2-3: /default follows the same gate, and an attachment defeats both", () => {
  assert.equal(
    swallowsStandalonePlanCommand({ text: "/default", attachmentCount: 0, showPlanModeToggle: true }),
    "default"
  );
  assert.equal(
    swallowsStandalonePlanCommand({ text: "/plan", attachmentCount: 1, showPlanModeToggle: true }),
    null
  );
});

test("R2-3: only a STANDALONE command is swallowed", () => {
  assert.equal(
    swallowsStandalonePlanCommand({
      text: "/plan the migration",
      attachmentCount: 0,
      showPlanModeToggle: true
    }),
    null
  );
});

// ---------------------------------------------------------------------------
// The send step: Implement reads a cut plan back whole (§5.6, §7.3, §7.4)
// ---------------------------------------------------------------------------

/** A stand-in for the store's `sendTurn`: records what reached the wire. */
function recordingSend(failure?: Error): { sent: string[]; send: (text: string) => Promise<void> } {
  const sent: string[] = [];
  return {
    sent,
    send: async (text) => {
      sent.push(text);
      if (failure) throw failure;
    }
  };
}

/** What Implement holds for a plan the wire cut at 16 KiB: the prompt ends in "…". */
const CUT_PROMPT = buildPlanImplementationPrompt("# Ship it\n\nstep 1…");

test("Implement on a plan that cannot be read back sends nothing, and says why", async () => {
  const wire = recordingSend();
  const outcome = await sendComposerTurn({
    text: CUT_PROMPT,
    resolveText: () =>
      Promise.reject(new Error("The full plan could not be loaded, so nothing was sent. Try again.")),
    send: wire.send
  });
  assert.deepEqual(outcome, {
    kind: "refused",
    notice: "The full plan could not be loaded, so nothing was sent. Try again."
  });
  assert.deepEqual(wire.sent, [], "nothing reached the wire");
  // A reader that rejects with a bare value still gets an honest notice.
  const bare = await sendComposerTurn({ text: CUT_PROMPT, resolveText: () => Promise.reject("gone"), send: wire.send });
  assert.deepEqual(bare, { kind: "refused", notice: "The full plan could not be loaded." });
  assert.deepEqual(wire.sent, []);
});

test("a read-back prompt over the turn bound is refused before it is sent, and nothing goes back to the draft", async () => {
  const whole = buildPlanImplementationPrompt(`# Ship it\n\n${"step ".repeat(MAX_TURN_INPUT_CHARS / 5)}`);
  // The composer measured the CUT prompt, which fits; only the whole one is over.
  assert.equal(composerPromptLengthValidationMessage(CUT_PROMPT), null);
  const expected = composerPromptLengthValidationMessage(whole);
  assert.ok(expected !== null, "the whole prompt is over the bound");
  const wire = recordingSend();
  const outcome = await sendComposerTurn({ text: CUT_PROMPT, resolveText: async () => whole, send: wire.send });
  // `refused` carries no text: only a FAILED send is written back into the
  // draft, so the whole prompt never lands in the composer.
  assert.deepEqual(outcome, { kind: "refused", notice: expected });
  assert.deepEqual(wire.sent, [], "the host never had to refuse it");
});

test("a plan read back whole is what gets sent, not the cut one", async () => {
  const whole = buildPlanImplementationPrompt(`# Ship it\n\n${"step\n".repeat(4_000)}done`);
  assert.ok(whole.length > 16 * 1024, "longer than the wire's cut");
  const wire = recordingSend();
  const outcome = await sendComposerTurn({ text: CUT_PROMPT, resolveText: async () => whole, send: wire.send });
  assert.deepEqual(outcome, { kind: "sent" });
  assert.deepEqual(wire.sent, [whole]);
});

test("a plain send goes out as typed, and one the host refuses goes back to the draft as typed", async () => {
  const wire = recordingSend();
  assert.deepEqual(await sendComposerTurn({ text: "fix the tests", send: wire.send }), { kind: "sent" });
  assert.deepEqual(wire.sent, ["fix the tests"]);

  // The user's own words: a failed send hands them back whole, for the draft.
  const refusing = recordingSend(new Error("The agent host is restarting."));
  assert.deepEqual(await sendComposerTurn({ text: "fix the tests", send: refusing.send }), {
    kind: "failed",
    text: "fix the tests",
    notice: "The agent host is restarting."
  });
  assert.deepEqual(refusing.sent, ["fix the tests"]);
});

test("a failed Implement leaves the draft alone: its prompt is the composer's, not the user's", async () => {
  // Written into the draft, the prompt would turn the primary button into a
  // plan-mode "Refine" that carries the implementation prefix. Left out, the
  // plan is still actionable, and Implement is simply pressed again.
  const whole = buildPlanImplementationPrompt("# Ship it\n\nevery step");
  const refusing = recordingSend(new Error("The agent host is restarting."));
  assert.deepEqual(await sendComposerTurn({ text: CUT_PROMPT, resolveText: async () => whole, send: refusing.send }), {
    kind: "failed",
    text: null,
    notice: "The agent host is restarting."
  });
  assert.deepEqual(refusing.sent, [whole], "the whole prompt is what the host refused");
});

test("every Implement reads its plan at send time, intact or cut, and no other send does", async () => {
  const reads: string[] = [];
  const read = async (plan: { id: string; planMarkdown: string }) => {
    reads.push(plan.id);
    return plan.planMarkdown;
  };
  const intact = { id: "p-intact", planMarkdown: "# Ship it\n\nevery step" };
  const resolveText = implementationTextResolver({ action: "implement", proposal: intact, read });
  assert.ok(resolveText, "an intact plan's Implement resolves its prompt too, not only a cut one's");
  assert.deepEqual(reads, [], "nothing is read before the send step runs");
  assert.equal(await resolveText(), buildPlanImplementationPrompt(intact.planMarkdown));
  assert.deepEqual(reads, ["p-intact"]);

  // A Refine sends the user's own text, and a plain send has no plan at all.
  assert.equal(implementationTextResolver({ action: "refine", proposal: intact, read }), undefined);
  assert.equal(implementationTextResolver({ action: null, proposal: null, read }), undefined);
  assert.deepEqual(reads, ["p-intact"]);
});

test("so a failed Implement on an intact plan leaves the draft alone too", async () => {
  const intact = { id: "p-intact", planMarkdown: "# Ship it\n\nevery step" };
  const prompt = buildPlanImplementationPrompt(intact.planMarkdown);
  const refusing = recordingSend(new Error("The agent host is restarting."));
  const outcome = await sendComposerTurn({
    text: prompt,
    resolveText: implementationTextResolver({
      action: "implement",
      proposal: intact,
      read: async (plan) => plan.planMarkdown
    }),
    send: refusing.send
  });
  assert.deepEqual(outcome, { kind: "failed", text: null, notice: "The agent host is restarting." });
  assert.deepEqual(refusing.sent, [prompt]);
});

// ---------------------------------------------------------------------------
// What a settled send leaves in the draft: a failed one comes back whole (§7.4)
// ---------------------------------------------------------------------------

/** A file picked or pasted here: keyed per staging, uploaded, ready to send. */
function fileChip(id: string, mimeType = "application/pdf", key = `picked:${id}`): StagedAttachment {
  return {
    key,
    name: id,
    sizeBytes: 12,
    mimeType,
    status: "ready",
    progress: 1,
    ref: { type: "file", id: `att-${id}`, name: id, mimeType, sizeBytes: 12 }
  };
}

function imageChip(id: string, key = `picked:${id}`): StagedAttachment {
  const name = `${id}.png`;
  return {
    key,
    name,
    sizeBytes: 12,
    mimeType: "image/png",
    status: "ready",
    progress: 1,
    ref: { type: "image", id: `att-${id}`, name, mimeType: "image/png", sizeBytes: 12 }
  };
}

const failedWith = (text: string | null): ComposerSendOutcome => ({
  kind: "failed",
  text,
  notice: "Could not send the message."
});

/** What `submit` leaves behind before the send goes out: nothing, tray included. */
const EMPTIED: { text: string; attachments: StagedAttachment[] } = { text: "", attachments: [] };

test("a failed send comes back with the chips it carried, so a resend carries the files", async () => {
  const shot = imageChip("shot");
  const report = fileChip("report");
  const refusing = recordingSend(new Error("The agent host is restarting."));
  const outcome = await sendComposerTurn({ text: "why does [Image #1] fail? see the report", send: refusing.send });
  assert.deepEqual(draftAfterSend({ outcome, sent: [shot, report], draft: EMPTIED }), {
    text: "why does [Image #1] fail? see the report",
    attachments: [shot, report]
  });
});

test("what was typed or staged while it was in flight stays, behind it, and no chip is doubled", () => {
  const report = fileChip("report");
  // A browser pick is keyed by its ref, so delivering it again stages the same key.
  const pick = fileChip("pick", "text/html", stagedAttachmentKeyForRef({ id: "att-pick" }));
  const logs = fileChip("logs", "text/plain");
  assert.deepEqual(
    draftAfterSend({
      outcome: failedWith("compare these"),
      sent: [report, pick],
      draft: { text: "and the logs", attachments: [{ ...pick }, logs] }
    }),
    { text: "compare these\n\nand the logs", attachments: [report, pick, logs] }
  );
  // One upload under another key is still one file, as `decideStagedAttachmentForRef` has it.
  assert.deepEqual(
    draftAfterSend({
      outcome: failedWith("compare these"),
      sent: [report],
      draft: { text: "", attachments: [{ ...report, key: "picked:report-again" }, logs] }
    }),
    { text: "compare these", attachments: [report, logs] }
  );
  // A message of files alone comes back as files alone: no blank lines ahead of what was typed since.
  assert.deepEqual(
    draftAfterSend({
      outcome: failedWith(""),
      sent: [report],
      draft: { text: "and this", attachments: [] }
    }),
    { text: "and this", attachments: [report] }
  );
});

test("an image staged meanwhile keeps its own [Image #N] once the sent images are back ahead of it", () => {
  const before = imageChip("before");
  const after = imageChip("after");
  // Staged into the emptied tray, the pasted image was #1 of its own.
  const pasted = imageChip("pasted");
  assert.deepEqual(
    draftAfterSend({
      outcome: failedWith("compare [Image #1] with [Image #2]"),
      sent: [before, after],
      draft: { text: "then crop [Image #1], not [Image #7]", attachments: [pasted] }
    }),
    {
      // A number that names none of the staged images is the user's own, as typed.
      text: "compare [Image #1] with [Image #2]\n\nthen crop [Image #3], not [Image #7]",
      attachments: [before, after, pasted]
    }
  );

  // An image delivered again meanwhile IS the sent one: its placeholder follows it there.
  const pick = imageChip("pick", stagedAttachmentKeyForRef({ id: "att-pick" }));
  assert.deepEqual(
    draftAfterSend({
      outcome: failedWith("look at [Image #1] and [Image #2]"),
      sent: [before, pick],
      draft: { text: "[Image #1] is the one, then [Image #2]", attachments: [{ ...pick }, pasted] }
    }),
    {
      text: "look at [Image #1] and [Image #2]\n\n[Image #2] is the one, then [Image #3]",
      attachments: [before, pick, pasted]
    }
  );
  // So does one upload under another key: it is the same image.
  assert.deepEqual(
    draftAfterSend({
      outcome: failedWith("look at [Image #1] and [Image #2]"),
      sent: [before, pick],
      draft: { text: "[Image #1] is the one", attachments: [{ ...pick, key: "picked:pick-again" }] }
    }),
    { text: "look at [Image #1] and [Image #2]\n\n[Image #2] is the one", attachments: [before, pick] }
  );
});

test("a send that went out, a refusal and a failed Implement all leave the draft as it is", () => {
  const report = fileChip("report");
  // `submit` already cleared the draft; only what was typed since is in it.
  const typedSince = { text: "next question", attachments: [] as StagedAttachment[] };
  assert.equal(draftAfterSend({ outcome: { kind: "sent" }, sent: [report], draft: typedSince }), null);
  assert.equal(
    draftAfterSend({
      outcome: { kind: "refused", notice: "The full plan could not be loaded." },
      sent: [],
      draft: typedSince
    }),
    null
  );
  // Wave D1: Implement's prompt is the composer's, and it never carries a chip.
  assert.equal(draftAfterSend({ outcome: failedWith(null), sent: [], draft: typedSince }), null);
});
