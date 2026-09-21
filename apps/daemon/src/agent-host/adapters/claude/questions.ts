/**
 * Claude adapter — `AskUserQuestion` (spec §4.2 Questions, §4.5 Claude).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts` `handleAskUserQuestion`.
 *
 * `AskUserQuestion` is intercepted **before** any approval logic and becomes
 * `user-input.requested`, in every runtime mode — plan mode leans on it
 * heavily. The question `id` **must equal the full question text**: the SDK
 * ≥ 2.1.121 looks answers up by text, so the key the UI keeps its draft under
 * has to match the SDK's lookup key. The capture proves it
 * (fixtures/claude README observation 12): the CLI echoes
 * `Your questions have been answered: "<question>"="<label>"`.
 */

import type { UserInputQuestion, UserInputQuestionOption } from "@orquester/api/agent-chat";

export interface AskUserQuestionParse {
  questions: UserInputQuestion[];
  /**
   * Two questions with identical text are indistinguishable by the answer key,
   * so one of them would silently receive the other's answer. The adapter
   * refuses rather than guessing.
   */
  duplicateQuestionText?: string;
}

function optionsOf(value: unknown): UserInputQuestionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: UserInputQuestionOption[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const option = entry as { label?: unknown; description?: unknown; value?: unknown };
    options.push({
      label: typeof option.label === "string" ? option.label : "",
      description: typeof option.description === "string" ? option.description : "",
      // Claude's options carry `label` + `description` and no `value`
      // (fixtures README observation 12); a newer CLI that adds one is kept.
      ...(typeof option.value === "string" ? { value: option.value } : {})
    });
  }
  return options;
}

export function parseAskUserQuestionInput(input: Record<string, unknown>): AskUserQuestionParse {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions: UserInputQuestion[] = [];
  const seen = new Set<string>();
  let duplicateQuestionText: string | undefined;

  raw.forEach((entry, index) => {
    const record =
      entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const question = typeof record.question === "string" ? record.question : "";
    // The id IS the question text. Never trimmed, never normalised: the SDK
    // looks the answer up by the exact string it sent.
    const id = question.length > 0 ? question : `q-${index}`;
    if (seen.has(id)) {
      duplicateQuestionText ??= id;
    }
    seen.add(id);
    questions.push({
      id,
      header: typeof record.header === "string" ? record.header : `Question ${index + 1}`,
      question,
      options: optionsOf(record.options),
      // `multiSelect` is present on the wire, so §4.2's "defaults to false" is
      // a fallback rather than the norm.
      ...(typeof record.multiSelect === "boolean" ? { multiSelect: record.multiSelect } : {}),
      ...(typeof record.allowCustomAnswer === "boolean"
        ? { allowCustomAnswer: record.allowCustomAnswer }
        : {})
    });
  });

  return {
    questions,
    ...(duplicateQuestionText !== undefined ? { duplicateQuestionText } : {})
  };
}

/** Convenience for the replay harness and the smoke script. */
export function questionsFromAskUserQuestionInput(
  input: Record<string, unknown>
): UserInputQuestion[] {
  return parseAskUserQuestionInput(input).questions;
}

/**
 * The reply the SDK expects: the original `questions` array plus an `answers`
 * map keyed by question **text**, whose value is the option **label**.
 */
export function buildAskUserQuestionReply(
  toolInput: Record<string, unknown>,
  answers: Record<string, unknown>
): { questions: unknown; answers: Record<string, unknown> } {
  return { questions: toolInput.questions, answers };
}
