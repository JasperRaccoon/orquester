// Automated workflows — an agent block's later pass in a loop (spec 2026-11-10 §7.3).
//
// A loop edge's `session` applies to every agent block of its reset set:
//   continue  a follow-up turn in the chat of the block's previous pass: a header ("Workflow loop:
//             pass 2 of up to 3"), the feedback (the loop's target only) and the block's prompt
//             rendered again against the new upstream outputs. A block that is not the target is told
//             the earlier steps ran again and to re-check its earlier findings.
//   new       a new chat: the prompt rendered again, the feedback (target only) and the previous
//             pass's report or answer.
// A `continue` that cannot continue — no previous chat, the chat closed, its agent no longer
// available, or the chat still busy — starts a new chat with the `new` text, and the pass records
// "new chat: previous session unavailable (<reason>)". A block whose own `session` continues an
// upstream block's chat (`fromNode`) keeps doing so, with the `continue` text.
//
// Everything here is composed BEFORE the saved-prompt `{variables}` pass, like the `{{…}}` values:
// inserted text is escaped for it (`escapePromptVariables`), and the feedback — text a reviewer or a
// gate's decider wrote — is framed as untrusted data. The gate's reviewer-agent decider can use the
// same two texts (`loopTemplate`) and session choice (`chooseLoopSession`) for its own later pass.

import { escapePromptVariables, frameUntrustedValue, promptDataNote, type SessionSummary } from "@orquester/api";

import { listSessions, ToolError, type DaemonApi } from "../../chat-client/index.ts";
import type { Clock, NodeLoopContext, WorkflowLogger } from "../contracts.ts";
import { clipUtf8 } from "./prompt.ts";
import { waitForIdle } from "./watch.ts";

/** How the block's pass talks to its agent: in its previous chat, or a new one. */
export type LoopTurnMode = "continue" | "new";

/** The previous pass's answer quoted into a new chat is cut past this (its report is ≤ 2 000 chars). */
const PREVIOUS_TEXT_BYTES = 8 * 1024;
/** Its outputs as JSON, likewise. */
const PREVIOUS_OUTPUTS_BYTES = 8 * 1024;
/** How long a `continue` waits for the previous chat to settle (a reset stopped it mid-turn). */
const IDLE_WAIT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** "Workflow loop: pass 2 of up to 3." */
export function loopHeader(loop: NodeLoopContext): string {
  return `Workflow loop: pass ${loop.loopPass} of up to ${loop.maxPasses}.`;
}

/** The target's feedback block, framed (none when this block is not the target or got no feedback). */
function feedbackSection(loop: NodeLoopContext, frameId: string): string | null {
  if (!loop.target || loop.feedback === undefined || loop.feedback.trim() === "") return null;
  const framed = frameUntrustedValue(loop.feedback, frameId);
  return `Feedback from ${escapePromptVariables(loop.sourceName)}:\n${framed}\n\n${promptDataNote(frameId)}`;
}

/** The previous chat's id: the previous pass's output's, else the one it recorded. */
export function previousSessionId(loop: NodeLoopContext): string | undefined {
  const output = loop.previous?.output;
  if (isRecord(output) && typeof output.sessionId === "string" && output.sessionId.length > 0) return output.sessionId;
  const recorded = loop.previous?.sessionId;
  return typeof recorded === "string" && recorded.length > 0 ? recorded : undefined;
}

/** What the previous pass ended with, for a new chat: its report (outcome, summary, outputs), else its answer. */
function previousSection(loop: NodeLoopContext): string | null {
  const previous = loop.previous;
  if (!previous) return null;
  const output = isRecord(previous.output) ? previous.output : {};
  const lines: string[] = [];
  const ended = previous.status === "succeeded" ? "finished" : previous.status === "failed" ? "failed" : "was stopped";
  const outcome = previous.report?.outcome ?? (typeof output.outcome === "string" ? output.outcome : undefined);
  lines.push(`Your previous pass (pass ${loop.pass - 1}) ${ended}${outcome ? ` with the outcome \`${outcome}\`` : ""}.`);
  if (previous.status !== "succeeded" && previous.error?.message) lines.push(`Why: ${previous.error.message}`);
  const summary = previous.report?.summary ?? (typeof output.summary === "string" ? output.summary : undefined);
  const outputs = previous.report?.outputs ?? (isRecord(output.outputs) ? output.outputs : undefined);
  if (summary !== undefined && summary.trim() !== "") lines.push(`Its report:\n${summary.trim()}`);
  if (outputs !== undefined && Object.keys(outputs).length > 0) {
    lines.push(`Its outputs: ${clipUtf8(JSON.stringify(outputs), PREVIOUS_OUTPUTS_BYTES).text}`);
  }
  // A gate's pass (its reviewer agent's later pass): the decision it ended with.
  if (typeof output.choice === "string" && output.choice !== "") {
    const by = isRecord(output.decidedBy) && typeof output.decidedBy.label === "string" ? ` (by ${output.decidedBy.label})` : "";
    const comment = typeof output.comment === "string" && output.comment.trim() !== "" ? `: ${clipUtf8(output.comment.trim(), PREVIOUS_TEXT_BYTES).text}` : "";
    lines.push(`The gate's decision then${by}: \`${output.choice}\`${comment}`);
  }
  if (summary === undefined && typeof output.text === "string" && output.text.trim() !== "") {
    const { text, truncated } = clipUtf8(output.text.trim(), PREVIOUS_TEXT_BYTES);
    lines.push(`Its final answer${truncated ? " (cut)" : ""}:\n${text}`);
  }
  return escapePromptVariables(lines.join("\n\n"));
}

