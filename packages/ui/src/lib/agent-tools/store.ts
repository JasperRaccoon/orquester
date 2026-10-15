/**
 * Agent tools in the client (unified MCP design 2026-10-15 §7, §9): the pending Orquester
 * approval cards of each chat, Settings › Agent tools, and each chat's toolsets (the Tools chip).
 *
 * The daemon owns all of it; these copies converge on it the way the secret cards do
 * (`lib/agent-chat/secret-requests.ts`): a **load** when a view mounts or the connection comes
 * back, then the bus — `agentChat.toolApproval` on `sessions` for cards (an `opened` card is the
 * whole summary, a `closed` one its id), and the coarse `agentTools.changed` on `agent-tools`,
 * after which whatever is loaded is read again. A card closed is never brought back by a load that
 * crossed its close.
 *
 * Every payload is read through a parser before it reaches state (AGENTS.md): cards through
 * `parseToolApprovalSummary` (sanitised text, unknown kinds kept as "unknown"), settings and chat
 * toolsets field-wise here. No React import (the hooks are `hooks.ts` and the dock's
 * `use-tool-approvals.ts`).
 */

import { createStore } from "zustand/vanilla";

import {
  AGENT_TOOLS_AGENTS,
  AGENT_TOOLS_CHANGED_EVENT,
  AGENT_TOOLS_CHANNEL,
  isToolsetId,
  TOOL_TIERS,
  TOOLSETS,
  type AgentAdapterId,
  type AgentToolGrant,
  type AgentToolsChangedPayload,
  type AgentToolsetView,
  type AgentToolsResponse,
  type RevokeAgentToolGrantsResponse,
  type ThreadAgentToolsResponse,
  type ToolsetId,
  type ToolsetToolSpec,
  type ToolTier,
  type UpdateAgentToolsSettingsRequest,
  type UpdateThreadAgentToolsRequest
} from "@orquester/api";
import {
  parseToolApprovalSummary,
  sanitizeApprovalLabel,
  TOOL_APPROVAL_EVENT_TYPE,
  type ParsedToolApprovalSummary,
  type ToolApprovalAnswer,
  type ToolApprovalAnswerResponse,
  type ToolApprovalDetailResponse,
  type ToolApprovalListResponse
} from "@orquester/api/agent-chat";

// ---------------------------------------------------------------------------
// Parsers (untrusted wire JSON → typed state)
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function isAgentId(value: unknown): value is AgentAdapterId {
  return typeof value === "string" && (AGENT_TOOLS_AGENTS as readonly string[]).includes(value);
}

function isTier(value: unknown): value is ToolTier {
  return typeof value === "string" && (TOOL_TIERS as readonly string[]).includes(value);
}

/** A grant as the wire shows it, or null. Family and scope a newer daemon names are kept as text. */
export function parseAgentToolGrant(value: unknown): AgentToolGrant | null {
  const record = asRecord(value);
  if (!record) return null;
  const { id, family, scope, projectPath, createdAt } = record;
  if (!nonEmpty(id) || !nonEmpty(family) || !nonEmpty(scope) || typeof projectPath !== "string" || typeof createdAt !== "string") {
    return null;
  }
  const workflowIds = Array.isArray(record.workflowIds) ? record.workflowIds.filter(nonEmpty) : undefined;
  return {
    id,
    family: sanitizeApprovalLabel(family, 64),
    scope: sanitizeApprovalLabel(scope, 32),
    projectPath,
    ...(nonEmpty(record.threadId) ? { threadId: record.threadId } : {}),
    ...(nonEmpty(record.targetProjectPath) ? { targetProjectPath: record.targetProjectPath } : {}),
    ...(workflowIds ? { workflowIds } : {}),
    createdAt,
    ...(typeof record.lastUsedAt === "string" ? { lastUsedAt: record.lastUsedAt } : {})
  };
}

function parseGrants(value: unknown): AgentToolGrant[] {
  return Array.isArray(value) ? value.map(parseAgentToolGrant).filter((grant): grant is AgentToolGrant => grant !== null) : [];
}

/** `{claude: bool, …}` for every matrix agent; a missing or malformed cell takes `fallback`'s. */
function parseAgentBooleans(value: unknown, fallback: Readonly<Record<AgentAdapterId, boolean>>): Record<AgentAdapterId, boolean> {
  const record = asRecord(value) ?? {};
  const out = { ...fallback } as Record<AgentAdapterId, boolean>;
  for (const agent of AGENT_TOOLS_AGENTS) {
    const cell = record[agent];
    if (typeof cell === "boolean") out[agent] = cell;
  }
  return out;
}

