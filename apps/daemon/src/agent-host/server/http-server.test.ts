/**
 * The unix-socket API end to end: a real `node:http` server on a real socket,
 * driven by a real orchestrator over the in-memory fakes (spec §6).
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import {
  isDeadlineRefusal,
  isThreadGoneStreamError,
  THREAD_HEAD_LOOKUP_MAX,
  THREAD_HISTORY_DEFAULT_TURNS,
  threadHeadQueryParams,
  type AgentChatStreamErrorLine,
  type AgentChatStreamFrame,
  type RuntimeEvent,
  type ThreadHeadResponse,
  type ThreadPromptsResponse,
  type ThreadPromptTextResponse,
  type ThreadSearchResponse,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import {
  agentHostRoutes,
  agentHostSupports,
  type AgentHostHealthResponse,
  type AgentHostHoldGoalsResponse,
  type AgentHostRecycleOpenCodeResponse,
  type HostThreadCatalogResponse,
  type AgentHostResumeGoalSessionsResponse
} from "../host-protocol.ts";
import { createThreadIndex, createUnavailableThreadIndex, type ThreadIndex } from "../index/index.ts";
import { testLogger } from "../index/testing.ts";
import { runtimeEventToActivities } from "../ingestion/activities.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type TestHost,
  type TestHostOptions
} from "../orchestration/testing/index.ts";
import {
  agentHostExtraRoutes,
  type AgentHostThreadSummary
} from "./extra-routes.ts";
import { DeadlineExceededError } from "../support/deadline.ts";
import { createAgentHostServer, type AgentHostServer } from "./http-server.ts";

const TOKEN = "test-token";

interface Harness {
  host: TestHost;
  server: AgentHostServer;
  socketPath: string;
  dir: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<{ status: number; body: unknown }>;
  stream(path: string): Promise<{
    frames: AgentChatStreamFrame[];
    raw: string[];
    closed: Promise<void>;
    close(): void;
    waitFor(predicate: (frames: AgentChatStreamFrame[]) => boolean): Promise<void>;
  }>;
  stop(): Promise<void>;
}

async function harness(
  options: {
    openGate?: boolean;
    index?: ThreadIndex;
    adapters?: TestHostOptions["adapters"];
    sessionToolsRefresh?: Parameters<typeof createAgentHostServer>[0]["sessionToolsRefresh"];
  } = {}
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-test-"));
  const socketPath = join(dir, "agent-host.sock");
  const host = createTestHost({
    openGate: options.openGate ?? true,
    ...(options.index ? { index: options.index } : {}),
    ...(options.adapters ? { adapters: options.adapters } : {})
  });
  const server = createAgentHostServer({
    orchestrator: host.orchestrator,
    store: host.store,
    logger: host.logger,
    hostInstanceId: "host-test",
    token: TOKEN,
    socketPath,
    tmpDir: join(dir, "tmp"),
    startedAt: "1970-01-01T00:00:00.000Z",
    pid: 4242,
    onStop: async () => ({ ok: true, markedThreadIds: [] }),
    ...(options.sessionToolsRefresh ? { sessionToolsRefresh: options.sessionToolsRefresh } : {})
  });
  await server.listen();

  const call: Harness["call"] = (method, path, body, token = TOKEN) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath,
          method,
          path,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload !== undefined
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {})
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: response.statusCode ?? 0,
              body: text.length > 0 ? (JSON.parse(text) as unknown) : null
            });
          });
        }
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const stream: Harness["stream"] = (path) =>
    new Promise((resolve, reject) => {
      const frames: AgentChatStreamFrame[] = [];
      const raw: string[] = [];
      const waiters: Array<{ predicate: (frames: AgentChatStreamFrame[]) => boolean; resolve: () => void }> = [];
      const req = request(
        { socketPath, method: "GET", path, headers: { authorization: `Bearer ${TOKEN}` } },
        (response) => {
          let buffer = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            buffer += chunk;
            let index = buffer.indexOf("\n");
            while (index >= 0) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              raw.push(line);
              if (line.length > 0 && !line.startsWith(":")) {
                frames.push(JSON.parse(line) as AgentChatStreamFrame);
              }
              for (const waiter of [...waiters]) {
                if (waiter.predicate(frames)) {
                  waiters.splice(waiters.indexOf(waiter), 1);
                  waiter.resolve();
                }
              }
              index = buffer.indexOf("\n");
            }
          });
          resolve({
            frames,
            raw,
            closed: new Promise<void>((done) => response.once("close", done)),
            close: () => req.destroy(),
            waitFor: (predicate) =>
              new Promise<void>((done) => {
                if (predicate(frames)) {
                  done();
                  return;
                }
                waiters.push({ predicate, resolve: done });
              })
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

  return {
    host,
    server,
    socketPath,
    dir,
    call,
    stream,
    async stop(): Promise<void> {
      await server.close();
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

describe("agent host server — auth (§6)", () => {
  it("answers one identical 401 for a missing and for a wrong token", async () => {
    const h = await harness();
    const missing = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        { socketPath: h.socketPath, method: "GET", path: agentHostRoutes.health },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
          }));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(missing.status, 401);
    const wrong = await h.call("GET", agentHostRoutes.health, undefined, "nope");
    assert.deepEqual(wrong, missing);
    assert.equal((wrong.body as { error: { code: string } }).error.code, "COMMAND_REJECTED");
    await h.stop();
  });
});

describe("agent host server — readiness (§3.1, §8)", () => {
  it("health reports the protocol version and host identity", async () => {
    const h = await harness();
    const result = await h.call("GET", agentHostRoutes.health);
    assert.equal(result.status, 200);
    const body = result.body as AgentHostHealthResponse;
    assert.equal(body.ok, true);
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.hostInstanceId, "host-test");
    assert.equal(body.pid, 4242);
    // Agent Profiles: a daemon refuses to send a profile thread to a host without this; likewise a
    // fork into another agent or account ("Continue in another agent") without `crossAgentFork`.
    // boxes: and a box thread to a host that cannot run its CLI in the box.
    assert.deepEqual(body.capabilities, { sessionProfiles: 1, crossAgentFork: 1, boxes: 1 });
    assert.equal(agentHostSupports(body, "sessionProfiles"), true);
    assert.equal(agentHostSupports(body, "crossAgentFork"), true);
    assert.equal(agentHostSupports(body, "boxes"), true);
    await h.stop();
  });

  it("reports live and active-turn threads for the drain-restart", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c1", input: "go" });
    await h.host.settle();
    const body = (await h.call("GET", agentHostRoutes.health)).body as AgentHostHealthResponse;
    assert.deepEqual(body.liveThreadIds, [threadId]);
    assert.deepEqual(body.activeTurnThreadIds, [threadId]);
    assert.deepEqual(
      body.backgroundWorkThreadIds,
      [],
      "the drain-restart also waits on live background work (§3.1)"
    );
    await h.stop();
  });
});

describe("agent host server — commands and reads (§6.2, §6.3)", () => {
  it("routes every §6.2 command and answers `{seq}`", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();

    const turn = await h.call("POST", agentHostRoutes.turn(threadId), {
      commandId: "c-turn",
      input: "hello"
    });
    assert.equal(turn.status, 200);
    assert.equal(typeof (turn.body as { seq: number }).seq, "number");
    await h.host.settle();

    const interrupt = await h.call("POST", agentHostRoutes.interrupt(threadId), {
      commandId: "c-int"
    });
    assert.equal(interrupt.status, 200);

    const mode = await h.call("POST", agentHostRoutes.mode(threadId), {
      commandId: "c-mode",
      runtimeMode: "auto"
    });
    assert.equal(mode.status, 200);

    const stop = await h.call("POST", agentHostRoutes.sessionStop(threadId), {
      commandId: "c-stop"
    });
    assert.equal(stop.status, 200);
    await h.host.settle();
    await h.stop();
  });

  it("maps every rejection to its §6.2 status", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();

    const invalid = await h.call("POST", agentHostRoutes.turn(threadId), {
      commandId: "c-bad",
      input: ""
    });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body as { error: { code: string } }).error.code, "INVALID_COMMAND");

    const missing = await h.call("POST", agentHostRoutes.turn("nope"), {
      commandId: "c-missing",
      input: "hi"
    });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");

    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c-dupe", input: "hi" });
    await h.host.createThread({ threadId: "thread-2" });
    const conflict = await h.call("POST", agentHostRoutes.turn("thread-2"), {
      commandId: "c-dupe",
      input: "hi"
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      (conflict.body as { error: { code: string } }).error.code,
      "COMMAND_ID_CONFLICT"
    );
    await h.host.settle();
    await h.stop();
  });

  it("creates, renames and deletes a thread", async () => {
    const h = await harness();
    const created = await h.call("POST", agentHostRoutes.createThread, {
      threadId: "thread-x",
      projectPath: "/work/p",
      cwd: "/work/p",
      title: "First",
      refId: "claude",
      accountId: "acc1",
      home: "account",
      modelSelection: { model: "m" },
      runtimeMode: "approval-required"
    });
    assert.equal(created.status, 200);
    assert.equal((created.body as { title: string }).title, "First");

    const renamed = await h.call("PUT", agentHostRoutes.updateThread("thread-x"), {
      title: "Renamed"
    });
    assert.equal(renamed.status, 200);
    const read = await h.call("GET", agentHostRoutes.read("thread-x"));
    assert.equal((read.body as { kind: string }).kind, "snapshot");
    assert.equal(
      (read.body as { thread: { head: { title: string } } }).thread.head.title,
      "Renamed"
    );

    const deleted = await h.call("DELETE", agentHostRoutes.deleteThread("thread-x"));
    assert.equal(deleted.status, 200);
    const gone = await h.call("GET", agentHostRoutes.read("thread-x"));
    assert.equal(gone.status, 404);
    await h.stop();
  });

  it("reads a turn diff showing every change unless whitespace is asked to be hidden", async (t) => {
    const h = await harness();
    t.after(() => h.stop());
    const threadId = await h.host.createThread();
    const at = h.host.clock.nowIso();
    await h.host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "ev-checkpoint",
        threadId,
        type: "thread.turn-diff-completed" as const,
        payload: {
          turnCount: 1,
          turnId: null,
          ref: `refs/orquester/checkpoints/${threadId}/turn/1`,
          status: "ready" as const,
          files: [{ path: "a.txt", additions: 1, deletions: 0 }],
          assistantMessageId: null,
          completedAt: at
        },
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await h.host.settle();
    h.host.checkpoints.diff = "diff --git a/a.txt b/a.txt\n";
    const plain = await h.call("GET", agentHostRoutes.turnDiff(threadId, 1));
    assert.equal(plain.status, 200);
    assert.deepEqual(plain.body, { fromTurnCount: 0, toTurnCount: 1, diff: "diff --git a/a.txt b/a.txt\n" });
    await h.call("GET", `${agentHostRoutes.turnDiff(threadId, 1)}?ignoreWhitespace=1`);
    await h.call("GET", `${agentHostRoutes.turnDiff(threadId, 1)}?ignoreWhitespace=0`);
    await h.call("GET", `${agentHostRoutes.turnDiff(threadId, 1)}?ignoreWhitespace=true`);
    assert.deepEqual(
      h.host.checkpoints.diffRequests.map((r) => r.ignoreWhitespace),
      [false, true, false, true]
    );
  });

  it("404s an unknown item and an unknown turn diff", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    assert.equal((await h.call("GET", agentHostRoutes.item(threadId, "nope"))).status, 404);
    assert.equal((await h.call("GET", agentHostRoutes.turnDiff(threadId, 7))).status, 404);
    await h.stop();
  });

  it("serves a tool call's streamed output joined from the log, and 404s with its own code", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const at = h.host.clock.nowIso();
    const row = (id: string, activityKind: string, payload: Record<string, unknown>) => ({
      eventId: `ev-${id}`,
      threadId,
      type: "thread.activity-appended" as const,
      payload: {
        activity: { kind: "activity" as const, id, tone: "tool" as const, activityKind, summary: activityKind, payload, turnId: null, createdAt: at, updatedAt: at }
      },
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      metadata: {}
    });
    const shell = "bgshell:task-1";
    await h.host.orchestrator.ingestionSink(threadId, [
      row("start", "tool.started", { itemType: "command_execution", toolUseId: shell }),
      row("o1", "tool.output", { toolUseId: shell, streamKind: "command_output", delta: "one\n" }),
      row("o2", "tool.output", { toolUseId: shell, streamKind: "command_output", delta: "  two\n" }),
      row("warn", "runtime.warning", { message: "not a tool call" })
    ]);
    await h.host.settle();

    const running = await h.call("GET", agentHostRoutes.itemOutput(threadId, "start"));
    assert.equal(running.status, 200);
    assert.deepEqual(running.body, { toolUseId: shell, output: "one\n  two\n", complete: false, truncated: false });

    // Not a tool call, and no such item: ITEM_NOT_FOUND — never the THREAD_NOT_FOUND a route miss answers.
    for (const itemId of ["warn", "nope"]) {
      const missing = await h.call("GET", agentHostRoutes.itemOutput(threadId, itemId));
      assert.equal(missing.status, 404, itemId);
      assert.equal((missing.body as { error: { code: string } }).error.code, "ITEM_NOT_FOUND", itemId);
    }
    const miss = await h.call("GET", `${agentHostRoutes.itemOutput(threadId, "start")}/more`);
    assert.equal(miss.status, 404);
    assert.equal((miss.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");
    // A thread the host does not have is the thread's own 404.
    const gone = await h.call("GET", agentHostRoutes.itemOutput("thread-gone", "start"));
    assert.equal(gone.status, 404);
    assert.equal((gone.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");
    await h.stop();
  });

  /** A thread whose shell streamed "one\n" then "  two\n" (10 bytes), beside a row that is no tool call. */
  async function shellThread(h: Harness): Promise<string> {
    const threadId = await h.host.createThread();
    const at = h.host.clock.nowIso();
    const row = (id: string, activityKind: string, payload: Record<string, unknown>) => ({
      eventId: `ev-${id}`,
      threadId,
      type: "thread.activity-appended" as const,
      payload: {
        activity: { kind: "activity" as const, id, tone: "tool" as const, activityKind, summary: activityKind, payload, turnId: null, createdAt: at, updatedAt: at }
      },
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      metadata: {}
    });
    await h.host.orchestrator.ingestionSink(threadId, [
      row("start", "tool.started", { itemType: "command_execution", toolUseId: "bgshell:task-1" }),
      row("o1", "tool.output", { toolUseId: "bgshell:task-1", streamKind: "command_output", delta: "one\n" }),
      row("o2", "tool.output", { toolUseId: "bgshell:task-1", streamKind: "command_output", delta: "  two\n" }),
      row("warn", "runtime.warning", { message: "not a tool call" })
    ]);
    await h.host.settle();
    return threadId;
  }

  it("answers one window of the join when offset or maxBytes asks for it, and the whole join without either", async () => {
    const h = await harness();
    const threadId = await shellThread(h);
    const output = (query: string) => h.call("GET", `${agentHostRoutes.itemOutput(threadId, "start")}${query}`);
    const first = await output("?offset=0&maxBytes=4");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { toolUseId: "bgshell:task-1", offset: 0, text: "one\n", totalBytes: 10, nextOffset: 4, complete: false, truncated: false });
    // Either parameter alone asks for a window: maxBytes from the start, offset at the default size.
    assert.deepEqual((await output("?maxBytes=3")).body, { toolUseId: "bgshell:task-1", offset: 0, text: "one", totalBytes: 10, nextOffset: 3, complete: false, truncated: false });
    assert.deepEqual((await output("?offset=4")).body, { toolUseId: "bgshell:task-1", offset: 4, text: "  two\n", totalBytes: 10, complete: false, truncated: false });
    // Neither: the whole join, exactly as a host before windows answered it.
    assert.deepEqual((await output("")).body, { toolUseId: "bgshell:task-1", output: "one\n  two\n", complete: false, truncated: false });
    await h.stop();
  });

  it("refuses a malformed offset, clamps maxBytes, and answers an offset past the end as the end", async () => {
    const h = await harness();
    const threadId = await shellThread(h);
    const output = (query: string, itemId = "start", thread = threadId) => h.call("GET", `${agentHostRoutes.itemOutput(thread, itemId)}${query}`);
    for (const offset of ["abc", "-1", "1.5", "1e3", ""]) {
      const refused = await output(`?offset=${offset}&maxBytes=4`);
      assert.equal(refused.status, 400, offset);
      assert.equal((refused.body as { error: { code: string } }).error.code, "INVALID_COMMAND", offset);
    }
    // A repeated offset names no one place to start: refused, whatever the values. A repeated maxBytes is a preference
    // like any page size here: its first value.
    const twice = await output("?offset=1&offset=2");
    assert.equal(twice.status, 400);
    assert.equal((twice.body as { error: { code: string } }).error.code, "INVALID_COMMAND");
    assert.equal(((await output("?offset=0&maxBytes=3&maxBytes=100")).body as { text: string }).text, "one");
    // A window's size is a preference: below 1 it is one character, unparseable it is the default, huge it is the widest.
    assert.deepEqual([(await output("?offset=0&maxBytes=0")).body], [{ toolUseId: "bgshell:task-1", offset: 0, text: "o", totalBytes: 10, nextOffset: 1, complete: false, truncated: false }]);
    for (const maxBytes of ["abc", "99999999999"]) {
      assert.equal(((await output(`?offset=0&maxBytes=${maxBytes}`)).body as { text: string }).text, "one\n  two\n", maxBytes);
    }
    // At or past the end — however far, a safe integer or not — the window is the end: empty, no nextOffset.
    for (const offset of ["10", "11", "99999999999999999999999"]) {
      const end = await output(`?offset=${offset}`);
      assert.equal(end.status, 200, offset);
      assert.deepEqual(end.body, { toolUseId: "bgshell:task-1", offset: 10, text: "", totalBytes: 10, complete: false, truncated: false }, offset);
    }
    // The same 404s as the whole join: the item's own, then the thread's.
    for (const itemId of ["warn", "nope"]) {
      const missing = await output("?offset=0", itemId);
      assert.equal(missing.status, 404, itemId);
      assert.equal((missing.body as { error: { code: string } }).error.code, "ITEM_NOT_FOUND", itemId);
    }
    const gone = await output("?offset=0", "start", "thread-gone");
    assert.equal(gone.status, 404);
    assert.equal((gone.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");
    await h.stop();
  });

  it("serves the provider snapshots with the host instance id", async () => {
    const h = await harness();
    const result = await h.call("GET", agentHostRoutes.providers);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { providers: [], hostInstanceId: "host-test" });
    assert.equal(
      (await h.call("POST", agentHostRoutes.providerRefresh("nope"))).status,
      404
    );
    await h.stop();
  });

  it("claims an attachment from a raw octet-stream body and resolves it back", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const bytes = Buffer.from("hello attachment");
    const uploaded = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          socketPath: h.socketPath,
          method: "POST",
          path: `${agentHostExtraRoutes.putAttachment(threadId)}?name=notes.md&type=text/markdown`,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/octet-stream",
            "content-length": bytes.length
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
            })
          );
        }
      );
      req.on("error", reject);
      req.end(bytes);
    });
    assert.equal(uploaded.status, 200);
    const ref = uploaded.body as { id: string; name: string; path?: string };
    assert.equal(ref.name, "notes.md");

    const resolved = await h.call(
      "GET",
      agentHostExtraRoutes.attachment(threadId, ref.id)
    );
    assert.equal(resolved.status, 200);
    assert.equal(typeof (resolved.body as { path: string }).path, "string");
    assert.equal(ref.path, (resolved.body as { path: string }).path, "the upload reply names the same absolute path the resolve route does");
    assert.equal(
      (await h.call("GET", agentHostExtraRoutes.attachment(threadId, "nope"))).status,
      404
    );
    await h.stop();
  });

  it("serves the §6.4 summary fields the daemon cannot derive from the log", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "sum-1", input: "go" });
    await h.host.settle();
    const summary = await h.call("GET", agentHostExtraRoutes.summary(threadId));
    assert.equal(summary.status, 200);
    const body = summary.body as AgentHostThreadSummary;
    assert.equal(body.chatSessionStatus, "running");
    assert.equal(body.backgroundLiveness, null);
    assert.deepEqual(body.pendingRequests, []);
    await h.stop();
  });

  it("names every open request so the daemon can publish agentChat.pending", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    // Ingestion's rows, as the adapter would produce them.
    await h.host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "req",
        threadId,
        type: "thread.activity-appended",
        payload: {
          activity: {
            kind: "activity",
            id: "approval:req-7",
            tone: "approval",
            activityKind: "approval.requested",
            summary: "Run a command?",
            payload: { requestId: "req-7", requestKind: "file-change" },
            turnId: null,
            createdAt: h.host.clock.nowIso(),
            updatedAt: h.host.clock.nowIso()
          }
        },
        occurredAt: h.host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await h.host.settle();

    const body = (await h.call("GET", agentHostExtraRoutes.summary(threadId)))
      .body as AgentHostThreadSummary;
    assert.equal(body.hasPendingApprovals, true);
    assert.deepEqual(body.pendingRequests.map(({ requestId, kind }) => ({ requestId, kind })), [
      { requestId: "req-7", kind: "approval" }
    ]);
    await h.stop();
  });

  it("answers an unknown route with 404 rather than hanging", async () => {
    const h = await harness();
    assert.equal((await h.call("GET", "/nope")).status, 404);
    assert.equal((await h.call("POST", "/threads/thread-1/unknown", {})).status, 404);
    await h.stop();
  });
});

