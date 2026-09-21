/**
 * Grok adapter — `_x.ai/ask_user_question` answers (spec §4.5 Grok, §4.3).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/acp/XAiAcpExtension.ts:119-200`.
 *
 * The answer envelope is keyed **by question TEXT**, not by id — and on this
 * CLI that is the only rule that *can* work, because the question carries no
 * `id` at all:
 *
 * ```json
 * {"questions":[{"question":"Should the new file be named alpha.txt or beta.txt?",
 *   "options":[{"label":"alpha.txt","description":"…"},{"label":"beta.txt","description":"…"}],
 *   "multiSelect":null}], "mode":"default"}
 * ```
 *
 * and the reply that was accepted verbatim:
 *
 * ```json
 * {"outcome":"accepted","answers":{"Should the new file be named alpha.txt or beta.txt?":["alpha.txt"]}}
 * ```
 *
 * Note the shape: a FLAT `{outcome, answers}`, like `exit_plan_mode` and
 * unlike `session/request_permission`'s nested `{outcome:{outcome}}`.
 */

import type { XaiAskUserQuestionParams } from "./acp/_generated/xai.ts";

/** A free-text answer that matches no advertised option becomes this label. */
export const OTHER_LABEL = "Other";

export interface XaiAnswerEnvelope {
  readonly outcome: "accepted";
  readonly answers: Record<string, string[]>;
  readonly annotations?: Record<string, { preview?: string; notes?: string }>;
}

/** A string, or an array of strings, trimmed, blanks dropped. */
function answerValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Build the reply. Answers are looked up by the question's `id` (which the
 * adapter sets to the question text when the provider gives none) and then by
 * the question text itself, so a client that echoes either one works.
 *
 * Unmatched free text becomes the single label `"Other"` plus a note carrying
 * what the user actually typed: Grok's own TUI advertises an "Other" escape
 * hatch, so this keeps the answer inside the vocabulary the agent expects
 * while still delivering the text. `"Other"` appears only when **nothing**
 * matched — a mix of one known label and one free-text answer reports the
 * known label plus notes.
 */
export function answersToXaiResponse(
  params: XaiAskUserQuestionParams,
  answers: Record<string, unknown>
): XaiAnswerEnvelope {
  const out: Record<string, string[]> = {};
  const annotations: Record<string, { preview?: string; notes?: string }> = {};

  for (const question of params.questions) {
    const values = answerValues(answers[question.id ?? question.question] ?? answers[question.question]);
    if (values.length === 0) {
      continue;
    }
    const byLabel = new Map(question.options.map((option) => [option.label, option]));
    const resolved = values.map((value) => ({ value, option: byLabel.get(value) }));

    const selected = resolved
      .filter((entry) => entry.option !== undefined)
      .map((entry) => entry.option!.label);
    const notes = resolved.filter((entry) => entry.option === undefined).map((entry) => entry.value);
    const preview =
      question.multiSelect === true
        ? undefined
        : resolved.map((entry) => entry.option?.preview?.trim()).find((value) => value !== undefined && value.length > 0);

    out[question.question] = selected.length > 0 ? selected : [OTHER_LABEL];
    if (preview !== undefined || notes.length > 0) {
      annotations[question.question] = {
        ...(preview === undefined ? {} : { preview }),
        ...(notes.length === 0 ? {} : { notes: notes.join("\n") })
      };
    }
  }

  return Object.keys(annotations).length === 0
    ? { outcome: "accepted", answers: out }
    : { outcome: "accepted", answers: out, annotations };
}
