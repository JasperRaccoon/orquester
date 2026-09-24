/**
 * Codex adapter — test support (spec §9).
 *
 * Two things live here: a deterministic {@link AdapterContext} so an event
 * stream is byte-stable, and a **scripted mock peer** — a real child process
 * launched through the same `support/spawn.ts` path as the real CLI, speaking
 * the same NDJSON framing. Lifecycle tests drive that, never a stubbed method
 * on the session object, so the transport is under test too.
 *
 * Not a `*.test.ts`, so `pnpm test` does not execute it; it is typechecked
 * with the rest of the package.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AdapterContext, AdapterLogger } from "../../adapter.ts";

// ---------------------------------------------------------------------------
// A deterministic context
// ---------------------------------------------------------------------------

export interface FakeContext {
  context: AdapterContext;
  abort: AbortController;
  rawFrames: { threadId: string; frame: unknown }[];
  logs: { level: string; message: string; detail?: unknown }[];
}

export function createFakeContext(
  overrides: Partial<AdapterContext> & { cwd?: string } = {}
): FakeContext {
  let eventSeq = 0;
  let uuidSeq = 0;
  let clockSeq = 0;
  const abort = new AbortController();
  const rawFrames: FakeContext["rawFrames"] = [];
  const logs: FakeContext["logs"] = [];

  const logger: AdapterLogger = {
    debug: (message, detail) => logs.push({ level: "debug", message, detail }),
    info: (message, detail) => logs.push({ level: "info", message, detail }),
    warn: (message, detail) => logs.push({ level: "warn", message, detail }),
    error: (message, detail) => logs.push({ level: "error", message, detail })
  };

  const context: AdapterContext = {
    logger,
    clock: {
      now: () => new Date(Date.UTC(2026, 8, 21, 0, 0, clockSeq++)),
      nowIso: () => new Date(Date.UTC(2026, 8, 21, 0, 0, 0)).toISOString()
    },
    ids: {
      eventId: () => `ev-${++eventSeq}`,
      messageId: (prefix) => `${prefix}-${++eventSeq}`,
      uuid: () => `uuid-${++uuidSeq}`
    },
    resolveAttachmentPath: (threadId, attachmentId) =>
      Promise.resolve(`/attachments/${threadId}/${attachmentId}`),
    attachmentsDir: (threadId) => `/attachments/${threadId}`,
    logRawFrame: (threadId, frame) => {
      rawFrames.push({ threadId, frame });
    },
    buildEnv: () => ({ PATH: process.env.PATH ?? "", HOME: tmpdir() }),
    resolveBin: () => Promise.resolve(null),
    sessionPath: () => process.env.PATH ?? "",
    tmpDir: () => tmpdir(),
    signal: abort.signal,
    ...overrides
  };

  return { context, abort, rawFrames, logs };
}

// ---------------------------------------------------------------------------
// The scripted mock peer
// ---------------------------------------------------------------------------

/** One programmed turn. */
export type MockTurnScript =
  | { kind: "text"; text: string }
  | { kind: "command-approval"; command: string; availableDecisions?: unknown[] }
  | { kind: "file-change-approval"; path: string; diff: string; /** Stay SILENT this long after the answer, so no notification shields the watchdog. */ holdAfterApprovalMs?: number }
  | { kind: "user-input"; questionId: string; header: string; question: string; options: { label: string; description: string }[]; isOther?: boolean; isBlocking?: boolean; /** Append a question the filter must drop, to exercise the partial-refusal rule. */ withUnrenderable?: boolean }
  | { kind: "elicitation"; serverName: string; message: string }
  | { kind: "mcp-form"; serverName: string; message: string }
  | { kind: "async-questions"; title: string; options: string[] }
  /**
   * Spawn a collab child that keeps running after the parent turn settles —
   * §3.1's "background work outlives the turn". The child is a separate thread
   * on the SAME connection, which is what R3 finding 2 and R6 are about.
   */
  | {
      kind: "spawn-child";
      childThreadId: string;
      /**
       * Leave the PARENT turn running too, so a turn-scoped Stop has both a
       * live child and a live parent — the R3 finding 4 shape.
       */
      keepParentRunning?: boolean;
    }
  | { kind: "silent" }
  /** Start a tool call and go silent: the liveness watchdog's WIDER window. */
  | { kind: "open-tool" }
  | { kind: "exit-mid-turn"; exitCode: number };