describe("agent host server — the event stream (§6.3)", () => {
  it("opens with a snapshot, marks synchronized, then streams live events", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const live = await h.stream(agentHostRoutes.events(threadId));
    await live.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    assert.equal(live.frames[0]?.kind, "snapshot");

    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "s1", input: "hello" });
    await live.waitFor((frames) =>
      frames.some(
        (frame) => frame.kind === "event" && frame.event.type === "thread.message-sent"
      )
    );
    const synchronizedIndex = live.frames.findIndex((frame) => frame.kind === "synchronized");
    const messageIndex = live.frames.findIndex(
      (frame) => frame.kind === "event" && frame.event.type === "thread.message-sent"
    );
    assert.ok(synchronizedIndex < messageIndex, "live frames follow the marker");
    live.close();
    await h.host.settle();
    await h.stop();
  });

  it("reads a bounded snapshot for the stream and `GET …/thread` only when asked", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const reads: unknown[] = [];
    const readThread = h.host.orchestrator.readThread;
    h.host.orchestrator.readThread = (id, after, options) => {
      reads.push(options);
      return readThread(id, after, options);
    };
    for (const query of ["", "?window=recent", "?after=0&window=recent&agentRows=on-demand"]) {
      const live = await h.stream(`${agentHostRoutes.events(threadId)}${query}`);
      await live.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
      live.close();
    }
    assert.equal((await h.call("GET", agentHostRoutes.read(threadId))).status, 200);
    assert.equal((await h.call("GET", `${agentHostRoutes.read(threadId)}?window=recent`)).status, 200);
    assert.equal((await h.call("GET", `${agentHostRoutes.read(threadId)}?window=everything`)).status, 200);
    assert.deepEqual(reads, [
      undefined,
      { window: "recent" },
      { window: "recent", agentRows: "on-demand" },
      undefined,
      { window: "recent" },
      undefined
    ]);
    h.host.orchestrator.readThread = readThread;
    await h.stop();
  });

  it("hands a history read the window's cut it names, and nothing for an empty one", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const queries: unknown[] = [];
    const readHistory = h.host.orchestrator.readHistory;
    h.host.orchestrator.readHistory = async (id, query) => {
      queries.push(query);
      return { threadId: id, turns: [], items: [], checkpoints: [], page: { beforeCursor: null }, seq: 1 };
    };
    await h.call("GET", `${agentHostRoutes.history(threadId)}?windowCut=cut-1`);
    await h.call("GET", `${agentHostRoutes.history(threadId)}?before=c-2&windowCut=`);
    assert.deepEqual(queries, [
      { windowCut: "cut-1", turns: THREAD_HISTORY_DEFAULT_TURNS },
      { before: "c-2", turns: THREAD_HISTORY_DEFAULT_TURNS }
    ]);
    h.host.orchestrator.readHistory = readHistory;
    await h.stop();
  });

  it("replays by cursor when the range is small enough", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "s2", input: "hello" });
    await h.host.settle();

    const live = await h.stream(`${agentHostRoutes.events(threadId)}?after=1`);
    await live.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    assert.equal(live.frames[0]?.kind, "event", "a small range replays instead of snapshotting");
    live.close();
    await h.stop();
  });

  it("two clients converge on the same order (§6.6)", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const a = await h.stream(agentHostRoutes.events(threadId));
    const b = await h.stream(agentHostRoutes.events(threadId));
    await a.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    await b.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));

    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "m1", input: "one" });
    await h.host.settle();
    const seen = (frames: AgentChatStreamFrame[]): number[] =>
      frames.filter((frame) => frame.kind === "event").map((frame) => frame.seq);
    await a.waitFor((frames) => seen(frames).length >= 4);
    await b.waitFor((frames) => seen(frames).length >= 4);

    // Host-authoritative and cursor-ordered: no CRDT, no client-side merge.
    assert.deepEqual(seen(a.frames), seen(b.frames));
    assert.deepEqual(
      seen(a.frames),
      [...seen(a.frames)].sort((left, right) => left - right)
    );
    a.close();
    b.close();
    await h.stop();
  });


  it("a thread the host does not hold answers one THREAD_NOT_FOUND error line and closes", async () => {
    const h = await harness();
    const live = await h.stream(agentHostRoutes.events("never-created"));
    await live.closed;
    const lines = live.raw.filter((line) => line.length > 0 && !line.startsWith(":"));
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]!) as AgentChatStreamErrorLine;
    assert.equal(line.kind, "error");
    assert.equal(line.code, "THREAD_NOT_FOUND");
    assert.equal(isThreadGoneStreamError(line), true, "a client stops reconnecting on it");
    // A host from before the code: its wording alone still says so; another failure does not.
    assert.equal(isThreadGoneStreamError({ kind: "error", message: line.message }), true);
    assert.equal(isThreadGoneStreamError({ kind: "error", message: "EIO: read failed" }), false);
    await h.stop();
  });

  it("closes every open stream when the host stops", { timeout: 10_000 }, async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const live = await h.stream(agentHostRoutes.events(threadId));
    await live.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    await h.server.close();
    await live.closed;
    await h.host.stop();
    await rm(h.dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// E9 - a deadline is a refusal, not an internal fault
// ---------------------------------------------------------------------------

/** POST an attachment body: the one route that reaches the store ungated. */
function upload(h: Harness, threadId: string): Promise<{ status: number; body: unknown }> {
  const bytes = Buffer.from("x");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: h.socketPath,
        method: "POST",
        path: `${agentHostExtraRoutes.putAttachment(threadId)}?name=notes.md`,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/octet-stream",
          "content-length": bytes.length
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
          })
        );
      }
    );
    req.on("error", reject);
    req.end(bytes);
  });
}

