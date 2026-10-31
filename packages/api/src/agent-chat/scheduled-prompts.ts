/**
 * Scheduled prompts: a composer message the daemon sends into its chat at a set time, so the user
 * need not be there ("send in 4h 20m", once an account's usage resets).
 *
 * The daemon owns them (`apps/daemon/src/agent-chat/scheduled-prompts.ts`): each is persisted on
 * the chat's tab record (`sessions.json`) BEFORE anything is armed, so a restart, a deploy or a
 * crash re-arms it, and one that came due while the daemon was down goes out as soon as it is
 * back. At its time it is posted through the chat's own `/turn` route under a command id derived
 * from the prompt, so a re-post after a crash is answered by the host's receipt and never sends
 * twice. A chat that is busy then gets it once it is idle; a send the chat refuses is kept,
 * `failed`, with the reason, until the user retries or cancels it.
 *
 * Every surface reads them off `SessionSummary.scheduledPrompts` (a light view without the full
 * text or attachments); the full prompt comes back only from a cancel, so "Edit" can put it into
 * the composer.
 */

import type { AttachmentRef, ComposerContextRecord, InteractionMode, ModelSelection } from "./adapter-types.ts";

/** At most this many scheduled prompts wait on one chat. */
export const MAX_SCHEDULED_PROMPTS_PER_CHAT = 20;
/** A prompt is scheduled at most this far ahead. */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60_000;
/** How many characters of the text the summary's {@link ScheduledPromptView.preview} carries. */
export const SCHEDULED_PROMPT_PREVIEW_CHARS = 280;

/**
 * Where a scheduled prompt stands:
 * - `scheduled`: armed, waiting for its time;
 * - `waiting`: its time came while the chat was busy (a turn, an approval, a question); it goes
 *   out once the chat is idle;
 * - `sending`: being posted now;
 * - `failed`: the chat refused it ({@link ScheduledPromptView.error}); kept until retried or cancelled.
 *
 * A prompt that was sent is gone from the list: it is the chat's message now.
 */
export type ScheduledPromptState = "scheduled" | "waiting" | "sending" | "failed";

/** The turn a scheduled prompt posts: `TurnCommandBody` without its command id. */
export interface ScheduledPromptTurn {
  input: string;
  attachments?: AttachmentRef[];
  context?: ComposerContextRecord[];
  interactionMode?: InteractionMode;
  modelSelection?: ModelSelection;
}

/** A whole scheduled prompt, as the daemon keeps it. */
export interface ScheduledPrompt extends ScheduledPromptTurn {
  /** Minted by the client; a repeated create with the same id answers the one already there. */
  id: string;
  createdAt: string;
  /** When it goes out (ISO). */
  sendAt: string;
  state: ScheduledPromptState;
  /** Why the last attempt failed (`failed` only). */
  error?: string;
  /** Attempts that reached the chat and were refused; each retry posts under a new command id. */
  attempts: number;
}

/** One scheduled prompt on `SessionSummary.scheduledPrompts`: everything but the full text and attachments. */
export interface ScheduledPromptView {
  id: string;
  createdAt: string;
  sendAt: string;
  state: ScheduledPromptState;
  /** The start of the text, at most {@link SCHEDULED_PROMPT_PREVIEW_CHARS} characters. */
  preview: string;
  attachmentCount: number;
  error?: string;
}

/** `POST …/scheduled-prompts`: schedule a prompt. */
export interface ScheduledPromptCreateRequest extends ScheduledPromptTurn {
  id: string;
  sendAt: string;
}

/** What every scheduled-prompt route answers: the chat's list after the action. */
export interface ScheduledPromptsResponse {
  scheduledPrompts: ScheduledPromptView[];
}

/** `DELETE …/scheduled-prompts/:promptId`: the list, and the prompt taken off it, whole. */
export interface ScheduledPromptCancelResponse extends ScheduledPromptsResponse {
  cancelled: ScheduledPrompt;
}

/** The summary's light view of a prompt. */
export function scheduledPromptView(prompt: ScheduledPrompt): ScheduledPromptView {
  return {
    id: prompt.id,
    createdAt: prompt.createdAt,
    sendAt: prompt.sendAt,
    state: prompt.state,
    preview: prompt.input.slice(0, SCHEDULED_PROMPT_PREVIEW_CHARS),
    attachmentCount: prompt.attachments?.length ?? 0,
    ...(prompt.error !== undefined ? { error: prompt.error } : {})
  };
}