/**
 * The block's prompt (after `{{…}}`, before `{variables}`) for a later loop pass: the `continue`
 * follow-up turn, or a new chat's prompt. Without a loop (pass 1) it is the prompt itself.
 */
export function loopTemplate(loop: NodeLoopContext | undefined, mode: LoopTurnMode, prompt: string, frameId: string): string {
  if (loop === undefined) return prompt;
  const header = loopHeader(loop);
  const feedback = feedbackSection(loop, frameId);
  const why = loop.target
    ? `${escapePromptVariables(loop.sourceName)} sent this step back to be done again.`
    : `The earlier steps ran again (${escapePromptVariables(loop.targetName)} and what follows it).`;
  if (mode === "continue") {
    const ask = loop.target
      ? "Do this step again with that in mind. Its instructions, rendered with the latest inputs:"
      : "Re-check your earlier findings against the current state, then do this step again. Its instructions, rendered with the latest inputs:";
    return [`${header} ${why}`, ...(feedback ? [feedback] : []), `${ask}\n\n${prompt}`].join("\n\n");
  }
  const previous = previousSection(loop);
  return [prompt, `${header} This step already ran in this workflow run. ${why}`, ...(feedback ? [feedback] : []), ...(previous ? [previous] : [])].join("\n\n");
}

/** The session a `continue` pass goes on in, or why it cannot (the pass then starts a new chat). */
export type LoopSessionChoice = { mode: "continue"; sessionId: string; summary: SessionSummary } | { mode: "new"; reason?: string };

/**
 * §7.3: where this pass talks to its agent. `new` when the loop says so; else the previous pass's
 * chat when it is still there and settles (a reset may have stopped it mid-turn); else a new chat
 * and the reason. `agentUsable` is the executor's catalogue check of the chat's agent.
 */
export async function chooseLoopSession(input: {
  loop: NodeLoopContext;
  api: DaemonApi;
  clock: Clock;
  signal: AbortSignal;
  logger: WorkflowLogger;
  agentUsable(summary: SessionSummary): Promise<string | null>;
  /** Reads retried while the daemon is unavailable (the executor's `transient`). */
  retry<T>(fn: () => Promise<T>): Promise<T>;
}): Promise<LoopSessionChoice> {
  const { loop } = input;
  if (loop.session === "new") return { mode: "new" };
  const sessionId = previousSessionId(loop);
  if (sessionId === undefined) return { mode: "new", reason: "its previous pass started no chat" };
  let summary: SessionSummary | undefined;
  try {
    summary = (await input.retry(() => listSessions(input.api))).find((candidate) => candidate.id === sessionId);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { mode: "new", reason: `the chat could not be read: ${error.message}` };
  }
  if (!summary) return { mode: "new", reason: "the chat was closed or deleted" };
  const refused = await input.agentUsable(summary);
  if (refused !== null) return { mode: "new", reason: refused };
  const idle = await waitForIdle({
    api: input.api,
    sessionId,
    clock: input.clock,
    signal: input.signal,
    until: new Date(input.clock.now().getTime() + IDLE_WAIT_MS),
    logger: input.logger
  });
  if (idle === "cancelled") return { mode: "new" };
  if (idle === "closed") return { mode: "new", reason: "the chat was closed or deleted" };
  if (idle === "timeout") return { mode: "new", reason: "the chat is still busy" };
  return { mode: "continue", sessionId, summary };
}

/** The note a pass records when its `continue` started a new chat (§7.3). */
export function newChatNote(reason: string): string {
  return `new chat: previous session unavailable (${reason})`;
}
