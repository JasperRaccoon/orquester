/**
 * Agent host — the text of every continue prompt the host sends on its own
 * (spec 2026-11-01 P1.3 R8): the continuation of a turn a restart cut short,
 * the revival of a thread whose subagents a restart stopped after its turn had
 * ended (R2b), the resume after an unexpected stop (R3), and the closing of a
 * pending wake's delivery (`pending-wake.ts`).
 *
 * The agent is told what was cut and what was stopped, by name, so it can
 * relaunch the subagents and background commands whose results it still needs:
 * a restart kills them, and they never report back.
 *
 * Pure: the orchestrator decides what was stopped (`continuation-policy.ts`).
 */

import type { ContinuationStoppedWork } from "@orquester/api/agent-chat";

import { CONTINUATION_PROMPT } from "../host-protocol.ts";

/** Why the host continues: a restart's handover, an unexpected stop, a missed wake. */
export type ContinuationCause = "restart" | "crash" | "wake";

/** At most this many stopped items are named; the rest are counted. */
export const CONTINUATION_PROMPT_MAX_LISTED = 12;

export interface ContinuationPromptInput {
  cause: ContinuationCause;
  /**
   * R2b: no turn was cut — the turn had ended, but subagents or background
   * commands it started were still running. Ignored for a wake.
   */
  revival?: boolean;
  /** What the restart stopped, in order. Past {@link CONTINUATION_PROMPT_MAX_LISTED} it is counted. */
  stopped: readonly ContinuationStoppedWork[];
  /** Stopped items not listed in {@link stopped} at all (a capped record): counted with the rest. */
  moreStopped?: number;
  /** R5: the cut turn was waiting on an approval or a question, which the restart cancelled. */
  requestCancelled?: boolean;
}

const RESTART_CUT = "Orquester restarted while you were working, so your last turn was cut short.";
const CRASH_CUT = "Orquester stopped unexpectedly while you were working, so your last turn was cut short.";
const RESTART_REVIVAL = "Orquester restarted while your";
const CRASH_REVIVAL = "Orquester stopped unexpectedly while your";
const REQUEST_CANCELLED =
  "The approval or question you were waiting on was cancelled by the restart: ask again if the action is still needed.";
const NOTHING_LISTED = "If you had subagents running, relaunch any whose results you still need.";
const DO_NOT_WAIT = "Do not wait for the old ones: they will not report back.";
/** The last sentence of every prompt {@link continuationPrompt} builds — what recognises one. */
const CHECK_BEFORE_REPEATING =
  "A command or action that was in progress may or may not have taken effect: check before repeating anything that changes state.";

/** The opening sentences a {@link continuationPrompt} of a restart or a crash starts with. */
const OPENINGS: readonly string[] = [RESTART_CUT, CRASH_CUT, RESTART_REVIVAL, CRASH_REVIVAL];

/**
 * The continue prompt. For a wake it is the closing part of the wake prompt,
 * which already says what finished: it starts at "Continue where you left off."
 */
export function continuationPrompt(input: ContinuationPromptInput): string {
  const listed = input.stopped.slice(0, CONTINUATION_PROMPT_MAX_LISTED);
  const unrecorded = Math.max(0, input.moreStopped ?? 0);
  const more = input.stopped.length - listed.length + unrecorded;
  const total = listed.length + more;
  // An item counted but never recorded may be of either kind.
  const subagents = unrecorded > 0 || input.stopped.some((item) => item.kind === "subagent");
  const background = unrecorded > 0 || input.stopped.some((item) => item.kind === "background");
  const what = phrase(subagents, background);

  const sentences: string[] = [];
  if (input.cause !== "wake") {
    const crash = input.cause === "crash";
    if (input.revival === true && total > 0) {
      sentences.push(`${crash ? CRASH_REVIVAL : RESTART_REVIVAL} ${what} were still running.`);
    } else {
      sentences.push(crash ? CRASH_CUT : RESTART_CUT);
    }
  }
  sentences.push(CONTINUATION_PROMPT);
  if (input.requestCancelled === true) sentences.push(REQUEST_CANCELLED);
  if (total === 0) {
    sentences.push(NOTHING_LISTED);
  } else {
    const names = listed.map((item) => `"${item.name}" (${item.kind === "subagent" ? "subagent" : "background command"})`);
    if (more > 0) names.push(`and ${more} more`);
    sentences.push(`The restart stopped these ${what}: ${names.join(", ")}.`);
    sentences.push(relaunch(subagents, background));
    sentences.push(DO_NOT_WAIT);
  }
  sentences.push(CHECK_BEFORE_REPEATING);
  return sentences.join(" ");
}

/**
 * Whether `text` is a continue prompt the host sent after a restart: this
 * build's {@link continuationPrompt} of a restart or a crash, or the literal an
 * older host sent ({@link CONTINUATION_PROMPT}), which old logs and provider
 * transcripts hold (R10). Never a message the user wrote around it.
 */
export function isContinuationPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === CONTINUATION_PROMPT) return true;
  return OPENINGS.some((opening) => trimmed.startsWith(opening)) && endsLikeContinuationPrompt(trimmed);
}

/** Whether `text` ends as every {@link continuationPrompt} does — the wake prompt's recogniser reads it. */
export function endsLikeContinuationPrompt(text: string): boolean {
  return text.trim().endsWith(CHECK_BEFORE_REPEATING);
}

function phrase(subagents: boolean, background: boolean): string {
  if (subagents && background) return "subagents and background commands";
  return background ? "background commands" : "subagents";
}

function relaunch(subagents: boolean, background: boolean): string {
  const agents = "Relaunch the subagents whose results you still need, with the same instructions";
  if (subagents && background) return `${agents}, and restart the background commands you still need.`;
  if (background) return "Restart the background commands you still need.";
  return `${agents}.`;
}