describe("agent host server - a deadline answers its specified status (E9)", () => {
  it("is a 409 COMMAND_REJECTED once the host is up, never a 500", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    h.host.store.putAttachment = () =>
      Promise.reject(new DeadlineExceededError("opencode/probe", 10_000));

    const answer = await upload(h, threadId);
    // The measured defect: every non-`AgentChatCommandError` fell through to
    // `500 COMMAND_REJECTED`, a pairing 6.2 gives no retry rule for.
    assert.equal(answer.status, 409);
    const envelope = answer.body as { error: { code: string; message: string } };
    assert.equal(envelope.error.code, "COMMAND_REJECTED");
    assert.match(envelope.error.message, /timed out/);
    // Marked as the refusal of a moment, which a merge back retries (`isDeadlineRefusal`).
    assert.deepEqual((envelope.error as { detail?: unknown }).detail, { reason: "deadline" });
    assert.equal(isDeadlineRefusal(envelope.error), true);
    await h.stop();
  });

  it("is a 503 HOST_UNAVAILABLE while the host is still cold", async () => {
    // Gate shut: 6.2's "retry the same commandId once the host is back", which
    // is a different instruction to the client than a plain refusal.
    const h = await harness({ openGate: false });
    h.host.store.putAttachment = () =>
      Promise.reject(new DeadlineExceededError("agent-host/boot", 30_000));

    const answer = await upload(h, "cold-thread");
    assert.equal(answer.status, 503);
    assert.equal((answer.body as { error: { code: string } }).error.code, "HOST_UNAVAILABLE");
    await h.stop();
  });
});

  /** A real index in a directory of its own: the route answers what the index derived. */
  async function realIndex(): Promise<{ index: ThreadIndex; filePath: string; release(): Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), "agent-host-prompts-"));
    const filePath = join(dir, "index.sqlite");
    const index = createThreadIndex({ filePath, logger: testLogger() });
    return {
      index,
      filePath,
      async release(): Promise<void> {
        index.close();
        await rm(dir, { recursive: true, force: true });
      }
    };
  }

