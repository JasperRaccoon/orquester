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

import {
  THREAD_HISTORY_DEFAULT_TURNS,
  THREAD_HISTORY_MAX_TURNS,
  THREAD_SEARCH_MAX_QUERY_CHARS,
  THREAD_SEARCH_MAX_RESULTS,
  type AgentChatStreamFrame,
  type RuntimeEvent,
  type ThreadActivityItem,
  type ThreadHistoryPage,
  type ThreadSearchHit,
  type ThreadSearchResponse
} from "@orquester/api/agent-chat";

import {
  AGENT_HOST_PROTOCOL_VERSION,
  agentHostRoutes,
  type AgentHostHealthResponse,
  type AgentHostHoldGoalsResponse
} from "../host-protocol.ts";
import type { ThreadIndex } from "../index/index.ts";
import { runtimeEventToActivities } from "../ingestion/activities.ts";
import { GOAL_HELD_FOR_UPDATE_SUMMARY } from "../orchestration/orchestrator.ts";
import {
  createScriptedAdapter,
  createTestHost,
  type TestHost,
  type TestHostOptions
} from "../orchestration/testing/index.ts";
import { createFakeThreadIndex } from "../orchestration/testing/fake-index.ts";
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
    close(): void;
    waitFor(predicate: (frames: AgentChatStreamFrame[]) => boolean): Promise<void>;
  }>;
  stop(): Promise<void>;
}

async function harness(
  options: {
    openGate?: boolean;
    index?: ThreadIndex;
    afterStopResponse?: () => void;
    adapters?: TestHostOptions["adapters"];
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
    ...(options.afterStopResponse ? { afterStopResponse: options.afterStopResponse } : {})
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
    const missing = await new Promise<number>((resolve, reject) => {
      const req = request(
        { socketPath: h.socketPath, method: "GET", path: agentHostRoutes.health },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(missing, 401);
    const wrong = await h.call("GET", agentHostRoutes.health, undefined, "nope");
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, {
      error: { code: "COMMAND_REJECTED", message: "Unauthorized." }
    });
    await h.stop();
  });
});

