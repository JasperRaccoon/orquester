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

import type {
  UserInputPreviewFormat,
  UserInputQuestion,
  UserInputQuestionOption
} from "@orquester/api/agent-chat";

/**
 * The format the session asks Claude to write option previews in
 * (`toolConfig.askUserQuestion.previewFormat`, SDK 0.3.278 `ToolConfig`), and
 * so the format every parsed preview is tagged with. Markdown, the CLI's own
 * default: the card renders it with the chat's markdown — code, tables,
 * mermaid — where an HTML fragment could only be shown inert, in a frame with
 * no scripts.
 */
export const CLAUDE_QUESTION_PREVIEW_FORMAT: UserInputPreviewFormat = "markdown";

interface AskUserQuestionParse {
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
    const option = entry as { label?: unknown; description?: unknown; value?: unknown; preview?: unknown };
    options.push({
      label: typeof option.label === "string" ? option.label : "",
      description: typeof option.description === "string" ? option.description : "",
      // Claude's options carry `label` + `description` and no `value`
      // (fixtures README observation 12); a newer CLI that adds one is kept.
      ...(typeof option.value === "string" ? { value: option.value } : {}),
      // The optional `preview` (fixtures README observation 12): display-only,
      // so a value of any other shape is dropped rather than the option.
      ...(typeof option.preview === "string" && option.preview.length > 0
        ? { preview: option.preview, previewFormat: CLAUDE_QUESTION_PREVIEW_FORMAT }
        : {})
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

/** `AskUserQuestionInput.annotations`: per question text, what the user saw. */
type AskUserQuestionAnnotations = Record<string, { preview?: string; notes?: string }>;

function previewOf(option: unknown, label: string): string | undefined {
  if (option === null || typeof option !== "object") {
    return undefined;
  }
  const record = option as { label?: unknown; preview?: unknown };
  return record.label === label && typeof record.preview === "string" && record.preview.length > 0
    ? record.preview
    : undefined;
}

/**
 * The previews the user chose, as the SDK takes them back: `annotations`,
 * keyed by question text, each `{ preview }` — the preview content of the
 * selected option (SDK 0.3.278 `AskUserQuestionInput.annotations`), so the
 * model knows which mockup was picked, not only its label.
 *
 * Only a single-select answer that IS one option's label carries one: the
 * tool supports previews on single-select questions alone, and a typed answer
 * chose no option, so there is no preview to send back.
 */
function chosenPreviews(
  toolInput: Record<string, unknown>,
  answers: Record<string, unknown>
): AskUserQuestionAnnotations {
  const annotations: AskUserQuestionAnnotations = {};
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  for (const entry of questions) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as { question?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof record.question !== "string" || record.multiSelect === true || !Array.isArray(record.options)) {
      continue;
    }
    const answer = answers[record.question];
    if (typeof answer !== "string") {
      continue;
    }
    for (const option of record.options) {
      const preview = previewOf(option, answer);
      if (preview !== undefined) {
        annotations[record.question] = { preview };
        break;
      }
    }
  }
  return annotations;
}

/**
 * The reply the SDK expects: the original `questions` array plus an `answers`
 * map keyed by question **text**, whose value is the option **label** — and,
 * when a chosen option had a preview, `annotations` ({@link chosenPreviews}).
 */
export function buildAskUserQuestionReply(
  toolInput: Record<string, unknown>,
  answers: Record<string, unknown>
): { questions: unknown; answers: Record<string, unknown>; annotations?: AskUserQuestionAnnotations } {
  const annotations = chosenPreviews(toolInput, answers);
  return {
    questions: toolInput.questions,
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {})
  };
}
