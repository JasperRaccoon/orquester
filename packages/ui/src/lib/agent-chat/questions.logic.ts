/**
 * Agent chat — question progress, answer resolution and per-question
 * attachment drafts (spec §7.5).
 *
 * Ported from T3 Code (MIT): `apps/web/src/pendingUserInput.ts` and
 * `apps/web/src/questionAttachments.ts`.
 *
 * The rules that are easy to get wrong and are therefore encoded here:
 * - a non-empty **custom answer beats selected options**, and an attachment
 *   alone satisfies a question (the answer is then the empty string);
 * - any draft text **displaced** by clicking an option is carried back into the
 *   thread draft, after whatever was already waiting there — clicking an option
 *   must never silently discard a typed custom answer;
 * - answer attachments live in their own namespace keyed by
 *   `(requestId, questionId)`, so moving between questions keeps each one's
 *   files and never mixes them into the next turn;
 * - staged files **and in-flight preparations** both count against the
 *   eight-attachment budget.
 *
 * No React import.
 */

import { MAX_TURN_ATTACHMENTS, type UserInputQuestion } from "@orquester/api/agent-chat";

export interface PendingUserInputDraftAnswer {
  selectedOptionValues?: string[];
  customAnswer?: string;
  attachmentCount?: number;
  /** True while an upload for this question has not finished (§7.5). */
  attachmentsBlocked?: boolean;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionValues: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionValues(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  // Provider option ids must stay unchanged, including whitespace.
  return [...new Set(value.filter((entry) => typeof entry === "string"))];
}

/** *T3: `pendingUserInput.ts:42-68`.* */
export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined
): string | string[] | null {
  if (draft?.attachmentsBlocked) {
    return null;
  }
  const customAnswer =
    question.allowCustomAnswer === false ? null : normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }
  const selected = normalizeSelectedOptionValues(draft?.selectedOptionValues).filter((value) =>
    question.options.some((option) => (option.value ?? option.label) === value)
  );
  const attachmentsAlone =
    question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null;
  if (question.multiSelect) {
    return selected.length > 0 ? selected : attachmentsAlone;
  }
  return selected[0] ?? attachmentsAlone;
}

/** Typing a custom answer clears the selection. *T3: `pendingUserInput.ts:70-82`.* */
export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string
): PendingUserInputDraftAnswer {
  const selected =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionValues(draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(selected && selected.length > 0 ? { selectedOptionValues: selected } : {})
  };
}

const DISPLACED_ANSWER_SEPARATOR = "\n\n";

/**
 * Selecting an option replaces the custom answer, because a non-empty custom
 * answer outranks selected options. Text the user typed must not vanish on
 * that click: it moves back into the thread draft, after whatever was already
 * waiting there.
 *
 * *T3: `pendingUserInput.ts:87-105`.*
 */
export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined
): string {
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0) {
    return prompt;
  }
  if (prompt.trim().length === 0) {
    return displaced;
  }
  return `${prompt.trimEnd()}${DISPLACED_ANSWER_SEPARATOR}${displaced}`;
}

/** *T3: `pendingUserInput.ts:107-127`.* */
export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selected = normalizeSelectedOptionValues(draft?.selectedOptionValues);
    const next = selected.includes(optionValue)
      ? selected.filter((value) => value !== optionValue)
      : [...selected, optionValue];
    return {
      customAnswer: "",
      ...(next.length > 0 ? { selectedOptionValues: next } : {})
    };
  }
  return { customAnswer: "", selectedOptionValues: [optionValue] };
}

/** Null until every question resolves. *T3: `pendingUserInput.ts:129-144`.* */
export function buildPendingUserInputAnswers(
  questions: readonly UserInputQuestion[],
  draftAnswers: Record<string, PendingUserInputDraftAnswer>
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    answers[question.id] = answer;
  }
  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: readonly UserInputQuestion[],
  draftAnswers: Record<string, PendingUserInputDraftAnswer>
): number {
  return questions.reduce(
    (count, question) =>
      resolvePendingUserInputAnswer(question, draftAnswers[question.id]) !== null
        ? count + 1
        : count,
    0
  );
}

/** *T3: `pendingUserInput.ts:160-191`.* */
export function derivePendingUserInputProgress(
  questions: readonly UserInputQuestion[],
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number
): PendingUserInputProgress {
  const normalizedIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer =
    activeQuestion?.allowCustomAnswer === false ? "" : (activeDraft?.customAnswer ?? "");
  return {
    questionIndex: normalizedIndex,
    activeQuestion,
    activeDraft,
    selectedOptionValues: normalizeSelectedOptionValues(activeDraft?.selectedOptionValues),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount: countAnsweredPendingUserInputQuestions(questions, draftAnswers),
    isLastQuestion: questions.length === 0 ? true : normalizedIndex >= questions.length - 1,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: resolvedAnswer !== null
  };
}

/**
 * A question offering only predefined choices offers no attachments at all
 * (§7.5) — the answer cannot carry one, so the affordance would lie.
 */
export function questionAcceptsAttachments(question: UserInputQuestion): boolean {
  return question.allowCustomAnswer !== false;
}

// ---------------------------------------------------------------------------
// Per-question attachment drafts (§7.5)
// ---------------------------------------------------------------------------

/**
 * The draft namespace for one question's attachments. Keyed by
 * `(requestId, questionId)` so moving between questions keeps each one's files
 * and never mixes them into the next turn.
 *
 * *T3: `questionAttachments.ts:13-22`; differs: T3 scopes by
 * `(environmentId, threadId)` as well because one client serves many
 * environments — here a thread IS the session id, so that is the whole scope.*
 */
export function questionAttachmentDraftId(
  sessionId: string,
  requestId: string,
  questionId: string
): string {
  return `question:${encodeURIComponent(sessionId)}:${encodeURIComponent(
    JSON.stringify([requestId, questionId])
  )}`;
}

/** Every draft key belonging to one request, for a bulk clear after the answer. */
export function questionAttachmentDraftPrefix(sessionId: string, requestId: string): string {
  return `question:${encodeURIComponent(sessionId)}:${encodeURIComponent(
    JSON.stringify([requestId, ""])
  ).slice(0, -1)}`;
}

/**
 * **Count both staged files and in-flight preparation** against the shared
 * question limit (§7.5): a second drop while the first upload is still running
 * must not be able to exceed the cap.
 *
 * *T3: `questionAttachments.ts:28-36`.*
 */
export function countQuestionAttachments(input: {
  staged: Record<string, number>;
  preparing: Record<string, number>;
  keys: readonly string[];
}): number {
  return input.keys.reduce(
    (total, key) => total + (input.staged[key] ?? 0) + (input.preparing[key] ?? 0),
    0
  );
}

/** How many more attachments this question may still take. */
export function remainingQuestionAttachmentSlots(input: {
  staged: Record<string, number>;
  preparing: Record<string, number>;
  keys: readonly string[];
}): number {
  return Math.max(0, MAX_TURN_ATTACHMENTS - countQuestionAttachments(input));
}

/** Uploads must complete before the answer can be submitted (§7.5). */
export function questionAnswerBlockedByUploads(input: {
  preparing: Record<string, number>;
  keys: readonly string[];
}): boolean {
  return input.keys.some((key) => (input.preparing[key] ?? 0) > 0);
}
