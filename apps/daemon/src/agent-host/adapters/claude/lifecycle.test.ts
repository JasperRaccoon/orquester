/**
 * Runtime-level tests: the real adapter, the real normaliser and the real
 * supervision, driven against a **scripted peer** that speaks the Agent SDK's
 * `Query` surface (§9). Nothing here waits on a timer: every deadline is
 * injected through `ClaudeAdapterDeps`, and every wait is on an event.
 *
 * Covered: spawn failure, a missing binary, a CLI below the version gate, a
 * handshake timeout, an exit mid-turn, interrupt ordering with a pending
 * approval, settle-as-cancel, lazy recovery after death, steering, resume,
 * rollback and compaction.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, it } from "node:test";

import type {
  Options as ClaudeQueryOptions,
  CanUseTool,
  Query,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent } from "@orquester/api/agent-chat";
import { HISTORICAL_RAW_SOURCE } from "@orquester/api/agent-chat";

import type { AdapterContext, AgentAdapter, SendTurnResult } from "../../adapter.ts";
import { resumeCursorFor } from "../../orchestration/resume.ts";
import type { ChildExitReason, ProviderChild } from "../../support/spawn.ts";
import { AsyncEventQueue, createDeferred } from "./async-queue.ts";
import type { ClaudeAdapterDeps } from "./deps.ts";
import { countingIds } from "./fixtures.ts";
import { createClaudeAdapterWith } from "./index.ts";
import { BACKGROUND_SHELL_TAIL_INTERVAL_MS } from "./session.ts";

// ---------------------------------------------------------------------------
// The scripted peer
// ---------------------------------------------------------------------------

/**
 * `"ok"` answers with {@link CONTEXT_USAGE_RESPONSE}; `"reject"` is the older
 * CLI that does not implement the control request; `"hang"` never answers, so
 * only the deadline ends the wait; `"absent"` deletes the method entirely, the
 * shape an SDK that predates it has.
 */
type ContextUsageBehaviour = "ok" | "reject" | "hang" | "absent";

const CONTEXT_USAGE_RESPONSE = {
  categories: [
    { name: "Messages", tokens: 8, kind: "used" },
    { name: "Free space", tokens: 984_132, kind: "free" }
  ],
  totalTokens: 15_868,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 2,
  autoCompactThreshold: 967_000,
  isAutoCompactEnabled: true,
  model: "claude-sonnet-5",
  apiUsage: null
};

class ScriptedQuery {
  readonly messages = new AsyncEventQueue<SDKMessage>();
  readonly received: SDKUserMessage[] = [];
  readonly calls: Array<{ op: string; arg?: unknown }> = [];
  readonly options: ClaudeQueryOptions | undefined;
  readonly canUseTool: CanUseTool | undefined;
  readonly initialized = createDeferred<void>();
  readonly contextUsage: ContextUsageBehaviour;
  contextUsageCalls = 0;

  /** Resolves once the peer has been handed a turn. */
  private turnWaiters: Array<() => void> = [];
  private initResolves: boolean;
  interruptReceipt: { still_queued: string[] } = { still_queued: [] };
  closed = false;

  constructor(params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: ClaudeQueryOptions;
    initResolves?: boolean;
    contextUsage?: ContextUsageBehaviour;
  }) {
    this.options = params.options;
    this.canUseTool = params.options?.canUseTool;
    this.initResolves = params.initResolves !== false;
    this.contextUsage = params.contextUsage ?? "ok";
    if (typeof params.prompt !== "string") {
      void this.readPrompt(params.prompt);
    }
  }

  private async readPrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) {
      this.received.push(message);
      const waiters = this.turnWaiters;
      this.turnWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  nextTurn(): Promise<void> {
    return new Promise((resolve) => {
      this.turnWaiters.push(resolve);
    });
  }

  emit(message: SDKMessage): void {
    this.messages.push(message);
  }

  endStream(): void {
    this.messages.close();
  }

  asQuery(): Query {
    const self = this;
    const iterator = this.messages[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      async initializationResult() {
        self.calls.push({ op: "initializationResult" });
        if (!self.initResolves) {
          // Never resolves: the handshake deadline is the only thing that ends
          // this wait.
          return new Promise(() => {});
        }
        self.initialized.resolve();
        return { commands: [], models: [], account: {} };
      },
      async interrupt() {
        self.calls.push({ op: "interrupt" });
        return self.interruptReceipt;
      },
      async setModel(model?: string) {
        self.calls.push({ op: "setModel", arg: model });
      },
      async setPermissionMode(mode: string) {
        self.calls.push({ op: "setPermissionMode", arg: mode });
      },
      async applyFlagSettings(settings: unknown) {
        self.calls.push({ op: "applyFlagSettings", arg: settings });
      },
      ...(this.contextUsage === "absent"
        ? {}
        : {
            async getContextUsage(opts?: { detail?: string }) {
              self.calls.push({ op: "getContextUsage", arg: opts });
              self.contextUsageCalls += 1;
              if (self.contextUsage === "reject") {
                throw new Error("unknown control request subtype: get_context_usage");
              }
              if (self.contextUsage === "hang") {
                return new Promise(() => {});
              }
              // The context grows between calls, as a real one does — so a
              // later refresh is a genuinely new reading and not swallowed by
              // the normaliser's dedupe.
              return {
                ...CONTEXT_USAGE_RESPONSE,
                totalTokens: CONTEXT_USAGE_RESPONSE.totalTokens + (self.contextUsageCalls - 1) * 1_000
              };
            }
          }),
      close() {
        self.calls.push({ op: "close" });
        self.closed = true;
        self.messages.close();
      }
    } as unknown as Query;
  }
}

function probeQuery(): Query {
  return {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    async initializationResult() {
      return {
        commands: [{ name: "review", description: "Review", argumentHint: "" }],
        models: [
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5",
            displayName: "Sonnet",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]
          }
        ],
        account: { email: "user@example.invalid", subscriptionType: "Claude Max", apiProvider: "firstParty" }
      };
    },
    async supportedModels() {
      return [];
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return { rate_limits_available: false, rate_limits: null };
    },
    close() {}
  } as unknown as Query;
}

// ---------------------------------------------------------------------------
// Fake child processes
// ---------------------------------------------------------------------------

function fakeChild(input: { stdout?: string; stderr?: string; code?: number }): ProviderChild {
  const stdout = new EventEmitter() as unknown as ProviderChild["stdout"];
  const stderr = new EventEmitter() as unknown as ProviderChild["stderr"];
  (stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};
  (stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};
  const reason: ChildExitReason = { kind: "exit", code: input.code ?? 0, signal: null };
  const exited = new Promise<ChildExitReason>((resolve) => {
    setImmediate(() => {
      if (input.stdout !== undefined) {
        (stdout as unknown as EventEmitter).emit("data", input.stdout);
      }
      (stdout as unknown as EventEmitter).emit("end");
      if (input.stderr !== undefined) {
        (stderr as unknown as EventEmitter).emit("data", input.stderr);
      }
      (stderr as unknown as EventEmitter).emit("end");
      resolve(reason);
    });
  });
  return {
    pid: 4242,
    stdin: new EventEmitter() as unknown as ProviderChild["stdin"],
    stdout,
    stderr,
    process: new EventEmitter() as unknown as ProviderChild["process"],
    exited,
    hasExited: () => false,
    exitReason: () => null,
    kill: async () => reason
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type EventOf<T extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: T }>;

function findEvent<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T,
  from = 0
): EventOf<T> | undefined {
  return events.slice(from).find((event): event is EventOf<T> => event.type === type);
}

interface Harness {
  adapter: AgentAdapter;
  events: RuntimeEvent[];
  peers: ScriptedQuery[];
  queryOptions: ClaudeQueryOptions[];
  waitFor: <T extends RuntimeEvent["type"]>(type: T, after?: number) => Promise<EventOf<T>>;
  timers: Array<{ fn: () => void; ms: number }>;
  drain: () => Promise<void>;
  /** Moves the injected clock, so a window expires without a real wait (§9). */
  advance: (ms: number) => void;
  /** Every timer handle the adapter cleared, so a leak is visible. */
  clearedTimers: Array<NodeJS.Timeout | number>;
  /** Every `logger.debug` message, in order. */
  debugLines: string[];
}