describe("agent host server — readiness (§3.1, §8)", () => {
  it("does not answer health until the command gate opens", async () => {
    const h = await harness({ openGate: false });
    let answered = false;
    const pending = h.call("GET", agentHostRoutes.health).then((result) => {
      answered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(answered, false, "a bound socket is not readiness");
    h.host.orchestrator.openGate();
    const result = await pending;
    assert.equal(result.status, 200);
    const body = result.body as AgentHostHealthResponse;
    assert.equal(body.ok, true);
    assert.equal(body.protocolVersion, AGENT_HOST_PROTOCOL_VERSION);
    assert.equal(body.hostInstanceId, "host-test");
    assert.equal(body.pid, 4242);
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
    assert.deepEqual(h.host.checkpoints.deleted, ["thread-x"]);
    const gone = await h.call("GET", agentHostRoutes.read("thread-x"));
    assert.equal(gone.status, 404);
    await h.stop();
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
    assert.deepEqual(body.pendingRequests, [
      { requestId: "req-7", kind: "approval", title: "Change a file" }
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

  it("the intentional stop writes the continuation markers first (§3.3)", async () => {
    let teardownStarted = false;
    const h = await harness({
      afterStopResponse: () => {
        teardownStarted = true;
      }
    });
    const threadId = await h.host.createThread();
    await h.call("POST", agentHostRoutes.turn(threadId), { commandId: "stop-1", input: "go" });
    await h.host.settle();

    // The harness's own `onStop` is replaced by a real marker pass. This
    // project did not opt in, so §3.3 says nothing is marked.
    const marked = await h.host.orchestrator.markThreadsForContinuation();
    assert.deepEqual(marked, []);
    assert.equal(h.host.store.heads.get(threadId)?.continueAfterRestart, undefined);

    const stopped = await h.call("POST", agentHostRoutes.stop);
    assert.equal(stopped.status, 200);
    assert.equal((stopped.body as { ok: boolean }).ok, true);
    assert.equal(teardownStarted, true, "teardown starts only after the response flushes");
    await h.stop();
  });

  it("closes every open stream when the host stops", async () => {
    const h = await harness();
    const threadId = await h.host.createThread();
    const live = await h.stream(agentHostRoutes.events(threadId));
    await live.waitFor((frames) => frames.some((frame) => frame.kind === "synchronized"));
    assert.equal(h.server.openStreams, 1);
    await h.server.close();
    assert.equal(h.server.openStreams, 0);
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

describe("agent host server — indexed history and search (design 2026-09-23, C)", () => {
  /** Record what the route hands the orchestrator, then let the real call answer. */
  function spyHistory(h: Harness): Array<{ threadId: string; before?: string; turns?: number }> {
    const calls: Array<{ threadId: string; before?: string; turns?: number }> = [];
    const readHistory = h.host.orchestrator.readHistory.bind(h.host.orchestrator);
    h.host.orchestrator.readHistory = (threadId, query) => {
      calls.push({ threadId, ...query });
      return readHistory(threadId, query);
    };
    return calls;
  }

  it("serves a history page, clamping `turns` and passing `before` through untouched", async () => {
    const h = await harness({ index: createFakeThreadIndex() });
    const threadId = await h.host.createThread();
    const calls = spyHistory(h);

    const page = await h.call("GET", `${agentHostRoutes.history(threadId)}?before=opaque-cursor&turns=5`);
    assert.equal(page.status, 200);
    const body = page.body as ThreadHistoryPage;
    assert.equal(body.threadId, threadId);
    assert.deepEqual(body.turns, []);
    assert.equal(body.page.beforeCursor, null);

    for (const [query, turns] of [
      ["", THREAD_HISTORY_DEFAULT_TURNS],
      ["?turns=0", 1],
      ["?turns=-4", 1],
      [`?turns=${THREAD_HISTORY_MAX_TURNS + 900}`, THREAD_HISTORY_MAX_TURNS],
      ["?turns=many", THREAD_HISTORY_DEFAULT_TURNS],
      ["?before=&turns=7", 7]
    ] as const) {
      const answer = await h.call("GET", `${agentHostRoutes.history(threadId)}${query}`);
      assert.equal(answer.status, 200, query);
      assert.deepEqual(calls.at(-1), { threadId, turns }, query);
    }
    assert.deepEqual(calls[0], { threadId, before: "opaque-cursor", turns: 5 });
    await h.stop();
  });

  it("answers 503 INDEX_UNAVAILABLE for history without a usable index, 404 for no thread", async () => {
    for (const index of [undefined, createFakeThreadIndex({ available: false })]) {
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

  it("stamps the snapshot a thread read answers with its history bounds", async () => {
    const h = await harness({ index: createFakeThreadIndex() });
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

  it("searches, clamping the query and the limit, and passing the project through", async () => {
    const index = createFakeThreadIndex();
    const hit: ThreadSearchHit = {
      threadId: "thread-1",
      projectPath: "/work/project",
      title: "Test thread",
      turnId: "turn-1",
      ordinal: 1,
      kind: "message",
      id: "user:1",
      role: "user",
      activityKind: null,
      snippet: "a «needle» here",
      at: "1970-01-01T00:00:00.000Z",
      seq: 2
    };
    index.searchHits = Array.from({ length: 60 }, (_unused, n) => ({ ...hit, id: `user:${n}` }));
    const h = await harness({ index });

    const answer = await h.call(
      "GET",
      `${agentHostRoutes.search}?q=${encodeURIComponent("needle")}&limit=3&projectPath=${encodeURIComponent("/work/project")}`
    );
    assert.equal(answer.status, 200);
    const body = answer.body as ThreadSearchResponse;
    assert.equal(body.query, "needle");
    assert.equal(body.indexed, true);
    assert.equal(body.hits.length, 3);
    assert.equal(body.truncated, true);
    assert.deepEqual(index.searches.at(-1), { q: "needle", limit: 3, projectPath: "/work/project" });

    await h.call("GET", `${agentHostRoutes.search}?q=needle`);
    assert.deepEqual(index.searches.at(-1), { q: "needle", limit: 20 }, "a default page of hits");
    await h.call("GET", `${agentHostRoutes.search}?q=needle&limit=0`);
    assert.equal(index.searches.at(-1)?.limit, 1);
    await h.call("GET", `${agentHostRoutes.search}?q=needle&limit=9999`);
    assert.equal(index.searches.at(-1)?.limit, THREAD_SEARCH_MAX_RESULTS);

    // Clamped by code point: an astral character is never cut in half.
    const long = "🔎".repeat(THREAD_SEARCH_MAX_QUERY_CHARS + 50);
    const clamped = await h.call("GET", `${agentHostRoutes.search}?q=${encodeURIComponent(long)}`);
    assert.equal(
      Array.from((clamped.body as ThreadSearchResponse).query).length,
      THREAD_SEARCH_MAX_QUERY_CHARS
    );
    assert.equal(index.searches.at(-1)?.q, (clamped.body as ThreadSearchResponse).query);

    // A blank query matches nothing, and is still a 200.
    const blank = await h.call("GET", agentHostRoutes.search);
    assert.equal(blank.status, 200);
    assert.deepEqual(blank.body, { query: "", hits: [], truncated: false, indexed: true });
    await h.stop();
  });

  it("answers search `indexed: false` with a 200 when there is no usable index", async () => {
    for (const index of [undefined, createFakeThreadIndex({ available: false })]) {
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
    assert.equal(h.host.store.heads.get(threadId)?.goalHeldForHandover, true);
    const rows = (h.host.store.logs.get(threadId) ?? [])
      .filter((event) => event.type === "thread.activity-appended")
      .map((event) => (event.payload as { activity: ThreadActivityItem }).activity)
      .filter((activity) => activity.activityKind === "goal.status");
    assert.deepEqual(rows.map((row) => row.summary), [GOAL_HELD_FOR_UPDATE_SUMMARY]);

    // A renewal answers the thread already held.
    assert.deepEqual((await h.call("POST", agentHostRoutes.holdGoals)).body, {
      heldThreadIds: [threadId]
    });
    // Only POST is the route.
    assert.equal((await h.call("GET", agentHostRoutes.holdGoals)).status, 404);
    await h.stop();
  });
});