function parseToolsetTools(value: unknown, fallback: readonly ToolsetToolSpec[]): ToolsetToolSpec[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.flatMap((entry): ToolsetToolSpec[] => {
    const tool = asRecord(entry);
    return tool && nonEmpty(tool.name) && isTier(tool.tier) ? [{ name: sanitizeApprovalLabel(tool.name, 64), tier: tool.tier }] : [];
  });
}

function parseToolsetView(value: unknown): AgentToolsetView | null {
  const record = asRecord(value);
  // A toolset this build does not know cannot be labelled or set: left out.
  if (!record || !isToolsetId(record.id)) return null;
  const spec = TOOLSETS.find((toolset) => toolset.id === record.id)!;
  const bytes = record.bytes;
  const catalogDefaults = parseAgentBooleans(record.catalogDefaults, spec.defaults);
  return {
    id: spec.id,
    label: typeof record.label === "string" && record.label.trim() ? sanitizeApprovalLabel(record.label, 120) : spec.label,
    // The catalogue's lock wins: a locked toolset is never offered as a switch.
    locked: spec.locked || record.locked === true,
    tools: parseToolsetTools(record.tools, spec.tools),
    ...(typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? { bytes: Math.round(bytes) } : {}),
    catalogDefaults,
    defaults: parseAgentBooleans(record.defaults, catalogDefaults)
  };
}

/** `GET /api/agent-tools` (and the settings `PUT`'s answer), or null when it is not one. */
export function parseAgentToolsResponse(value: unknown): AgentToolsResponse | null {
  const record = asRecord(value);
  if (!record || typeof record.revision !== "number" || !Number.isFinite(record.revision) || !Array.isArray(record.toolsets)) return null;
  const seen = new Set<ToolsetId>();
  const toolsets = record.toolsets
    .map(parseToolsetView)
    .filter((view): view is AgentToolsetView => view !== null && !seen.has(view.id) && (seen.add(view.id), true));
  return {
    revision: record.revision,
    // Fail closed on a malformed switch: read as off only when it says so.
    enabled: record.enabled !== false,
    toolsets,
    grants: parseGrants(record.grants)
  };
}

function parseToolsetBooleans(value: unknown): Partial<Record<ToolsetId, boolean>> {
  const out: Partial<Record<ToolsetId, boolean>> = {};
  for (const [key, cell] of Object.entries(asRecord(value) ?? {})) {
    if (isToolsetId(key) && typeof cell === "boolean") out[key] = cell;
  }
  return out;
}

/** A chat's toolsets (`GET`/`PUT agentChatRoutes.agentTools`), or null — also when it is another chat's. */
export function parseThreadAgentToolsResponse(value: unknown, threadId?: string): ThreadAgentToolsResponse | null {
  const record = asRecord(value);
  if (!record || !nonEmpty(record.threadId) || !isAgentId(record.agent) || !Array.isArray(record.resolved)) return null;
  if (threadId !== undefined && record.threadId !== threadId) return null;
  const resolved = TOOLSETS.map((toolset) => toolset.id).filter((id) => (record.resolved as unknown[]).includes(id));
  // `core` is on in every chat whatever the answer says.
  if (!resolved.includes("core")) resolved.unshift("core");
  const declines: Partial<Record<ToolsetId, string>> = {};
  for (const [key, until] of Object.entries(asRecord(record.declines) ?? {})) {
    if (isToolsetId(key) && typeof until === "string") declines[key] = until;
  }
  return {
    threadId: record.threadId,
    agent: record.agent,
    overrides: parseToolsetBooleans(record.overrides),
    resolved,
    workflowOwned: record.workflowOwned === true,
    appliesAtNextIdle: record.appliesAtNextIdle === true,
    declines,
    grants: parseGrants(record.grants)
  };
}

/** `agentTools.changed`'s payload, or null. */
export function parseAgentToolsChangedPayload(value: unknown): AgentToolsChangedPayload | null {
  const record = asRecord(value);
  if (!record || typeof record.revision !== "number") return null;
  return { revision: record.revision, ...(nonEmpty(record.threadId) ? { threadId: record.threadId } : {}) };
}