interface HarnessOptions {
  binaryPath?: string | null;
  version?: string;
  queryThrows?: boolean;
  initResolves?: boolean;
  /**
   * The history worker's stdout. `args` is its argv — `…, method, sessionId,
   * JSON options` — so a test can see which session a call names and where a
   * `forkSession` cuts.
   */
  historyStdout?: (method: string, args: readonly string[]) => string;
  deadlineMs?: number;
  compactDeadlineMs?: number;
  contextUsageDeadlineMs?: number;
  /** How the scripted peer answers `getContextUsage` (§7.6). */
  contextUsage?: ContextUsageBehaviour;
  signal?: AbortSignal;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const events: RuntimeEvent[] = [];
  const peers: ScriptedQuery[] = [];
  const queryOptions: ClaudeQueryOptions[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const clearedTimers: Array<NodeJS.Timeout | number> = [];
  const debugLines: string[] = [];
  const listeners: Array<() => void> = [];

  let nowMs = Date.parse("2026-09-21T00:00:00.000Z");
  const advance = (ms: number): void => {
    nowMs += ms;
  };

  const context: AdapterContext = {
    logger: {
      debug(message) {
        debugLines.push(message);
      },
      info() {},
      warn() {},
      error() {}
    },
    clock: { now: () => new Date(nowMs), nowIso: () => new Date(nowMs).toISOString() },
    ids: countingIds(),
    resolveAttachmentPath: async (_threadId, id) => `/attachments/${id}`,
    attachmentsDir: (threadId) => `/appdir/threads/${threadId}/attachments`,
    logRawFrame: () => {},
    buildEnv: ({ home }) => ({
      PATH: "/usr/bin",
      HOME: "/home/orq",
      TMPDIR: "/tmp",
      ...(home.path.length > 0 ? { CLAUDE_CONFIG_DIR: home.path } : {})
    }),
    resolveBin: async () =>
      options.binaryPath === undefined ? "/usr/local/bin/claude" : options.binaryPath,
    sessionPath: () => "/usr/bin",
    tmpDir: () => "/tmp",
    signal: options.signal ?? new AbortController().signal
  };

  const deps: ClaudeAdapterDeps = {
    query: (params) => {
      queryOptions.push(params.options ?? {});
      if (params.options?.persistSession === false) {
        return probeQuery();
      }
      if (options.queryThrows === true) {
        throw new Error("spawn EACCES: the claude binary is not executable");
      }
      const peer = new ScriptedQuery({
        ...params,
        ...(options.initResolves !== undefined ? { initResolves: options.initResolves } : {}),
        ...(options.contextUsage !== undefined ? { contextUsage: options.contextUsage } : {})
      });
      peers.push(peer);
      return peer.asQuery();
    },
    spawn: (spawnOptions) => {
      if (spawnOptions.args.includes("--version")) {
        return fakeChild({ stdout: `${options.version ?? "2.1.210"} (Claude Code)` });
      }
      const method = spawnOptions.args.find(
        (arg) => arg === "getSessionMessages" || arg === "forkSession"
      );
      return fakeChild({
        stdout: options.historyStdout?.(method ?? "", spawnOptions.args) ?? "[]"
      });
    },
    setTimer: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return timers.length as unknown as NodeJS.Timeout;
    },
    clearTimer: (handle) => {
      clearedTimers.push(handle);
    },
    hostConfigDir: "/host/.claude",
    nodePath: process.execPath,
    deadlines: {
      handshakeMs: options.deadlineMs ?? 50,
      cancelMs: options.deadlineMs ?? 50,
      compactMs: options.compactDeadlineMs ?? 5_000,
      contextUsageMs: options.contextUsageDeadlineMs ?? 50
    }
  };

  const adapter = await createClaudeAdapterWith(context, deps);

  void (async () => {
    for await (const event of adapter.events) {
      events.push(event);
      for (const listener of [...listeners]) {
        listener();
      }
    }
  })();

  const waitFor = <T extends RuntimeEvent["type"]>(type: T, after = 0): Promise<EventOf<T>> =>
    new Promise<EventOf<T>>((resolve, reject) => {
      // A missing event must FAIL the test rather than hang it, so the guard
      // is a real (ref'd) timer that is cleared the moment the event lands.
      let guard: NodeJS.Timeout | undefined;
      const finish = (found: EventOf<T>): void => {
        if (guard !== undefined) {
          clearTimeout(guard);
        }
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        resolve(found);
      };
      const listener = (): void => {
        const found = findEvent(events, type, after);
        if (found) {
          finish(found);
        }
      };
      const immediate = findEvent(events, type, after);
      if (immediate) {
        resolve(immediate);
        return;
      }
      listeners.push(listener);
      guard = setTimeout(() => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        reject(
          new Error(`timed out waiting for ${type}; saw ${events.map((e) => e.type).join(", ")}`)
        );
      }, 5_000);
    });

  const drain = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    adapter,
    events,
    peers,
    queryOptions,
    waitFor,
    timers,
    drain,
    advance,
    clearedTimers,
    debugLines
  };
}

const START = {
  threadId: "thread-1",
  cwd: "/work/project",
  home: { kind: "account" as const, accountId: "acc-1", path: "/homes/acc-1/home" },
  modelSelection: { model: "sonnet" },
  runtimeMode: "approval-required" as const
};

function systemInit(sessionId = "sess-1"): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    model: "claude-sonnet-5",
    permissionMode: "default",
    cwd: "/work/project",
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    plugins: [],
    apiKeySource: "none",
    claude_code_version: "2.1.210",
    output_style: "default",
    uuid: "u-init"
  } as unknown as SDKMessage;
}

function successResult(sessionId = "sess-1"): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    duration_ms: 10,
    duration_api_ms: 10,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    session_id: sessionId,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { "claude-sonnet-5": { contextWindow: 200000 } },
    permission_denials: [],
    terminal_reason: "completed",
    uuid: "u-result"
  } as unknown as SDKMessage;
}

function userRow(uuid: string, text: string): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] }
  };
}

function assistantRow(uuid: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("claude adapter — start failures", () => {
  it("refuses when the binary cannot be resolved", async () => {
    const harness = await makeHarness({ binaryPath: null });
    await assert.rejects(() => harness.adapter.startSession(START), /not installed/);
    assert.equal(harness.adapter.hasSession(START.threadId), false);
  });

  it("refuses a CLI below the minimum version, naming the version needed", async () => {
    const harness = await makeHarness({ version: "2.0.9" });
    await assert.rejects(() => harness.adapter.startSession(START), /2\.1\.121 or newer/);
    assert.equal(harness.adapter.listSessions().length, 0);
  });

  it("a spawn failure settles as an errored exit, not a hang", async () => {
    const harness = await makeHarness({ queryThrows: true });
    await assert.rejects(() => harness.adapter.startSession(START), /EACCES/);
    const exited = await harness.waitFor("session.exited");
    assert.equal(exited.payload.exitKind, "error");
    assert.equal(exited.payload.recoverable, false);
    assert.ok(harness.events.some((event) => event.type === "runtime.error"));
    assert.equal(harness.adapter.hasSession(START.threadId), false);
  });

  it("an expired handshake deadline kills the child instead of staying 'starting'", async () => {
    const harness = await makeHarness({ initResolves: false, deadlineMs: 20 });
    await assert.rejects(() => harness.adapter.startSession(START), /timed out/);
    const exited = await harness.waitFor("session.exited");
    assert.equal(exited.payload.exitKind, "error");
    assert.equal(harness.peers[0]?.closed, true, "the query must be closed on an expired deadline");
    assert.equal(harness.adapter.hasSession(START.threadId), false);
  });
});

describe("claude adapter — turns", () => {
  it("starts, runs a turn and settles it", async () => {
    const harness = await makeHarness();
    const record = await harness.adapter.startSession(START);
    assert.equal(record.status, "ready");
    const peer = harness.peers[0]!;

    const turn = await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "hello",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    // The turn id is stamped on the SDKUserMessage, so the native transcript
    // id equals our turn id (§4.5) — the whole basis of rollback.
    assert.equal(peer.received[0]?.uuid, turn.turnId);
    // The final content block is text, so a typed `/command` still expands.
    const content = peer.received[0]?.message.content as Array<{ type: string }>;
    assert.equal(content.at(-1)?.type, "text");

    peer.emit(systemInit());
    peer.emit(successResult());
    const completed = await harness.waitFor("turn.completed");
    assert.equal(completed.payload.state, "completed");
    assert.equal(completed.turnId, turn.turnId);
    assert.ok(turn.resumeCursor);
  });

  it("steering reuses the active turn rather than opening a second one", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;

    const first = await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "do the thing",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    const second = await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "actually, wait",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    assert.equal(second.turnId, first.turnId, "a steer is not a second turn");
    assert.equal(
      harness.events.filter((event) => event.type === "turn.started").length,
      1
    );
    // The steer rides the same prompt queue, with no uuid of its own.
    assert.equal(peer.received.length, 2);
    assert.equal(peer.received[1]?.uuid, undefined);
  });

  it("plan mode is per turn and restores the session's base mode", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;

    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "plan it",
      attachments: [],
      interactionMode: "plan"
    });
    await peer.nextTurn();
    peer.emit(successResult());
    await harness.waitFor("turn.completed");

    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "now do it",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    const modes = peer.calls.filter((call) => call.op === "setPermissionMode").map((c) => c.arg);
    assert.deepEqual(modes, ["plan", "default"]);
  });

  it("refuses a promptless continuation — Claude does not declare the capability", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    await assert.rejects(
      () =>
        harness.adapter.sendTurn({
          threadId: START.threadId,
          input: "   ",
          attachments: [],
          interactionMode: "default",
          continuation: true
        }),
      /without a prompt/
    );
    assert.equal(harness.adapter.capabilities.promptlessTurnContinuation, undefined);
  });

  it("compaction is the /compact turn and resolves when it settles", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;

    const compaction = harness.adapter.compact(START.threadId);
    await peer.nextTurn();
    const content = peer.received[0]?.message.content as Array<{ type: string; text: string }>;
    assert.equal(content.at(-1)?.text, "/compact");

    peer.emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 34995, post_tokens: 873 },
      session_id: "sess-1",
      uuid: "u-compact"
    } as unknown as SDKMessage);
    peer.emit(successResult());
    await compaction;

    const compacted = findEvent(harness.events, "thread.state.changed");
    assert.ok(compacted);
    assert.equal(harness.adapter.capabilities.compaction.type, "slash-command");
  });
});

