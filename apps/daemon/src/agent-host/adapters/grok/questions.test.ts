/**
 * `_x.ai/ask_user_question` answer mapping, against the shape recorded in
 * `07b-ask-user-question.ndjson`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { XaiAskUserQuestionParams } from "./acp/_generated/xai.ts";
import { OTHER_LABEL, answersToXaiResponse } from "./questions.ts";

/** Verbatim from the capture: note the question carries no `id`. */
const REAL: XaiAskUserQuestionParams = {
  sessionId: "01a0c1ff-cb2c-7322-9c33-ebbc9dad9133",
  toolCallId: "call-cc7ef02f-0141-40ad-824f-75c0e97f820d-0",
  questions: [
    {
      question: "Should the new file be named alpha.txt or beta.txt?",
      options: [
        { label: "alpha.txt", description: "Create the new file as alpha.txt" },
        { label: "beta.txt", description: "Create the new file as beta.txt" }
      ],
      multiSelect: null
    }
  ],
  mode: "default"
};

const TEXT = REAL.questions[0].question;

test("the envelope is keyed by question TEXT — the only key that can work here", () => {
  assert.deepEqual(answersToXaiResponse(REAL, { [TEXT]: "alpha.txt" }), {
    outcome: "accepted",
    answers: { [TEXT]: ["alpha.txt"] }
  });
});

test("an array of answers is accepted, trimmed, and blanks dropped", () => {
  assert.deepEqual(answersToXaiResponse(REAL, { [TEXT]: [" alpha.txt ", "", "beta.txt"] }).answers, {
    [TEXT]: ["alpha.txt", "beta.txt"]
  });
});

test("free text that matches no option becomes `Other` plus a note", () => {
  const response = answersToXaiResponse(REAL, { [TEXT]: "gamma.txt" });
  assert.deepEqual(response.answers, { [TEXT]: [OTHER_LABEL] });
  assert.deepEqual(response.annotations?.[TEXT], { notes: "gamma.txt" });
});

test("a mix of a known label and free text keeps the label and notes the text", () => {
  const response = answersToXaiResponse(REAL, { [TEXT]: ["alpha.txt", "or maybe gamma"] });
  assert.deepEqual(response.answers, { [TEXT]: ["alpha.txt"] });
  assert.equal(response.annotations?.[TEXT]?.notes, "or maybe gamma");
});

test("an unanswered question is dropped from the envelope", () => {
  assert.deepEqual(answersToXaiResponse(REAL, {}), { outcome: "accepted", answers: {} });
  assert.deepEqual(answersToXaiResponse(REAL, { [TEXT]: "   " }).answers, {});
});

test("annotations are omitted entirely when empty", () => {
  const response = answersToXaiResponse(REAL, { [TEXT]: "beta.txt" });
  assert.equal("annotations" in response, false);
});

test("an explicit question id is honoured, and the text still works as a fallback", () => {
  const withId: XaiAskUserQuestionParams = {
    ...REAL,
    questions: [{ ...REAL.questions[0], id: "q1" }]
  };
  assert.deepEqual(answersToXaiResponse(withId, { q1: "beta.txt" }).answers, { [TEXT]: ["beta.txt"] });
  assert.deepEqual(answersToXaiResponse(withId, { [TEXT]: "beta.txt" }).answers, { [TEXT]: ["beta.txt"] });
});

test("a preview rides as an annotation on a single-select question only", () => {
  const withPreview: XaiAskUserQuestionParams = {
    ...REAL,
    questions: [
      {
        question: TEXT,
        options: [{ label: "alpha.txt", preview: "creates alpha" }],
        multiSelect: null
      }
    ]
  };
  assert.equal(answersToXaiResponse(withPreview, { [TEXT]: "alpha.txt" }).annotations?.[TEXT]?.preview, "creates alpha");

  const multi: XaiAskUserQuestionParams = {
    ...withPreview,
    questions: [{ ...withPreview.questions[0], multiSelect: true }]
  };
  assert.equal(answersToXaiResponse(multi, { [TEXT]: "alpha.txt" }).annotations, undefined);
});
