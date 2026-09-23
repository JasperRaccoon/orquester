import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { SYSTEM_ACCOUNT_ID, type AgentConversationsResponse, type CreateSessionRequest, type RegistryResponse, type SessionSummary } from "@orquester/api";
import { agentChatRoutes, RUNTIME_MODES, startedTurns, type AccountHomeKind, type CreateAgentChatSessionFields, type ModelSelection, type RuntimeMode, type StartedTurn, type ThreadActivityItem, type ThreadItem, type ThreadSnapshotPayload, type TurnDiffResponse } from "@orquester/api/agent-chat";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { resolveProject } from "../addressing.ts";
import { conversationLaunch, findAgent, isProxyAgent, launchesProxyModel, loadAgents, resolveModelSelection, validateAccountId, type ResolvedSelection } from "../agents.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError, expectOk } from "../errors.ts";
import { findSession, listSessions, readThread, requireChatSession, sendCommand } from "../reads.ts";
import { fitJsonBytes, jsonBytes, MAX_RESULT_BYTES, resultBytes, toSafeToolError } from "../result.ts";
import { defineTool, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";
import { buildViewContext, chatDetail, sessionView } from "../views.ts";
import { byAttention } from "./watch.ts";

export const MAX_RUNNING_SESSIONS_PER_PROJECT = 24;
const runtimeModeSchema = z.enum(RUNTIME_MODES as unknown as [RuntimeMode, ...RuntimeMode[]]);
const optionsSchema = z.record(z.union([z.string(), z.boolean()])).describe("Model options by id, e.g. {\"effort\":\"high\",\"thinking\":true}. `effort` works for every agent.");
const sessionIdField = z.string().min(1).describe("The session id from list_sessions.");

/**
 * A turn is starting or running. The summary can trail the host by a beat, so the thread head just
 * read counts too — the fields the host's own `identitySwitchRefusal` reads.
 */
function isTurnActive(s: SessionSummary, snap: ThreadSnapshotPayload): boolean {
  if (s.chatSessionStatus === "starting" || s.chatSessionStatus === "running" || s.latestTurn?.state === "running" || s.latestTurn?.state === "pending") return true;
  const { status, activeTurnId } = snap.head.session;
  return status === "starting" || status === "running" || activeTurnId !== null;
}

/** The GUI's `canSwitchChatAccount` / the host's `identitySwitchRefusal`; the host stays authoritative. */
function switchRefusal(s: SessionSummary, snap: ThreadSnapshotPayload): string | null {
  if (isTurnActive(s, snap)) return "Wait for the agent to finish the current turn before switching accounts.";
  if (s.hasPendingApprovals || s.hasPendingUserInput || snap.pending.approvals.length > 0 || snap.pending.userInputs.length > 0) return "Answer the agent's open request before switching accounts.";
  if (s.backgroundLiveness) return "Wait for the background work to finish before switching accounts.";
  return null;
}

function sameSelection(a: ResolvedSelection, b: ModelSelection): boolean {
  const norm = (o: readonly { id: string; value: string | boolean }[] | undefined) => JSON.stringify([...(o ?? [])].sort((x, y) => x.id.localeCompare(y.id)));
  return a.model === b.model && norm(a.options) === norm(b.options);
}

/** An error's detail as fields to merge into ours: an object's own fields; anything else rides as `cause`. */
function detailFields(detail: unknown): Record<string, unknown> {
  if (detail === undefined) return {};
  return detail !== null && typeof detail === "object" && !Array.isArray(detail) ? { ...(detail as Record<string, unknown>) } : { cause: detail };
}

const listSessionsTool = defineTool({
  name: "list_sessions",
  title: "List sessions",
  description: "The open tabs: chat sessions (Claude/Codex/OpenCode/Grok) and terminals, with status (working/waiting/idle), attention and why. `attention:true` returns only sessions that need you, ordered like the Attention Center.",
  input: {
    project: z.string().optional().describe("Absolute project path or \"<workspace>/<project>\"; omit for every project."),
    kind: z.enum(["chat", "terminal", "all"]).default("all").describe("Which tabs to list."),
    attention: z.boolean().default(false).describe("Only sessions with attention set or waiting on you.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    // `!== undefined`, as wait_for_session tests it: an empty project is refused by resolveProject, never "every project".
    const projectPath = args.project !== undefined ? (await resolveProject(api, args.project)).path : undefined;
    const ctx = await buildViewContext(api);
    let sessions = await listSessions(api, projectPath);
    if (args.kind !== "all") sessions = sessions.filter((s) => (args.kind === "chat") === (s.kind === "agent-chat"));
    if (args.attention) {
      sessions = sessions.filter((s) => s.activity && (s.activity.attention !== null || s.activity.state === "waiting"));
      // The Attention Center's order — wait_for_session's own comparator: "what just called for me" first.
      sessions.sort(byAttention);
    } else {
      sessions.sort((a, b) => a.projectPath.localeCompare(b.projectPath) || a.order - b.order);
    }
    return { sessions: sessions.map((s) => sessionView(s, ctx)) };
  }
});

const getSession = defineTool({
  name: "get_session",
  title: "Get session status",
  description: "Everything about one session: status and why, model/options/permission mode/account, pending questions and approvals (with their options and ids), the proposed plan, subagents, the context meter and the last reply.",
  input: { sessionId: sessionIdField },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const summary = await findSession(api, args.sessionId);
    if (summary.kind !== "agent-chat") return { session: sessionView(summary, await buildViewContext(api)) };
    return { session: await chatDetail(api, args.sessionId) };
  }
});

/**
 * The room get_turn_diff's file list always has in the result, in JSON bytes, however big the diff: a turn that
 * regenerated thousands of files would otherwise leave the diff nothing, or push the result past the cap. A diff that
 * leaves more unused (a 400-file rename is almost all file list) gives the list that room instead.
 */
const MIN_DIFF_FILES_BYTES = 20_000;

/** A checkpoint's changed files: the head whose JSON fits `budget` bytes, and how many were left out. */
function fitFiles(files: readonly { path: string; additions: number; deletions: number }[], budget: number): { files: { path: string; additions: number; deletions: number }[]; omitted: number } {
  const kept: { path: string; additions: number; deletions: number }[] = [];
  let used = 2; // the brackets
  for (const f of files) {
    const row = { path: f.path, additions: f.additions, deletions: f.deletions };
    const cost = resultBytes(row) + (kept.length ? 1 : 0); // the separating comma
    if (used + cost > budget) break;
    used += cost;
    kept.push(row);
  }
  return { files: kept, omitted: files.length - kept.length };
}

const getTurnDiff = defineTool({
  name: "get_turn_diff",
  title: "Get a turn's diff",
  description: "The unified diff of the files a turn changed (the GUI's changed-files card). Defaults to the latest turn with a checkpoint. A diff too large for one result is cut at the end (truncated:true); a file list too long is cut too (filesTruncated:true, omittedFiles counts the rest).",
  input: { sessionId: sessionIdField, turn: z.number().int().min(1).optional().describe("Turn number (1-based); default: the latest checkpointed turn.") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    // Checkpoints are keyed by turn ORDINAL and sparse (a non-git project captures nothing);
    // default to the latest turn that has one.
    const latestCheckpointed = snap.checkpoints.reduce((max, c) => Math.max(max, c.checkpointTurnCount), 0);
    const turnCount = args.turn ?? latestCheckpointed;
    if (turnCount < 1) throw new ToolError("INVALID_ARGUMENT", "This session has no checkpointed turn yet.");
    const res = expectOk<TurnDiffResponse>(await api.request("GET", agentChatRoutes.turnDiff(args.sessionId, turnCount), { query: { ignoreWhitespace: "1" } }), "diff");
    const files = snap.checkpoints.find((c) => c.checkpointTurnCount === turnCount)?.files ?? [];
    // The list gets its floor, or all the diff leaves unused of the result beside the frame — the frame counted with the
    // markers a cut list would carry.
    const frame = resultBytes({ turn: res.toTurnCount, fromTurn: res.fromTurnCount, files: [], filesTruncated: true, omittedFiles: files.length, diff: "", truncated: false });
    const listed = fitFiles(files, Math.max(MIN_DIFF_FILES_BYTES, MAX_RESULT_BYTES - frame - jsonBytes(res.diff)));
    const result = { turn: res.toTurnCount, fromTurn: res.fromTurnCount, files: listed.files, ...(listed.omitted ? { filesTruncated: true, omittedFiles: listed.omitted } : {}), diff: "", truncated: false };
    // The diff gets whatever the rest of the result leaves of the result budget, so the whole
    // result survives `ok()` intact instead of being shed to a bare prefix.
    const diff = fitJsonBytes(res.diff, MAX_RESULT_BYTES - Buffer.byteLength(JSON.stringify(result), "utf8"));
    return { ...result, diff: diff.text, truncated: diff.truncated };
  }
});

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** A `cwd` argument: absolute, or relative to the project; an existing directory inside the sandbox. */
async function resolveCwd(api: DaemonApi, projectPath: string, input: string): Promise<string> {
  const cwd = resolve(projectPath, input);
  let real: string;
  try {
    real = await assertInsideFsRoot(api.fsRoot, cwd);
  } catch (error) {
    if (error instanceof FsSandboxError) throw new ToolError("PATH_NOT_ALLOWED", "cwd is not allowed (outside the sandbox).");
    throw error;
  }
  // The sandbox check accepts a path that does not exist yet; a session needs a real directory.
  if (!(await isDirectory(real))) throw new ToolError("INVALID_ARGUMENT", `cwd "${input}" is not an existing directory.`);
  return cwd;
}

interface ResumeRow { id: string; agent: string; title: string; home: AccountHomeKind; accountId?: string }

/**
 * Why the registry disabled an agent (`RegistryEntry.disabledReason` — "proxy down", …), when it says; read only to
 * refuse. It is a second registry read, so any failure of it — a throw, an error status, a body of another shape — only
 * leaves the reason out: the refusal stays INVALID_ARGUMENT, never an INTERNAL. When `AgentView` carries the reason
 * itself (F2), the view `findAgent` returned can answer instead and this read can go.
 */
async function disabledReason(api: DaemonApi, refId: string): Promise<string | undefined> {
  try {
    const res = await api.request("GET", "/api/registry");
    const agents = res.status < 400 ? (res.body as Partial<RegistryResponse> | null)?.agents : undefined;
    const entry: unknown = Array.isArray(agents) ? agents.find((e: unknown) => (e as { id?: unknown } | null)?.id === refId) : undefined;
    const reason = (entry as { disabledReason?: unknown } | undefined)?.disabledReason;
    const text = typeof reason === "string" ? reason.trim().replace(/\.+$/, "") : "";
    return text || undefined;
  } catch {
    return undefined;
  }
}

const createSession = defineTool({
  name: "create_session",
  title: "Open a chat session",
  description: "Open a new chat tab for an agent in a project — the GUI's '+' menu — with model, options (effort…), permission mode and account; or resume a past conversation from list_conversations. Returns the session detail. Send the first message with send_message.",
  input: {
    project: z.string().describe("Absolute project path or \"<workspace>/<project>\"."),
    agent: z.string().min(1).optional().describe("Agent id from list_agents (claude, claudex, claudemix, codex, opencode, grok). Required unless `resume` is given."),
    // min(1): an empty model would read as none, so the default model would launch in its place (agents.ts).
    model: z.string().min(1).optional().describe("Model slug from list_agents; default: the agent's default."),
    options: optionsSchema.optional(),
    runtimeMode: runtimeModeSchema.default("full-access").describe("Permission mode: approval-required (Supervised), auto-accept-edits, auto, full-access."),
    accountId: z.string().optional().describe("A managed account id from list_agents, or \"system\"; default: the family's default account."),
    title: z.string().min(1).max(300).optional().describe("Tab title; default: the agent's name (or the conversation's)."),
    // min(1): an empty cwd resolves to the project itself, the default, which is reading it as omitted.
    cwd: z.string().min(1).optional().describe("Working directory: absolute or relative to the project, an existing directory inside the sandbox; default: the project path."),
    resume: z.object({ conversationId: z.string().min(1).describe("Conversation id from list_conversations for the same project.") }).optional().describe("Resume this conversation (id from list_conversations for the same project). One stored in a managed account's home resumes under that account.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const project = await resolveProject(api, args.project);
    let resumeRow: ResumeRow | undefined;
    if (args.resume) {
      const res = expectOk<AgentConversationsResponse>(await api.request("GET", "/api/agents/conversations", { query: { path: project.path } }), "conversations");
      const row = res.conversations.find((c) => c.id === args.resume!.conversationId);
      if (!row) throw new ToolError("INVALID_ARGUMENT", `No conversation "${args.resume.conversationId}" in this project; pick one from list_conversations.`);
      // A proxy-home transcript belongs to the launcher that owns that home; with none named, plain `claude` would open an
      // empty session in its own HOME — list_conversations reports that row resumable:false, and it is refused here.
      const launch = conversationLaunch(row);
      if (!launch.reachable) throw new ToolError("INVALID_ARGUMENT", `Conversation "${row.id}" is not resumable: it lives in a proxy home with no launcher. Pick a row with resumable: true from list_conversations.`);
      resumeRow = { id: row.id, agent: launch.agent, title: row.title, home: row.home ?? "system", ...(row.accountId ? { accountId: row.accountId } : {}) };
    }
    const refId = args.agent ?? resumeRow?.agent;
    if (!refId) throw new ToolError("INVALID_ARGUMENT", "agent is required (see list_agents).");
    if (resumeRow && args.agent && resumeRow.agent !== args.agent) throw new ToolError("INVALID_ARGUMENT", `Conversation "${resumeRow.id}" belongs to ${resumeRow.agent}, not ${args.agent}.`);
    const agent = findAgent(await loadAgents(api), refId);
    if (!agent.enabled) {
      const reason = await disabledReason(api, refId);
      throw new ToolError("INVALID_ARGUMENT", reason ? `${refId} is not available on this host: ${reason}.` : `${refId} is not available on this host (not installed or disabled).`);
    }
    const selection = resolveModelSelection(agent, { model: args.model, options: args.options });
    let accountId = validateAccountId(agent, args.accountId);
    // The GUI's `resumeAccountId`: a transcript in a managed account's home is visible only from there, so that
    // account is forced. A system-home transcript is visible from every home (each managed home links its history
    // back), so the caller's pick stands and an omitted one stays omitted — the family default, as the GUI's chip
    // pre-selects; forcing System there broke resume whenever the system login was stale.
    if (resumeRow?.home === "account" && resumeRow.accountId) accountId = resumeRow.accountId;
    // The daemon falls back to the family default for claude/codex/grok only; a proxy launcher left without an account
    // runs unpinned. Pin what the "+" menu pre-selects: the seeded family default, else System.
    if (accountId === undefined && isProxyAgent(refId)) accountId = agent.defaultAccountId;
    const cwd = args.cwd === undefined ? project.path : await resolveCwd(api, project.path, args.cwd);
    const running = (await listSessions(api, project.path)).filter((s) => s.status === "running").length;
    if (running >= MAX_RUNNING_SESSIONS_PER_PROJECT) throw new ToolError("SESSION_BUSY", `${running} sessions are open in this project (limit ${MAX_RUNNING_SESSIONS_PER_PROJECT}); close some first.`);
    const chat: CreateAgentChatSessionFields = { ...(accountId ? { accountId } : {}), modelSelection: { model: selection.model, options: selection.options }, runtimeMode: args.runtimeMode };
    if (resumeRow) chat.resume = { home: resumeRow.home, conversationId: resumeRow.id };
    // A top-level model becomes the launch's ANTHROPIC_MODEL: claudex's proxy model, and only that. claudemix never
    // names one — the daemon resolves its own Claude default, as the "+" menu leaves it — so its selection rides `chat`.
    const body: CreateSessionRequest = { kind: "agent-chat", refId, projectPath: project.path, cwd, title: args.title ?? (resumeRow?.title || agent.name), ...(accountId ? { accountId } : {}), ...(launchesProxyModel(refId) ? { model: selection.model } : {}), chat };
    const summary = expectOk<SessionSummary>(await api.request("POST", "/api/sessions", { body }), "create");
    try {
      return { session: await chatDetail(api, summary.id) };
    } catch (error) {
      // The tab exists now: a caller told only that the read failed would retry and open a second one. The failure keeps
      // the code and safe message it would have had (a thrown one is logged, never echoed); the detail names the tab.
      const failure = toSafeToolError(error).structuredContent;
      throw new ToolError(failure.code, `Session ${summary.id} was created but could not be read: ${failure.message}`, { ...detailFields(failure.detail), sessionId: summary.id, created: true });
    }
  }
});

const updateSession = defineTool({
  name: "update_session",
  title: "Update session settings",
  description: "Change what the composer bar holds — model, options (effort…), permission mode, account — and/or rename the tab. Model/permission changes restart a live agent session and are refused while a turn runs unless force:true; an account switch applies on the next message and needs an idle session.",
  input: {
    sessionId: sessionIdField,
    title: z.string().min(1).max(300).optional().describe("New tab title."),
    // min(1): an empty model would read as the session's current one, a silent no-op.
    model: z.string().min(1).optional().describe("Model slug from list_agents."),
    options: optionsSchema.optional(),
    runtimeMode: runtimeModeSchema.optional().describe("Permission mode."),
    accountId: z.string().optional().describe("Managed account id or \"system\"; applied on the next message."),
    force: z.boolean().default(false).describe("Apply model/permission changes even while a turn is running (this cuts the turn).")
  },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    const summary = await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const current = snap.head.modelSelection;
    const wantsSelection = args.model !== undefined || args.options !== undefined;
    // Decided on the registry id first, then the thread's adapter — the GUI's `chatAccountSwitchSupported`.
    if (args.accountId !== undefined && (summary.refId === "opencode" || snap.head.adapter === "opencode")) {
      throw new ToolError("INVALID_ARGUMENT", "OpenCode runs one server per project under the daemon's own identity; it has no per-session account.");
    }
    // The catalogue only when something is checked against it, so a rename or a permission change never depends on
    // it. Legacy models included: a thread whose model has since gone legacy can still change its options.
    const agent = wantsSelection || args.accountId !== undefined ? findAgent(await loadAgents(api, { includeLegacyModels: true }), summary.refId) : null;
    const selection = agent && wantsSelection ? resolveModelSelection(agent, { model: args.model, options: args.options, current }) : undefined;
    const accountId = agent && args.accountId !== undefined ? validateAccountId(agent, args.accountId) : undefined;
    // What would actually change. One /mode body carries model, options and permission mode (atomic on the host).
    const mode: { runtimeMode?: RuntimeMode; modelSelection?: ModelSelection } = {};
    const modeFields: string[] = [];
    if (selection && !sameSelection(selection, current)) {
      // `instanceId` routes the provider instance, not the model: carried unchanged, as the composer does.
      mode.modelSelection = { ...(current.instanceId !== undefined ? { instanceId: current.instanceId } : {}), model: selection.model, options: selection.options };
      if (selection.model !== current.model) modeFields.push("model");
      if (args.options !== undefined || !modeFields.length) modeFields.push("options");
    }
    if (args.runtimeMode !== undefined && args.runtimeMode !== snap.head.runtimeMode) {
      mode.runtimeMode = args.runtimeMode;
      modeFields.push("runtimeMode");
    }
    // Only a real change restarts the agent, so only a real change is refused mid-turn: a field that already holds its
    // value is skipped below and cuts nothing.
    if (modeFields.length && isTurnActive(summary, snap) && !args.force) {
      throw new ToolError("SESSION_BUSY", "A turn is running; changing the model or permission mode restarts the agent and would cut it. Wait, interrupt_session, or pass force:true.");
    }
    // The tab record spells the system identity as an absent id; the wire spells it "system".
    const switchAccount = accountId !== undefined && accountId !== (summary.accountId || SYSTEM_ACCOUNT_ID);
    if (switchAccount) {
      const refusal = switchRefusal(summary, snap);
      if (refusal) throw new ToolError("SESSION_BUSY", refusal);
    }
    // Every check has run. Writes in order; `applied` records only what landed, and rides a mid-way failure's detail.
    const applied: string[] = [];
    try {
      if (args.title !== undefined && args.title !== summary.title) {
        expectOk(await api.request("PUT", `/api/sessions/${encodeURIComponent(args.sessionId)}`, { body: { title: args.title } }), "rename");
        applied.push("title");
      }
      if (modeFields.length) {
        await sendCommand(api, args.sessionId, "mode", mode);
        applied.push(...modeFields);
      }
      if (switchAccount) {
        await sendCommand(api, args.sessionId, "account", { accountId });
        applied.push("accountId");
      }
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(error.code, error.message, { applied, ...(error.detail !== undefined ? { cause: error.detail } : {}) });
      throw error;
    }
    return { applied, session: await chatDetail(api, args.sessionId) };
  }
});

const interruptSession = defineTool({
  name: "interrupt_session",
  title: "Interrupt",
  description: "The GUI's Stop: interrupts the running turn (its pending requests are cancelled); with no turn running, stops every live subagent, background shell and watch loop.",
  input: { sessionId: sessionIdField },
  // Not idempotent: a retry after the turn has stopped goes on to stop the background work.
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    // Name the turn only while the session runs one — read from the same head as the turn id.
    const { status, activeTurnId } = snap.head.session;
    const turnId = status === "running" ? activeTurnId : null;
    const { seq } = await sendCommand(api, args.sessionId, "interrupt", turnId ? { turnId } : {});
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const stopSession = defineTool({
  name: "stop_session",
  title: "Stop the agent process",
  description: "Stop the provider process but keep the tab, its history and resume cursor; the next send_message resumes it. Use it to recover a session whose chat.sessionStatus is error.",
  input: { sessionId: sessionIdField },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const { seq } = await sendCommand(api, args.sessionId, "session/stop", {});
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

const closeSession = defineTool({
  name: "close_session",
  title: "Close a session",
  description: "Close a tab (chat or terminal). A chat's thread is deleted; the provider's own transcript stays resumable via list_conversations for Claude, Codex and Grok (and claudex/claudemix from their proxy homes); OpenCode history is not listed.",
  input: { sessionId: sessionIdField },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    await findSession(api, args.sessionId);
    expectOk(await api.request("DELETE", `/api/sessions/${encodeURIComponent(args.sessionId)}`), "close");
    return { closed: true, sessionId: args.sessionId };
  }
});

/** How long revert_session waits for the host to finish the rewind it accepted. */
export const REWIND_WAIT_MS = 10_000;
/**
 * How long that wait goes without reading the thread again when no bus event about the session wakes it first: a
 * rewind's failure row moves nothing on the session's summary, so no event may ever announce it.
 */
export const REWIND_RECHECK_MS = 1_000;
/** What §5.5 step 6 appends, as an `error` activity, for any rewind that failed (orchestrator.ts `revertEffect`). */
const REVERT_FAILED_ACTIVITY_KIND = "checkpoint.revert.failed";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function isRevertFailure(item: ThreadItem): item is ThreadActivityItem {
  return item.kind === "activity" && item.activityKind === REVERT_FAILED_ACTIVITY_KIND;
}

/**
 * A settled compaction marker of the conversation itself: the GUI's `isCompactionActivity` whose `compactionMarkerState`
 * is `compacted` (packages/ui entries.logic.ts) — a `context-compaction` row unless it says it is still running or
 * failed (an unreadable state is settled: old logs recorded only those), or the legacy `thread.state.changed
 * {state: "compacted"}`. A subagent's own row is not the parent timeline's, which is the one the GUI reads.
 */
function isSettledCompaction(item: ThreadItem): boolean {
  if (item.kind !== "activity" || item.agentId) return false;
  const state = isRecord(item.payload) ? item.payload.state : undefined;
  if (item.activityKind === "context-compaction") return state !== "compacting" && state !== "compaction-failed";
  return item.activityKind === "thread.state.changed" && state === "compacted";
}

/** Where a turn begins among the thread's rows: its user message, else its first row; -1 when none is left. */
function turnOpening(items: readonly ThreadItem[], turn: StartedTurn): number {
  const byMessage = turn.userMessageId === undefined ? -1 : items.findIndex((item) => item.id === turn.userMessageId);
  return byMessage !== -1 ? byMessage : items.findIndex((item) => item.turnId === turn.turnId);
}

/**
 * The fewest turns a rewind may keep. The provider holds nothing from before the thread's LAST settled compaction, so
 * the GUI withholds "rewind to here" on every message before it (rows.logic.ts `buildRevertTurnCountByUserMessageId`,
 * and a history page's `rewindable`), and the adapter would refuse the rollback. Turns are in start order, so the first
 * one that begins after the marker is the earliest a rewind may cut at. 0 when nothing was compacted; the started-turn
 * count when no turn began after it.
 *
 * "Before" and "after" are positions in `snap.items`, the fold's append order, where the GUI sorts its timeline by
 * `createdAt` (entries.logic.ts). For a real log the two agree: the fold appends each row when its event lands in the
 * host's append-only log, and the host stamps the row then; a row updated later keeps both its place and its stamp.
 * A turn with no row left in the window is placed by its own start instead: retention evicts rows but never a turn
 * record and never the marker, so on a long thread an early marker outlives the rows of every turn between it and the
 * window — turns the host rewinds to, and the GUI offers from its history pages.
 */
function fewestKeptTurns(snap: ThreadSnapshotPayload): number {
  let marker = -1;
  for (let i = snap.items.length - 1; i >= 0 && marker === -1; i -= 1) if (isSettledCompaction(snap.items[i]!)) marker = i;
  if (marker === -1) return 0;
  const markedAt = snap.items[marker]!.createdAt;
  const started = startedTurns(snap.turns);
  const first = started.findIndex((turn) => {
    const opening = turnOpening(snap.items, turn);
    return opening !== -1 ? opening > marker : (turn.startedAt ?? turn.requestedAt) > markedAt;
  });
  return first === -1 ? started.length : first;
}

/** send_message's refusal (messages.ts `readyToSend`), worded for a rewind: the agent is waiting on the caller. */
function pendingRefusal(snap: ThreadSnapshotPayload): ToolError | null {
  const { approvals, userInputs } = snap.pending;
  if (!approvals.length && !userInputs.length) return null;
  const open = [
    ...approvals.map((a) => `approval ${a.requestId} (resolve_approval)`),
    ...userInputs.map((q) => `question ${q.requestId} (answer_question${q.dismissible ? " or dismiss_question" : ""})`)
  ];
  return new ToolError("PENDING_REQUEST", `Resolve the agent's open request before rewinding: it is waiting on ${open.join(" and ")}. get_session shows the details.`, { approvals: approvals.map((a) => a.requestId), questions: userInputs.map((q) => q.requestId) });
}

/** A rewind's failure row as the tool's answer: its summary and the host's reason (`payload.detail`), as the GUI shows them. */
function rewindFailed(row: ThreadActivityItem, seq: number): ToolError {
  const reason = isRecord(row.payload) && typeof row.payload.detail === "string" ? row.payload.detail.trim() : "";
  const summary = row.summary.trim() || "Rewind failed";
  return new ToolError("COMMAND_REJECTED", reason ? `${summary}: ${reason}` : `${summary}.`, { seq, activityId: row.id, ...(reason ? { reason } : {}) });
}

/**
 * The host answers `/revert` with `{seq}` long before the rollback runs: that is an effect (orchestrator.ts
 * `revertEffect`), and an adapter's refusal leaves only a `checkpoint.revert.failed` row. So, as the GUI does
 * (`waitForRewind`), the outcome is read off the thread: the rewind landed once at most `keepTurns` turns are started,
 * or the first dropped one is gone (a turn sent right after the rewind cannot hide it); it failed on a failure row that
 * was not there before the POST. The thread is read again on every bus event about the session, else every
 * REWIND_RECHECK_MS — never a fixed sleep — until REWIND_WAIT_MS; a closed request ends the wait at once. The bus
 * listener, the timer and the abort listener are always removed.
 */
async function awaitRewind(ctx: ToolContext, sessionId: string, target: { keepTurns: number; firstDroppedTurnId: string; seq: number }, knownFailures: ReadonlySet<string>): Promise<void> {
  // Elapsed time as wait.ts counts it: the larger of the caller's clock and the monotonic one.
  const startedAt = ctx.now();
  const startedMono = performance.now();
  const remaining = () => REWIND_WAIT_MS - Math.max(ctx.now() - startedAt, performance.now() - startedMono);
  // A retry would take a late failure row of THIS rewind for its own (the row names no command), and get_session shows
  // no failure: so the text says how to tell the outcome instead.
  const inProgress = () => new ToolError("SESSION_BUSY", `The rewind is still in progress — do not call revert_session again. It has landed once get_session's chat.turnCount comes down to keepTurns (${target.keepTurns}); if it failed, read_transcript shows a "Rewind failed" error.`, { seq: target.seq });
  let events = 0;
  let closed = false;
  let wake: (() => void) | null = null;
  const off = ctx.api.subscribe((event) => {
    if (event.channel !== "sessions" || (event.payload as { id?: unknown } | null)?.id !== sessionId) return;
    events += 1;
    if (event.type === "session.closed") closed = true;
    const w = wake;
    wake = null;
    w?.();
  });
  try {
    for (;;) {
      if (closed) throw new ToolError("SESSION_NOT_FOUND", `Session "${sessionId}" was closed while rewinding.`, { seq: target.seq });
      if (ctx.signal.aborted) throw inProgress();
      const seen = events;
      const snap = await readThread(ctx.api, sessionId);
      const started = startedTurns(snap.turns);
      if (started.length <= target.keepTurns || !started.some((turn) => turn.turnId === target.firstDroppedTurnId)) return;
      const failure = snap.items.find((item): item is ThreadActivityItem => isRevertFailure(item) && !knownFailures.has(item.id));
      if (failure) throw rewindFailed(failure, target.seq);
      const left = remaining();
      if (left <= 0 || ctx.signal.aborted) throw inProgress();
      // Nothing about the session moved during that read: wait until something does, or look again shortly.
      if (events === seen) {
        await new Promise<void>((resolve) => {
          const resume = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", resume); wake = null; resolve(); };
          const timer = setTimeout(resume, Math.min(left, REWIND_RECHECK_MS));
          ctx.signal.addEventListener("abort", resume, { once: true });
          wake = resume;
        });
      }
    }
  } finally {
    off();
  }
}

const revertSession = defineTool({
  name: "revert_session",
  title: "Rewind the conversation",
  description: "Rewind the conversation to keep only the first `keepTurns` turns (the GUI's 'Rewind to here'). Conversation only — files are not restored. Refused before the last context compaction, while a request is pending or a turn runs, and without rollback (Grok). Waits up to 10 s for the host: the session once rewound, COMMAND_REJECTED with its reason, or SESSION_BUSY if still going.",
  input: { sessionId: sessionIdField, keepTurns: z.number().int().min(0).describe("Number of turns to keep, counted from the first (0 = rewind to before the first turn; N = keep turns 1..N and discard the rest).") },
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const { api } = ctx;
    const summary = await requireChatSession(api, args.sessionId);
    const snap = await readThread(api, args.sessionId);
    const agent = findAgent(await loadAgents(api), summary.refId);
    if (!agent.supports.rollback) throw new ToolError("INVALID_ARGUMENT", `${summary.refId} does not support conversation rollback.`);
    const started = startedTurns(snap.turns); // turns are counted by START ORDER (turns.ts), never by checkpoints
    if (started.length === 0) throw new ToolError("INVALID_ARGUMENT", "This conversation has no turns to rewind.");
    if (args.keepTurns >= started.length) throw new ToolError("INVALID_ARGUMENT", `keepTurns must be between 0 and ${started.length - 1}: this conversation has ${started.length} started turn${started.length === 1 ? "" : "s"}.`);
    const fewest = fewestKeptTurns(snap);
    if (args.keepTurns < fewest) {
      const why = "Cannot rewind past the last context compaction — the agent no longer holds what came before it";
      throw new ToolError("INVALID_ARGUMENT", fewest < started.length ? `${why}. keepTurns must be between ${fewest} and ${started.length - 1}.` : `${why}, and it happened in the latest turn: there is no turn to rewind to.`);
    }
    if (isTurnActive(summary, snap)) throw new ToolError("SESSION_BUSY", "Stop the current turn before rewinding.");
    const pending = pendingRefusal(snap);
    if (pending) throw pending;
    // Only a failure row that appears after the POST answers this rewind.
    const knownFailures = new Set(snap.items.filter(isRevertFailure).map((item) => item.id));
    const { seq } = await sendCommand(api, args.sessionId, "revert", { targetTurnCount: args.keepTurns });
    try {
      await awaitRewind(ctx, args.sessionId, { keepTurns: args.keepTurns, firstDroppedTurnId: started[args.keepTurns]!.turnId, seq }, knownFailures);
      return { seq, session: await chatDetail(api, args.sessionId) };
    } catch (error) {
      // The host accepted the command: whatever fails after it — a thread read in the wait, the detail read after it —
      // keeps its code and safe message (a thrown one is logged, never echoed) and gains the command's seq.
      const failure = toSafeToolError(error).structuredContent;
      throw new ToolError(failure.code, failure.message, { ...detailFields(failure.detail), seq });
    }
  }
});

const compactSession = defineTool({
  name: "compact_session",
  title: "Compact context",
  description: "Ask the agent to compact its context window (the GUI's 'Compact context'). Refused while a turn runs or on an empty conversation.",
  input: { sessionId: sessionIdField },
  // Not idempotent: a retry compacts again.
  annotations: MUTATING,
  async run(args, { api }) {
    await requireChatSession(api, args.sessionId);
    const { seq } = await sendCommand(api, args.sessionId, "compact", {});
    return { seq, session: await chatDetail(api, args.sessionId) };
  }
});

export const sessionTools: ToolDef[] = [listSessionsTool, getSession, getTurnDiff, createSession, updateSession, interruptSession, stopSession, closeSession, revertSession, compactSession] as ToolDef[];
