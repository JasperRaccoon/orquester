// Automated workflows — the texts an agent block sends (spec §5.1, §5.3, §5.4, §5.5).
//
// Rendering is two passes, in this order and never the other: `{{…}}` expressions against the run
// context first, with every inserted value escaped for the saved-prompt `{variables}` pass
// (`escapePromptVariables`) so text a trigger delivered can never inject a `{diff}`; then the
// `{variables}` themselves, daemon-side (`PromptRenderer`), in the workflow's time zone. A failed
// variable read fails the block naming it — a prompt is never sent missing its variables.

import { escapePromptVariables, renderTemplate, WORKFLOW_LIMITS, type AgentBlockConfig, type AgentFailureReason } from "@orquester/api";
import type { NodeExecutionContext, PromptRenderer } from "../contracts.ts";
import { tailUtf8, truncateUtf8 } from "../run-context.ts";

/** §5.1 step 3 — appended to every prompt this block sends while `autonomyNote` is on. */
const AUTONOMY_NOTE =
  "You are running unattended inside an automated workflow. No human will answer. Never ask questions or wait for confirmation; make reasonable decisions and complete the task fully.";

/** §5.4 step 3 — the first message after an in-session account switch. */
const CONTINUE_AFTER_SWITCH =
  "You were interrupted by a usage limit and have been moved to another account. Continue the task from exactly where you stopped.";

/** §5.5 — the custom answer to a question that allows one. */
export const AUTONOMOUS_ANSWER = "No user is available. Choose the most reasonable option yourself and proceed autonomously.";

/**
 * §5.4 step 4 — the handoff paragraph (the agent is named), saying why the previous agent stopped:
 * a usage limit, a refused login, or (with no known reason) neither.
 */
function handoffNotice(agent: string, reason?: AgentFailureReason): string {
  const why =
    reason === "usage_limit"
      ? "was cut off by a usage limit"
      : reason === "auth"
        ? "was stopped because its account's login failed"
        : "was stopped before it finished";
  return `A previous agent (${agent}) ${why}. Its partial work may already be in the working tree — inspect it and continue from there.`;
}

/** The prompt plus the autonomy note, when the block wants it. */
export function withAutonomyNote(text: string, autonomyNote: boolean): string {
  return autonomyNote ? `${text}\n\n${AUTONOMY_NOTE}` : text;
}

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
export function clipUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return { text: truncateUtf8(text, maxBytes), truncated: true };
}

/** The longest SUFFIX of `text` within `maxBytes` UTF-8 bytes (the newest part of a transcript). */
export function clipUtf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return { text: tailUtf8(text, maxBytes), truncated: true };
}

/**
 * §5.4 step 4: the original rendered prompt, the handoff notice, the previous agent's last
 * assistant messages (≤ 32 KiB, newest kept) and `git status --short` (≤ 8 KiB).
 */
export function buildHandoffPrompt(input: {
  originalPrompt: string;
  previousAgent: string;
  /** Why the previous agent stopped (its last hop's account failure), when known. */
  previousReason?: AgentFailureReason | undefined;
  previousMessages: string;
  gitStatus: string | null;
  autonomyNote: boolean;
}): string {
  const parts = [input.originalPrompt, handoffNotice(input.previousAgent, input.previousReason)];
  const messages = clipUtf8Tail(input.previousMessages.trim(), WORKFLOW_LIMITS.handoffMessagesBytes);
  if (messages.text) {
    parts.push(`The previous agent's last messages${messages.truncated ? " (the oldest part cut)" : ""}:\n\n${messages.text}`);
  }
  if (input.gitStatus !== null) {
    const status = clipUtf8(input.gitStatus.trimEnd(), WORKFLOW_LIMITS.handoffGitStatusBytes);
    parts.push(`\`git status --short\` of the project${status.truncated ? " (cut)" : ""}:\n\n${status.text || "(clean)"}`);
  }
  return withAutonomyNote(parts.join("\n\n"), input.autonomyNote);
}

/** §5.4 step 3 for an account whose login was refused (the account moved for a sign-in failure). */
const CONTINUE_AFTER_AUTH_SWITCH =
  "Your previous account's login failed and you have been moved to another account. Continue the task from exactly where you stopped.";

/**
 * The message sent after an account switch (or after waiting for a reset on the same session),
 * naming why the previous account stopped: a refused login reads as one, never as a usage limit.
 */
export function continueMessage(autonomyNote: boolean, reason?: AgentFailureReason): string {
  return withAutonomyNote(reason === "auth" ? CONTINUE_AFTER_AUTH_SWITCH : CONTINUE_AFTER_SWITCH, autonomyNote);
}

export type PromptSourceResult = { ok: true; template: string } | { ok: false; message: string };

/** The block's prompt template: its text, or a saved prompt's body plus the optional `append`. */
export function promptSource(config: AgentBlockConfig, prompts: Pick<PromptRenderer, "savedPromptBody">): PromptSourceResult {
  if (config.prompt.kind === "text") return { ok: true, template: config.prompt.text };
  const saved = prompts.savedPromptBody(config.prompt.promptId);
  if (!saved) return { ok: false, message: `The saved prompt "${config.prompt.promptId}" no longer exists.` };
  const append = config.prompt.append?.trim() ? `\n\n${config.prompt.append}` : "";
  return { ok: true, template: `${saved.body}${append}` };
}

/**
 * Pass 1: `{{…}}` against the run context, every inserted value escaped for the `{variables}`
 * pass. Rendered with the shared renderer rather than `ctx.render` because only the renderer takes
 * the escape hook.
 */
export function renderExpressions(template: string, ctx: Pick<NodeExecutionContext, "expressionContext" | "secrets">): { text: string; warnings: string[] } {
  const context = ctx.expressionContext();
  return renderTemplate(template, { ...context, secrets: ctx.secrets }, { escapeValue: escapePromptVariables });
}

/** Pass 2: the saved-prompt `{variables}`, daemon-side. */
export async function renderVariables(
  text: string,
  input: { prompts: PromptRenderer; projectPath: string; timeZone: string; agentLabel?: string; modelLabel?: string }
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const result = await input.prompts.render({
    body: text,
    projectPath: input.projectPath,
    timeZone: input.timeZone,
    ...(input.agentLabel ? { agentLabel: input.agentLabel } : {}),
    ...(input.modelLabel ? { modelLabel: input.modelLabel } : {})
  });
  return result.ok ? { ok: true, text: result.text } : { ok: false, message: result.reason };
}
