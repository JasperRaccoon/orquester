import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UserInputQuestion } from "@orquester/api/agent-chat";

import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  countQuestionAttachments,
  derivePendingUserInputProgress,
  questionAcceptsAttachments,
  questionAnswerBlockedByUploads,
  questionAttachmentDraftId,
  remainingQuestionAttachmentSlots,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection
} from "./questions.logic";

const question = (overrides: Partial<UserInputQuestion> = {}): UserInputQuestion => ({
  id: "q1",
  header: "Pick one",
  question: "Which?",
  options: [
    { label: "Alpha", description: "" },
    { label: "Beta", description: "", value: "beta" }
  ],
  ...overrides
});

describe("resolvePendingUserInputAnswer", () => {
  it("lets a non-empty custom answer beat selected options", () => {
    const answer = resolvePendingUserInputAnswer(question(), {
      selectedOptionValues: ["Alpha"],
      customAnswer: "  something else  "
    });
    assert.equal(answer, "something else");
  });

  it("falls back to the selection when the custom answer is blank", () => {
    assert.equal(
      resolvePendingUserInputAnswer(question(), {
        selectedOptionValues: ["beta"],
        customAnswer: "   "
      }),
      "beta"
    );
  });

  it("ignores a custom answer the question does not allow", () => {
    assert.equal(
      resolvePendingUserInputAnswer(question({ allowCustomAnswer: false }), {
        customAnswer: "typed"
      }),
      null
    );
  });

  it("drops a selection the question does not offer", () => {
    assert.equal(resolvePendingUserInputAnswer(question(), { selectedOptionValues: ["ghost"] }), null);
  });

  it("returns an array for a multi-select question", () => {
    assert.deepEqual(
      resolvePendingUserInputAnswer(question({ multiSelect: true }), {
        selectedOptionValues: ["Alpha", "beta"]
      }),
      ["Alpha", "beta"]
    );
  });

  it("lets an attachment alone satisfy a question", () => {
    assert.equal(resolvePendingUserInputAnswer(question(), { attachmentCount: 1 }), "");
    assert.deepEqual(
      resolvePendingUserInputAnswer(question({ multiSelect: true }), { attachmentCount: 2 }),
      ""
    );
  });

  it("is unanswerable while an upload is still running", () => {
    assert.equal(
      resolvePendingUserInputAnswer(question(), {
        selectedOptionValues: ["Alpha"],
        attachmentsBlocked: true
      }),
      null
    );
  });
});

describe("displaced custom answers", () => {
  it("carries typed text back into the draft after whatever was waiting", () => {
    assert.equal(carryDisplacedCustomAnswerIntoPrompt("hello", "typed"), "hello\n\ntyped");
    assert.equal(carryDisplacedCustomAnswerIntoPrompt("   ", "typed"), "typed");
    assert.equal(carryDisplacedCustomAnswerIntoPrompt("hello", "   "), "hello");
    assert.equal(carryDisplacedCustomAnswerIntoPrompt("hello", undefined), "hello");
  });

  it("clicking an option clears the custom answer", () => {
    const next = togglePendingUserInputOptionSelection(question(), { customAnswer: "typed" }, "Alpha");
    assert.equal(next.customAnswer, "");
    assert.deepEqual(next.selectedOptionValues, ["Alpha"]);
  });

  it("multi-select toggles in place", () => {
    const first = togglePendingUserInputOptionSelection(question({ multiSelect: true }), undefined, "Alpha");
    const second = togglePendingUserInputOptionSelection(
      question({ multiSelect: true }),
      first,
      "beta"
    );
    assert.deepEqual(second.selectedOptionValues, ["Alpha", "beta"]);
    const third = togglePendingUserInputOptionSelection(
      question({ multiSelect: true }),
      second,
      "Alpha"
    );
    assert.deepEqual(third.selectedOptionValues, ["beta"]);
  });

  it("typing clears the selection", () => {
    const next = setPendingUserInputCustomAnswer({ selectedOptionValues: ["Alpha"] }, "typed");
    assert.equal(next.selectedOptionValues, undefined);
  });
});

describe("progress", () => {
  it("counts answered questions and clamps the index", () => {
    const questions = [question({ id: "q1" }), question({ id: "q2" })];
    const progress = derivePendingUserInputProgress(
      questions,
      { q1: { selectedOptionValues: ["Alpha"] } },
      99
    );
    assert.equal(progress.questionIndex, 1);
    assert.equal(progress.activeQuestion?.id, "q2");
    assert.equal(progress.answeredQuestionCount, 1);
    assert.equal(progress.isLastQuestion, true);
    assert.equal(progress.isComplete, false);
    assert.equal(progress.canAdvance, false);
  });

  it("is complete only when every question resolves", () => {
    const questions = [question({ id: "q1" }), question({ id: "q2" })];
    const answers = {
      q1: { selectedOptionValues: ["Alpha"] },
      q2: { customAnswer: "yes" }
    };
    assert.deepEqual(buildPendingUserInputAnswers(questions, answers), {
      q1: "Alpha",
      q2: "yes"
    });
    assert.equal(derivePendingUserInputProgress(questions, answers, 0).isComplete, true);
  });

  it("returns null for a partial answer set", () => {
    assert.equal(buildPendingUserInputAnswers([question()], {}), null);
  });
});

describe("attachment drafts", () => {
  it("keys a draft by (requestId, questionId) so questions never mix", () => {
    const a = questionAttachmentDraftId("s1", "r1", "q1");
    const b = questionAttachmentDraftId("s1", "r1", "q2");
    const c = questionAttachmentDraftId("s1", "r2", "q1");
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it("counts staged files AND in-flight preparation against the budget", () => {
    const input = { staged: { k1: 3 }, preparing: { k1: 2 }, keys: ["k1"] };
    assert.equal(countQuestionAttachments(input), 5);
    assert.equal(remainingQuestionAttachmentSlots(input), 3);
  });

  it("blocks the answer while an upload is in flight", () => {
    assert.equal(questionAnswerBlockedByUploads({ preparing: { k1: 1 }, keys: ["k1"] }), true);
    assert.equal(questionAnswerBlockedByUploads({ preparing: {}, keys: ["k1"] }), false);
  });

  it("offers no attachments on a predefined-choices-only question", () => {
    assert.equal(questionAcceptsAttachments(question({ allowCustomAnswer: false })), false);
    assert.equal(questionAcceptsAttachments(question()), true);
  });
});