// ---------------------------------------------------------------------------
// The routes these stores call — `ApiClient` satisfies them; tests pass fakes.
// ---------------------------------------------------------------------------

export interface ToolApprovalsApi {
  listToolApprovals(sessionId: string, signal?: AbortSignal): Promise<ToolApprovalListResponse>;
  getToolApproval(sessionId: string, approvalId: string, signal?: AbortSignal): Promise<ToolApprovalDetailResponse>;
  answerToolApproval(sessionId: string, approvalId: string, answer: ToolApprovalAnswer): Promise<ToolApprovalAnswerResponse>;
}

export interface AgentToolsApi {
  getAgentTools(signal?: AbortSignal): Promise<AgentToolsResponse>;
  updateAgentToolsSettings(request: UpdateAgentToolsSettingsRequest): Promise<AgentToolsResponse>;
  revokeAgentToolGrant(grantId: string): Promise<void>;
  revokeAgentToolGrants(threadId?: string): Promise<RevokeAgentToolGrantsResponse>;
  getThreadAgentTools(sessionId: string, signal?: AbortSignal): Promise<ThreadAgentToolsResponse>;
  updateThreadAgentTools(sessionId: string, request: UpdateThreadAgentToolsRequest): Promise<ThreadAgentToolsResponse>;
}

/** The HTTP status of a failed request (`ApiError.status`), or null when none came back. */
export function failureStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** The daemon's error code (`{error: {code}}` or `{code}`), or null. */
export function failureCode(error: unknown): string | null {
  const body = (error as { body?: unknown } | null)?.body as { code?: unknown; error?: { code?: unknown } } | null | undefined;
  const code = body?.error?.code ?? body?.code;
  return typeof code === "string" ? code : null;
}

/** The daemon's message for a refusal, sanitised to one line, or null. */
export function failureMessage(error: unknown): string | null {
  const message = (error as { serverMessage?: unknown } | null)?.serverMessage;
  return typeof message === "string" && message.trim() ? sanitizeApprovalLabel(message, 300) : null;
}

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

export interface ToolApprovalsState {
  /** Pending cards by session id, oldest first. */
  bySession: Readonly<Record<string, readonly ParsedToolApprovalSummary[]>>;
}

export const toolApprovalsStore = createStore<ToolApprovalsState>(() => ({ bySession: {} }));

/** Closed card ids: a load that started before the close never revives one. */
const closedApprovals = new Set<string>();
/** Enough to outlive any load in flight; the oldest id goes first past it. */
const CLOSED_IDS_KEPT = 1024;
/** Bumped by a reset: a load answered for the previous connection is dropped. */
let approvalsGeneration = 0;

const NO_APPROVALS: readonly ParsedToolApprovalSummary[] = [];

export function toolApprovalsFor(state: ToolApprovalsState, sessionId: string): readonly ParsedToolApprovalSummary[] {
  return state.bySession[sessionId] ?? NO_APPROVALS;
}

/** Oldest first (spec §7.1: cards stack oldest first); equal times keep their id order. */
function byRequestedAt(a: ParsedToolApprovalSummary, b: ParsedToolApprovalSummary): number {
  return a.requestedAt.localeCompare(b.requestedAt) || a.approvalId.localeCompare(b.approvalId);
}

function setApprovals(sessionId: string, approvals: ParsedToolApprovalSummary[]): void {
  toolApprovalsStore.setState((state) => {
    const bySession = { ...state.bySession };
    if (approvals.length === 0) delete bySession[sessionId];
    else bySession[sessionId] = approvals.sort(byRequestedAt);
    return { bySession };
  });
}

function upsertApproval(approval: ParsedToolApprovalSummary): void {
  if (closedApprovals.has(approval.approvalId)) return;
  const current = toolApprovalsFor(toolApprovalsStore.getState(), approval.threadId);
  setApprovals(approval.threadId, [...current.filter((entry) => entry.approvalId !== approval.approvalId), approval]);
}

function removeApproval(sessionId: string, approvalId: string): void {
  closedApprovals.add(approvalId);
  if (closedApprovals.size > CLOSED_IDS_KEPT) {
    const oldest = closedApprovals.values().next().value;
    if (oldest !== undefined) closedApprovals.delete(oldest);
  }
  const current = toolApprovalsFor(toolApprovalsStore.getState(), sessionId);
  if (current.some((entry) => entry.approvalId === approvalId)) {
    setApprovals(
      sessionId,
      current.filter((entry) => entry.approvalId !== approvalId)
    );
  }
}

