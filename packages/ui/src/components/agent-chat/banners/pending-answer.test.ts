import test from "node:test";
import assert from "node:assert/strict";
import type { UserInputQuestion } from "@orquester/api/agent-chat";

import {
  allowsAnswerAttachments,
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  questionAttachmentKey,
  questionShortcutOption,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingAnswerDraft,
  type QuestionShortcutInput
} from "./pending-answer.ts";

function question(overrides: Partial<UserInputQuestion> = {}): UserInputQuestion {
  return {
    id: "Which branch?",
    header: "Branch",
    question: "Which branch should I use?",
    options: [
      { label: "main", description: "the default branch" },
      { label: "develop", description: "the integration branch", value: "dev" }
    ],
    ...overrides
  };
}

// Observe the same submitted map the question card sends to the provider.
function submittedAnswer(q: UserInputQuestion, draft: PendingAnswerDraft | undefined): string | string[] | null {
  return buildPendingUserInputAnswers([q], { [q.id]: draft ?? {} })?.[q.id] ?? null;
}

test("an option with no value answers with its label", () => {
  assert.equal(
    submittedAnswer(question(), { selectedOptionValues: ["main"] }),
    "main"
  );
  assert.equal(submittedAnswer(question(), { selectedOptionValues: ["dev"] }), "dev");
});

test("a custom answer beats a selected option", () => {
  const draft: PendingAnswerDraft = { selectedOptionValues: ["main"], customAnswer: "  feature/x " };
  assert.equal(submittedAnswer(question(), draft), "feature/x");
});

test("a custom answer is refused when the question forbids one", () => {
  const q = question({ allowCustomAnswer: false });
  assert.equal(submittedAnswer(q, { customAnswer: "anything" }), null);
});

test("multi-select answers with an array and drops unknown values", () => {
  const q = question({ multiSelect: true });
  assert.deepEqual(
    submittedAnswer(q, { selectedOptionValues: ["main", "ghost", "dev"] }),
    ["main", "dev"]
  );
});

test("an attachment alone satisfies a question", () => {
  assert.equal(submittedAnswer(question(), { attachmentCount: 1 }), "");
  assert.equal(
    submittedAnswer(question({ multiSelect: true }), { attachmentCount: 2 }),
    ""
  );
});

test("an unfinished upload keeps the answer unresolved", () => {
  assert.equal(
    submittedAnswer(question(), {
      selectedOptionValues: ["main"],
      attachmentsBlocked: true
    }),
    null
  );
});

test("a choice-only question offers no attachments", () => {
  assert.equal(allowsAnswerAttachments(question()), true);
  assert.equal(allowsAnswerAttachments(question({ allowCustomAnswer: false })), false);
});

test("an `isOther` option asks for text rather than answering with its label", () => {
  const q = question({
    allowCustomAnswer: false,
    options: [
      { label: "main", description: "" },
      { label: "Other…", description: "", ...{ isOther: true } }
    ]
  });
  // `isOther` re-enables the custom field even though allowCustomAnswer is false.
  assert.equal(allowsAnswerAttachments(q), true);
  assert.equal(submittedAnswer(q, { selectedOptionValues: ["Other…"] }), null);
  assert.equal(
    submittedAnswer(q, { selectedOptionValues: ["Other…"], customAnswer: "feature" }),
    "feature"
  );
});

test("a secret answer is never carried back into the thread draft", () => {
  assert.equal(carryDisplacedCustomAnswerIntoPrompt("draft", "hunter2", { isSecret: true }), "draft");
});

test("displaced text lands after whatever was already in the draft", () => {
  assert.equal(carryDisplacedCustomAnswerIntoPrompt("keep this ", " typed "), "keep this\n\ntyped");
  assert.equal(carryDisplacedCustomAnswerIntoPrompt("   ", "typed"), "typed");
  assert.equal(carryDisplacedCustomAnswerIntoPrompt("keep", "   "), "keep");
});

test("toggling clears the custom answer; multi-select toggles in place", () => {
  const multi = question({ multiSelect: true });
  const first = togglePendingUserInputOptionSelection(multi, { customAnswer: "typed" }, "main");
  assert.deepEqual(submittedAnswer(multi, first), ["main"]);
  const second = togglePendingUserInputOptionSelection(multi, first, "dev");
  assert.deepEqual(submittedAnswer(multi, second), ["main", "dev"]);
  const third = togglePendingUserInputOptionSelection(multi, second, "main");
  assert.deepEqual(submittedAnswer(multi, third), ["dev"]);
});

test("a new single-select choice becomes the submitted answer", () => {
  const single = question();
  const first = togglePendingUserInputOptionSelection(single, undefined, "main");
  const second = togglePendingUserInputOptionSelection(single, first, "dev");
  assert.equal(submittedAnswer(single, second), "dev");
});