describe("agent host server — indexed history and search (design 2026-09-23, C)", () => {
  it("answers 503 INDEX_UNAVAILABLE for history without a usable index, 404 for no thread", async () => {
    for (const index of [undefined, createUnavailableThreadIndex()]) {
      const h = await harness(index ? { index } : {});
      const threadId = await h.host.createThread();
      const answer = await h.call("GET", agentHostRoutes.history(threadId));
      assert.equal(answer.status, 503);
      assert.equal(
        (answer.body as { error: { code: string } }).error.code,
        "INDEX_UNAVAILABLE"
      );
      const missing = await h.call("GET", agentHostRoutes.history("no-such-thread"));
      assert.equal(missing.status, 404);
      await h.stop();
    }
  });

  it("stamps the snapshot a thread read answers with its history bounds", async (t) => {
    const { index, release } = await realIndex();
    t.after(release);
    const h = await harness({ index });
    t.after(() => h.stop());
    const threadId = await h.host.createThread();
    const read = await h.call("GET", agentHostRoutes.read(threadId));
    assert.equal(read.status, 200);
    const thread = (read.body as { kind: string; thread: { history?: unknown } }).thread;
    assert.deepEqual(thread.history, {
      indexed: true,
      hasOlder: false,
      beforeCursor: null,
      oldestRetainedOrdinal: null,
      totalTurns: 0
    });
    await h.stop();
  });

  it("caps the search query by code point and answers blank queries", async (t) => {
    const { index, release } = await realIndex();
    t.after(release);
    const h = await harness({ index });
    t.after(() => h.stop());

    // Clamped by code point: an astral character is never cut in half.
    const long = "🔎".repeat(250);
    const clamped = await h.call("GET", `${agentHostRoutes.search}?q=${encodeURIComponent(long)}`);
    assert.equal(
      Array.from((clamped.body as ThreadSearchResponse).query).length,
      200
    );

    // A blank query matches nothing, and is still a 200.
    const blank = await h.call("GET", agentHostRoutes.search);
    assert.equal(blank.status, 200);
    assert.deepEqual(blank.body, { query: "", hits: [], truncated: false, indexed: true });
    await h.stop();
  });

  it("answers search `indexed: false` with a 200 when there is no usable index", async () => {
    for (const index of [undefined, createUnavailableThreadIndex()]) {
      const h = await harness(index ? { index } : {});
      const answer = await h.call("GET", `${agentHostRoutes.search}?q=anything`);
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, {
        query: "anything",
        hits: [],
        truncated: false,
        indexed: false
      });
      await h.stop();
    }
  });
});

