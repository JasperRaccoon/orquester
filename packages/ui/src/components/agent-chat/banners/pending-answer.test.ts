import test from "node:test";
import assert from "node:assert/strict";
import type { UserInputQuestion } from "@orquester/api/agent-chat";

import {
  allowsAnswerAttachments,
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  questionAttachmentKey,
  questionOptionValue,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingAnswerDraft
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

test("an option with no value answers with its label", () => {
  assert.equal(questionOptionValue({ label: "main", description: "" }), "main");
  assert.equal(questionOptionValue({ label: "develop", description: "", value: "dev" }), "dev");
  assert.equal(
    resolvePendingUserInputAnswer(question(), { selectedOptionValues: ["main"] }),
    "main"
  );
});

test("a custom answer beats a selected option", () => {
  const draft: PendingAnswerDraft = { selectedOptionValues: ["main"], customAnswer: "  feature/x " };
  assert.equal(resolvePendingUserInputAnswer(question(), draft), "feature/x");
});

test("a custom answer is refused when the question forbids one", () => {
  const q = question({ allowCustomAnswer: false });
  assert.equal(resolvePendingUserInputAnswer(q, { customAnswer: "anything" }), null);
});

test("multi-select answers with an array and drops unknown values", () => {
  const q = question({ multiSelect: true });
  assert.deepEqual(
    resolvePendingUserInputAnswer(q, { selectedOptionValues: ["main", "ghost", "dev"] }),
    ["main", "dev"]
  );
});

test("an attachment alone satisfies a question", () => {
  assert.equal(resolvePendingUserInputAnswer(question(), { attachmentCount: 1 }), "");
  assert.equal(
    resolvePendingUserInputAnswer(question({ multiSelect: true }), { attachmentCount: 2 }),
    ""
  );
});

test("an unfinished upload keeps the answer unresolved", () => {
  assert.equal(
    resolvePendingUserInputAnswer(question(), {
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
  assert.equal(resolvePendingUserInputAnswer(q, { selectedOptionValues: ["Other…"] }), null);
  assert.equal(
    resolvePendingUserInputAnswer(q, { selectedOptionValues: ["Other…"], customAnswer: "feature" }),
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
  assert.deepEqual(first, { customAnswer: "", selectedOptionValues: ["main"] });
  const second = togglePendingUserInputOptionSelection(multi, first, "dev");
  assert.deepEqual(second.selectedOptionValues, ["main", "dev"]);
  const third = togglePendingUserInputOptionSelection(multi, second, "main");
  assert.deepEqual(third.selectedOptionValues, ["dev"]);
});

test("single-select replaces the selection rather than adding to it", () => {
  const single = question();
  const first = togglePendingUserInputOptionSelection(single, undefined, "main");
  const second = togglePendingUserInputOptionSelection(single, first, "dev");
  assert.deepEqual(second.selectedOptionValues, ["dev"]);
});

test("typing clears a selection only once there is text to prefer", () => {
  const withSelection: PendingAnswerDraft = { selectedOptionValues: ["main"] };
  assert.deepEqual(setPendingUserInputCustomAnswer(withSelection, "x"), { customAnswer: "x" });
  assert.deepEqual(setPendingUserInputCustomAnswer(withSelection, ""), {
    customAnswer: "",
    selectedOptionValues: ["main"]
  });
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
