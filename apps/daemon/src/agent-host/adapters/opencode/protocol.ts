/**
 * Agent host — OpenCode wire shapes (spec §4.5 OpenCode).
 *
 * Hand-written from the server's own `GET /doc` (committed as
 * `apps/daemon/test/fixtures/opencode/openapi.json`, 162 routes and an
 * 89-member `Event` union) and from the real frames in
 * `apps/daemon/test/fixtures/opencode/*.ndjson`, captured from **opencode
 * 1.18.5**.
 *
 * These are decode-tolerant *views*, not a generated mirror: every field the
 * adapter does not read is left off, every field it reads is optional where
 * the capture ever showed it missing. A structural `isX` guard is what lets an
 * unknown frame reach the §10 fallback (surface + `runtime.warning`) instead of
 * throwing inside the demux.
 */

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/**
 * The frames the adapter genuinely maps. The demux switch over this union ends
 * in `satisfies never` (§4.2/§10).
 */
export const HANDLED_EVENT_TYPES = [
  "session.created",
  "session.updated",
  "session.deleted",
  "session.compacted",
  "session.status",
  "session.idle",
  "session.error",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "todo.updated",
  "command.executed"
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/**
 * Documented (or, for `server.heartbeat`, observed) frames the adapter
 * deliberately ignores. Everything here is *known*: it must not produce a
 * `runtime.warning`, or the timeline fills with noise every ten seconds
 * (fixtures README observation 18 — `server.heartbeat` is emitted but absent
 * from the OpenAPI, and 37 `session.next.*` / `*.v2.*` members are documented
 * but dormant in 1.18.5).
 */
export const KNOWN_IGNORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Observed live, no session bearing / nothing to render.
  "server.connected",
  "server.heartbeat",
  "session.diff",
  "plugin.added",
  "catalog.updated",
  "reference.updated",
  "integration.updated",
  "integration.connection.updated",
  "models-dev.refreshed",
  // Documented, dormant in 1.18.5 — a forward-compat surface.
  "session.next.agent.switched",
  "session.next.model.switched",
  "session.next.moved",
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.context.updated",
  "session.next.synthetic",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.reasoning.ended",
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  "session.next.tool.called",
  "session.next.tool.progress",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.retried",
  "session.next.compaction.started",
  "session.next.compaction.delta",
  "session.next.compaction.ended",
  "session.next.revert.staged",
  "session.next.revert.cleared",
  "session.next.revert.committed",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  // Documented, not this client's concern.
  "installation.updated",
  "installation.update-available",
  "file.edited",
  "file.watcher.updated",
  "project.directories.updated",
  "project.updated",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted",
  "lsp.updated",
  "mcp.tools.changed",
  "mcp.browser.open.failed",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "tui.session.select",
  "vcs.branch.updated",
  "workspace.ready",
  "workspace.failed",
  "workspace.status",
  "worktree.ready",
  "worktree.failed",
  "global.disposed",
  "server.instance.disposed"
]);

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
  total?: number;
}

export interface OpenCodeSessionInfo {
  id: string;
  parentID?: string;
  title?: string;
  directory?: string;
  version?: string;
  time?: { created?: number; updated?: number };
}

export type OpenCodeMessageRole = "user" | "assistant";

export interface OpenCodeMessageInfo {
  id: string;
  role: OpenCodeMessageRole;
  sessionID?: string;
  parentID?: string;
  agent?: string;
  mode?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
  finish?: string;
  time?: { created?: number; completed?: number };
}

export interface OpenCodeToolStateBase {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

export type OpenCodePart =
  | {
      type: "text" | "reasoning";
      id: string;
      messageID: string;
      sessionID?: string;
      text: string;
      time?: { start?: number; end?: number };
    }
  | {
      type: "tool";
      id: string;
      messageID: string;
      sessionID?: string;
      tool: string;
      callID: string;
      state: OpenCodeToolStateBase;
    }
  | {
      type: "step-finish";
      id: string;
      messageID: string;
      sessionID?: string;
      reason?: string;
      tokens: OpenCodeTokens;
      cost?: number;
    }
  | {
      type: "step-start" | "file" | "agent" | "patch" | "snapshot" | (string & {});
      id: string;
      messageID: string;
      sessionID?: string;
    };

export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  /** `bash`, `read`, `edit`, `webfetch`, `external_directory`, `doom_loop`, … */
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  /**
   * The pattern list an `always` reply would persist — directory-wide, across
   * every session on this server (fixtures README observation 9/10). It is
   * what the "Allow for workspace" warning names.
   */
  always?: string[];
  /** Links the ask to the exact tool part, so the card needs no text match. */
  tool?: { messageID: string; callID: string };
}

export interface OpenCodeQuestionOption {
  label: string;
  description?: string;
}

export interface OpenCodeQuestion {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
}

export interface OpenCodeQuestionRequest {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestion[];
  tool?: { messageID: string; callID: string };
}

export interface OpenCodeTodo {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | (string & {});
  priority?: string;
}

export type OpenCodeSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string };

export type OpenCodePermissionReply = "once" | "always" | "reject";

// ---------------------------------------------------------------------------
// The handled event union
// ---------------------------------------------------------------------------