/**
 * A goal as the mock's goal store holds it: the app-server's own `ThreadGoal`
 * without `threadId`, which the mock stamps. Unset counters start at 0, and
 * `createdAt`/`updatedAt` at 1 789 950 000 (unix seconds).
 */
export interface MockGoal {
  objective: string;
  /** The app-server's spelling: `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete`. */
  status: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface MockConfig {
  userAgent?: string;
  /** Never answer `initialize`, to exercise the handshake deadline. */
  hangOnInitialize?: boolean;
  /** Exit this many ms after start without answering anything. */
  exitAfterMs?: number;
  exitCode?: number;
  threadId?: string;
  /** `thread/resume` answers an error, exercising the fresh-thread fallback. */
  failResume?: boolean;
  /**
   * `turn/interrupt` answers THIS error instead of acting, whatever the turn
   * id — so a test can drive a failure that is NOT the benign "no active turn"
   * race the adapter is allowed to swallow.
   */
  interruptError?: { code: number; message: string };
  /** Consumed in order; the last one repeats. */
  turns?: MockTurnScript[];
  /** Turn ids handed back by `thread/turns/list`, newest first. */
  historyTurnIds?: string[];
  /**
   * Page `thread/turns/list` like the real server: at most this many turns
   * (fewer when the request's `limit` is smaller) and a `nextCursor` while
   * history remains. Unset, every list answers the whole history in one page.
   */
  turnsPageSize?: number;
  /**
   * What the thread's goal store (`goals_1.sqlite`) holds at start. The mock
   * answers `thread/goal/get|set|clear` against it the way the app-server does
   * — reply first, then `thread/goal/updated {turnId: null}` after a set and
   * `thread/goal/cleared` after a clear that removed something — and sends it
   * as the snapshot after every `thread/resume`. It starts no continuation
   * turns: a test starts its own.
   */
  goal?: MockGoal | null;
  /** `thread/resume` sends no goal snapshot at all — the store unreadable, say. */
  noResumeGoalSnapshot?: boolean;
  /** Every `thread/goal/*` request answers THIS error instead. */
  goalError?: { code: number; message: string };
  /** `thread/goal/set` is never answered: a wedged goal store. */
  hangGoalSet?: boolean;
  /** Every `thread/goal/*` request is handled this many ms late: a slow goal store. */
  goalReplyDelayMs?: number;
  /** The resume's goal snapshot goes out this many ms after the resume's reply. */
  resumeGoalSnapshotDelayMs?: number;
  /**
   * A `thread/goal/set`'s reply goes out alone; 30 ms later an `updated`
   * carrying the goal as it was BEFORE the set — a progress flush queued
   * earlier, trailing the reply — and only then the set's own `updated`.
   */
  staleGoalUpdateAfterSet?: boolean;
  /** `thread/settings/update` answers THIS error instead of `{}`. */
  settingsError?: { code: number; message: string };
  /**
   * `thread/goal/get` is overtaken by a change: the stored goal moves to this
   * status and its `thread/goal/updated` goes out BEFORE the reply, which
   * still carries the goal as it was when the request was read.
   */
  goalMovesDuringGet?: string;
  /** Everything the mock received, appended as NDJSON. */
  logPath: string;
}

/**
 * Write the mock to a fresh temp dir and return its executable path.
 *
 * It is a real executable with a shebang so `spawnProviderChild` launches it
 * exactly as it launches `codex`, argv and all (`app-server` is argv[2] and is
 * ignored).
 */
export function writeMockCodexServer(config: Omit<MockConfig, "logPath">): {
  bin: string;
  dir: string;
  logPath: string;
  received(): MockReceived[];
} {
  const dir = mkdtempSync(join(tmpdir(), "codex-mock-"));
  const logPath = join(dir, "received.ndjson");
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...config, logPath }), "utf8");

  const bin = join(dir, "codex-mock.mjs");
  writeFileSync(bin, MOCK_SERVER_SOURCE.replace("__CONFIG_PATH__", configPath), "utf8");
  chmodSync(bin, 0o755);

  return {
    bin,
    dir,
    logPath,
    received: () => readReceived(logPath)
  };
}