/**
 * Apply one `/events` message: `agentChat.toolApproval` `{threadId, opened? | closed?}`. Anything
 * that is not a well-formed card event is ignored; an opened card whose `threadId` is not the
 * event's is ignored too (a card is only ever shown in its own chat).
 */
export function applyToolApprovalEvent(event: { type: string; payload: unknown }): void {
  if (event.type !== TOOL_APPROVAL_EVENT_TYPE) return;
  const payload = asRecord(event.payload);
  if (!payload || !nonEmpty(payload.threadId)) return;
  const threadId = payload.threadId;
  const closed = asRecord(payload.closed);
  if (closed) {
    if (nonEmpty(closed.approvalId)) removeApproval(threadId, closed.approvalId);
    return;
  }
  const opened = parseToolApprovalSummary(payload.opened);
  if (opened && opened.threadId === threadId) upsertApproval(opened);
}

/** The answer was taken, or the card had already ended (404/409): drop it now rather than on the bus. */
export function markToolApprovalClosed(sessionId: string, approvalId: string): void {
  removeApproval(sessionId, approvalId);
}

/**
 * Replace one session's cards with the daemon's list. A card an event opened while the load was in
 * flight is kept; one closed meanwhile stays closed. A failure (an older daemon's 404 included)
 * leaves the copy as it was.
 */
export async function loadToolApprovals(api: ToolApprovalsApi, sessionId: string, signal?: AbortSignal): Promise<void> {
  const startedIn = approvalsGeneration;
  const before = new Set(toolApprovalsFor(toolApprovalsStore.getState(), sessionId).map((entry) => entry.approvalId));
  let response: ToolApprovalListResponse;
  try {
    response = await api.listToolApprovals(sessionId, signal);
  } catch {
    return;
  }
  if (startedIn !== approvalsGeneration || signal?.aborted) return;
  const raw = asRecord(response)?.approvals;
  const listed = (Array.isArray(raw) ? raw : [])
    .map(parseToolApprovalSummary)
    .filter((entry): entry is ParsedToolApprovalSummary => entry !== null && entry.threadId === sessionId)
    .filter((entry) => !closedApprovals.has(entry.approvalId));
  const listedIds = new Set(listed.map((entry) => entry.approvalId));
  const openedMeanwhile = toolApprovalsFor(toolApprovalsStore.getState(), sessionId).filter(
    (entry) => !before.has(entry.approvalId) && !listedIds.has(entry.approvalId)
  );
  setApprovals(sessionId, [...listed, ...openedMeanwhile]);
}

/**
 * One card with its WHOLE preview (`GET toolApproval`), parsed; null when the daemon no longer has
 * it or answered something else. A 404/409 also closes the card here.
 */
export async function fetchToolApprovalDetail(
  api: ToolApprovalsApi,
  sessionId: string,
  approvalId: string,
  signal?: AbortSignal
): Promise<ParsedToolApprovalSummary | null> {
  try {
    const response = await api.getToolApproval(sessionId, approvalId, signal);
    const approval = parseToolApprovalSummary(asRecord(response)?.approval);
    return approval && approval.approvalId === approvalId && approval.threadId === sessionId ? approval : null;
  } catch (error) {
    const status = failureStatus(error);
    if (status === 404 || status === 409) markToolApprovalClosed(sessionId, approvalId);
    throw error;
  }
}

/** A connection switch or sign-out: everything here belonged to the old daemon. */
export function resetToolApprovals(): void {
  approvalsGeneration += 1;
  closedApprovals.clear();
  toolApprovalsStore.setState({ bySession: {} });
}

// ---------------------------------------------------------------------------
// Settings › Agent tools and each chat's toolsets
// ---------------------------------------------------------------------------

export interface ThreadToolsEntry {
  data: ThreadAgentToolsResponse | null;
  /** The last load failed (the chip keeps its last good data). */
  error: string | null;
  /** The daemon has no such route (an older one): the chip hides. */
  unsupported: boolean;
}

export interface AgentToolsState {
  settings: AgentToolsResponse | null;
  settingsLoading: boolean;
  settingsError: string | null;
  /** The daemon has no agent-tools routes (an older one). */
  settingsUnsupported: boolean;
  /** Per chat, for the chats a view watches. */
  threads: Readonly<Record<string, ThreadToolsEntry>>;
}

