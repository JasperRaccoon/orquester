// Ported from T3 Code (MIT): apps/web/src/pendingUserInput.ts
/**
 * The question card's answer model (spec §7.5).
 *
 * One draft per question, resolved into the `answers` map `/answer` takes. The
 * rules that are not obvious:
 *
 *  - **A non-empty custom answer beats selected options.** That is why
 *    {@link carryDisplacedCustomAnswerIntoPrompt} exists: clicking an option
 *    would otherwise silently discard what the user typed.
 *  - **An attachment alone satisfies a question** — the answer is `""` and the
 *    files carry the meaning.
 *  - **A question whose attachments have not finished uploading resolves to
 *    `null`**, so the card cannot advance past an unfinished upload.
 *
 * Reality findings honoured here (fixture capture, Codex): an option may carry
 * **no `value`** — the label is the value — and a question may mark one option
 * `isOther` (choosing it means "I will type it") or mark itself `isSecret`
 * (the answer is a credential). A secret answer is never carried back into the
 * thread draft, because the draft is rendered, persisted as a user message and
 * sent to the model.
 */

import type { UserInputQuestion, UserInputQuestionOption } from "@orquester/api/agent-chat";

/**
 * Optional per-option flags some providers send that the shared contract does
 * not name yet. Read structurally so the card lights up the moment the
 * adapter starts stamping them, and behaves exactly as before until then.
 */
export interface QuestionOptionFlags {
  /** "Other…": picking it means the answer is the typed text, not this label. */
  isOther?: boolean;
}

export interface QuestionFlags {
  /** The answer is a credential: masked in the field, never echoed anywhere. */
  isSecret?: boolean;
  /** The provider is blocked on this one; it cannot be dismissed. */
  isBlocking?: boolean;
}

export type QuestionOption = UserInputQuestionOption & QuestionOptionFlags;
export type Question = UserInputQuestion & QuestionFlags;

/** An option carries no `value` on some providers — the label IS the value. */
export function questionOptionValue(option: UserInputQuestionOption): string {
  return option.value ?? option.label;
}

export function isOtherOption(option: UserInputQuestionOption): boolean {
  return (option as QuestionOption).isOther === true;
}

export function isSecretQuestion(question: UserInputQuestion): boolean {
  return (question as Question).isSecret === true;
}

export function allowsCustomAnswer(question: UserInputQuestion): boolean {
  return question.allowCustomAnswer !== false || question.options.some(isOtherOption);
}

/** A question offering only predefined choices offers no attachments at all. */
export function allowsAnswerAttachments(question: UserInputQuestion): boolean {
  return allowsCustomAnswer(question) && !isSecretQuestion(question);
}

export interface PendingAnswerDraft {
  selectedOptionValues?: string[];
  customAnswer?: string;
  /** Staged plus in-flight, both counted against the eight-attachment budget. */
  attachmentCount?: number;
  /** True while an upload has not finished: the answer resolves to `null`. */
  attachmentsBlocked?: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionValues(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  // Provider option ids must stay unchanged, including whitespace.
  return Array.from(new Set(value.filter((entry) => typeof entry === "string")));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingAnswerDraft | undefined
): string | string[] | null {
  if (draft?.attachmentsBlocked) return null;

  const customAnswer = allowsCustomAnswer(question)
    ? normalizeDraftAnswer(draft?.customAnswer)
    : null;
  if (customAnswer) return customAnswer;

  const selected = normalizeSelectedOptionValues(draft?.selectedOptionValues).filter((value) =>
    question.options.some((option) => questionOptionValue(option) === value)
  );
  // An "other" pick with nothing typed is not an answer — it is a request for
  // the text field.
  const withoutOther = selected.filter(
    (value) =>
      !question.options.some(
        (option) => questionOptionValue(option) === value && isOtherOption(option)
      )
  );

  const attachmentsAnswer =
    allowsAnswerAttachments(question) && (draft?.attachmentCount ?? 0) > 0 ? "" : null;

  if (question.multiSelect) {
    return withoutOther.length > 0 ? withoutOther : attachmentsAnswer;
  }
  return withoutOther[0] ?? attachmentsAnswer;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingAnswerDraft | undefined,
  customAnswer: string
): PendingAnswerDraft {
  // Typing clears a selection only once there is something to prefer: an empty
  // field must not silently drop the option the user already picked.
  const selected =
    customAnswer.trim().length > 0 ? undefined : normalizeSelectedOptionValues(draft?.selectedOptionValues);
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
 * **A secret answer is never carried** — see the file header.
 *
 * *T3: `pendingUserInput.ts:87-105`.*
 */
export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined,
  options?: { isSecret?: boolean }
): string {
  if (options?.isSecret) return prompt;
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0) return prompt;
  if (prompt.trim().length === 0) return displaced;
  return `${prompt.trimEnd()}${DISPLACED_ANSWER_SEPARATOR}${displaced}`;
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingAnswerDraft | undefined,
  optionValue: string
): PendingAnswerDraft {
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

export function buildPendingUserInputAnswers(
  questions: readonly UserInputQuestion[],
  draftAnswers: Record<string, PendingAnswerDraft>
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: readonly UserInputQuestion[],
  draftAnswers: Record<string, PendingAnswerDraft>
): number {
  return questions.reduce(
    (count, question) =>
      resolvePendingUserInputAnswer(question, draftAnswers[question.id]) !== null ? count + 1 : count,
    0
  );
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingAnswerDraft | undefined;
  selectedOptionValues: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

export function derivePendingUserInputProgress(
  questions: readonly UserInputQuestion[],
  draftAnswers: Record<string, PendingAnswerDraft>,
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
    activeQuestion && !allowsCustomAnswer(activeQuestion) ? "" : (activeDraft?.customAnswer ?? "");

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
 * Answer attachments live in their own per-question draft namespace, keyed by
 * `(requestId, questionId)`, separate from the prompt draft — so moving
 * between questions keeps each one's files and never mixes them into the next
 * turn.
 *
 * *T3: `questionAttachments.ts:13-22`.*
 */
export function questionAttachmentKey(requestId: string, questionId: string): string {
  return `${encodeURIComponent(requestId)}:${encodeURIComponent(questionId)}`;
}