describe("claude adapter — approvals", () => {
  async function openApproval(): Promise<{
    harness: Harness;
    peer: ScriptedQuery;
    decision: Promise<unknown>;
    requestId: string;
  }> {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "remove the file",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    const abort = new AbortController();
    const decision = peer.canUseTool!("Bash", { command: "rm -f x" }, {
      signal: abort.signal,
      toolUseID: "toolu_1",
      requestId: "req-abc",
      description: "Remove x",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "rm -f x" }],
          behavior: "allow",
          destination: "localSettings"
        }
      ]
    } as unknown as Parameters<CanUseTool>[2]);
    const opened = await harness.waitFor("request.opened");
    return { harness, peer, decision, requestId: opened.requestId! };
  }

  it("keys the card on the SDK's own request id and uses its description", async () => {
    const { harness, decision, requestId } = await openApproval();
    assert.equal(requestId, "req-abc");
    const opened = findEvent(harness.events, "request.opened");
    assert.equal(opened?.payload.detail, "Remove x");
    assert.equal(opened?.payload.dismissible, false);
    harness.adapter.respondToApproval(START.threadId, requestId, "accept");
    assert.deepEqual(await decision, { behavior: "allow", updatedInput: { command: "rm -f x" } });
  });

  it("acceptForSession rescopes the CLI's suggestion to the session", async () => {
    const { harness, decision, requestId } = await openApproval();
    await harness.adapter.respondToApproval(START.threadId, requestId, "acceptForSession");
    const result = (await decision) as {
      behavior: string;
      updatedPermissions?: Array<{ destination: string }>;
    };
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedPermissions?.map((u) => u.destination), ["session"]);
  });

  it("a redelivered request does not open a second card", async () => {
    const { harness, peer, decision, requestId } = await openApproval();
    const abort = new AbortController();
    const second = peer.canUseTool!("Bash", { command: "rm -f x" }, {
      signal: abort.signal,
      toolUseID: "toolu_1",
      requestId: "req-abc"
    } as unknown as Parameters<CanUseTool>[2]);
    await harness.drain();
    assert.equal(harness.events.filter((event) => event.type === "request.opened").length, 1);
    await harness.adapter.respondToApproval(START.threadId, requestId, "decline");
    assert.equal(((await decision) as { behavior: string }).behavior, "deny");
    assert.equal(((await second) as { behavior: string }).behavior, "deny");
  });

  it("a stop settles the open request as cancel BEFORE it closes the query", async () => {
    const { harness, peer, decision } = await openApproval();
    const before = harness.events.length;
    await harness.adapter.stopSession(START.threadId);

    const tail = harness.events.slice(before).map((event) => event.type);
    const resolvedAt = tail.indexOf("request.resolved");
    const exitedAt = tail.indexOf("session.exited");
    assert.ok(resolvedAt >= 0, `no request.resolved in ${tail.join(", ")}`);
    assert.ok(exitedAt > resolvedAt, "session.exited must be the last word");
    const resolved = findEvent(harness.events, "request.resolved", before);
    assert.equal(resolved?.payload.decision, "cancel");
    // The provider's callback is unparked rather than left awaiting forever.
    assert.equal(((await decision) as { behavior: string }).behavior, "deny");
    assert.equal(peer.closed, true);
    // And the turn never outlives its process.
    const tailTypes = harness.events.slice(before).map((event) => event.type);
    assert.ok(tailTypes.indexOf("turn.completed") < tailTypes.indexOf("session.exited"));
  });

  it("an interrupt settles the pending request before the interrupt RPC", async () => {
    const { harness, peer } = await openApproval();
    const callsBefore = peer.calls.length;
    const before = harness.events.length;
    const interrupt = harness.adapter.interruptTurn(START.threadId);
    await harness.drain();

    const resolved = findEvent(harness.events, "request.resolved", before);
    assert.ok(resolved, "the card is cancelled first — an open prompt would deadlock Stop");
    const interruptCall = peer.calls.slice(callsBefore).find((call) => call.op === "interrupt");
    assert.ok(interruptCall);

    // The receipt was empty, so the session survives once the turn settles.
    peer.emit(successResult());
    await interrupt;
    assert.equal(harness.adapter.hasSession(START.threadId), true);
  });

  it("a non-empty interrupt receipt escalates to closing the query", async () => {
    const { harness, peer } = await openApproval();
    peer.interruptReceipt = { still_queued: ["queued-uuid"] };
    await harness.adapter.interruptTurn(START.threadId);
    assert.equal(peer.closed, true, "Stop means stop: queued work escalates to a process kill");
    assert.equal(harness.adapter.hasSession(START.threadId), false);
  });

  it("an interrupt for a turn that is no longer active is a no-op", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "go",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    const callsBefore = peer.calls.length;
    await harness.adapter.interruptTurn(START.threadId, "some-other-turn");
    assert.equal(peer.calls.slice(callsBefore).some((call) => call.op === "interrupt"), false);
    assert.equal(harness.adapter.hasSession(START.threadId), true);
  });
});

describe("claude adapter — questions", () => {
  it("AskUserQuestion becomes a question and its answer rides back by text", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "ask me",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    const abort = new AbortController();
    const reply = peer.canUseTool!(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Which file?",
            header: "Choice",
            options: [{ label: "a.txt", description: "" }],
            multiSelect: false
          }
        ]
      },
      {
        signal: abort.signal,
        toolUseID: "toolu_q",
        requestId: "req-q"
      } as unknown as Parameters<CanUseTool>[2]
    );
    const requested = await harness.waitFor("user-input.requested");
    assert.equal(requested.payload.questions[0]!.id, "Which file?");

    harness.adapter.respondToUserInput(START.threadId, "req-q", { "Which file?": "a.txt" });
    const result = (await reply) as { behavior: string; updatedInput: { answers: unknown } };
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput.answers, { "Which file?": "a.txt" });
    await harness.waitFor("user-input.resolved");
  });
});

describe("claude adapter — death and recovery", () => {
  it("a stream that ends mid-turn settles the turn and closes live tasks first", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "run a subagent",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    peer.emit({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Explore",
      task_type: "local_agent",
      session_id: "sess-1",
      uuid: "u-task"
    } as unknown as SDKMessage);
    await harness.waitFor("task.started");

    const before = harness.events.length;
    peer.endStream();
    await harness.waitFor("session.exited", before);

    const tail = harness.events.slice(before);
    const types = tail.map((event) => event.type);
    assert.ok(types.includes("task.completed"), types.join(", "));
    const stopped = findEvent(tail, "task.completed");
    assert.equal(stopped?.payload.status, "stopped");
    assert.ok(types.indexOf("task.completed") < types.indexOf("session.exited"));
    assert.ok(types.indexOf("turn.completed") < types.indexOf("session.exited"));
    const completed = findEvent(tail, "turn.completed");
    assert.equal(completed?.payload.state, "interrupted");
    assert.equal(harness.adapter.hasSession(START.threadId), false);
  });

  it("lazy recovery restarts from the persisted cursor", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "one",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    peer.emit(systemInit("7f1c9b02-5d4a-4a2e-9f77-2b1d0c8e4a10"));
    peer.emit(successResult("7f1c9b02-5d4a-4a2e-9f77-2b1d0c8e4a10"));
    await harness.waitFor("turn.completed");

    peer.endStream();
    await harness.waitFor("session.exited");
    assert.equal(harness.adapter.hasSession(START.threadId), false);

    // A crashed session is indistinguishable from a fresh one (§4.1).
    const optionsBefore = harness.queryOptions.length;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "two",
      attachments: [],
      interactionMode: "default"
    });
    assert.equal(harness.adapter.hasSession(START.threadId), true);
    const resumed = harness.queryOptions.slice(optionsBefore).at(-1)!;
    assert.equal(resumed.resume, "7f1c9b02-5d4a-4a2e-9f77-2b1d0c8e4a10", "the new query must resume the native session");
    assert.equal(resumed.sessionId, undefined);
  });

  it("a session started from a cursor resumes instead of minting a session id", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession({
      ...START,
      resumeCursor: {
        threadId: START.threadId,
        resume: "b46b654b-57bb-40e4-8c82-d3536bd06a28",
        turnCount: 1,
        turnStartMessageIds: ["turn-a"]
      }
    });
    const options = harness.queryOptions.at(-1)!;
    assert.equal(options.resume, "b46b654b-57bb-40e4-8c82-d3536bd06a28");
    assert.equal(options.sessionId, undefined);
  });

  it("the §6.1 create-time cursor resumes, and its first turn refreshes it", async () => {
    // The minimal `{threadId, resume}` the host builds from the resume picker.
    // Accepting only the adapter's own full cursor would silently degrade a
    // real resume into a fresh session.
    const conversationId = "b46b654b-57bb-40e4-8c82-d3536bd06a28";
    const harness = await makeHarness();
    await harness.adapter.startSession({
      ...START,
      resumeCursor: resumeCursorFor("claude", START.threadId, conversationId)
    });
    const options = harness.queryOptions.at(-1)!;
    assert.equal(options.resume, conversationId);
    assert.equal(options.sessionId, undefined);

    // The turn runs, and the cursor it returns is the full shape — the fields
    // the minimal form omits are the adapter's to fill in (§4.1).
    const peer = harness.peers[0]!;
    const turn = await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "carry on",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    const cursor = turn.resumeCursor as {
      resume: string;
      turnCount: number;
      turnStartMessageIds: string[];
    };
    assert.equal(cursor.resume, conversationId);
    assert.equal(cursor.turnCount, 1);
    assert.deepEqual(cursor.turnStartMessageIds, [turn.turnId]);

    peer.emit(systemInit(conversationId));
    peer.emit(successResult(conversationId));
    const completed = await harness.waitFor("turn.completed");
    assert.equal(completed.payload.state, "completed");
  });

  it("a cursor that fails its shape check means no resume, never an error", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession({ ...START, resumeCursor: { resume: "-rf" } });
    const options = harness.queryOptions.at(-1)!;
    assert.equal(options.resume, undefined);
    assert.equal(typeof options.sessionId, "string");
  });

  it("the liveness watchdog cancels a silent turn and pauses on a pending request", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "go",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    // A pending approval pauses the watchdog: a turn waiting on a human is not
    // a stalled turn (§3.1).
    const abort = new AbortController();
    void peer.canUseTool!("Bash", { command: "ls" }, {
      signal: abort.signal,
      toolUseID: "t",
      requestId: "req-w"
    } as unknown as Parameters<CanUseTool>[2]);
    await harness.waitFor("request.opened");

    // The window really has elapsed, and the turn really is silent...
    harness.advance(11 * 60_000);
    harness.timers.at(-1)!.fn();
    await harness.drain();
    // ...but a turn waiting on a human is not a stalled turn.
    assert.equal(harness.adapter.hasSession(START.threadId), true, "paused, not cancelled");
    assert.equal(
      harness.events.some(
        (event) => event.type === "runtime.error" && event.payload.message.includes("no activity")
      ),
      false
    );

    harness.adapter.respondToApproval(START.threadId, "req-w", "decline");
    await harness.drain();
    harness.advance(11 * 60_000);
    harness.timers.at(-1)!.fn();
    await harness.drain();
    const error = harness.events.filter((event): event is EventOf<"runtime.error"> => event.type === "runtime.error").find((event) => event.payload.message.includes("no activity"));
    assert.ok(error, "a silent turn is cancelled rather than left 'working'");
    assert.equal(harness.adapter.hasSession(START.threadId), false);
  });
});