export interface MockReceived {
  method?: string;
  id?: number | string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function readReceived(logPath: string): MockReceived[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MockReceived);
}

// ---------------------------------------------------------------------------
// Waiting on events, never on sleeps (§9)
// ---------------------------------------------------------------------------

/** Collect runtime events into an array and let a test await a predicate. */
export class EventCollector {
  readonly events: RuntimeEvent[] = [];
  private readonly waiters: { match: (event: RuntimeEvent) => boolean; resolve: (event: RuntimeEvent) => void }[] =
    [];

  constructor(source: AsyncIterable<RuntimeEvent>) {
    void (async () => {
      for await (const event of source) {
        this.events.push(event);
        for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.waiters[index]!;
          if (waiter.match(event)) {
            this.waiters.splice(index, 1);
            waiter.resolve(event);
          }
        }
      }
    })();
  }

  /** Resolve with the first (already seen or future) event matching `match`. */
  waitFor(match: (event: RuntimeEvent) => boolean, label = "event"): Promise<RuntimeEvent> {
    const existing = this.events.find(match);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise<RuntimeEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for ${label}; saw: ${this.events.map((e) => e.type).join(", ")}`
          )
        );
      }, 15_000);
      this.waiters.push({
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
  }

  waitForType(type: RuntimeEvent["type"]): Promise<RuntimeEvent> {
    return this.waitFor((event) => event.type === type, type);
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

/** Poll a predicate on the microtask/timer queue. Never a bare sleep. */
export async function waitUntil(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// The mock's source
// ---------------------------------------------------------------------------

const MOCK_SERVER_SOURCE = `#!/usr/bin/env node
// Generated by testing.ts. A minimal, scripted \`codex app-server\` peer:
// NDJSON, one JSON object per line, NO \`jsonrpc\` field — the real framing.
import { appendFileSync, readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("__CONFIG_PATH__", "utf8"));
const log = (record) => {
  try { appendFileSync(config.logPath, JSON.stringify(record) + "\\n"); } catch {}
};

const send = (frame) => { process.stdout.write(JSON.stringify(frame) + "\\n"); };
let serverRequestId = 0;
const pendingServerRequests = new Map();

const threadId = config.threadId ?? "thread-mock-1";
let turnSeq = 0;
let activeTurnId = null;
let turnIndex = 0;
const turnScripts = config.turns ?? [{ kind: "text", text: "ok" }];
const historyTurnIds = config.historyTurnIds ?? [];

if (typeof config.exitAfterMs === "number") {
  setTimeout(() => { process.exit(config.exitCode ?? 0); }, config.exitAfterMs);
}

const threadObject = () => ({
  id: threadId, sessionId: threadId, forkedFromId: null, parentThreadId: null,
  preview: "", ephemeral: false, historyMode: "paginated", modelProvider: "openai",
  model: "gpt-5.5", reasoningEffort: "medium", status: { type: "idle" }, path: null,
  cwd: process.cwd(), cliVersion: "0.154.0", originator: "orquester", source: "vscode",
  canAcceptDirectInput: true, gitInfo: null, name: null, turns: [],
  environments: null, extra: null, section: null, sectionEnteredAt: null, projectId: null,
  createdAt: 0, updatedAt: 0, recencyAt: null, threadSource: null, agentNickname: null,
  agentRole: null, daybreakEnabled: null
});

const threadResponse = () => ({
  thread: threadObject(), model: "gpt-5.5", modelProvider: "openai", serviceTier: null,
  cwd: process.cwd(), runtimeWorkspaceRoots: [], instructionSources: [],
  approvalPolicy: "untrusted", approvalsReviewer: "user",
  sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null,
  reasoningEffort: "medium", multiAgentMode: "explicitRequestOnly"
});

const turnObject = (id, status) => ({
  id, items: [], itemsView: "notLoaded", status, error: null,
  startedAt: 0, completedAt: status === "inProgress" ? null : 1, durationMs: null
});

// The goal store (\`goals_1.sqlite\`): one goal per thread, or none.
let goalClock = 1789950000;
const goalNow = () => ++goalClock;
let goal = config.goal
  ? { tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1789950000, updatedAt: 1789950000, ...config.goal }
  : null;
const goalCopy = () => (goal === null ? null : { threadId, ...goal });
const sendGoalUpdated = (turnId) => send({ method: "thread/goal/updated", params: { threadId, turnId, goal: goalCopy() } });
const sendGoalCleared = () => send({ method: "thread/goal/cleared", params: { threadId } });
const noGoalError = () => ({ code: -32600, message: "cannot update goal for thread " + threadId + ": no goal exists" });
const goalLater = (fn) => {
  if (typeof config.goalReplyDelayMs === "number") { setTimeout(fn, config.goalReplyDelayMs); } else { fn(); }
};

const askServerRequest = (method, params) => new Promise((resolve) => {
  const id = serverRequestId++;
  pendingServerRequests.set(id, resolve);
  send({ id, method, params });
});

async function runTurn(turnId, script) {
  const itemId = "item-" + turnId;
  switch (script.kind) {
    case "text": {
      send({ method: "item/started", params: { item: { type: "agentMessage", id: itemId, text: "", phase: null, memoryCitation: null, delivery: null, questions: null }, threadId, turnId, startedAtMs: 0 } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: script.text } });
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 }, last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } } });
      send({ method: "item/completed", params: { item: { type: "agentMessage", id: itemId, text: script.text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null }, threadId, turnId, completedAtMs: 1 } });
      break;
    }
    case "command-approval": {
      send({ method: "item/started", params: { item: { type: "commandExecution", id: itemId, pluginId: null, scriptPath: null, command: script.command, cwd: process.cwd(), processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }, threadId, turnId, startedAtMs: 0 } });
      send({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
      const reply = await askServerRequest("item/commandExecution/requestApproval", {
        kind: "command", threadId, turnId, itemId, startedAtMs: 0, environmentId: "local",
        command: script.command, cwd: process.cwd(), commandActions: [],
        proposedExecpolicyAmendment: ["ls", "-1"],
        availableDecisions: script.availableDecisions ?? ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls", "-1"] } }, "cancel"]
      });
      send({ method: "serverRequest/resolved", params: { threadId, requestId: 0 } });
      const accepted = reply && reply.result && (reply.result.decision === "accept" || reply.result.decision === "acceptForSession" || (typeof reply.result.decision === "object"));
      send({ method: "item/completed", params: { item: { type: "commandExecution", id: itemId, pluginId: null, scriptPath: null, command: script.command, cwd: process.cwd(), processId: null, source: "unifiedExecStartup", status: accepted ? "completed" : "declined", commandActions: [], aggregatedOutput: accepted ? "a.ts\\n" : null, exitCode: accepted ? 0 : null, durationMs: 5 }, threadId, turnId, completedAtMs: 1 } });
      if (reply && reply.result && reply.result.decision === "cancel") {
        send({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
        send({ method: "turn/completed", params: { threadId, turn: turnObject(turnId, "interrupted") } });
        activeTurnId = null;
        return;
      }
      break;
    }
    case "file-change-approval": {
      send({ method: "item/started", params: { item: { type: "fileChange", id: itemId, changes: [{ path: script.path, kind: { type: "add" }, diff: script.diff }], status: "inProgress" }, threadId, turnId, startedAtMs: 0 } });
      const reply = await askServerRequest("item/fileChange/requestApproval", { threadId, turnId, itemId, startedAtMs: 0, reason: null, grantRoot: null });
      if (script.holdAfterApprovalMs) {
        await new Promise((r) => setTimeout(r, script.holdAfterApprovalMs));
      }
      const accepted = reply && reply.result && reply.result.decision !== "decline" && reply.result.decision !== "cancel";
      send({ method: "item/completed", params: { item: { type: "fileChange", id: itemId, changes: [{ path: script.path, kind: { type: "add" }, diff: script.diff }], status: accepted ? "completed" : "declined" }, threadId, turnId, completedAtMs: 1 } });
      break;
    }
    case "user-input": {
      const reply = await askServerRequest("item/tool/requestUserInput", {
        threadId, turnId, itemId,
        questions: script.withUnrenderable
          ? [
              { id: script.questionId, header: script.header, question: script.question, isOther: script.isOther === true, isSecret: false, options: script.options },
              { id: "unrenderable", header: "H", question: "Q?", isOther: false, isSecret: false, options: null }
            ]
          : [{ id: script.questionId, header: script.header, question: script.question, isOther: script.isOther === true, isSecret: false, options: script.options }],
        isBlocking: script.isBlocking !== false, autoResolutionMs: null
      });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: JSON.stringify(reply && reply.result) } });
      break;
    }
    case "elicitation": {
      await askServerRequest("mcpServer/elicitation/request", {
        threadId, turnId, serverName: script.serverName, mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
        message: script.message, requestedSchema: { type: "object", properties: {} }
      });
      break;
    }
    case "mcp-form": {
      // A GENUINE MCP form: mode "form" like an approval, but no
      // \`codex_approval_kind\` and a non-empty requestedSchema.
      await askServerRequest("mcpServer/elicitation/request", {
        threadId, turnId, serverName: script.serverName, mode: "form",
        _meta: null,
        message: script.message,
        requestedSchema: { type: "object", properties: { branch: { type: "string" } } }
      });
      break;
    }
    case "async-questions": {
      send({ method: "item/completed", params: { item: { type: "agentMessage", id: itemId, text: "Which branch?", phase: "final_answer", memoryCitation: null, delivery: "async", questions: [{ title: script.title, options: script.options }] }, threadId, turnId, completedAtMs: 1 } });
      break;
    }
    case "spawn-child": {
      const child = script.childThreadId;
      // The collab tool call, then the subagent activity that registers the
      // child as live background work, then the child's OWN turn on its own
      // thread id — all on this one connection.
      send({ method: "item/started", params: { item: { type: "subAgentActivity", id: "sub-" + child, kind: "started", agentThreadId: child, agentPath: "/root/" + child }, threadId, turnId, startedAtMs: 0 } });
      send({ method: "turn/started", params: { threadId: child, turn: turnObject(child + "-turn", "inProgress") } });
      if (script.keepParentRunning) { return; }
      // The PARENT turn finishes while the child keeps working.
      send({ method: "turn/completed", params: { threadId, turn: turnObject(turnId, "completed") } });
      activeTurnId = null;
      return;
    }
    case "silent":
      return;
    case "open-tool":
      send({ method: "item/started", params: { item: { type: "commandExecution", id: itemId, pluginId: null, scriptPath: null, command: "sleep 3600", cwd: process.cwd(), processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }, threadId, turnId, startedAtMs: 0 } });
      return;
    case "exit-mid-turn": {
      send({ method: "item/started", params: { item: { type: "commandExecution", id: itemId, pluginId: null, scriptPath: null, command: "sleep 30", cwd: process.cwd(), processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }, threadId, turnId, startedAtMs: 0 } });
      setTimeout(() => { process.exit(script.exitCode); }, 10);
      return;
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: turnObject(turnId, "completed") } });
  activeTurnId = null;
}