export type OpenCodeHandledEvent =
  | { type: "session.created"; properties: { sessionID?: string; info: OpenCodeSessionInfo } }
  | { type: "session.updated"; properties: { sessionID?: string; info: OpenCodeSessionInfo } }
  | { type: "session.deleted"; properties: { sessionID?: string; info: OpenCodeSessionInfo } }
  | { type: "session.compacted"; properties: { sessionID: string } }
  | {
      type: "session.status";
      properties: { sessionID: string; status: OpenCodeSessionStatus };
    }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID?: string; error?: unknown } }
  | { type: "message.updated"; properties: { sessionID?: string; info: OpenCodeMessageInfo } }
  | { type: "message.removed"; properties: { sessionID?: string; messageID: string } }
  | {
      type: "message.part.updated";
      properties: { sessionID?: string; part: OpenCodePart; time?: number };
    }
  | {
      type: "message.part.delta";
      properties: {
        sessionID?: string;
        messageID: string;
        partID: string;
        /**
         * `"text"` for BOTH `text` and `reasoning` parts (fixtures README
         * observation 4) — the stream kind comes from the PART's `type`,
         * never from this field.
         */
        field: string;
        delta: string;
      };
    }
  | {
      type: "message.part.removed";
      properties: { sessionID?: string; messageID: string; partID: string };
    }
  | { type: "permission.asked"; properties: OpenCodePermissionRequest }
  | {
      type: "permission.replied";
      properties: { sessionID: string; requestID: string; reply: OpenCodePermissionReply };
    }
  | { type: "question.asked"; properties: OpenCodeQuestionRequest }
  | {
      type: "question.replied";
      properties: { sessionID: string; requestID: string; answers: string[][] };
    }
  | { type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  | { type: "todo.updated"; properties: { sessionID: string; todos: OpenCodeTodo[] } }
  | {
      type: "command.executed";
      properties: { sessionID: string; name: string; arguments?: string; messageID: string };
    };

/** Anything that arrived on `GET /event` before it was classified. */
export interface OpenCodeRawEvent {
  id?: string;
  type: string;
  properties?: unknown;
}

const HANDLED = new Set<string>(HANDLED_EVENT_TYPES);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A frame off the SSE stream, before any type check. */
export function asRawEvent(value: unknown): OpenCodeRawEvent | null {
  if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) {
    return null;
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    type: value.type,
    properties: value.properties
  };
}

export function isHandledEventType(type: string): type is HandledEventType {
  return HANDLED.has(type);
}

/**
 * Structural narrowing for the frames the demux maps. Deliberately shallow:
 * this proves the fields the switch dereferences exist, nothing more. A frame
 * whose type is handled but whose shape is wrong falls through to the §10
 * warning rather than throwing inside the switch.
 */
export function asHandledEvent(raw: OpenCodeRawEvent): OpenCodeHandledEvent | null {
  const p = raw.properties;
  if (!isRecord(p)) {
    return null;
  }
  switch (raw.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return isRecord(p.info) && typeof p.info.id === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "session.compacted":
    case "session.idle":
      return typeof p.sessionID === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "session.status":
      return typeof p.sessionID === "string" &&
        isRecord(p.status) &&
        typeof p.status.type === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "session.error":
      return { type: "session.error", properties: p } as OpenCodeHandledEvent;
    case "message.updated":
      return isRecord(p.info) &&
        typeof p.info.id === "string" &&
        (p.info.role === "user" || p.info.role === "assistant")
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "message.removed":
      return typeof p.messageID === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "message.part.updated":
      return isRecord(p.part) &&
        typeof p.part.id === "string" &&
        typeof p.part.messageID === "string" &&
        typeof p.part.type === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "message.part.delta":
      return typeof p.messageID === "string" &&
        typeof p.partID === "string" &&
        typeof p.field === "string" &&
        typeof p.delta === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "message.part.removed":
      return typeof p.messageID === "string" && typeof p.partID === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "permission.asked":
      return typeof p.id === "string" &&
        typeof p.sessionID === "string" &&
        typeof p.permission === "string"
        ? ({
            type: raw.type,
            properties: { ...p, patterns: Array.isArray(p.patterns) ? p.patterns : [] }
          } as OpenCodeHandledEvent)
        : null;
    case "permission.replied":
      return typeof p.requestID === "string" && typeof p.reply === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "question.asked":
      return typeof p.id === "string" && Array.isArray(p.questions)
        ? ({ type: raw.type, properties: p } as unknown as OpenCodeHandledEvent)
        : null;
    case "question.replied":
      return typeof p.requestID === "string"
        ? ({
            type: raw.type,
            properties: { ...p, answers: Array.isArray(p.answers) ? p.answers : [] }
          } as OpenCodeHandledEvent)
        : null;
    case "question.rejected":
      return typeof p.requestID === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "todo.updated":
      return typeof p.sessionID === "string" && Array.isArray(p.todos)
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    case "command.executed":
      return typeof p.name === "string" && typeof p.messageID === "string"
        ? ({ type: raw.type, properties: p } as OpenCodeHandledEvent)
        : null;
    default:
      return null;
  }
}

/**
 * The owning session of a frame. `session.created` / `session.updated` carry
 * it as `properties.info.id` rather than `properties.sessionID`, so an
 * extractor must read **both** (fixtures README observation 19).
 */
export function eventSessionId(raw: OpenCodeRawEvent): string | undefined {
  const p = raw.properties;
  if (!isRecord(p)) {
    return undefined;
  }
  if (typeof p.sessionID === "string" && p.sessionID.length > 0) {
    return p.sessionID;
  }
  const info = p.info;
  if (isRecord(info) && typeof info.id === "string" && info.id.length > 0) {
    return info.id;
  }
  return undefined;
}

/** Request events are the only child-session frames T3 lets through (§4.5). */
export function isRequestEventType(type: string): boolean {
  return (
    type === "permission.asked" ||
    type === "permission.replied" ||
    type === "question.asked" ||
    type === "question.replied" ||
    type === "question.rejected"
  );
}