describe("claude adapter — rollback", () => {
  const history = [
    {
      type: "user",
      uuid: "turn-a",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "one" }] }
    },
    {
      type: "assistant",
      uuid: "asst-a",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
    },
    {
      type: "user",
      uuid: "turn-b",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "two" }] }
    },
    {
      type: "assistant",
      uuid: "asst-b",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
    }
  ];
  const fork = [
    { ...history[0], uuid: "fork-a" },
    { ...history[1], uuid: "fork-asst-a" }
  ];

  async function twoTurns(harness: Harness): Promise<ScriptedQuery> {
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    for (const text of ["one", "two"]) {
      await harness.adapter.sendTurn({
        threadId: START.threadId,
        input: text,
        attachments: [],
        interactionMode: "default"
      });
      await peer.nextTurn();
      peer.emit(systemInit("b46b654b-57bb-40e4-8c82-d3536bd06a28"));
      peer.emit(successResult("b46b654b-57bb-40e4-8c82-d3536bd06a28"));
      await harness.waitFor("turn.completed", harness.events.length - 1);
    }
    return peer;
  }

  it("forks the native session and restarts on the fork's id", async () => {
    let forkCalls = 0;
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "forkSession") {
          forkCalls += 1;
          return JSON.stringify({ sessionId: "d908c283-1c9a-45ee-9506-3ca4a69c8579" });
        }
        return JSON.stringify(forkCalls === 0 ? history : fork);
      }
    });
    const peer = await twoTurns(harness);
    // The turn ids the adapter minted ARE the native anchors; rewrite the
    // fixture's uuids to match them so the alignment is exercised for real.
    const boundaries = harness.events
      .filter((event) => event.type === "turn.started")
      .map((event) => event.turnId!);
    history[0]!.uuid = boundaries[0]!;
    history[2]!.uuid = boundaries[1]!;
    fork[0]!.uuid = "fork-a";

    const optionsBefore = harness.queryOptions.length;
    const snapshot = await harness.adapter.rollbackThread(START.threadId, 1);
    assert.equal(snapshot.threadId, START.threadId);
    assert.equal(snapshot.turns.length, 1, "one turn is kept");
    const resumed = harness.queryOptions.slice(optionsBefore).at(-1)!;
    assert.equal(resumed.resume, "d908c283-1c9a-45ee-9506-3ca4a69c8579");
    assert.equal(peer.closed, true);
  });

  it("rolling back every turn starts a fresh session rather than forking", async () => {
    const harness = await makeHarness({ historyStdout: () => JSON.stringify(history) });
    await twoTurns(harness);
    const optionsBefore = harness.queryOptions.length;
    const snapshot = await harness.adapter.rollbackThread(START.threadId, 2);
    assert.deepEqual(snapshot.turns, []);
    const restarted = harness.queryOptions.slice(optionsBefore).at(-1)!;
    assert.equal(restarted.resume, undefined);
    assert.equal(typeof restarted.sessionId, "string");
  });

  it("refuses a misaligned fork rather than guessing", async () => {
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "forkSession") {
          return JSON.stringify({ sessionId: "d908c283-1c9a-45ee-9506-3ca4a69c8579" });
        }
        // The fork's retained body differs: role matching alone must not pass.
        return JSON.stringify(history);
      }
    });
    await twoTurns(harness);
    const boundaries = harness.events
      .filter((event) => event.type === "turn.started")
      .map((event) => event.turnId!);
    history[0]!.uuid = boundaries[0]!;
    history[2]!.uuid = boundaries[1]!;
    await assert.rejects(
      () => harness.adapter.rollbackThread(START.threadId, 1),
      /did not preserve the retained turn boundaries/
    );
    // Phase 1 refused, so the live session is untouched.
    assert.equal(harness.adapter.hasSession(START.threadId), true);
  });

  it("rejects a non-integer rewind", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    await assert.rejects(() => harness.adapter.rollbackThread(START.threadId, 0), /integer >= 1/);
  });

  // -------------------------------------------------------------------------
  // By turn id (`RollbackTarget`): the id decides the cut, never the count.
  // -------------------------------------------------------------------------

  const FORK_SESSION = "d908c283-1c9a-45ee-9506-3ca4a69c8579";
  /** The session a history-worker call names: its argv ends `sessionId, json`. */
  const historySession = (args: readonly string[]): string => args[args.length - 2]!;
  /** Where a `forkSession` call cuts. */
  const forkCut = (args: readonly string[]): string =>
    (JSON.parse(args[args.length - 1]!) as { upToMessageId: string }).upToMessageId;
  const startedTurnIds = (harness: Harness): string[] =>
    harness.events
      .filter((event) => event.type === "turn.started")
      .map((event) => event.turnId!);
  interface CursorView {
    resume: string;
    turnStartMessageIds?: Array<string | null>;
    turnBoundaries?: Array<{ turnId: string; uuid: string | null }>;
  }
  /** The cursor the live (restarted) session would persist now. */
  const liveCursor = (harness: Harness): CursorView =>
    harness.adapter.listSessions()[0]!.resumeCursor as CursorView;

  async function runTurn(
    harness: Harness,
    peer: ScriptedQuery,
    text: string,
    sessionId: string
  ): Promise<SendTurnResult> {
    const before = harness.events.length;
    const turn = await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: text,
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    peer.emit(systemInit(sessionId));
    peer.emit(successResult(sessionId));
    await harness.waitFor("turn.completed", before);
    return turn;
  }

  it("by id: keeps the turns before the target, resumes on the fork and closes the old peer", async () => {
    let forkCalls = 0;
    const cuts: string[] = [];
    const harness = await makeHarness({
      historyStdout: (method, args) => {
        if (method === "forkSession") {
          forkCalls += 1;
          cuts.push(forkCut(args));
          return JSON.stringify({ sessionId: FORK_SESSION });
        }
        return JSON.stringify(forkCalls === 0 ? history : fork);
      }
    });
    const peer = await twoTurns(harness);
    const [first, second] = startedTurnIds(harness);
    history[0]!.uuid = first!;
    history[2]!.uuid = second!;

    const optionsBefore = harness.queryOptions.length;
    const snapshot = await harness.adapter.rollbackThread(START.threadId, 1, {
      firstRemovedTurnId: second!,
      droppedTurnIds: [second!],
      retainedTurnIds: [first!]
    });
    assert.deepEqual(
      snapshot.turns.map((turn) => turn.id),
      [first],
      "one turn is kept, under its own id"
    );
    assert.deepEqual(cuts, ["asst-a"], "the fork is cut at the entry before the removed turn");
    const resumed = harness.queryOptions.slice(optionsBefore).at(-1)!;
    assert.equal(resumed.resume, FORK_SESSION);
    assert.equal(peer.closed, true);
    // The kept turn is re-paired onto the fork's rewritten uuid, and the
    // legacy list carries the same uuid for an older host.
    const cursor = liveCursor(harness);
    assert.equal(cursor.resume, FORK_SESSION);
    assert.deepEqual(cursor.turnBoundaries, [{ turnId: first, uuid: "fork-a" }]);
    assert.deepEqual(cursor.turnStartMessageIds, ["fork-a"]);
    assert.equal(harness.debugLines.length, 0, "the host's count agreed with the id");
  });

  it("by id: a count that disagrees with the ids is logged, and the id decides", async () => {
    let forkCalls = 0;
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "forkSession") {
          forkCalls += 1;
          return JSON.stringify({ sessionId: FORK_SESSION });
        }
        return JSON.stringify(forkCalls === 0 ? history : fork);
      }
    });
    await twoTurns(harness);
    const [first, second] = startedTurnIds(harness);
    history[0]!.uuid = first!;
    history[2]!.uuid = second!;

    // Two over this session's two boundaries is "every turn" — a fresh session
    // on the count path. The id says only the second turn goes.
    const optionsBefore = harness.queryOptions.length;
    const snapshot = await harness.adapter.rollbackThread(START.threadId, 2, {
      firstRemovedTurnId: second!,
      droppedTurnIds: [second!],
      retainedTurnIds: [first!]
    });
    assert.deepEqual(snapshot.turns.map((turn) => turn.id), [first]);
    assert.equal(harness.queryOptions.slice(optionsBefore).at(-1)!.resume, FORK_SESSION);
    assert.ok(
      harness.debugLines.some(
        (line) => line.includes("the host counted 2") && line.includes("The id wins")
      ),
      harness.debugLines.join("\n")
    );
  });

  it("by id: a HISTORY turn of a resumed thread is rewindable, cut at its own anchor", async () => {
    const conversationId = "b46b654b-57bb-40e4-8c82-d3536bd06a28";
    let liveTurnId = "LIVE";
    const forks: Array<{ sessionId: string; cut: string }> = [];
    const harness = await makeHarness({
      historyStdout: (method, args) => {
        if (method === "forkSession") {
          forks.push({ sessionId: historySession(args), cut: forkCut(args) });
          return JSON.stringify({ sessionId: FORK_SESSION });
        }
        if (historySession(args) === FORK_SESSION) {
          // The fork keeps the first history turn's BODIES under new uuids.
          return JSON.stringify([
            { ...userRow("hist-1", "old one"), uuid: "fork-h1" },
            { ...assistantRow("hist-a1"), uuid: "fork-ha1" }
          ]);
        }
        // Two turns from before this thread existed, then the live one.
        return JSON.stringify([
          userRow("hist-1", "old one"),
          assistantRow("hist-a1"),
          userRow("hist-2", "old two"),
          assistantRow("hist-a2"),
          userRow(liveTurnId, "new"),
          assistantRow("live-a")
        ]);
      }
    });
    // Resumed from the picker: the cursor names the conversation and nothing
    // else, so neither history turn is a boundary this adapter recorded.
    await harness.adapter.startSession({
      ...START,
      resumeCursor: resumeCursorFor("claude", START.threadId, conversationId)
    });
    const peer = harness.peers[0]!;
    liveTurnId = (await runTurn(harness, peer, "new", conversationId)).turnId;

    // The host's fold holds both projected history turns — their ids are
    // their uuids — and the live one, so a rewind to before `hist-2` drops
    // two. This session recorded ONE boundary: a count of two over it is
    // "every turn", a fresh session that would have lost `hist-1` as well.
    const optionsBefore = harness.queryOptions.length;
    const snapshot = await harness.adapter.rollbackThread(START.threadId, 2, {
      firstRemovedTurnId: "hist-2",
      droppedTurnIds: ["hist-2", liveTurnId],
      retainedTurnIds: ["hist-1"]
    });
    assert.deepEqual(forks, [{ sessionId: conversationId, cut: "hist-a1" }]);
    const resumed = harness.queryOptions.slice(optionsBefore).at(-1)!;
    assert.equal(resumed.resume, FORK_SESSION);
    assert.equal(peer.closed, true);
    // The kept history turn keeps its id, paired onto its fork uuid, so it is
    // still rewindable by id in the forked session.
    const cursor = liveCursor(harness);
    assert.deepEqual(cursor.turnBoundaries, [{ turnId: "hist-1", uuid: "fork-h1" }]);
    assert.deepEqual(cursor.turnStartMessageIds, ["fork-h1"]);
    assert.equal(snapshot.turns.length, 1);
  });

  it("by id: a turn one rewind kept is still rewindable by its own id after the fork", async () => {
    const original = "b46b654b-57bb-40e4-8c82-d3536bd06a28";
    const secondFork = "1cd693b5-c8e4-4947-9523-02599edae9a8";
    const ids: string[] = [];
    let fourthSent = false;
    let forkCount = 0;
    const forks: Array<{ sessionId: string; cut: string }> = [];
    const harness = await makeHarness({
      historyStdout: (method, args) => {
        const sessionId = historySession(args);
        if (method === "forkSession") {
          forks.push({ sessionId, cut: forkCut(args) });
          forkCount += 1;
          return JSON.stringify({ sessionId: forkCount === 1 ? FORK_SESSION : secondFork });
        }
        if (sessionId === secondFork) {
          return JSON.stringify([
            { ...userRow("x", "one"), uuid: "f2-a" },
            { ...assistantRow("x"), uuid: "f2-aa" }
          ]);
        }
        if (sessionId === FORK_SESSION) {
          // Every uuid rewritten; the turn sent on the fork appended once sent.
          return JSON.stringify([
            { ...userRow("x", "one"), uuid: "f1-a" },
            { ...assistantRow("x"), uuid: "f1-aa" },
            { ...userRow("x", "two"), uuid: "f1-b" },
            { ...assistantRow("x"), uuid: "f1-ab" },
            ...(fourthSent ? [userRow(ids[3]!, "four"), assistantRow("a-d")] : [])
          ]);
        }
        return JSON.stringify([
          userRow(ids[0] ?? "A", "one"),
          assistantRow("a-a"),
          userRow(ids[1] ?? "B", "two"),
          assistantRow("a-b"),
          userRow(ids[2] ?? "C", "three"),
          assistantRow("a-c")
        ]);
      }
    });
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    for (const text of ["one", "two", "three"]) {
      await runTurn(harness, peer, text, original);
    }
    ids.push(...startedTurnIds(harness));
    const [a, b, c] = ids;

    await harness.adapter.rollbackThread(START.threadId, 1, {
      firstRemovedTurnId: c!,
      droppedTurnIds: [c!],
      retainedTurnIds: [a!, b!]
    });
    assert.deepEqual(liveCursor(harness).turnBoundaries, [
      { turnId: a, uuid: "f1-a" },
      { turnId: b, uuid: "f1-b" }
    ]);

    const forkedPeer = harness.peers.at(-1)!;
    assert.notEqual(forkedPeer, peer);
    fourthSent = true;
    const fourth = await runTurn(harness, forkedPeer, "four", FORK_SESSION);
    ids.push(fourth.turnId);

    // `b` now starts at `f1-b`, a uuid the host never saw: only the pair the
    // first fork wrote can resolve it.
    const snapshot = await harness.adapter.rollbackThread(START.threadId, 2, {
      firstRemovedTurnId: b!,
      droppedTurnIds: [b!, fourth.turnId],
      retainedTurnIds: [a!]
    });
    assert.deepEqual(forks.slice(1), [{ sessionId: FORK_SESSION, cut: "f1-aa" }]);
    assert.equal(harness.queryOptions.at(-1)!.resume, secondFork);
    assert.equal(forkedPeer.closed, true);
    assert.deepEqual(liveCursor(harness).turnBoundaries, [{ turnId: a, uuid: "f2-a" }]);
    assert.deepEqual(snapshot.turns.map((turn) => turn.id), [a]);
  });

  it("by id: a misaligned fork still refuses, and the live session is untouched", async () => {
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "forkSession") {
          return JSON.stringify({ sessionId: FORK_SESSION });
        }
        // The fork's retained body differs: role matching alone must not pass.
        return JSON.stringify(history);
      }
    });
    await twoTurns(harness);
    const [first, second] = startedTurnIds(harness);
    history[0]!.uuid = first!;
    history[2]!.uuid = second!;
    await assert.rejects(
      () =>
        harness.adapter.rollbackThread(START.threadId, 1, {
          firstRemovedTurnId: second!,
          droppedTurnIds: [second!],
          retainedTurnIds: [first!]
        }),
      /did not preserve the retained turn boundaries/
    );
    assert.equal(harness.adapter.hasSession(START.threadId), true);
  });

  it("by id: an id the transcript cannot place refuses before any fork", async () => {
    let forkCalls = 0;
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "forkSession") {
          forkCalls += 1;
          return JSON.stringify({ sessionId: FORK_SESSION });
        }
        return JSON.stringify(history);
      }
    });
    await twoTurns(harness);
    const [first, second] = startedTurnIds(harness);
    history[0]!.uuid = first!;
    history[2]!.uuid = second!;
    await assert.rejects(
      () =>
        harness.adapter.rollbackThread(START.threadId, 1, {
          firstRemovedTurnId: "turn-nobody-started",
          droppedTurnIds: ["turn-nobody-started"],
          retainedTurnIds: [first!, second!]
        }),
      /turn boundary is unavailable/
    );
    assert.equal(forkCalls, 0, "a refused rewind leaves no orphan fork on disk");
    assert.equal(harness.adapter.hasSession(START.threadId), true);
  });
});