function handle(frame) {
  log(frame);
  if (frame.method === undefined && frame.id !== undefined) {
    const resolve = pendingServerRequests.get(frame.id);
    if (resolve) { pendingServerRequests.delete(frame.id); resolve(frame); }
    return;
  }
  const { id, method, params } = frame;
  switch (method) {
    case "initialize":
      if (config.hangOnInitialize) return;
      send({ id, result: { userAgent: "orquester/" + (config.userAgent ?? "0.154.0") + " (test)", codexHome: process.env.CODEX_HOME ?? "/nonexistent", platformFamily: "unix", platformOs: "linux" } });
      return;
    case "initialized":
      return;
    case "thread/start":
      send({ id, result: threadResponse() });
      send({ method: "thread/started", params: { thread: threadObject() } });
      return;
    case "thread/resume":
      if (config.failResume) { send({ id, error: { code: -32600, message: "thread not found" } }); return; }
      send({ id, result: { ...threadResponse(), initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null } });
      // The goal snapshot, after the reply: \`updated\` when there is a goal,
      // \`cleared\` when there is none (fixture 07).
      if (!config.noResumeGoalSnapshot) {
        const snapshot = () => {
          if (goal !== null) { sendGoalUpdated(null); } else { sendGoalCleared(); }
        };
        if (typeof config.resumeGoalSnapshotDelayMs === "number") {
          setTimeout(snapshot, config.resumeGoalSnapshotDelayMs);
        } else {
          snapshot();
        }
      }
      return;
    case "thread/goal/get":
      goalLater(() => {
        if (config.goalError) { send({ id, error: config.goalError }); return; }
        if (config.goalMovesDuringGet && goal !== null) {
          const asRead = goalCopy();
          goal = { ...goal, status: config.goalMovesDuringGet, updatedAt: goalNow() };
          sendGoalUpdated(null);
          send({ id, result: { goal: asRead } });
          return;
        }
        send({ id, result: { goal: goalCopy() } });
      });
      return;
    case "thread/goal/set":
      goalLater(() => {
        if (config.goalError) { send({ id, error: config.goalError }); return; }
        if (config.hangGoalSet) return;
        let objective;
        if (typeof params.objective === "string") {
          objective = params.objective.trim();
          if (objective.length === 0 || objective.length > 4000) {
            send({ id, error: { code: -32600, message: "goal objective must be between 1 and 4000 characters" } });
            return;
          }
        }
        const before = goalCopy();
        const now = goalNow();
        if (goal === null) {
          if (objective === undefined) { send({ id, error: noGoalError() }); return; }
          goal = { objective, status: params.status ?? "active", tokenBudget: typeof params.tokenBudget === "number" ? params.tokenBudget : null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now };
        } else {
          goal = {
            ...goal,
            ...(objective !== undefined ? { objective } : {}),
            ...(params.status !== undefined && params.status !== null ? { status: params.status } : {}),
            ...("tokenBudget" in params ? { tokenBudget: params.tokenBudget ?? null } : {}),
            updatedAt: now
          };
        }
        // The reply first, then the notification — the app-server's order.
        send({ id, result: { goal: goalCopy() } });
        if (config.staleGoalUpdateAfterSet && before !== null) {
          // Queued before the set, delivered a moment after its reply: the
          // reply has been read by the time the stale update lands.
          const after = goalCopy();
          setTimeout(() => {
            send({ method: "thread/goal/updated", params: { threadId, turnId: null, goal: before } });
            send({ method: "thread/goal/updated", params: { threadId, turnId: null, goal: after } });
          }, 30);
          return;
        }
        sendGoalUpdated(null);
      });
      return;
    case "thread/settings/update":
      // Sticky overrides for the thread's subsequent turns; the reply is \`{}\`.
      if (config.settingsError) { send({ id, error: config.settingsError }); return; }
      send({ id, result: {} });
      return;
    case "thread/goal/clear":
      goalLater(() => {
        if (config.goalError) { send({ id, error: config.goalError }); return; }
        const cleared = goal !== null;
        goal = null;
        send({ id, result: { cleared } });
        if (cleared) { sendGoalCleared(); }
      });
      return;
    case "turn/start": {
      const isSteering = activeTurnId !== null;
      const turnId = isSteering ? activeTurnId : (threadId + "-turn-" + ++turnSeq);
      activeTurnId = turnId;
      send({ id, result: { turn: turnObject(turnId, "inProgress") } });
      if (!isSteering) {
        send({ method: "turn/started", params: { threadId, turn: turnObject(turnId, "inProgress") } });
        const script = turnScripts[Math.min(turnIndex, turnScripts.length - 1)];
        turnIndex += 1;
        void runTurn(turnId, script);
      }
      return;
    }
    case "turn/interrupt": {
      if (config.interruptError) { send({ id, error: config.interruptError }); return; }
      if (activeTurnId === null || params.turnId !== activeTurnId) {
        send({ id, error: { code: -32600, message: "no active turn to interrupt" } });
        return;
      }
      const turnId = activeTurnId;
      activeTurnId = null;
      send({ id, result: {} });
      send({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
      send({ method: "turn/completed", params: { threadId, turn: turnObject(turnId, "interrupted") } });
      return;
    }
    case "thread/compact/start": {
      send({ id, result: {} });
      const turnId = threadId + "-compact-" + ++turnSeq;
      activeTurnId = turnId;
      send({ method: "turn/started", params: { threadId, turn: turnObject(turnId, "inProgress") } });
      send({ method: "item/started", params: { item: { type: "contextCompaction", id: "compaction-1" }, threadId, turnId, startedAtMs: 0 } });
      send({ method: "item/completed", params: { item: { type: "contextCompaction", id: "compaction-1" }, threadId, turnId, completedAtMs: 1 } });
      send({ method: "turn/completed", params: { threadId, turn: turnObject(turnId, "completed") } });
      activeTurnId = null;
      return;
    }
    case "thread/turns/list": {
      const all = historyTurnIds.map((tid) => ({ ...turnObject(tid, "completed"), items: [{ type: "agentMessage", id: "i-" + tid, text: tid, phase: "final_answer", memoryCitation: null, delivery: null, questions: null }], itemsView: "full" }));
      if (typeof config.turnsPageSize !== "number") {
        send({ id, result: { data: all, nextCursor: null, backwardsCursor: null } });
        return;
      }
      // The cursor is opaque to the client; here it is the next offset.
      const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
      const size = typeof params.limit === "number" ? Math.min(params.limit, config.turnsPageSize) : config.turnsPageSize;
      const end = Math.min(all.length, start + size);
      send({ id, result: { data: all.slice(start, end), nextCursor: end < all.length ? String(end) : null, backwardsCursor: null } });
      return;
    }
    case "thread/revert":
      send({ id, result: { thread: threadObject(), turnsBackwardsCursor: null, itemsBackwardsCursor: null } });
      send({ method: "thread/reverted", params: { threadId } });
      return;
    case "thread/rollback":
      send({ id, error: { code: -32600, message: "paginated threads do not support thread/rollback" } });
      return;
    case "account/read":
      send({ id, result: { account: { type: "chatgpt", email: "user@example.invalid", planType: "pro" }, requiresOpenaiAuth: true } });
      return;
    case "model/list":
      send({ id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: "GPT-5.5", description: "", modelSpecialty: null, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }, { reasoningEffort: "medium", description: "balanced" }], defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, isDefault: true }], nextCursor: null } });
      return;
    case "skills/list":
      send({ id, result: { data: [{ cwd: process.cwd(), skills: [{ name: "demo", description: "a demo skill", path: "/skills/demo/SKILL.md", scope: "repo", enabled: true, pluginId: null }], errors: [] }] } });
      return;
    case "account/rateLimits/read":
      send({ id, result: { ordinaryUsageAllowed: true, rateLimits: { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1790220221 }, secondary: null, credits: null, individualLimit: null, spendControlReached: false, planType: "pro", rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null } });
      return;
    default:
      send({ id, error: { code: -32600, message: "Invalid request: unknown variant \`" + method + "\`" } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const nl = buffer.indexOf("\\n");
    if (nl === -1) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    try { handle(JSON.parse(line)); } catch (error) { log({ error: String(error), line }); }
  }
});
process.stdin.on("end", () => { process.exit(0); });
`;
