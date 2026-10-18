/**
 * Agent Profiles — the one error type: every refusal a route can answer, with its HTTP status
 * and wire code. Routes send it as `{error: {code, message}}` (the agent-profile shape); the
 * shared agent-profile infra's `AgentProfileError` (a bad name, an unparseable frontmatter) is
 * answered the same way. Anything else is a 500 `SESSION_PROFILE_ERROR`. No message ever quotes
 * a secret value.
 */

import type { SessionProfileErrorCode } from "@orquester/api";

export class SessionProfileError extends Error {
  constructor(
    readonly status: number,
    readonly code: SessionProfileErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SessionProfileError";
  }
}

export const sessionProfileErrors = {
  invalid: (message: string) => new SessionProfileError(400, "INVALID_REQUEST", message),
  invalidName: (message: string) => new SessionProfileError(400, "INVALID_NAME", message),
  invalidItem: (message: string) => new SessionProfileError(400, "INVALID_ITEM", message),
  kindNotSupported: (message: string) => new SessionProfileError(400, "KIND_NOT_SUPPORTED", message),
  notFound: (profileId: string) =>
    new SessionProfileError(404, "PROFILE_NOT_FOUND", `No Agent Profile "${profileId.slice(0, 80)}".`),
  itemNotFound: (itemId: string) => new SessionProfileError(404, "ITEM_NOT_FOUND", `No item "${itemId.slice(0, 80)}".`),
  nameTaken: (name: string) =>
    new SessionProfileError(409, "PROFILE_NAME_TAKEN", `An Agent Profile named "${name}" already exists.`),
  itemExists: (kind: string, name: string) =>
    new SessionProfileError(409, "ITEM_EXISTS", `This profile already has a ${kind} named "${name}" for those agents.`),
  conflict: () =>
    new SessionProfileError(409, "PROFILE_CONFLICT", "The profile changed since you loaded it. It has been refreshed."),
  /** A launch's profile is not prepared for its agent (preparation failed, or the daemon is stopping); `reason` says why. */
  notReady: (reason: string) => new SessionProfileError(409, "PROFILE_NOT_READY", reason),
  /** The agent has no preparer yet: its profile chats cannot launch (never a Global fallback). */
  unsupportedAgent: (agentLabel: string) =>
    new SessionProfileError(400, "PROFILE_UNSUPPORTED_AGENT", `Agent Profiles are not supported for ${agentLabel} yet.`),
  /** The delete guard (§5.5): the workflows using the profile are not the ones the caller confirmed. */
  workflowUsesChanged: (message: string) => new SessionProfileError(409, "WORKFLOW_USES_CHANGED", message),
  unreadable: (profileId: string, detail: string) =>
    new SessionProfileError(500, "PROFILE_UNREADABLE", `Agent Profile "${profileId}" could not be read: ${detail}`)
};