describe("claude adapter — snapshot", () => {
  it("probes without authenticating and publishes the §4.1 shape", async () => {
    const harness = await makeHarness();
    const snapshot = await harness.adapter.refreshSnapshot({ cwd: "/work/project" });
    assert.equal(snapshot.id, "claude");
    assert.deepEqual(snapshot.refIds, ["claude", "claudex", "claudemix"]);
    assert.equal(snapshot.installed, true);
    assert.equal(snapshot.version, "2.1.210");
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.auth.status, "authenticated");
    assert.equal(snapshot.auth.email, "user@example.invalid");
    assert.equal(snapshot.auth.label, "Claude Max");
    assert.ok(snapshot.models.some((model) => model.slug === "sonnet"));
    // `/compact` is synthesised for every provider that can serve it (§4.6.3).
    assert.ok(snapshot.slashCommands.some((command) => command.name === "compact"));
    assert.ok(snapshot.slashCommands.some((command) => command.name === "review"));
    assert.equal(snapshot.capabilities.showPlanModeToggle, true);
    assert.equal(snapshot.capabilities.reportsContextWindow, true);
    assert.equal(snapshot.capabilities.sessionModelSwitch, "in-session");
    // An API-key login has no windows: the bars clear rather than lie.
    assert.equal(snapshot.usageLimits?.unavailable?.reason, "unsupported");
    const probeOptions = harness.queryOptions.find((options) => options.persistSession === false);
    assert.ok(probeOptions, "the probe must use the never-yielding query");
    assert.equal(probeOptions.canUseTool, undefined);
  });

  it("degrades rather than throwing when the CLI is missing", async () => {
    const harness = await makeHarness({ binaryPath: null });
    const snapshot = await harness.adapter.refreshSnapshot();
    assert.equal(snapshot.installed, false);
    assert.equal(snapshot.status, "error");
    assert.ok(snapshot.message?.includes("not installed"));
    assert.ok(snapshot.models.length > 0, "a fallback catalogue keeps the picker usable");
  });

  it("marks a below-minimum CLI degraded and does not probe it", async () => {
    const harness = await makeHarness({ version: "2.0.1" });
    const snapshot = await harness.adapter.refreshSnapshot();
    assert.equal(snapshot.status, "degraded");
    assert.equal(snapshot.versionAdvisory?.status, "behind_latest");
    assert.equal(
      harness.queryOptions.some((options) => options.persistSession === false),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Fix-wave regressions
// ---------------------------------------------------------------------------

describe("claude adapter — fix-wave regressions", () => {
  it("R6 #1: a session-scoped Stop with no running turn stops the background work", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "spawn a watcher",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    peer.emit({
      type: "system",
      subtype: "task_started",
      task_id: "watch-1",
      description: "Monitor the log",
      task_type: "local_bash",
      session_id: "sess-1",
      uuid: "u-task"
    } as unknown as SDKMessage);
    await harness.waitFor("task.started");
    // The turn settles; the watch loop keeps running inside the CLI.
    peer.emit(successResult());
    await harness.waitFor("turn.completed");
    assert.equal(harness.adapter.hasSession(START.threadId), true);

    // §6.2: `/interrupt` is addressed to the SESSION and is valid with no turn
    // running — it is the only way to stop background work.
    const before = harness.events.length;
    await harness.adapter.interruptTurn(START.threadId);

    const tail = harness.events.slice(before);
    const stopped = findEvent(tail, "task.completed");
    assert.ok(stopped, `no task.completed in ${tail.map((e) => e.type).join(", ")}`);
    assert.equal(stopped.payload.status, "stopped");
    assert.equal(stopped.payload.taskId, "watch-1");
    const types = tail.map((event) => event.type);
    assert.ok(types.indexOf("task.completed") < types.indexOf("session.exited"));
    assert.equal(peer.closed, true, "the CLI owns the background work; closing it is the only reach");
    assert.equal(harness.adapter.hasSession(START.threadId), false);
  });

  it("R6 #1: naming a turn that is not running is still a no-op", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.interruptTurn(START.threadId, "some-other-turn");
    assert.equal(peer.closed, false);
    assert.equal(harness.adapter.hasSession(START.threadId), true);
  });

  it("Q1 #12: an already-aborted host signal still stops everything", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const harness = await makeHarness({ signal: aborted.signal });
    // `addEventListener("abort")` on an already-aborted signal never fires, so
    // the adapter has to check `aborted` itself or the event queue is never
    // closed and the ingestion iterator hangs forever.
    let closed = false;
    void (async () => {
      for await (const _event of harness.adapter.events) {
        void _event;
      }
      closed = true;
    })();
    await harness.drain();
    assert.equal(closed, true, "the event stream must end when the host is already stopping");
  });

  it("Q1 #13: a compaction that never settles is bounded, not a permanent wedge", async () => {
    const harness = await makeHarness({ compactDeadlineMs: 20 });
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    const compaction = harness.adapter.compact(START.threadId);
    await peer.nextTurn();
    // The CLI keeps the turn alive and never emits a terminal `result`.
    await assert.rejects(() => compaction, /timed out/);
    assert.ok(
      harness.events.some(
        (event) =>
          event.type === "runtime.warning" && event.payload.message.includes("compacting")
      )
    );
  });

  it("Q1 #14: a rewind during a live turn keeps the right number of turns", async () => {
    const sessionId = "b46b654b-57bb-40e4-8c82-d3536bd06a28";
    // Three human turns, each followed by an assistant reply. The uuids of the
    // three user rows are patched to the turn ids the adapter actually mints.
    const boundaries: string[] = [];
    const makeHistory = (): unknown[] => [
      userRow(boundaries[0] ?? "TURN-A", "one"),
      assistantRow("asst-a"),
      userRow(boundaries[1] ?? "TURN-B", "two"),
      assistantRow("asst-b"),
      userRow(boundaries[2] ?? "TURN-C", "three")
    ];
    let forked = false;
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "forkSession") {
          forked = true;
          return JSON.stringify({ sessionId: "d908c283-1c9a-45ee-9506-3ca4a69c8579" });
        }
        if (!forked) {
          return JSON.stringify(makeHistory());
        }
        // The fork rewrites every uuid but preserves the retained BODIES — the
        // four conversation rows before the removed turn.
        return JSON.stringify([
          { ...userRow(boundaries[0]!, "one"), uuid: "fork-1" },
          { ...assistantRow("asst-a"), uuid: "fork-2" },
          { ...userRow(boundaries[1]!, "two"), uuid: "fork-3" },
          { ...assistantRow("asst-b"), uuid: "fork-4" }
        ]);
      }
    });
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;

    for (const text of ["one", "two"]) {
      await harness.adapter.sendTurn({
        threadId: START.threadId,
        input: text,
        attachments: [],
        interactionMode: "default"
      });
      await peer.nextTurn();
      peer.emit(systemInit(sessionId));
      peer.emit(successResult(sessionId));
      await harness.waitFor("turn.completed", harness.events.length - 1);
    }
    // A third turn that is still RUNNING: `turnStartMessageIds` now leads
    // `turns` by one, which is exactly where the old slice went wrong.
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "three",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    boundaries.push(
      ...harness.events
        .filter((event) => event.type === "turn.started")
        .map((event) => event.turnId!)
    );
    assert.equal(boundaries.length, 3);

    const snapshot = await harness.adapter.rollbackThread(START.threadId, 1);
    // Three boundaries minus one rewound turn = two retained. The old code
    // sliced `turns.length - numTurns` = 1 and seeded one turn fewer than the
    // cursor claimed, so every later rewind targeted the wrong boundary.
    assert.equal(snapshot.turns.length, 2);
  });

  it("Q1 #15 / R3 #5: a rewind across a compaction refuses BEFORE forking", async () => {
    const sessionId = "b46b654b-57bb-40e4-8c82-d3536bd06a28";
    const boundaries: string[] = [];
    let forkCalls = 0;
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "forkSession") {
          forkCalls += 1;
          return JSON.stringify({ sessionId: "d908c283-1c9a-45ee-9506-3ca4a69c8579" });
        }
        return JSON.stringify([
          userRow(boundaries[0] ?? "TURN-A", "one"),
          assistantRow("asst-a"),
          userRow(boundaries[1] ?? "TURN-B", "two")
        ]);
      }
    });
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    for (const text of ["one", "two"]) {
      await harness.adapter.sendTurn({
        threadId: START.threadId,
        input: text,
        attachments: [],
        interactionMode: "default"
      });
      await peer.nextTurn();
      peer.emit(systemInit(sessionId));
      peer.emit(successResult(sessionId));
      await harness.waitFor("turn.completed", harness.events.length - 1);
    }
    boundaries.push(
      ...harness.events
        .filter((event) => event.type === "turn.started")
        .map((event) => event.turnId!)
    );

    // A compaction whose preserved set does NOT contain the rewind anchor.
    peer.emit({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 30_000,
        post_tokens: 900,
        preserved_messages: { anchor_uuid: "x", all_uuids: ["something-else"] }
      },
      session_id: sessionId,
      uuid: "u-compact"
    } as unknown as SDKMessage);
    // The marker is held for exactly one frame so the CLI's summary can ride
    // it, so the next frame is what releases it. The preserved-uuid
    // bookkeeping the rewind reads happened at the boundary itself.
    peer.emit({
      type: "system",
      subtype: "status",
      status: "requesting",
      session_id: sessionId,
      uuid: "u-after-compact"
    } as unknown as SDKMessage);
    await harness.waitFor("thread.state.changed");

    await assert.rejects(
      () => harness.adapter.rollbackThread(START.threadId, 1),
      /compacted after that turn/
    );
    assert.equal(forkCalls, 0, "no orphan fork session may be created by a doomed rewind");
    assert.equal(harness.adapter.hasSession(START.threadId), true);
  });

  it("Q1 #37: a redelivered question does not open a second card", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "ask me",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();

    const input = {
      questions: [
        { question: "Which file?", header: "Choice", options: [{ label: "a.txt", description: "" }] }
      ]
    };
    const options = {
      signal: new AbortController().signal,
      toolUseID: "toolu_q",
      requestId: "req-q"
    } as unknown as Parameters<CanUseTool>[2];
    const first = peer.canUseTool!("AskUserQuestion", input, options);
    await harness.waitFor("user-input.requested");
    const second = peer.canUseTool!("AskUserQuestion", input, options);
    await harness.drain();

    assert.equal(harness.events.filter((e) => e.type === "user-input.requested").length, 1);
    harness.adapter.respondToUserInput(START.threadId, "req-q", { "Which file?": "a.txt" });
    // BOTH deliveries settle: the old code dropped the first deferred, parking
    // that control request forever.
    assert.equal(((await first) as { behavior: string }).behavior, "allow");
    assert.equal(((await second) as { behavior: string }).behavior, "allow");
  });

  it("R3 #8: an undeclared dialog kind is not answered at all", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const onUserDialog = harness.queryOptions.at(-1)!.onUserDialog!;
    const answer = await onUserDialog(
      { dialogKind: "something_new", payload: {} },
      { signal: new AbortController().signal, requestId: "req-d" }
    );
    // `{behavior:"cancelled"}` is a real settlement the SDK forbids here.
    assert.equal(answer, null);
  });

  it("R2-1: the per-cwd overlay carries the machine command list", async () => {
    const harness = await makeHarness();
    const snapshot = await harness.adapter.refreshSnapshot({ cwd: "/work/project" });
    const overlay = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === "/work/project");
    assert.ok(overlay, "the per-cwd overlay must exist");
    // The client resolves `overlay.slashCommands ?? provider.slashCommands`, and
    // `??` does not fall back on an empty array — an empty overlay left the tab
    // with no provider commands at all.
    assert.ok(overlay.slashCommands.length > 0);
    assert.ok(overlay.slashCommands.some((command) => command.name === "compact"));
    assert.ok(overlay.slashCommands.some((command) => command.name === "review"));
  });

  it("R3 #13: the probe runs under the account home when one is named", async () => {
    const harness = await makeHarness();
    await harness.adapter.refreshSnapshot({
      cwd: "/work/project",
      home: { kind: "account", accountId: "acc-1", path: "/homes/acc-1/home" }
    });
    const probeOptions = harness.queryOptions.filter((o) => o.persistSession === false).at(-1)!;
    assert.equal(probeOptions.env?.CLAUDE_CONFIG_DIR, "/homes/acc-1/home");
  });

  it("Q1 #35: two probes with different keys do not share one in-flight result", async () => {
    const harness = await makeHarness();
    const [wide, scoped] = await Promise.all([
      harness.adapter.refreshSnapshot(),
      harness.adapter.refreshSnapshot({ cwd: "/work/project" })
    ]);
    assert.equal(wide.workspaceSnapshots?.some((e) => e.cwd === "/work/project") ?? false, false);
    assert.ok(scoped.workspaceSnapshots?.some((entry) => entry.cwd === "/work/project"));
  });

  it("Q1 #36: stop() clears its guard timer", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const clearedBefore = harness.clearedTimers.length;
    await harness.adapter.stopSession(START.threadId);
    assert.ok(
      harness.clearedTimers.length > clearedBefore,
      "a ref'd guard timer left behind holds the event loop open at shutdown"
    );
  });

  it("Q1 #38: a cursor naming another thread is rejected", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession({
      ...START,
      resumeCursor: {
        threadId: "some-other-thread",
        resume: "b46b654b-57bb-40e4-8c82-d3536bd06a28"
      }
    });
    const options = harness.queryOptions.at(-1)!;
    assert.equal(options.resume, undefined, "a cursor copied onto the wrong thread must not resume");
    assert.equal(typeof options.sessionId, "string");
  });

  it("a supervised start launches supervised — no permission mode, no skip flag", async () => {
    // The runtime mode is the only authority. The `claude` registry row's
    // TERMINAL argv (`--dangerously-skip-permissions --effort max --verbose`)
    // used to reach this start and was folded into `bypassPermissions`, so the
    // permission chip did nothing.
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const options = harness.queryOptions.at(-1)!;
    assert.equal(START.runtimeMode, "approval-required");
    assert.equal(options.permissionMode, undefined);
    assert.equal(options.allowDangerouslySkipPermissions, undefined);
    // Only the flag the adapter authors itself; no terminal flag rides along.
    assert.deepEqual(options.extraArgs, { "thinking-display": "summarized" });
  });
});

