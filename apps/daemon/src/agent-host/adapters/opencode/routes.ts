/**
 * Agent host — the exact OpenCode routes this adapter uses, in one place
 * (spec §4.5 OpenCode), plus the request/response views they exchange.
 *
 * 1.18.5 ships **three** spellings of "reply to a permission" (fixtures README
 * observation 3):
 *
 * ```
 * POST /permission/{requestID}/reply                             ← the one that works
 * POST /session/{sessionID}/permissions/{permissionID}           ← the SDK trap §4.5 names
 * POST /api/session/{sessionID}/permission/{requestID}/reply     ← new in 1.18.5
 * ```
 *
 * Keeping every path here is what stops one of the other two creeping into a
 * call site later.
 */

import type { OpenCodeMessageInfo, OpenCodePart, OpenCodeSessionInfo } from "./protocol.ts";
import type { OpenCodePermissionRuleset } from "./ruleset.ts";

export const openCodeRoutes = {
  health: "/global/health",
  providers: "/provider",
  agents: "/agent",
  commands: "/command",
  skills: "/skill",
  sessions: "/session",
  sessionStatus: "/session/status",
  permissions: "/permission",
  questions: "/question",
  session: (id: string) => `/session/${id}`,
  children: (id: string) => `/session/${id}/children`,
  messages: (id: string) => `/session/${id}/message`,
  message: (sessionId: string, messageId: string) =>
    `/session/${sessionId}/message/${messageId}`,
  promptAsync: (id: string) => `/session/${id}/prompt_async`,
  command: (id: string) => `/session/${id}/command`,
  abort: (id: string) => `/session/${id}/abort`,
  summarize: (id: string) => `/session/${id}/summarize`,
  fork: (id: string) => `/session/${id}/fork`,
  todo: (id: string) => `/session/${id}/todo`,
  permissionReply: (requestId: string) => `/permission/${requestId}/reply`,
  questionReply: (requestId: string) => `/question/${requestId}/reply`,
  /** The route T3 never calls; §6.2's `/dismiss` uses it. */
  questionReject: (requestId: string) => `/question/${requestId}/reject`
} as const;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface OpenCodeTextPartInput {
  type: "text";
  text: string;
}

export interface OpenCodeFilePartInput {
  type: "file";
  mime: string;
  filename: string;
  /** A `file://` URL — the server reads it off this host's disk. */
  url: string;
}

export type OpenCodePartInput = OpenCodeTextPartInput | OpenCodeFilePartInput;

export interface CreateSessionBody {
  title?: string;
  /**
   * Sent at **create** as well as by `PATCH` — `session.created` echoes it back
   * in full, and sending it here closes the window in which a session exists
   * with default permissions (fixtures README observation 24).
   */
  permission: OpenCodePermissionRuleset;
}

export interface UpdateSessionBody {
  permission: OpenCodePermissionRuleset;
}

/** `prompt_async` takes `{providerID, modelID}`; `command` takes a **string**. */
export interface PromptAsyncBody {
  messageID: string;
  model: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  system?: string;
  parts: OpenCodePartInput[];
}

export interface SessionCommandBody {
  messageID: string;
  command: string;
  arguments: string;
  /** `"<providerID>/<modelID>"` — the asymmetry with `prompt_async` is real. */
  model: string;
  agent?: string;
  variant?: string;
  /** `session.command` accepts **no** `system` addendum; the schema has none. */
  parts: OpenCodePartInput[];
}

export interface SummarizeBody {
  providerID: string;
  modelID: string;
  auto: false;
}

export interface ForkBody {
  /** Absent = fork the whole history (and re-mint every message id). */
  messageID?: string;
  directory?: string;
}

// ---------------------------------------------------------------------------
// Response views
// ---------------------------------------------------------------------------

export interface OpenCodeMessageWithParts {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export type SessionStatusMap = Record<string, { type: string } | undefined>;

export interface OpenCodeCommandRow {
  name: string;
  description?: string;
  /** `"skill"` rows reappear as skills and are dropped from the command list. */
  source?: string;
  /** Present on every row in 1.18.5, but one optional field from throwing. */
  hints?: string[];
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface OpenCodeAgentRow {
  name: string;
  mode?: "primary" | "subagent" | "all" | (string & {});
  hidden?: boolean;
  description?: string;
}

export interface OpenCodeSkillRow {
  name?: string | null;
  description?: string | null;
  location?: string | null;
}

export interface OpenCodeModelRow {
  id: string;
  name?: string;
  /** An **object**, not an array — and its values name the reasoning effort. */
  variants?: Record<string, { reasoning?: { effort?: string } } | undefined>;
}

export interface OpenCodeProviderRow {
  id: string;
  name?: string;
  models: Record<string, OpenCodeModelRow | undefined>;
}

export interface ProviderListResponse {
  all: OpenCodeProviderRow[];
  /** Login is inferred from this being non-empty — there is no `auth list`. */
  connected: string[];
  default?: Record<string, string>;
}

export type { OpenCodeSessionInfo };
