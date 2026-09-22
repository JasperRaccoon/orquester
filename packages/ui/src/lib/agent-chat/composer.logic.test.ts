import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_TURN_INPUT_CHARS } from "@orquester/api/agent-chat";

import {
  attachmentRejectionReason,
  composerPromptLengthValidationMessage,
  composerSubmissionIntentForEnter,
  composerSubmissionValidationMessage,
  draftIsEmpty,
  insertIntoDraftAtCaret,
  nextPastedTextFileName,
  parsePersistedDrafts,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  pastedTextDisposition
} from "./composer.logic";

describe("composerSubmissionIntentForEnter", () => {
  const base = {
    isMobileViewport: false,
    shiftKey: false,
    modifierKey: false,
    isRunning: false
  };

  it("sends on Enter and inserts a newline on Shift+Enter", () => {
    assert.equal(composerSubmissionIntentForEnter(base), "foreground");
    assert.equal(composerSubmissionIntentForEnter({ ...base, shiftKey: true }), null);
  });

  it("NEVER sends below the narrow breakpoint", () => {
    assert.equal(composerSubmissionIntentForEnter({ ...base, isMobileViewport: true }), null);
  });

  it("inverts steer/queue for one message with mod+Enter during a turn", () => {
    assert.equal(
      composerSubmissionIntentForEnter({ ...base, modifierKey: true, isRunning: true }),
      "alternate"
    );
    assert.equal(composerSubmissionIntentForEnter({ ...base, modifierKey: true }), "foreground");
  });

  it("honours a mod-enter send shortcut", () => {
    assert.equal(composerSubmissionIntentForEnter({ ...base, sendShortcut: "mod-enter" }), null);
    assert.equal(
      composerSubmissionIntentForEnter({ ...base, sendShortcut: "mod-enter", modifierKey: true }),
      "foreground"
    );
  });
});

describe("prompt length validation", () => {
  it("measures the larger of the literal draft and its wire-expanded form", () => {
    const literal = "x".repeat(10);
    const expanded = "x".repeat(MAX_TURN_INPUT_CHARS + 5);
    assert.equal(composerPromptLengthValidationMessage(literal), null);
    assert.match(
      composerPromptLengthValidationMessage(literal, expanded) ?? "",
      /5 characters over/
    );
  });

  it("exempts an answer to a pending question — it is not a provider turn", () => {
    const tooLong = "x".repeat(MAX_TURN_INPUT_CHARS + 1);
    assert.equal(
      composerSubmissionValidationMessage({
        prompt: tooLong,
        submissionTarget: "pending-user-input"
      }),
      null
    );
    assert.notEqual(
      composerSubmissionValidationMessage({ prompt: tooLong, submissionTarget: "provider-turn" }),
      null
    );
  });

  it("refuses more than eight attachments", () => {
    const attachments = Array.from({ length: 9 }, (_, index) => ({
      type: "file" as const,
      id: `a${index}`,
      name: `a${index}`,
      sizeBytes: 1
    }));
    assert.match(
      composerSubmissionValidationMessage({
        prompt: "hi",
        submissionTarget: "provider-turn",
        attachments
      }) ?? "",
      /at most 8 attachments/
    );
  });
});

describe("attachment bounds", () => {
  it("refuses an unsupported image type and an oversized image", () => {
    assert.match(
      attachmentRejectionReason({ name: "a.bmp", type: "image/bmp", size: 10 }) ?? "",
      /GIF, JPEG, PNG and WebP/
    );
    assert.match(
      attachmentRejectionReason({ name: "a.png", type: "image/png", size: 11 * 1024 * 1024 }) ?? "",
      /image limit/
    );
    assert.equal(attachmentRejectionReason({ name: "a.png", type: "image/PNG", size: 10 }), null);
  });

  it("refuses an oversized file", () => {
    assert.match(
      attachmentRejectionReason({ name: "a.bin", size: 51 * 1024 * 1024 }) ?? "",
      /file limit/
    );
  });
});

describe("paste disposition", () => {
  it("folds a large paste into an attachment, counted in bytes as well as chars", () => {
    const long = "a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    assert.equal(pastedTextDisposition({ text: long, canAttach: true }), "attachment");
    // Unicode-heavy text is under the char threshold but over the byte one.
    const heavy = "🙂".repeat(9_000);
    assert.ok(heavy.length < PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    assert.equal(pastedTextDisposition({ text: heavy, canAttach: true }), "attachment");
  });

  it("keeps a small paste inline, and honours the escape hatch", () => {
    assert.equal(pastedTextDisposition({ text: "short", canAttach: true }), "inline");
    assert.equal(
      pastedTextDisposition({ text: "a".repeat(40_000), canAttach: true, bypassAutoAttachment: true }),
      "inline"
    );
    assert.equal(pastedTextDisposition({ text: "a".repeat(40_000), canAttach: false }), "inline");
  });

  it("names folded pastes stably", () => {
    assert.equal(nextPastedTextFileName([]), "pasted-text.txt");
    assert.equal(nextPastedTextFileName(["pasted-text.txt"]), "pasted-text-2.txt");
  });
});

describe("inserting external payloads", () => {
  it("writes into the draft at the caret rather than typing into a pane", () => {
    assert.deepEqual(insertIntoDraftAtCaret("", 0, "payload"), { text: "payload", cursor: 7 });
    assert.equal(insertIntoDraftAtCaret("ab", 2, "X").text, "ab\nX");
    assert.equal(insertIntoDraftAtCaret("ab", 1, "X").text, "a\nX\nb");
    assert.equal(insertIntoDraftAtCaret("a ", 2, "X").text, "a X");
  });
});

describe("persisted drafts", () => {
  it("survives garbage without letting it reach typed code", () => {
    assert.deepEqual(parsePersistedDrafts(null), {});
    assert.deepEqual(parsePersistedDrafts("not json"), {});
    assert.deepEqual(parsePersistedDrafts("[1,2]"), {});
    assert.deepEqual(parsePersistedDrafts(JSON.stringify({ s1: { text: 42 } })), {});
  });

  it("keeps the valid entries of a partly-malformed blob", () => {
    const parsed = parsePersistedDrafts(
      JSON.stringify({
        s1: { text: "hi", attachments: [{ type: "file", id: "a", name: "a", sizeBytes: 1 }, 7], context: "x" },
        s2: null
      })
    );
    assert.equal(parsed.s1?.text, "hi");
    assert.equal(parsed.s1?.attachments.length, 1);
    assert.deepEqual(parsed.s1?.context, []);
    assert.equal(parsed.s2, undefined);
  });

  it("knows an empty draft", () => {
    assert.equal(draftIsEmpty({ text: "  ", attachments: [], context: [] }), true);
    assert.equal(draftIsEmpty({ text: "x", attachments: [], context: [] }), false);
  });
});