describe("claude adapter — a resumed thread has a timeline (E6)", () => {
  const conversationId = "b46b654b-57bb-40e4-8c82-d3536bd06a28";
  const transcript = [
    userRow("turn-a", "what is the capital of France?"),
    assistantRow("asst-a"),
    userRow("turn-b", "and of Spain?"),
    assistantRow("asst-b")
  ];

  it("reads the native transcript and projects it", async () => {
    let reads = 0;
    const harness = await makeHarness({
      historyStdout: (method) => {
        if (method === "getSessionMessages") {
          reads += 1;
          return JSON.stringify(transcript);
        }
        return "{}";
      }
    });
    await harness.adapter.startSession({
      ...START,
      resumeCursor: { threadId: START.threadId, resume: conversationId }
    });

    // A resume replays NOTHING onto the stream, so the in-memory turns are
    // empty and the snapshot has to come from the provider's own transcript.
    assert.equal(
      harness.events.some((event) => event.type === "turn.started"),
      false
    );
    const snapshot = await harness.adapter.readThread(START.threadId);
    assert.equal(reads, 1);
    assert.deepEqual(
      snapshot.turns.map((turn) => turn.id),
      ["turn-a", "turn-b"]
    );

    const projected = harness.adapter.projectHistory!(snapshot);
    assert.equal(projected.filter((event) => event.type === "turn.started").length, 2);
    assert.equal(projected.filter((event) => event.type === "turn.completed").length, 2);
    assert.ok(projected.every((event) => event.raw?.source === HISTORICAL_RAW_SOURCE));
    const texts = projected
      .filter(
        (event): event is EventOf<"item.completed"> =>
          event.type === "item.completed" && event.payload.itemType === "user_message"
      )
      .map((event) => (event.payload.data as { text: string }).text);
    assert.deepEqual(texts, ["what is the capital of France?", "and of Spain?"]);
  });

  it("a session started fresh reads no transcript at all", async () => {
    let reads = 0;
    const harness = await makeHarness({
      historyStdout: () => {
        reads += 1;
        return JSON.stringify(transcript);
      }
    });
    await harness.adapter.startSession(START);
    const snapshot = await harness.adapter.readThread(START.threadId);
    // Nothing has been written under that fresh session id, so spawning a
    // worker for it would be pure waste.
    assert.equal(reads, 0);
    assert.deepEqual(snapshot.turns, []);
    assert.deepEqual(harness.adapter.projectHistory!(snapshot), []);
  });

  it("an unreadable transcript degrades to an empty timeline, never an error", async () => {
    const harness = await makeHarness({ historyStdout: () => "not json at all" });
    await harness.adapter.startSession({
      ...START,
      resumeCursor: { threadId: START.threadId, resume: conversationId }
    });
    const snapshot = await harness.adapter.readThread(START.threadId);
    assert.deepEqual(snapshot.turns, []);
  });
});