describe("agent host server — the thread's prompts (the right rail's History)", () => {
  let sunk = 0;
  /** Append events the way ingestion does — a turn's end, a replayed prompt. */
  async function sink(
    h: Harness,
    threadId: string,
    drafts: Array<
      | { type: "thread.session-set"; payload: { session: { status: "ready"; activeTurnId: null } } }
      | {
          type: "thread.message-sent";
          payload: { messageId: string; role: "user"; text: string; streaming: false; turnId: null };
        }
    >
  ): Promise<void> {
    await h.host.orchestrator.ingestionSink(
      threadId,
      drafts.map((draft) => {
        sunk += 1;
        return {
          ...draft,
          eventId: `sunk-${sunk}`,
          threadId,
          occurredAt: h.host.clock.nowIso(),
          commandId: null,
          causationEventId: null,
          metadata: {}
        };
      })
    );
  }

  /**
   * The index as a host sees it while it is being rebuilt: the file is there,
   * but live appends only reach it once `feeding` — before that, only a
   * catch-up from the log fills it.
   */
  function starved(index: ThreadIndex): { index: ThreadIndex; feed(): void } {
    let feeding = false;
    const wrapped = new Proxy(index, {
      get(target, key) {
        if (key === "observe" && !feeding) {
          return () => undefined;
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    return {
      index: wrapped,
      feed: () => {
        feeding = true;
      }
    };
  }

  const turnEnded = {
    type: "thread.session-set" as const,
    payload: { session: { status: "ready" as const, activeTurnId: null } }
  };
  const userPrompt = (messageId: string, text: string) => ({
    type: "thread.message-sent" as const,
    payload: { messageId, role: "user" as const, text, streaming: false as const, turnId: null }
  });

  it("lists the thread's prompts from the index, newest first — steers included", async () => {
    const { index, release } = await realIndex();
    const h = await harness({ index });
    try {
      const threadId = await h.host.createThread();
      await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c-1", input: "first prompt" });
      await h.host.settle();
      await sink(h, threadId, [turnEnded]);
      await h.call("POST", agentHostRoutes.turn(threadId), {
        commandId: "c-2",
        input: "second [Image #1] prompt"
      });
      await h.host.settle();
      // Turn 2 is still running: this one steers it.
      await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c-3", input: "a steer" });
      await h.host.settle();
      await index.drain();

      const answer = await h.call("GET", agentHostRoutes.prompts(threadId));
      assert.equal(answer.status, 200);
      const body = answer.body as ThreadPromptsResponse;
      assert.equal(body.threadId, threadId);
      assert.equal(body.indexed, true);
      assert.equal(body.before, null);
      assert.deepEqual(
        body.prompts.map((entry) => [entry.text, entry.turnId, entry.turnOrdinal, entry.rewindable]),
        [
          ["a steer", "turn-2", null, null],
          ["second prompt", "turn-2", 2, true],
          ["first prompt", "turn-1", 1, true]
        ]
      );
      assert.ok(body.prompts.every((entry) => !entry.truncated && entry.seq > 0));

      const paged = await h.call("GET", `${agentHostRoutes.prompts(threadId)}?limit=2`);
      const first = paged.body as ThreadPromptsResponse;
      assert.deepEqual(first.prompts.map((entry) => entry.text), ["a steer", "second prompt"]);
      assert.notEqual(first.before, null);
      const rest = await h.call(
        "GET",
        `${agentHostRoutes.prompts(threadId)}?limit=2&before=${encodeURIComponent(first.before!)}`
      );
      assert.deepEqual(
        (rest.body as ThreadPromptsResponse).prompts.map((entry) => entry.text),
        ["first prompt"]
      );
      assert.equal((rest.body as ThreadPromptsResponse).before, null);
    } finally {
      await h.stop();
      await release();
    }
  });

  it("answers the list `indexed: false` without a usable index, the text 503, and 404 for no thread", async () => {
    for (const index of [undefined, createUnavailableThreadIndex()]) {
      const h = await harness(index ? { index } : {});
      try {
        const threadId = await h.host.createThread();
        const list = await h.call("GET", agentHostRoutes.prompts(threadId));
        assert.equal(list.status, 200);
        assert.deepEqual(list.body, {
          threadId,
          prompts: [],
          before: null,
          indexed: false
        } satisfies ThreadPromptsResponse);
        const text = await h.call("GET", agentHostRoutes.promptText(threadId, "user:1"));
        assert.equal(text.status, 503);
        assert.equal((text.body as { error: { code: string } }).error.code, "INDEX_UNAVAILABLE");

        for (const path of [
          agentHostRoutes.prompts("no-such-thread"),
          agentHostRoutes.promptText("no-such-thread", "user:1")
        ]) {
          const missing = await h.call("GET", path);
          assert.equal(missing.status, 404, path);
          assert.equal((missing.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");
        }
      } finally {
        await h.stop();
      }
    }
  });

  it("serves one prompt's whole text, and 404 PROMPT_NOT_FOUND for any other id", async () => {
    const { index, release } = await realIndex();
    const h = await harness({ index });
    try {
      const threadId = await h.host.createThread();
      await h.call("POST", agentHostRoutes.turn(threadId), {
        commandId: "c-1",
        input: " look at [Image #1] this "
      });
      await h.host.settle();
      await sink(h, threadId, [userPrompt("user:notice", "<task-notification>done</task-notification>")]);
      await index.drain();
      const [entry] = (
        (await h.call("GET", agentHostRoutes.prompts(threadId))).body as ThreadPromptsResponse
      ).prompts;
      assert.ok(entry !== undefined && entry.messageId.includes(":"), "an id the path must encode");

      const answer = await h.call("GET", agentHostRoutes.promptText(threadId, entry.messageId));
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, {
        messageId: entry.messageId,
        text: "look at this",
        truncated: false
      } satisfies ThreadPromptTextResponse);

      for (const messageId of ["user:notice", "user:unknown", "assistant:turn-1"]) {
        const missing = await h.call("GET", agentHostRoutes.promptText(threadId, messageId));
        assert.equal(missing.status, 404, messageId);
        assert.equal(
          (missing.body as { error: { code: string } }).error.code,
          "PROMPT_NOT_FOUND",
          messageId
        );
      }
    } finally {
      await h.stop();
      await release();
    }
  });

  it("answers `catchingUp` while the index catches up with a thread, the page once it has, and `indexed:false` for one it never will", async () => {
    const real = await realIndex();
    const { index, feed } = starved(real.index);
    const h = await harness({ index });
    try {
      // Written while the index sees nothing: a file rebuilt under the host.
      const threadId = await h.host.createThread();
      await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c-1", input: "first prompt" });
      await h.host.settle();
      const unreached = await h.host.createThread({ threadId: "thread-unreached" });
      await h.call("POST", agentHostRoutes.turn(unreached), { commandId: "c-2", input: "never indexed" });
      await h.host.settle();
      await real.index.drain();

      const sweep = real.index.beginCatchUpSweep();
      const catching = await h.call("GET", agentHostRoutes.prompts(threadId));
      assert.equal(catching.status, 200);
      assert.deepEqual(catching.body, {
        threadId,
        prompts: [],
        before: null,
        indexed: false,
        catchingUp: true
      } satisfies ThreadPromptsResponse);
      const text = await h.call("GET", agentHostRoutes.promptText(threadId, "user:1"));
      assert.equal(text.status, 503, "no 404 from an index that cannot say yet");
      assert.equal((text.body as { error: { code: string } }).error.code, "INDEX_UNAVAILABLE");

      await real.index.catchUp({
        threadId,
        projectPath: "/work/project",
        title: "Test thread",
        logSeq: await h.host.store.lastSeq(threadId),
        read: (cursor) => h.host.store.readEventsFrom(threadId, cursor)
      });
      feed();
      const caughtUp = (await h.call("GET", agentHostRoutes.prompts(threadId))).body as ThreadPromptsResponse;
      assert.equal(caughtUp.indexed, true);
      assert.equal(caughtUp.catchingUp, undefined);
      assert.deepEqual(caughtUp.prompts.map((entry) => entry.text), ["first prompt"]);
      const [entry] = caughtUp.prompts;
      const whole = await h.call("GET", agentHostRoutes.promptText(threadId, entry!.messageId));
      assert.equal(whole.status, 200);
      const absent = await h.call("GET", agentHostRoutes.promptText(threadId, "user:unknown"));
      assert.equal(absent.status, 404, "caught up: now a missing prompt is a 404");

      // The sweep ends without reaching the other thread: nothing will now
      // before the host restarts, which is what plain `indexed:false` says.
      sweep.end();
      const behind = await h.call("GET", agentHostRoutes.prompts(unreached));
      assert.deepEqual(behind.body, {
        threadId: unreached,
        prompts: [],
        before: null,
        indexed: false
      } satisfies ThreadPromptsResponse);
      assert.equal((await h.call("GET", agentHostRoutes.promptText(unreached, "user:2"))).status, 503);
    } finally {
      await h.stop();
      await real.release();
    }
  });

  it("answers a read that failed with a retryable 503 INDEX_UNAVAILABLE, never an empty page", async () => {
    const { index, release, filePath } = await realIndex();
    const h = await harness({ index });
    try {
      const threadId = await h.host.createThread();
      const unreadable = async (): Promise<void> => {
        for (const path of [agentHostRoutes.prompts(threadId), agentHostRoutes.promptText(threadId, "user:1")]) {
          const answer = await h.call("GET", path);
          assert.equal(answer.status, 503, path);
          assert.equal((answer.body as { error: { code: string } }).error.code, "INDEX_UNAVAILABLE", path);
        }
      };
      await index.drain();
      const damaged = new Database(filePath);
      try {
        const tables = damaged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        for (const { name } of tables) damaged.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
      } finally {
        damaged.close();
      }
      await unreadable();
    } finally {
      await h.stop();
      await release();
    }
  });

  it("reads a prompt longer than the index keeps back from its own line in the log", async () => {
    const { index, release } = await realIndex();
    const h = await harness({ index });
    try {
      const threadId = await h.host.createThread();
      const long = `${"x".repeat(200_000)} and the rest`;
      const twice = "y".repeat(200_005);
      await sink(h, threadId, [
        userPrompt("user:long", long),
        userPrompt("user:twice", twice),
        userPrompt("user:twice", `${twice}!`)
      ]);
      await index.drain();

      const listed = ((await h.call("GET", agentHostRoutes.prompts(threadId))).body as ThreadPromptsResponse)
        .prompts;
      const longEntry = listed.find((entry) => entry.messageId === "user:long")!;
      assert.equal(longEntry.text.length, 4000);
      assert.equal(longEntry.truncated, true);

      const whole = await h.call("GET", agentHostRoutes.promptText(threadId, "user:long"));
      assert.equal(whole.status, 200);
      assert.deepEqual(whole.body, { messageId: "user:long", text: long, truncated: false });

      // Written twice, so no one line holds its latest text: the index's copy,
      // said to be cut.
      const head = await h.call("GET", agentHostRoutes.promptText(threadId, "user:twice"));
      const clipped = head.body as ThreadPromptTextResponse;
      assert.equal(clipped.messageId, "user:twice");
      assert.equal(clipped.truncated, true);
      assert.ok(clipped.text.length > 0 && clipped.text.length < twice.length);
      assert.ok(twice.startsWith(clipped.text));

      // A log that no longer holds the prompt at its line: the same fallback.
      h.host.store.truncateAt(threadId, 0);
      const unread = await h.call("GET", agentHostRoutes.promptText(threadId, "user:long"));
      const fallback = unread.body as ThreadPromptTextResponse;
      assert.equal(fallback.messageId, "user:long");
      assert.equal(fallback.truncated, true);
      assert.ok(fallback.text.length > 0 && fallback.text.length < long.length);
      assert.ok(long.startsWith(fallback.text));
    } finally {
      await h.stop();
      await release();
    }
  });
});

describe("agent host server — unified MCP §9.3, a thread's new session-tool manifest", () => {
  it("POST /threads/:id/session-tools/refresh hands the manifest over and answers what was applied", async () => {
    const seen: [string, unknown][] = [];
    const h = await harness({
      sessionToolsRefresh: async (threadId, body) => {
        seen.push([threadId, body]);
        return { applied: "next-idle" };
      }
    });
    try {
      const manifest = { tools: ["list_sessions"], instructions: "## Orquester", deny: ["remote"] };
      const answered = await h.call("POST", agentHostRoutes.sessionToolsRefresh("thread-1"), { manifest });
      assert.equal(answered.status, 200);
      assert.deepEqual(answered.body, { applied: "next-idle" });
      assert.deepEqual(seen, [["thread-1", { manifest }]]);
      assert.equal((await h.call("POST", agentHostRoutes.sessionToolsRefresh("thread-1"), { manifest: { tools: "x" } })).status, 400);
      assert.equal((await h.call("POST", agentHostRoutes.sessionToolsRefresh("thread-1"), { manifest }, "wrong-token")).status, 401);
      assert.equal(seen.length, 1);
    } finally {
      await h.stop();
    }
  });

  it("a host without the hook answers the route-miss 404 (an older host)", async () => {
    const h = await harness();
    try {
      const answered = await h.call("POST", agentHostRoutes.sessionToolsRefresh("thread-1"), { manifest: { tools: [], instructions: "", deny: [] } });
      assert.equal(answered.status, 404);
    } finally {
      await h.stop();
    }
  });
});

describe("agent host server — Agent Profiles' prepared-dir leases", () => {
  it("GET /profiles/leases answers the orchestrator's live prepared dirs, behind the host's auth", async () => {
    const h = await harness();
    try {
      const answered = await h.call("GET", agentHostRoutes.profileLeases);
      assert.equal(answered.status, 200);
      assert.deepEqual(answered.body, { preparedDirs: [] });
      assert.equal((await h.call("GET", agentHostRoutes.profileLeases, undefined, "wrong-token")).status, 401);
      assert.equal((await h.call("POST", agentHostRoutes.profileLeases)).status, 404, "only GET is the route");
    } finally {
      await h.stop();
    }
  });
});

describe("agent host server — agent profile §4.8, OpenCode server recycling", () => {
  it("POST /opencode/recycle-idle answers the OpenCode adapter's counts", async () => {
    let calls = 0;
    const inputs: unknown[] = [];
    const opencode = Object.assign(createScriptedAdapter({ id: "opencode" }), {
      recycleIdleServers: async (input?: { poolKey?: string }) => {
        calls += 1;
        inputs.push(input);
        return { recycled: 2, deferred: 1 };
      }
    });
    const h = await harness({ adapters: { opencode } });
    try {
      const answered = await h.call("POST", agentHostRoutes.recycleIdleOpenCode);
      assert.equal(answered.status, 200);
      assert.deepEqual(answered.body, { recycled: 2, deferred: 1 } satisfies AgentHostRecycleOpenCodeResponse);
      assert.equal(calls, 1);
      assert.equal((await h.call("GET", agentHostRoutes.recycleIdleOpenCode)).status, 404, "only POST is the route");
      assert.equal(calls, 1);
      assert.equal(
        (await h.call("POST", agentHostRoutes.recycleIdleOpenCode, undefined, "wrong-token")).status,
        401,
        "behind the host's auth like every route"
      );
      assert.equal(calls, 1);

      // An optional pool key narrows the recycle; an empty or odd one recycles every server.
      await h.call("POST", agentHostRoutes.recycleIdleOpenCode, { poolKey: "profile-a" });
      await h.call("POST", agentHostRoutes.recycleIdleOpenCode, { poolKey: "" });
      await h.call("POST", agentHostRoutes.recycleIdleOpenCode, { poolKey: 7 });
      assert.deepEqual(inputs, [undefined, { poolKey: "profile-a" }, undefined, undefined]);
    } finally {
      await h.stop();
    }
  });

  it("recycles nothing when no adapter serves OpenCode", async () => {
    const h = await harness({ adapters: { claude: createScriptedAdapter({ id: "claude" }) } });
    try {
      const answered = await h.call("POST", agentHostRoutes.recycleIdleOpenCode);
      assert.equal(answered.status, 200);
      assert.deepEqual(answered.body, { recycled: 0, deferred: 0 });
    } finally {
      await h.stop();
    }
  });
});

describe("agent host server — a thread's session catalog (Agent Profiles composer)", () => {
  it("GET /threads/:id/catalog answers the live session's report, else live: false — never a start", async () => {
    let answer: "catalog" | "none" | "throw" = "catalog";
    const asked: string[] = [];
    const claude = Object.assign(createScriptedAdapter({ id: "claude" }), {
      sessionCatalog: async (threadId: string) => {
        asked.push(threadId);
        if (answer === "throw") throw new Error("the provider hung up");
        return answer === "none"
          ? null
          : { slashCommands: [{ name: "review", description: "Review" }], skills: [{ name: "lint", path: "/p/lint/SKILL.md", enabled: true }] };
      }
    });
    const h = await harness({ adapters: { claude } });
    try {
      const threadId = await h.host.createThread();
      const live = await h.call("GET", agentHostRoutes.catalog(threadId));
      assert.equal(live.status, 200);
      assert.deepEqual(live.body, {
        live: true,
        slashCommands: [{ name: "review", description: "Review" }],
        skills: [{ name: "lint", path: "/p/lint/SKILL.md", enabled: true }]
      } satisfies HostThreadCatalogResponse);
      answer = "none";
      assert.deepEqual((await h.call("GET", agentHostRoutes.catalog(threadId))).body, { live: false, slashCommands: [], skills: [] });
      answer = "throw";
      assert.deepEqual((await h.call("GET", agentHostRoutes.catalog(threadId))).body, { live: false, slashCommands: [], skills: [] });
      assert.deepEqual(asked, [threadId, threadId, threadId]);
      assert.ok(!claude.calls.some((call) => call.kind === "startSession"), "a read never starts a session");
      const missing = await h.call("GET", agentHostRoutes.catalog("no-such-thread"));
      assert.equal(missing.status, 404);
      assert.equal((missing.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");
    } finally {
      await h.stop();
    }
  });

  it("answers live: false for an adapter without the read", async () => {
    const h = await harness({ adapters: { claude: createScriptedAdapter({ id: "claude" }) } });
    try {
      const threadId = await h.host.createThread();
      assert.deepEqual((await h.call("GET", agentHostRoutes.catalog(threadId))).body, { live: false, slashCommands: [], skills: [] });
    } finally {
      await h.stop();
    }
  });
});

describe("agent host server — goals §5.7, the deploy's goal hold", () => {
  it("POST /goals/hold renews the lease and answers every thread held after it", async () => {
    const codex = createScriptedAdapter({
      id: "codex",
      capabilities: {
        goals: { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true }
      },
      goalCommand: async () => ({ summary: "" })
    });
    const h = await harness({ adapters: { codex } });

    const nothing = await h.call("POST", agentHostRoutes.holdGoals);
    assert.equal(nothing.status, 200);
    assert.deepEqual(nothing.body, { heldThreadIds: [] } satisfies AgentHostHoldGoalsResponse);

    // A Codex thread whose goal continues, its turn running.
    const threadId = await h.host.createThread({ refId: "codex" });
    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c-work", input: "work" });
    await h.host.settle();
    const goalEvent = {
      eventId: "goal-set",
      threadId,
      createdAt: "1970-01-01T00:00:00.000Z",
      type: "thread.goal.updated",
      payload: { goal: { objective: "ship it", status: "active" }, change: "set" }
    } as RuntimeEvent;
    await h.host.orchestrator.ingestionSink(
      threadId,
      runtimeEventToActivities(goalEvent).map((activity) => ({
        eventId: "ingest-goal-set",
        threadId,
        type: "thread.activity-appended" as const,
        payload: { activity },
        occurredAt: "1970-01-01T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        metadata: {}
      }))
    );

    const held = await h.call("POST", agentHostRoutes.holdGoals);
    assert.equal(held.status, 200);
    assert.deepEqual(held.body, { heldThreadIds: [threadId] });

    // A renewal answers the thread already held.
    assert.deepEqual((await h.call("POST", agentHostRoutes.holdGoals)).body, {
      heldThreadIds: [threadId]
    });
    // Only POST is the route.
    assert.equal((await h.call("GET", agentHostRoutes.holdGoals)).status, 404);
    await h.stop();
  });

  it("POST /goals/resume-sessions takes the threads it knows and refuses a malformed body whole", async () => {
    const h = await harness();
    try {
      const threadId = await h.host.createThread({ refId: "claude" });
      // The resume itself is the orchestrator's (goal-legacy-handover.test.ts):
      // here, what the route takes and what it refuses.
      const taken = await h.call("POST", agentHostRoutes.resumeGoalSessions, {
        threadIds: [threadId, "thread-missing", "../escape"]
      });
      assert.equal(taken.status, 200);
      assert.deepEqual(taken.body, { threadIds: [threadId] } satisfies AgentHostResumeGoalSessionsResponse);

      for (const body of [{}, { threadIds: "x" }, { threadIds: [7] }, { threadIds: Array(1_001).fill("t") }]) {
        const refused = await h.call("POST", agentHostRoutes.resumeGoalSessions, body);
        assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 60));
      }
      assert.equal(
        (await h.call("GET", agentHostRoutes.resumeGoalSessions)).status,
        404,
        "only POST is the route"
      );
    } finally {
      await h.stop();
    }
  });
});

describe("agent host server — thread lineage's fork route (spec 2026-10-14 §6)", () => {
  it("creates the child as a fork of the thread in the path, and refuses a malformed child id", async () => {
    const h = await harness();
    const parentId = await h.host.createThread();
    const body = {
      threadId: "fork-child-1",
      projectPath: "/work/project",
      cwd: "/work/project",
      title: "Fork",
      refId: "claude",
      accountId: "acc1",
      home: "account",
      modelSelection: undefined,
      runtimeMode: undefined,
      fork: {}
    };
    const created = await h.call("POST", agentHostRoutes.forkThread(parentId), body);
    assert.equal(created.status, 200);
    const result = created.body as { head: { id: string; lineage?: { parentThreadId: string } }; strategy: string };
    assert.equal(result.head.id, "fork-child-1");
    assert.equal(result.head.lineage?.parentThreadId, parentId);
    assert.equal(result.strategy, "empty", "nothing to carry over from an empty parent");

    const malformed = await h.call("POST", agentHostRoutes.forkThread(parentId), { ...body, threadId: "../x" });
    assert.equal(malformed.status, 400);
    const missing = await h.call("POST", agentHostRoutes.forkThread("nope"), { ...body, threadId: "fork-child-2" });
    assert.equal(missing.status, 404);
    await h.stop();
  });

  it("confirmOnly answers a child the host holds and never creates one", async () => {
    const h = await harness();
    const parentId = await h.host.createThread();
    const body = {
      threadId: "fork-child-3",
      projectPath: "/work/project",
      cwd: "/work/project",
      title: "Fork",
      refId: "claude",
      accountId: "acc1",
      home: "account",
      modelSelection: undefined,
      runtimeMode: undefined,
      fork: {}
    };
    const absent = await h.call("POST", agentHostRoutes.forkThread(parentId), { ...body, confirmOnly: true });
    assert.equal(absent.status, 404);
    assert.equal((absent.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND");
    assert.equal((await h.call("GET", agentHostRoutes.read("fork-child-3"))).status, 404, "nothing was created");

    // Two forks of one child at once: one `thread.created`, both answered with it.
    const [one, two] = await Promise.all([
      h.call("POST", agentHostRoutes.forkThread(parentId), body),
      h.call("POST", agentHostRoutes.forkThread(parentId), body)
    ]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    const read = await h.call("GET", agentHostRoutes.read("fork-child-3"));
    const { thread } = read.body as { thread: { head: { lineage?: { parentThreadId: string } } } };
    assert.equal(thread.head.lineage?.parentThreadId, parentId);
    const confirmed = await h.call("POST", agentHostRoutes.forkThread(parentId), { ...body, confirmOnly: true });
    assert.equal(confirmed.status, 200);
    const result = confirmed.body as { head: { id: string }; lineage: { parentThreadId: string }; strategy: string };
    assert.equal(result.head.id, "fork-child-3");
    assert.equal(result.lineage.parentThreadId, parentId);
    assert.equal(result.strategy, "empty");
    await h.stop();
  });
});

describe("agent host server — the thread's head (follow-up: head reads)", () => {
  it("serves the current head and matches its opening message through the URL query", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c-head-1", input: "hello" });
    await h.host.settle();
    const read = await h.call("GET", agentHostRoutes.read(threadId));
    const snap = (read.body as { thread: ThreadSnapshotPayload }).thread;
    const messageId = snap.turns.at(-1)?.userMessageId;
    assert.ok(messageId, "the sent message opened the turn");
    const query = { replyChars: 50, turnIds: ["nope"], messageIds: [messageId] };
    const params = new URLSearchParams(threadHeadQueryParams(query)).toString();
    const head = await h.call("GET", `${agentHostRoutes.head(threadId)}?${params}`);
    assert.equal(head.status, 200);
    const body = head.body as ThreadHeadResponse;
    assert.equal(body.seq, snap.seq);
    assert.equal(body.head.id, threadId);
    assert.equal(body.startedTurnCount, 1);
    assert.equal(body.runningTurn?.turnId, "turn-1");
    assert.equal(body.lastReply, null);
    assert.deepEqual(body.matchedTurns?.map((turn) => [turn.turnId, turn.userMessageId, turn.state]), [["turn-1", messageId, "running"]]);
    await h.stop();
  });

  it("refuses a lookup past the cap with 400 INVALID_COMMAND rather than cutting it short", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const ids = Array.from({ length: THREAD_HEAD_LOOKUP_MAX + 1 }, (_, i) => `m${i}`);
    const params = new URLSearchParams(threadHeadQueryParams({ messageIds: ids })).toString();
    const refused = await h.call("GET", `${agentHostRoutes.head(threadId)}?${params}`);
    assert.equal(refused.status, 400);
    assert.equal((refused.body as { error: { code: string } }).error.code, "INVALID_COMMAND");
    await h.stop();
  });

  it("a thread it does not hold is its own THREAD_NOT_FOUND, never the route miss an older host answers", async () => {
    const h = await harness();
    const gone = await h.call("GET", agentHostRoutes.head("nope"));
    assert.equal(gone.status, 404);
    const error = (gone.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, "THREAD_NOT_FOUND");
    assert.ok(!error.message.startsWith("No route for"), error.message);
    await h.stop();
  });
});

describe("agent host server — on-demand agent rows", () => {
  /** A settled agent `a` (a call and its words) and a running one `b`, ingested as an adapter's rows. */
  async function fleetThread(h: Harness, id = "thread-1"): Promise<string> {
    const threadId = await h.host.createThread({ threadId: id });
    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "c-fleet", input: "go" });
    await h.host.settle();
    const at = "1970-01-01T00:00:01.000Z";
    const row = (id: string, activityKind: string, payload: Record<string, unknown>, agentId?: string) => ({
      eventId: `ingest-${id}`,
      threadId,
      type: "thread.activity-appended" as const,
      payload: {
        activity: {
          kind: "activity" as const,
          id,
          tone: "tool" as const,
          activityKind,
          summary: activityKind,
          payload,
          turnId: null,
          createdAt: at,
          updatedAt: at,
          ...(agentId !== undefined ? { agentId } : {})
        }
      },
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      metadata: {}
    });
    const words = (messageId: string, text: string, agentId: string) => ({
      eventId: `ingest-${messageId}`,
      threadId,
      type: "thread.message-sent" as const,
      payload: { messageId, role: "assistant" as const, text, streaming: false, turnId: null, agentId },
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      metadata: {}
    });
    await h.host.orchestrator.ingestionSink(threadId, [
      row("a-launch", "task.started", { taskId: "a", agentKind: "agent", title: "A" }),
      row("b-launch", "task.started", { taskId: "b", agentKind: "agent", title: "B" }),
      row("a1-start", "tool.started", { toolUseId: "a1", title: "Bash" }, "a"),
      row("a1-done", "tool.completed", { toolUseId: "a1", title: "Bash" }, "a"),
      words("aw", "found it", "a"),
      row("b1-start", "tool.started", { toolUseId: "b1", title: "Read" }, "b"),
      row("a-end", "task.completed", { taskId: "a", agentKind: "agent", status: "completed" })
    ]);
    await h.host.settle();
    return threadId;
  }

  const idsOf = (items: ReadonlyArray<{ id: string }>): string[] => items.map((item) => item.id);

  it("a read without the opt-in is byte for byte the full snapshot; with it, the settled agent's rows are left out and named", async () => {
    const h = await harness();
    const threadId = await fleetThread(h);
    const full = await h.call("GET", agentHostRoutes.read(threadId));
    const unknown = await h.call("GET", `${agentHostRoutes.read(threadId)}?agentRows=everything`);
    assert.deepEqual(unknown.body, full.body, "only the one value opts in");
    const snap = (full.body as { thread: ThreadSnapshotPayload }).thread;
    assert.equal("omittedAgentIds" in snap, false);
    const lazy = await h.call("GET", `${agentHostRoutes.read(threadId)}?agentRows=on-demand`);
    const omitted = (lazy.body as { thread: ThreadSnapshotPayload }).thread;
    const status = Object.fromEntries(snap.roster.map((entry) => [entry.id, entry.status]));
    assert.equal(status.a, "completed");
    assert.deepEqual(omitted.omittedAgentIds, status.b === "completed" ? ["a", "b"] : ["a"]);
    const left = idsOf(snap.items).filter((id) => !idsOf(omitted.items).includes(id));
    assert.deepEqual(left.filter((id) => id.startsWith("a")), ["a1-start", "a1-done", "aw"]);
    for (const id of ["a-launch", "a-end", "b-launch"]) assert.ok(idsOf(omitted.items).includes(id), id);
    // Nothing but the items and the list moved.
    const { items: _fullItems, ...fullRest } = snap;
    const { items: _lazyItems, omittedAgentIds: _list, ...lazyRest } = omitted;
    assert.deepEqual(lazyRest, fullRest);
    await h.stop();
  });

  it("a POST naming the stream writes the agent's rows into that stream, after `synchronized`", async () => {
    const h = await harness();
    const threadId = await fleetThread(h);
    const full = ((await h.call("GET", agentHostRoutes.read(threadId))).body as { thread: ThreadSnapshotPayload }).thread;
    const plain = await h.stream(agentHostRoutes.events(threadId));
    const live = await h.stream(`${agentHostRoutes.events(threadId)}?agentRows=on-demand`);
    await plain.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    await live.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    const marker = live.frames.find((frame) => frame.kind === "synchronized") as { streamId?: string };
    const plainMarker = plain.frames.find((frame) => frame.kind === "synchronized") as { streamId?: string };
    assert.equal(plainMarker.streamId, undefined, "a stream without the opt-in has no id");
    assert.equal(typeof marker.streamId, "string");
    const first = live.frames[0] as { kind: string; thread: ThreadSnapshotPayload };
    assert.ok(first.thread.omittedAgentIds?.includes("a"));

    const answer = await h.call("POST", agentHostRoutes.agentRows(threadId), { streamId: marker.streamId, agentIds: ["a"] });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true });
    await live.waitFor((frames) => frames.some((frame) => frame.kind === "agent-rows"));
    const frame = live.frames.find((candidate) => candidate.kind === "agent-rows") as {
      seq: number;
      agentIds: string[];
      items: ThreadSnapshotPayload["items"];
      after: Array<string | null>;
    };
    assert.deepEqual(frame.agentIds, ["a"]);
    assert.equal(frame.seq, full.seq);
    assert.deepEqual(frame.items, full.items.filter((item) => item.agentId === "a" && item.id !== "a-end"));
    assert.equal(frame.after.length, frame.items.length);
    assert.ok(!plain.frames.some((candidate) => candidate.kind === "agent-rows"), "only the named stream");
    plain.close();
    live.close();
    await h.stop();
  });

  it("answers 404 STREAM_NOT_FOUND for a stream it does not hold or another thread's, and 400 for a malformed body", async () => {
    const h = await harness();
    const threadId = await fleetThread(h);
    const other = await h.host.createThread({ threadId: "thread-other" });
    const live = await h.stream(`${agentHostRoutes.events(threadId)}?agentRows=on-demand`);
    await live.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    const streamId = (live.frames.find((frame) => frame.kind === "synchronized") as { streamId: string }).streamId;
    const code = (result: { body: unknown }): string => (result.body as { error: { code: string } }).error.code;

    const unknown = await h.call("POST", agentHostRoutes.agentRows(threadId), { streamId: "nope", agentIds: ["a"] });
    assert.equal(unknown.status, 404);
    assert.equal(code(unknown), "STREAM_NOT_FOUND");
    const elsewhere = await h.call("POST", agentHostRoutes.agentRows(other), { streamId, agentIds: ["a"] });
    assert.equal(elsewhere.status, 404);
    assert.equal(code(elsewhere), "STREAM_NOT_FOUND");
    // A request whose frames cannot be built — the thread is gone — answers so, never a hang.
    const deletedThread = await fleetThread(h, "thread-doomed");
    const doomed = await h.stream(`${agentHostRoutes.events(deletedThread)}?agentRows=on-demand`);
    await doomed.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    const doomedId = (doomed.frames.find((frame) => frame.kind === "synchronized") as { streamId: string }).streamId;
    assert.equal((await h.call("DELETE", `/threads/${deletedThread}`)).status, 200);
    const gone = await h.call("POST", agentHostRoutes.agentRows(deletedThread), { streamId: doomedId, agentIds: ["a"] });
    assert.equal(gone.status, 404);
    assert.equal(code(gone), "THREAD_NOT_FOUND");
    doomed.close();
    for (const body of [{}, { streamId }, { streamId, agentIds: [] }, { streamId, agentIds: [7] }]) {
      const refused = await h.call("POST", agentHostRoutes.agentRows(threadId), body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(code(refused), "INVALID_COMMAND");
    }
    live.close();
    await h.stop();
  });
});