const INITIAL_AGENT_TOOLS: AgentToolsState = {
  settings: null,
  settingsLoading: false,
  settingsError: null,
  settingsUnsupported: false,
  threads: {}
};

export const agentToolsStore = createStore<AgentToolsState>(() => INITIAL_AGENT_TOOLS);

let toolsGeneration = 0;
/** The client the last load used: what a bus event re-reads with. */
let boundApi: AgentToolsApi | null = null;
/** Whether a view shows the settings (an event then re-reads them). */
let settingsWatchers = 0;
/** Chats a view shows, refcounted: an event re-reads them; an unwatched one is forgotten. */
const threadWatchers = new Map<string, number>();
/** Per target, the newest load: an older answer never overwrites a newer one. */
const loadSeq = new Map<string, number>();

function nextSeq(key: string): number {
  const seq = (loadSeq.get(key) ?? 0) + 1;
  loadSeq.set(key, seq);
  return seq;
}

function isLatest(key: string, seq: number, generation: number): boolean {
  return generation === toolsGeneration && loadSeq.get(key) === seq;
}

function loadFailureText(error: unknown): string {
  return failureMessage(error) ?? "Could not reach the daemon.";
}

function setThread(threadId: string, patch: Partial<ThreadToolsEntry>): void {
  agentToolsStore.setState((state) => {
    const current = state.threads[threadId] ?? { data: null, error: null, unsupported: false };
    return { threads: { ...state.threads, [threadId]: { ...current, ...patch } } };
  });
}

/** Read the settings (Settings › Agent tools). */
export async function loadAgentToolsSettings(api: AgentToolsApi, signal?: AbortSignal): Promise<void> {
  boundApi = api;
  const generation = toolsGeneration;
  const seq = nextSeq("settings");
  agentToolsStore.setState({ settingsLoading: true });
  try {
    const parsed = parseAgentToolsResponse(await api.getAgentTools(signal));
    if (!isLatest("settings", seq, generation) || signal?.aborted) return;
    if (parsed === null) {
      agentToolsStore.setState({ settingsLoading: false, settingsError: "The daemon answered in an unexpected shape." });
      return;
    }
    agentToolsStore.setState({ settings: parsed, settingsLoading: false, settingsError: null, settingsUnsupported: false });
  } catch (error) {
    if (!isLatest("settings", seq, generation) || signal?.aborted) return;
    const unsupported = failureStatus(error) === 404 && failureCode(error) === null;
    agentToolsStore.setState({ settingsLoading: false, settingsError: unsupported ? null : loadFailureText(error), settingsUnsupported: unsupported });
  }
}

/** Read one chat's toolsets (the Tools chip). */
export async function loadThreadAgentTools(api: AgentToolsApi, threadId: string, signal?: AbortSignal): Promise<void> {
  boundApi = api;
  const generation = toolsGeneration;
  const key = `thread:${threadId}`;
  const seq = nextSeq(key);
  try {
    const parsed = parseThreadAgentToolsResponse(await api.getThreadAgentTools(threadId, signal), threadId);
    if (!isLatest(key, seq, generation) || signal?.aborted) return;
    if (parsed === null) {
      setThread(threadId, { error: "The daemon answered in an unexpected shape." });
      return;
    }
    setThread(threadId, { data: parsed, error: null, unsupported: false });
  } catch (error) {
    if (!isLatest(key, seq, generation) || signal?.aborted) return;
    // An older daemon has no such route (a bare 404); a chat it does not know answers a code.
    if (failureStatus(error) === 404 && failureCode(error) === null) setThread(threadId, { unsupported: true, error: null });
    else setThread(threadId, { error: loadFailureText(error) });
  }
}

/**
 * Change the settings. `revision` is the one the user saw; a stale one is refused (409
 * `REVISION_MISMATCH`) and the settings are read again — the caller says so. Resolves with the
 * daemon's answer; rejects with its refusal.
 */
export async function updateAgentToolsSettings(api: AgentToolsApi, request: UpdateAgentToolsSettingsRequest): Promise<void> {
  boundApi = api;
  const generation = toolsGeneration;
  const seq = nextSeq("settings");
  try {
    const parsed = parseAgentToolsResponse(await api.updateAgentToolsSettings(request));
    if (parsed !== null && isLatest("settings", seq, generation)) {
      agentToolsStore.setState({ settings: parsed, settingsError: null });
    }
  } catch (error) {
    if (failureStatus(error) === 409) void loadAgentToolsSettings(api);
    throw error;
  }
  reloadWatchedThreads(api);
}