// ---------------------------------------------------------------------------
// Background shells
// ---------------------------------------------------------------------------

const SHELL_TASK = "bvf4wz8g5";
const SHELL_TOOL_USE = "toolu_01St";

function bashToolUse(command: string): SDKMessage {
  return {
    type: "stream_event",
    uuid: "u-bash",
    session_id: "sess-1",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: SHELL_TOOL_USE,
        name: "Bash",
        input: { command, description: "Run the suites", run_in_background: true }
      }
    }
  } as unknown as SDKMessage;
}

function backgroundTaskStarted(): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: SHELL_TASK,
    tool_use_id: SHELL_TOOL_USE,
    description: "Run the suites",
    is_backgrounded: true,
    task_type: "local_bash",
    session_id: "sess-1",
    uuid: "u-task"
  } as unknown as SDKMessage;
}

function launchPlaceholder(outputFile: string): SDKMessage {
  return {
    type: "user",
    uuid: "u-launch",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: SHELL_TOOL_USE,
          is_error: false,
          content: `Command running in background with ID: ${SHELL_TASK}. Output is being written to: ${outputFile}. You will be notified when it completes. To check interim output, use Read on that file path.`
        }
      ]
    }
  } as unknown as SDKMessage;
}

/** Fire the most recently scheduled tail poll. */
function firePendingTail(harness: Harness): void {
  for (let index = harness.timers.length - 1; index >= 0; index -= 1) {
    const entry = harness.timers[index]!;
    if (entry.ms === BACKGROUND_SHELL_TAIL_INTERVAL_MS) {
      entry.fn();
      return;
    }
  }
  throw new Error("no background-shell tail poll was scheduled");
}