test("custom text overrides a choice while empty text preserves it", () => {
  const withSelection: PendingAnswerDraft = { selectedOptionValues: ["main"] };
  const typed = setPendingUserInputCustomAnswer(withSelection, "x");
  assert.equal(submittedAnswer(question(), typed), "x");
  assert.equal(submittedAnswer(question(), setPendingUserInputCustomAnswer(withSelection, "")), "main");
  assert.equal(submittedAnswer(question(), setPendingUserInputCustomAnswer(typed, "")), null,
    "clearing custom text must not resurrect the previously selected option");
});

test("the answers map is null until every question resolves", () => {
  const questions = [question({ id: "a" }), question({ id: "b" })];
  assert.equal(buildPendingUserInputAnswers(questions, { a: { selectedOptionValues: ["main"] } }), null);
  assert.deepEqual(
    buildPendingUserInputAnswers(questions, {
      a: { selectedOptionValues: ["main"] },
      b: { customAnswer: "dev" }
    }),
    { a: "main", b: "dev" }
  );
});

test("progress reports the active question, the count and completeness", () => {
  const questions = [question({ id: "a" }), question({ id: "b" })];
  const progress = derivePendingUserInputProgress(
    questions,
    { a: { selectedOptionValues: ["main"] } },
    1
  );
  assert.equal(progress.activeQuestion?.id, "b");
  assert.equal(progress.answeredQuestionCount, 1);
  assert.equal(progress.isLastQuestion, true);
  assert.equal(progress.isComplete, false);
  assert.equal(progress.canAdvance, false);
});

test("an out-of-range question index is clamped, never thrown on", () => {
  const questions = [question({ id: "a" })];
  assert.equal(derivePendingUserInputProgress(questions, {}, 9).questionIndex, 0);
  assert.equal(derivePendingUserInputProgress(questions, {}, -3).questionIndex, 0);
  assert.equal(derivePendingUserInputProgress([], {}, 4).activeQuestion, null);
});

test("attachment drafts are namespaced per (requestId, questionId)", () => {
  assert.notEqual(questionAttachmentKey("r1", "q1"), questionAttachmentKey("r1", "q2"));
  // The separator cannot be forged out of a request id.
  assert.notEqual(questionAttachmentKey("a:b", "c"), questionAttachmentKey("a", "b:c"));
});

// ---------------------------------------------------------------------------
// The 1–9 shortcut (§7.5)
// ---------------------------------------------------------------------------

/** A `2` pressed on the visible tab, focus on no field, a three-option question. */
const digitPress: QuestionShortcutInput = {
  key: "2",
  modified: false,
  tabActive: true,
  layerOpen: false,
  typing: false,
  optionCount: 3
};

test("a digit picks its option on the visible tab", () => {
  assert.equal(questionShortcutOption({ ...digitPress, key: "1" }), 0);
  assert.equal(questionShortcutOption(digitPress), 1);
  assert.equal(questionShortcutOption({ ...digitPress, key: "3" }), 2);
  assert.equal(questionShortcutOption({ ...digitPress, key: "9", optionCount: 9 }), 8);
});

test("an open layer keeps the digit: it never answers the question behind a modal, a menu or a popover", () => {
  // The output viewer, Settings, a dropdown, a composer popover: focus sits on
  // a button in the layer, and a digit typed there answered the question under
  // it — and an answer cannot be taken back. The layer set is the chat's one
  // (`anotherLayerOwnsTheKeyboard`), the same the Escape handlers read.
  for (const key of ["1", "2", "3"]) {
    assert.equal(questionShortcutOption({ ...digitPress, key, layerOpen: true }), null, key);
  }
});

test("a digit never answers from a hidden tab, while typing, or under a modifier", () => {
  // Every open chat tab keeps its card mounted (Q2-2); a digit typed into a
  // field is text; Ctrl/Cmd/Alt+digit is somebody else's chord.
  assert.equal(questionShortcutOption({ ...digitPress, tabActive: false }), null);
  assert.equal(questionShortcutOption({ ...digitPress, typing: true }), null);
  assert.equal(questionShortcutOption({ ...digitPress, modified: true }), null);
});

test("only 1–9, and only an option the question has", () => {
  for (const key of ["0", "a", "Enter", "F1", ""]) {
    assert.equal(questionShortcutOption({ ...digitPress, key }), null, JSON.stringify(key));
  }
  assert.equal(questionShortcutOption({ ...digitPress, key: "4" }), null);
  assert.equal(questionShortcutOption({ ...digitPress, optionCount: 0 }), null);
});
