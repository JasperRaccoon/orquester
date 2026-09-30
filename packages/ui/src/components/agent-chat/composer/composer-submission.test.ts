import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanImplementationPrompt } from "@orquester/api/agent-chat";

import {
  attachmentCountBlockSend,
  attachmentRejectionReason,
  composerPromptLengthValidationMessage,
  composerSubmissionIntentForEnter,
  composerStatusText,
  composerSubmissionValidationMessage,
  decideStagedAttachmentForRef,
  draftAfterSend,
  hasSendableContent,
  implementationTextResolver,
  isPasteAsTextShortcut,
  mergeMessageIntoDraft,
  pastedTextDisposition,
  planExternalSend,
  planExternalSubmit,
  resolveFollowUpDisposition,
  resolvePlanFollowUpSubmission,
  sendComposerTurn,
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

test("the prompt limit accepts 120000 characters and refuses the next", () => {
  assert.equal(composerPromptLengthValidationMessage("x".repeat(120_000)), null);
  assert.ok(composerPromptLengthValidationMessage("x".repeat(120_001)));
});

test("an answer to a pending question is exempt from the turn input bound", () => {
  const prompt = "x".repeat(120_010);
  assert.ok(composerSubmissionValidationMessage({ prompt, submissionTarget: "provider-turn" }));
  assert.equal(
    composerSubmissionValidationMessage({ prompt, submissionTarget: "pending-user-input" }),
    null
  );
});

test("a paste at or over 32 KiB becomes an attachment", () => {
  const big = "a".repeat(32 * 1024);
  assert.equal(pastedTextDisposition({ text: big, canAttach: true }), "attachment");
  assert.equal(
    pastedTextDisposition({ text: "a".repeat(100), canAttach: true }),
    "inline"
  );
});

test("the byte length folds a paste the character count would let through", () => {
  // Each emoji is 4 UTF-8 bytes but 2 UTF-16 code units.
  const text = "😀".repeat((32 * 1024) / 4);
  assert.ok(text.length < 32 * 1024);
  assert.equal(pastedTextDisposition({ text, canAttach: true }), "attachment");
});

test("a smaller paste still folds when it would blow the input limit", () => {
  assert.equal(
    pastedTextDisposition({ text: "small", canAttach: true, wouldExceedInputLimit: true }),
    "attachment"
  );
});

test("the escape hatch and a composer that cannot attach both keep the paste inline", () => {
  const big = "a".repeat(32 * 1024);
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

// ---------------------------------------------------------------------------
// Staging an already-uploaded reference (§7.4, §7.7)
// ---------------------------------------------------------------------------

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

test("a file coming back is never refused for the count, and every other bound still applies", () => {
  // A failed send's files, a returned queued message's, a rewound message's,
  // a persisted draft's: each was part of a message once, so the eight never
  // refuse it — the send gate holds the draft instead.
  const eight: StagedAttachmentLike[] = Array.from({ length: 8 }, (_, index) => ({
    key: `k${index}`,
    status: "ready" as const,
    ref: { id: `/tmp/${index}` }
  }));
  const back = { type: "file", id: "/tmp/back", name: "back.txt", mimeType: "text/plain", sizeBytes: 12 } as const;
  assert.equal(decideStagedAttachmentForRef({ existing: eight, ref: back }).kind, "rejected", "a new pick is refused at eight");
  assert.equal(decideStagedAttachmentForRef({ existing: eight, ref: back, enforceCount: false }).kind, "staged");
  assert.equal(
    decideStagedAttachmentForRef({
      existing: [...eight, { key: "picked:back", status: "ready", ref: { id: back.id } }],
      ref: back,
      enforceCount: false
    }).kind,
    "duplicate",
    "one chip per file still"
  );
  const huge = { ...back, id: "/tmp/huge", sizeBytes: 60 * 1024 * 1024 };
  assert.equal(decideStagedAttachmentForRef({ existing: [], ref: huge, enforceCount: false }).kind, "rejected");
  const vector = { type: "image", id: "/tmp/v.svg", name: "v.svg", mimeType: "image/svg+xml", sizeBytes: 12 } as const;
  assert.equal(decideStagedAttachmentForRef({ existing: [], ref: vector, enforceCount: false }).kind, "rejected");
});

test("the status line works the count out from the draft, so it follows every chip removed and goes once the draft fits", () => {
  const status = (count: number) => composerStatusText({ notice: "offline", attachments: Array(count).fill({}) });
  assert.notEqual(status(16), status(13), "warning updates after removing attachments");
  assert.equal(status(8), "offline");
  assert.ok(composerStatusText({ notice: null, attachments: Array(9).fill({}) }));
  assert.equal(composerStatusText({ notice: null, attachments: Array(8).fill({}) }), null);
});

test("a draft over eight attachments cannot be sent", () => {
  assert.equal(attachmentCountBlockSend([]), null);
  assert.equal(attachmentCountBlockSend(Array(8).fill({})), null);
  assert.ok(attachmentCountBlockSend(Array(9).fill({})));
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
// Goals §8.2 — a goal chip action goes through the composer's own send path
// ---------------------------------------------------------------------------

const ACTION = {
  text: "/goal pause",
  reverting: false,
  sending: false,
  hasPendingRequest: false,
  adapterId: "codex"
};

test("goals §8.2: a chip action is refused for exactly what refuses the composer's own send", () => {
  assert.equal(planExternalSend(ACTION).notice, null);
  for (const overrides of [
    { reverting: true }, { hasPendingRequest: true }, { sending: true },
    { adapterId: "grok", text: "/always-approve" },
    { text: "x".repeat(120_001) }, { text: "  " }
  ]) assert.ok(planExternalSend({ ...ACTION, ...overrides }).notice, JSON.stringify(overrides));
});

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------

test("fix round 1 (7): a typed host /goal is never queued — the host applies it at once", () => {
  for (const followUpBehavior of ["queue", "steer"] as const) {
    for (const intent of ["foreground", "alternate"] as const) {
      assert.equal(
        resolveFollowUpDisposition({ followUpBehavior, intent, isRunning: true, hostCommand: true }),
        "send",
        `${followUpBehavior}/${intent}`
      );
    }
  }
  assert.equal(
    resolveFollowUpDisposition({ followUpBehavior: "queue", intent: "foreground", isRunning: true }),
    "queue",
    "every other message still follows the preference"
  );
  assert.equal(
    resolveFollowUpDisposition({
      followUpBehavior: "queue",
      intent: "foreground",
      isRunning: true,
      hostCommand: false
    }),
    "queue"
  );
});

// ---------------------------------------------------------------------------
// Final fix wave
// ---------------------------------------------------------------------------

test("final wave (4): an open card never holds back a goal command the HOST applies", () => {
  // Pause and Clear are exactly what a user wants while an approval waits, and
  // the host needs no such guard: it applies them without starting a turn.
  const card = { ...ACTION, text: "  /goal pause  ", hasPendingRequest: true, hostParsesGoal: true };
  assert.equal(planExternalSend(card).notice, null);
  assert.deepEqual(planExternalSend(card), { text: "/goal pause", notice: null });
  assert.equal(planExternalSend({ ...card, text: "/goal clear" }).notice, null);
});

test("final wave (4): everything else still waits for the card", () => {
  const card = { ...ACTION, hasPendingRequest: true };
  assert.ok(planExternalSend({ ...card, hostParsesGoal: false }).notice);
  assert.ok(planExternalSend({ ...card, hostParsesGoal: undefined }).notice);
  assert.ok(planExternalSend({ ...card, hostParsesGoal: true, text: "Continue working toward the goal." }).notice);
  assert.ok(planExternalSend({ ...card, hostParsesGoal: true, reverting: true }).notice);
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
  assert.equal(bare.kind, "refused");
  assert.ok("notice" in bare && bare.notice.length > 0);
  assert.deepEqual(wire.sent, []);
});

test("a read-back prompt over the turn bound is refused before it is sent, and nothing goes back to the draft", async () => {
  const whole = buildPlanImplementationPrompt(`# Ship it\n\n${"step ".repeat(120_000 / 5)}`);
  // The composer measured the CUT prompt, which fits; only the whole one is over.
  assert.equal(composerPromptLengthValidationMessage(CUT_PROMPT), null);
  assert.ok(whole.length > 120_000);
  const wire = recordingSend();
  const outcome = await sendComposerTurn({ text: CUT_PROMPT, resolveText: async () => whole, send: wire.send });
  // `refused` carries no text: only a FAILED send is written back into the
  // draft, so the whole prompt never lands in the composer.
  assert.equal(outcome.kind, "refused");
  assert.ok("notice" in outcome && outcome.notice.length > 0);
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

test("send ownership marks only generated prompts to stay out of the draft after reload", async () => {
  const sent: Array<{ text: string; generatedPrompt: boolean }> = [];
  const send = async (text: string, options: { generatedPrompt: boolean }): Promise<void> => {
    sent.push({ text, ...options });
  };
  const whole = buildPlanImplementationPrompt("# Ship it\n\nevery step");
  await sendComposerTurn({ text: "fix the tests", send });
  await sendComposerTurn({ text: CUT_PROMPT, resolveText: async () => whole, send });
  await sendComposerTurn({ text: "/goal pause", returnToDraftOnFailure: false, send });
  assert.deepEqual(sent, [
    { text: "fix the tests", generatedPrompt: false },
    { text: whole, generatedPrompt: true },
    { text: "/goal pause", generatedPrompt: true }
  ]);
});

test("every Implement reads its plan at send time, intact or cut, and no other send does", async () => {
  const reads: string[] = [];
  const read = async (plan: { id: string; planMarkdown: string }) => {
    reads.push(plan.id);
    return "# Complete plan\n\nRead-back-only step";
  };
  const intact = { id: "p-intact", planMarkdown: "# Ship it\n\nevery step" };
  const resolveText = implementationTextResolver({ action: "implement", proposal: intact, read });
  assert.ok(resolveText, "an intact plan's Implement resolves its prompt too, not only a cut one's");
  assert.deepEqual(reads, [], "nothing is read before the send step runs");
  const resolved = await resolveText();
  assert.ok(resolved.includes("# Complete plan\n\nRead-back-only step"));
  assert.ok(!resolved.includes(intact.planMarkdown));
  assert.deepEqual(reads, ["p-intact"]);

  // A Refine sends the user's own text, and a plain send has no plan at all.
  assert.equal(implementationTextResolver({ action: "refine", proposal: intact, read }), undefined);
  assert.equal(implementationTextResolver({ action: null, proposal: null, read }), undefined);
  assert.deepEqual(reads, ["p-intact"]);
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

test("what was typed or staged while it was in flight stays, behind it, and no chip is doubled", () => {
  const report = fileChip("report");
  // Delivering the same browser pick again must not duplicate its file.
  const pick = fileChip("pick", "text/html", "picked:delivered-again");
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
  const pick = imageChip("pick", "picked:delivered-again");
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

// ---------------------------------------------------------------------------
// A message coming back BEHIND the draft: the same merge, the other way round
// ---------------------------------------------------------------------------

test("a message returned behind the draft keeps naming its own images, never the draft's", () => {
  // A queued message returned (or a Stop's drain, or a rewind) into a draft
  // that already holds an image of its own: its `[Image #1]` named ITS first
  // image, which now sits second.
  const own = imageChip("own");
  const queued = imageChip("queued");
  assert.deepEqual(
    mergeMessageIntoDraft({
      draft: { text: "[Image #1] is mine", attachments: [own] },
      message: { text: "queued: look at [Image #1]", attachments: [queued] },
      at: "back"
    }),
    { text: "[Image #1] is mine\n\nqueued: look at [Image #2]", attachments: [own, queued] }
  );

  // A returned image the draft already holds IS that chip: its placeholder
  // follows it there, and no chip is doubled.
  const pick = imageChip("pick");
  const other = imageChip("other");
  assert.deepEqual(
    mergeMessageIntoDraft({
      draft: { text: "", attachments: [own, pick] },
      message: {
        text: "[Image #1] then [Image #2], not [Image #9]",
        attachments: [{ ...pick, key: "ref:att-pick" }, other]
      },
      at: "back"
    }),
    { text: "[Image #2] then [Image #3], not [Image #9]", attachments: [own, pick, other] }
  );
});

test("a returned message joins the draft's text with one blank line, and no blank lines when either side is empty", () => {
  const report = fileChip("report");
  assert.deepEqual(
    mergeMessageIntoDraft({
      draft: { text: "typed since  \n", attachments: [] },
      message: { text: "the queued one", attachments: [] },
      at: "back"
    }),
    { text: "typed since\n\nthe queued one", attachments: [] }
  );
  assert.deepEqual(
    mergeMessageIntoDraft({
      draft: { text: "typed since", attachments: [] },
      message: { text: "", attachments: [report] },
      at: "back"
    }),
    { text: "typed since", attachments: [report] },
    "a message of files alone brings no blank lines"
  );
  assert.deepEqual(
    mergeMessageIntoDraft({
      draft: { text: "  ", attachments: [] },
      message: { text: "the queued one", attachments: [] },
      at: "back"
    }),
    { text: "the queued one", attachments: [] }
  );
});

test("a failed send comes back ahead of the draft exactly as it was sent, the draft's own images renumbered behind it", () => {
  // The merge in front: the restored text is kept as it was — trailing
  // whitespace included — and only the draft behind it moves.
  const before = imageChip("before");
  const pasted = imageChip("pasted");
  assert.deepEqual(
    draftAfterSend({
      outcome: failedWith("compare [Image #1]  "),
      sent: [before],
      draft: { text: "then crop [Image #1]", attachments: [pasted] }
    }),
    { text: "compare [Image #1]  \n\nthen crop [Image #2]", attachments: [before, pasted] }
  );
});

// ---------------------------------------------------------------------------
// Where it comes back: the thread it was sent FROM (§7.4)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Goals §8.2 × §7.4: a goal chip action that fails leaves the draft alone
// ---------------------------------------------------------------------------

test("goals §8.2: a failed goal chip action says why and writes nothing back into any draft", async () => {
  const refusing = recordingSend(new Error("The agent host is restarting."));
  const outcome = await sendComposerTurn({
    text: "/goal pause",
    returnToDraftOnFailure: false,
    send: refusing.send
  });
  assert.deepEqual(outcome, { kind: "failed", text: null, notice: "The agent host is restarting." });
  assert.deepEqual(refusing.sent, ["/goal pause"], "it did go out, and the host refused it");
});

// ---------------------------------------------------------------------------
// The right rail's Send — exactly what Enter does with that text as the draft
// ---------------------------------------------------------------------------

const RAIL = {
  text: "Review the current changes",
  reverting: false,
  sending: false,
  hasPendingRequest: false,
  adapterId: "claude",
  hostParsesGoal: false,
  showPlanModeToggle: true,
  followUpBehavior: "steer" as const,
  isTurnActive: false,
  lastQueued: null,
  now: 10_000
};

test("the rail's Send measures the TRIMMED text against the length bound, as Enter does", () => {
  const padded = `${"x".repeat(120_000)}${" ".repeat(50)}`;
  assert.equal(planExternalSubmit({ ...RAIL, text: padded }).kind, "send");
});

test("the rail's Send: a double click's twin is not queued twice", () => {
  const queued = { ...RAIL, isTurnActive: true, followUpBehavior: "queue" as const };
  const first = { text: RAIL.text, at: 10_000 };
  assert.equal(planExternalSubmit({ ...queued, lastQueued: first, now: 10_400 }).kind, "refuse");
  // Past the window, or another text: queued.
  assert.equal(
    planExternalSubmit({ ...queued, lastQueued: first, now: 10_000 + 1000 }).kind,
    "queue"
  );
  assert.equal(planExternalSubmit({ ...queued, text: "another", lastQueued: first, now: 10_100 }).kind, "queue");
  // A steer is guarded by the send in flight, not by this window.
  assert.equal(
    planExternalSubmit({ ...queued, followUpBehavior: "steer", lastQueued: first, now: 10_100 }).kind,
    "send"
  );
});