describe("claude adapter — background shells", () => {
  it("tails the CLI's output file and drains it BEFORE the completion bookend", async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), "orq-bgshell-"));
    try {
      const outputFile = nodePath.join(dir, `${SHELL_TASK}.output`);
      await writeFile(outputFile, "", "utf8");

      const harness = await makeHarness();
      await harness.adapter.startSession(START);
      const peer = harness.peers[0]!;
      await harness.adapter.sendTurn({
        threadId: START.threadId,
        input: "run the suites in the background",
        attachments: [],
        interactionMode: "default"
      });
      await peer.nextTurn();

      peer.emit(bashToolUse("pnpm -r test"));
      peer.emit(backgroundTaskStarted());
      const started = await harness.waitFor("task.started");
      assert.equal(started.payload.isBackgrounded, true);
      await harness.drain();
      const item = harness.events.find(
        (event) => event.type === "item.started" && event.itemId === `bgshell:${SHELL_TASK}`
      );
      assert.ok(item, "the shell gets its own row, or the drill-in has nothing to show");

      peer.emit(launchPlaceholder(outputFile));
      await harness.drain();

      // The file grows between polls; each poll ships only what was appended.
      await appendFile(outputFile, "ok 1 - first\n", "utf8");
      let seen = harness.events.length;
      firePendingTail(harness);
      const first = await harness.waitFor("content.delta", seen);
      assert.equal(first.itemId, `bgshell:${SHELL_TASK}`);
      assert.equal(first.agentId, SHELL_TASK);
      assert.equal(first.payload.streamKind, "command_output");
      assert.equal(first.payload.delta, "ok 1 - first\n");

      await appendFile(outputFile, "ok 2 - second\n", "utf8");
      seen = harness.events.length;
      firePendingTail(harness);
      const second = await harness.waitFor("content.delta", seen);
      assert.equal(second.payload.delta, "ok 2 - second\n", "only the appended bytes");

      // The last lines land after the final poll and before the notification:
      // without the drain they would arrive after `item.completed`, which is
      // where ingestion closes the item's output buffer, and be lost.
      await appendFile(outputFile, "# pass 2\n", "utf8");
      seen = harness.events.length;
      peer.emit({
        type: "system",
        subtype: "task_notification",
        task_id: SHELL_TASK,
        tool_use_id: SHELL_TOOL_USE,
        status: "completed",
        output_file: outputFile,
        summary: 'Background command "Run the suites" completed (exit code 0)',
        session_id: "sess-1",
        uuid: "u-note"
      } as unknown as SDKMessage);
      const completed = await harness.waitFor("task.completed", seen);
      assert.equal(completed.payload.exitCode, 0);

      const tail = harness.events.slice(seen);
      const types = tail.map((event) => event.type);
      const lastDelta = types.lastIndexOf("content.delta");
      const itemDone = types.indexOf("item.completed");
      assert.ok(lastDelta >= 0, `expected a drained delta, saw ${types.join(", ")}`);
      assert.ok(itemDone > lastDelta, `the drain must precede the item's bookend: ${types.join(", ")}`);
      assert.ok(types.indexOf("task.completed") > itemDone);
      const drained = tail.find(
        (event): event is EventOf<"content.delta"> =>
          event.type === "content.delta" && event.itemId === `bgshell:${SHELL_TASK}`
      );
      assert.equal(drained?.payload.delta, "# pass 2\n");

      // The tail is over: a later poll adds nothing, even if the file grows.
      await appendFile(outputFile, "late\n", "utf8");
      const after = harness.events.length;
      firePendingTail(harness);
      await harness.drain();
      assert.deepEqual(harness.events.slice(after), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable output file says so once and stops, rather than polling forever", async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), "orq-bgshell-"));
    try {
      const missing = nodePath.join(dir, "never-created.output");
      const harness = await makeHarness();
      await harness.adapter.startSession(START);
      const peer = harness.peers[0]!;
      await harness.adapter.sendTurn({
        threadId: START.threadId,
        input: "run it",
        attachments: [],
        interactionMode: "default"
      });
      await peer.nextTurn();
      peer.emit(bashToolUse("pnpm -r test"));
      peer.emit(backgroundTaskStarted());
      await harness.waitFor("task.started");
      peer.emit(launchPlaceholder(missing));
      await harness.drain();

      const seen = harness.events.length;
      firePendingTail(harness);
      const notice = await harness.waitFor("content.delta", seen);
      assert.ok(notice.payload.delta.includes("ENOENT"), notice.payload.delta);
      assert.ok(notice.payload.delta.includes(missing));

      const after = harness.events.length;
      firePendingTail(harness);
      await harness.drain();
      assert.deepEqual(harness.events.slice(after), [], "one notice, never a stream of them");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("claude adapter — the context meter asks the CLI for its own /context accounting", () => {
  const meterRows = (harness: Harness, from = 0): Array<EventOf<"thread.token-usage.updated">> =>
    harness.events
      .slice(from)
      .filter((event): event is EventOf<"thread.token-usage.updated"> =>
        event.type === "thread.token-usage.updated"
      );

  it("reads the window once the session is ready, before any turn has run", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const row = await harness.waitFor("thread.token-usage.updated");
    assert.equal(harness.peers[0]?.contextUsageCalls, 1);
    assert.deepEqual(
      harness.peers[0]?.calls.find((call) => call.op === "getContextUsage")?.arg,
      { detail: "summary" },
      "summary mode: it answers from the last response and makes no token-count call"
    );
    // The denominator used to arrive only with the first `result`, so the
    // opening turn showed a bare count and no ring.
    assert.equal(row.payload.usage.usedTokens, 15_868);
    assert.equal(row.payload.usage.maxTokens, 1_000_000);
    assert.equal(row.payload.usage.autoCompactAtTokens, 967_000);
    assert.equal(row.payload.usage.compactsAutomatically, true);
  });

  it("refreshes after a result, attributing the row to the turn it was asked for", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    await harness.waitFor("thread.token-usage.updated");
    const peer = harness.peers[0]!;

    const turn = await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "do the thing",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    const before = harness.events.length;
    peer.emit(systemInit());
    peer.emit(successResult());
    await harness.waitFor("turn.completed");
    await harness.drain();

    assert.equal(peer.contextUsageCalls, 2, "ready, then once per settled turn");
    const refreshed = meterRows(harness, before);
    assert.equal(refreshed.length, 1, "the settled turn produced exactly one fresh reading");
    assert.equal(refreshed[0]?.payload.usage.usedTokens, 16_868);
    assert.equal(
      refreshed[0]?.turnId,
      turn.turnId,
      "the row names the turn it was asked for, never the next one"
    );
    // The result's `modelUsage[*].contextWindow` must not take the denominator
    // back off the CLI's own resolved window.
    assert.equal(refreshed[0]?.payload.usage.maxTokens, 1_000_000);
  });

  it("a CLI that rejects the control request never fails the turn and never warns", async () => {
    const harness = await makeHarness({ contextUsage: "reject" });
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "do the thing",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    peer.emit(successResult());
    const completed = await harness.waitFor("turn.completed");
    await harness.drain();

    assert.equal(completed.payload.state, "completed");
    assert.ok(peer.contextUsageCalls >= 1, "it was tried");
    assert.deepEqual(
      harness.events.filter(
        (event) => event.type === "runtime.warning" || event.type === "runtime.error"
      ),
      [],
      "an unavailable meter refresh is a debug line, never a row in the chat"
    );
  });

  it("an unanswered request expires on its own deadline rather than hanging the thread", async () => {
    const harness = await makeHarness({ contextUsage: "hang", contextUsageDeadlineMs: 20 });
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "do the thing",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    peer.emit(successResult());
    const completed = await harness.waitFor("turn.completed");
    assert.equal(completed.payload.state, "completed");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await harness.drain();
    assert.deepEqual(meterRows(harness), [], "no answer, no reading — and no invented one");
    assert.deepEqual(
      harness.events.filter((event) => event.type === "runtime.error"),
      []
    );
  });

  it("an SDK with no getContextUsage at all degrades silently", async () => {
    const harness = await makeHarness({ contextUsage: "absent" });
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;
    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "do the thing",
      attachments: [],
      interactionMode: "default"
    });
    await peer.nextTurn();
    peer.emit(successResult());
    const completed = await harness.waitFor("turn.completed");
    await harness.drain();
    assert.equal(completed.payload.state, "completed");
    assert.equal(peer.contextUsageCalls, 0);
    assert.deepEqual(
      harness.events.filter((event) => event.type === "runtime.error"),
      []
    );
  });
});