/** Set (`true`/`false`) or clear (`null` = inherit) a chat's overrides. */
export async function updateThreadAgentTools(api: AgentToolsApi, threadId: string, request: UpdateThreadAgentToolsRequest): Promise<void> {
  boundApi = api;
  const generation = toolsGeneration;
  const key = `thread:${threadId}`;
  const seq = nextSeq(key);
  const parsed = parseThreadAgentToolsResponse(await api.updateThreadAgentTools(threadId, request), threadId);
  if (parsed !== null && isLatest(key, seq, generation)) setThread(threadId, { data: parsed, error: null });
}

/** Revoke one grant (Settings, the Tools chip), then read again what shows grants. */
export async function revokeAgentToolGrant(api: AgentToolsApi, grantId: string): Promise<void> {
  boundApi = api;
  try {
    await api.revokeAgentToolGrant(grantId);
  } catch (error) {
    // Already gone: the lists are stale, not the user.
    if (failureStatus(error) !== 404) throw error;
  }
  refreshAfterGrantChange(api);
}

/** Revoke every grant, or every grant of one chat. */
export async function revokeAgentToolGrants(api: AgentToolsApi, threadId?: string): Promise<number> {
  boundApi = api;
  const response = await api.revokeAgentToolGrants(threadId);
  refreshAfterGrantChange(api);
  const revoked = asRecord(response)?.revoked;
  return typeof revoked === "number" ? revoked : 0;
}

function refreshAfterGrantChange(api: AgentToolsApi): void {
  if (settingsWatchers > 0) void loadAgentToolsSettings(api);
  reloadWatchedThreads(api);
}

function reloadWatchedThreads(api: AgentToolsApi, only?: string): void {
  for (const threadId of threadWatchers.keys()) {
    if (only === undefined || only === threadId) void loadThreadAgentTools(api, threadId);
  }
}

/**
 * Apply one `/events` message on `agent-tools`: `agentTools.changed` re-reads what is shown — the
 * settings when a view shows them, and the chat it names (else every watched chat: a settings or
 * project-grant change moves every chat's resolution).
 */
export function applyAgentToolsEvent(event: { channel?: string; type: string; payload: unknown }): void {
  if (event.channel !== undefined && event.channel !== AGENT_TOOLS_CHANNEL) return;
  if (event.type !== AGENT_TOOLS_CHANGED_EVENT) return;
  const payload = parseAgentToolsChangedPayload(event.payload);
  if (payload === null || boundApi === null) return;
  const api = boundApi;
  if (settingsWatchers > 0) {
    // A settings change this client already holds (its own `PUT`'s answer) needs no second read;
    // a chat's change can still move the grants list, so it always does.
    const current = agentToolsStore.getState().settings;
    if (payload.threadId !== undefined || current === null || current.revision !== payload.revision) {
      void loadAgentToolsSettings(api);
    }
  }
  reloadWatchedThreads(api, payload.threadId);
}

/** A view shows the settings: an event re-reads them while it does. Returns the unwatch. */
export function watchAgentToolsSettings(): () => void {
  settingsWatchers += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    settingsWatchers = Math.max(0, settingsWatchers - 1);
  };
}

/** A view shows a chat's toolsets. Returns the unwatch; the last one forgets the chat. */
export function watchThreadAgentTools(threadId: string): () => void {
  threadWatchers.set(threadId, (threadWatchers.get(threadId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (threadWatchers.get(threadId) ?? 1) - 1;
    if (left > 0) {
      threadWatchers.set(threadId, left);
      return;
    }
    threadWatchers.delete(threadId);
    loadSeq.delete(`thread:${threadId}`);
    agentToolsStore.setState((state) => {
      if (!(threadId in state.threads)) return state;
      const threads = { ...state.threads };
      delete threads[threadId];
      return { threads };
    });
  };
}

/** A connection switch or sign-out: the old daemon's settings, chats and grants go. */
export function resetAgentTools(): void {
  toolsGeneration += 1;
  boundApi = null;
  loadSeq.clear();
  agentToolsStore.setState({ ...INITIAL_AGENT_TOOLS, threads: {} });
}
