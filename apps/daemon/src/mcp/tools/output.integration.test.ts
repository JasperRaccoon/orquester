import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { agentChatRoutes, type ThreadActivityItem } from "@orquester/api/agent-chat";
import { replayClaudeFixture } from "../../agent-host/adapters/claude/fixtures.ts";
import { createIngestion } from "../../agent-host/ingestion/index.ts";
import { FakeClock, FakeTimers, RecordingLiveness, counterIdGen } from "../../agent-host/ingestion/test-harness.ts";
import { isAgentChatCommandError } from "../../agent-host/orchestration/errors.ts";
import { createTestHost, type TestHost } from "../../agent-host/orchestration/testing/index.ts";
import { parseItemOutputWindow } from "../../agent-host/server/http-server.ts";
import type { AppendableDomainEvent } from "../../agent-host/services.ts";
import { createThreadStore } from "../../agent-host/store/index.ts";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "../daemon-api.ts";
import { chatSummary } from "../fixtures.ts";
import type { ToolContext, ToolDef } from "../tool.ts";
import { messageTools } from "./messages.ts";
import { outputTools } from "./output.ts";

/*
 * read_transcript's `outputItemId` and read_tool_output against the REAL orchestrator: its fold and snapshot slimming
 * (`slimItemsForRead`), its item read and its join of a call's streamed output — one window of it
 * (`readToolOutputWindow`), or the whole join (`readToolOutput`) from a host that ignores the window — over the in-memory
 * store the host's own tests use; then over the REAL store, whose cache serves the windows. A Claude background shell
 * seeded as ingestion writes it.
 */

const THREAD = "thread-1";
const SHELL = "bgshell:task-1";
const ITEM_ROUTE = /^\/api\/sessions\/([^/]+)\/items\/([^/]+)(\/output)?$/;

/**
 * The item-output route as the host's HTTP server answers it (agent-host/server/http-server.ts): one window of the join
 * when the query asks for one (`parseItemOutputWindow`, the server's own rules), else the whole join — and a host from
 * before windows (`olderHostWithRoute`) answers the whole join whatever the query says.
 */
async function itemOutputAnswer(
  read: { window(itemId: string, window: NonNullable<ReturnType<typeof parseItemOutputWindow>>): Promise<unknown>; whole(itemId: string): Promise<unknown> },
  itemId: string,
  query: Record<string, string> | undefined,
  olderHostWithRoute = false
): Promise<unknown> {
  const window = olderHostWithRoute ? null : parseItemOutputWindow(new URL(`http://agent-host.localhost/?${new URLSearchParams(query ?? {})}`));
  return window === null ? read.whole(itemId) : read.window(itemId, window);
}

/**
 * The daemon routes the two tools read, answered as the host's HTTP server answers them (agent-host/server/
 * http-server.ts): `…/thread` is `readThread`; `…/items/:itemId` is `readItem`, a miss 404 `THREAD_NOT_FOUND`;
 * `…/items/:itemId/output` is `readToolOutputWindow` (or, for no window, `readToolOutput`), a miss 404
 * `ITEM_NOT_FOUND` — or, on a host that predates the route, its generic route miss; on a host from before windows, the
 * whole join whatever the query asks. Every body crosses JSON, as it crosses the socket.
 */
function hostApi(host: TestHost, options: { olderHost?: boolean; olderHostWithRoute?: boolean } = {}): DaemonApi & { paths: string[] } {
  const wire = (status: number, body: unknown): DaemonResponse => ({ status, body: JSON.parse(JSON.stringify(body)) as unknown });
  const paths: string[] = [];
  return {
    fsRoot: "/work",
    workspacesDir: "/work",
    paths,
    async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string> }): Promise<DaemonResponse> {
      paths.push(path);
      try {
        if (method === "GET" && path === "/api/sessions") return wire(200, [chatSummary({ id: THREAD })]);
        if (method === "GET" && path === agentChatRoutes.thread(THREAD)) return wire(200, await host.orchestrator.readThread(THREAD));
        const match = method === "GET" ? ITEM_ROUTE.exec(path) : null;
        if (match && decodeURIComponent(match[1]!) === THREAD) {
          const itemId = decodeURIComponent(match[2]!);
          if (!match[3]) {
            const item = await host.orchestrator.readItem(THREAD, itemId);
            return item ? wire(200, { item }) : wire(404, { error: { code: "THREAD_NOT_FOUND", message: `No item '${itemId}'.` } });
          }
          if (options.olderHost) {
            return wire(404, { error: { code: "THREAD_NOT_FOUND", message: `No route for GET /threads/${THREAD}/items/${match[2]}/output.` } });
          }
          const joined = await itemOutputAnswer({
            window: (id, window) => host.orchestrator.readToolOutputWindow(THREAD, id, window),
            whole: (id) => host.orchestrator.readToolOutput(THREAD, id)
          }, itemId, opts?.query, options.olderHostWithRoute);
          return joined ? wire(200, joined) : wire(404, { error: { code: "ITEM_NOT_FOUND", message: `No tool call behind item '${itemId}'.` } });
        }
      } catch (error) {
        if (isAgentChatCommandError(error)) return wire(error.status, error.toEnvelope());
        throw error;
      }
      return wire(404, { error: { code: "NOT_FOUND", message: `${method} ${path}` } });
    },
    async uploadAttachment() { throw new Error("not a route these tests read"); },
    subscribe: () => () => {}
  };
}

const parse = (t: ToolDef, args: Record<string, unknown>) => z.object(t.input).strict().parse(args) as never;
const ctx = (api: DaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => 0 });
const transcriptTool = messageTools.find((t) => t.name === "read_transcript")!;
const outputTool = outputTools.find((t) => t.name === "read_tool_output")!;

/** An event as ingestion hands it to the orchestrator's sink. */
function sinkEvent<T extends AppendableDomainEvent["type"]>(host: TestHost, eventId: string, type: T, payload: Extract<AppendableDomainEvent, { type: T }>["payload"]): AppendableDomainEvent {
  return { eventId, threadId: THREAD, type, payload, occurredAt: host.clock.nowIso(), commandId: null, causationEventId: null, metadata: {} } as AppendableDomainEvent;
}

/** One of the shell's rows, as ingestion writes it: its own item id, stamped with the task as its agent. */
function shellRow(host: TestHost, id: string, activityKind: string, payload: Record<string, unknown>): AppendableDomainEvent {
  host.clock.advance(1);
  const at = host.clock.nowIso();
  return sinkEvent(host, `ev-${id}`, "thread.activity-appended", {
    activity: { kind: "activity", id, tone: "tool", activityKind, summary: activityKind === "tool.output" ? "Tool output" : "Background shell", payload: { toolUseId: SHELL, ...payload }, turnId: "turn-1", agentId: "task-1", createdAt: at, updatedAt: at }
  });
}

const DATA = { toolName: "Bash", input: { command: "make -j8", description: "Build" }, background: true };
const CHUNKS = ["make: entering\n", "  [ 50%] cc a.o\n", "\n  [100%] linked\n"];

/** A thread whose one turn launched a background shell that has streamed three chunks, and — when `done` — finished. */
async function shellThread(done: boolean): Promise<TestHost> {
  const host = createTestHost();
  await host.createThread({ threadId: THREAD });
  for (const event of [
    sinkEvent(host, "ask:sent", "thread.message-sent", { messageId: "ask", role: "user", text: "build it in the background", streaming: false, turnId: null }),
    sinkEvent(host, "ask:start", "thread.turn-start-requested", { turnId: null, messageId: "ask", interactionMode: "default" }),
    sinkEvent(host, "turn-1:running", "thread.session-set", { session: { status: "running", activeTurnId: "turn-1" } })
  ]) await host.orchestrator.ingestionSink(THREAD, [event]);
  await host.orchestrator.ingestionSink(THREAD, [
    shellRow(host, "shell-start", "tool.started", { itemType: "command_execution", title: "Background shell", status: "inProgress", agentId: "task-1", data: DATA }),
    ...CHUNKS.map((delta, i) => shellRow(host, `chunk-${i}`, "tool.output", { streamKind: "command_output", delta }))
  ]);
  if (done) {
    await host.orchestrator.ingestionSink(THREAD, [
      shellRow(host, "shell-done", "tool.completed", { itemType: "command_execution", title: "Background shell", status: "completed", agentId: "task-1", data: { ...DATA, exitCode: 0 } })
    ]);
  }
  await host.orchestrator.ingestionSink(THREAD, [sinkEvent(host, "turn-1:ready", "thread.session-set", { session: { status: "ready", activeTurnId: null } })]);
  await host.settle();
  return host;
}

/** The shell's one tool entry in its own drill-in, as read_transcript returns it. */
async function shellEntry(api: DaemonApi): Promise<{ tool: { status: string }; outputItemId?: string }> {
  const read = await transcriptTool.run(parse(transcriptTool, { sessionId: THREAD, agentId: "task-1" }), ctx(api));
  const tools = (read.entries as { kind: string; tool: { status: string }; outputItemId?: string }[]).filter((e) => e.kind === "tool");
  assert.equal(tools.length, 1);
  return tools[0]!;
}

describe("a background shell's output through read_transcript and read_tool_output, against the real orchestrator", () => {
  it("a finished shell: its completion — cut on the wire, holding no output — reads back as the joined chunks", async () => {
    const host = await shellThread(true);
    const api = hostApi(host);
    const entry = await shellEntry(api);
    assert.deepEqual([entry.tool.status, entry.outputItemId], ["completed", "shell-done"]);
    const whole = await outputTool.run(parse(outputTool, { sessionId: THREAD, itemId: entry.outputItemId! }), ctx(api));
    assert.deepEqual(whole, { itemId: "shell-done", kind: "command-output", text: CHUNKS.join(""), offset: 0, totalBytes: Buffer.byteLength(CHUNKS.join("")) });
    await host.stop();
  });

  it("a running shell: its latest row is offered, and its output so far comes back with running: true", async () => {
    const host = await shellThread(false);
    const api = hostApi(host);
    const entry = await shellEntry(api);
    assert.deepEqual([entry.tool.status, entry.outputItemId], ["inProgress", "shell-start"]);
    const soFar = await outputTool.run(parse(outputTool, { sessionId: THREAD, itemId: "shell-start" }), ctx(api));
    assert.deepEqual([soFar.kind, soFar.text, soFar.running], ["command-output", CHUNKS.join(""), true]);
    // The host was asked for one window, and answered one.
    assert.ok(api.paths.includes(agentChatRoutes.itemOutput(THREAD, "shell-start")));
    await host.stop();
  });

  it("a running shell grows between two pages: the next page continues at the last one's end, until it finishes", async () => {
    const host = await shellThread(false);
    const api = hostApi(host);
    const page = (offset: number, maxBytes = 1_000) => outputTool.run(parse(outputTool, { sessionId: THREAD, itemId: "shell-start", offset, maxBytes }), ctx(api));
    const soFar = CHUNKS.join("");
    const first = await page(0);
    assert.deepEqual(first, { itemId: "shell-start", kind: "command-output", text: soFar, offset: 0, totalBytes: Buffer.byteLength(soFar), running: true });
    // Two more chunks land while the caller reads; the next page starts where the first one ended.
    await host.orchestrator.ingestionSink(THREAD, ["  [ 99%] cc z.o\n", "installed \u{1F4E6}\n"].map((delta, i) => shellRow(host, `late-${i}`, "tool.output", { streamKind: "command_output", delta })));
    await host.settle();
    const grown = `  [ 99%] cc z.o\ninstalled \u{1F4E6}\n`;
    const second = await page(first.totalBytes as number);
    assert.deepEqual(second, { itemId: "shell-start", kind: "command-output", text: grown, offset: first.totalBytes, totalBytes: Buffer.byteLength(soFar + grown), running: true });
    // Narrow windows over the same span join to the same bytes, the 4-byte character never split.
    let text = "";
    for (let offset: number | undefined = first.totalBytes as number; offset !== undefined;) {
      const narrow = await page(offset, 3);
      text += narrow.text as string;
      offset = narrow.nextOffset as number | undefined;
    }
    assert.equal(text, grown);
    await host.orchestrator.ingestionSink(THREAD, [shellRow(host, "shell-done", "tool.completed", { itemType: "command_execution", title: "Background shell", status: "completed", agentId: "task-1", data: { ...DATA, exitCode: 0 } })]);
    await host.settle();
    const done = await page(Buffer.byteLength(soFar + grown));
    assert.deepEqual(done, { itemId: "shell-start", kind: "command-output", text: "", offset: Buffer.byteLength(soFar + grown), totalBytes: Buffer.byteLength(soFar + grown) });
    await host.stop();
  });

  it("a host that predates the join answers its route miss: the completion's payload comes back, never an error", async () => {
    const host = await shellThread(true);
    const api = hostApi(host, { olderHost: true });
    const entry = await shellEntry(api);
    const fallback = await outputTool.run(parse(outputTool, { sessionId: THREAD, itemId: entry.outputItemId! }), ctx(api));
    const completion = await host.orchestrator.readItem(THREAD, "shell-done");
    assert.ok(completion?.kind === "activity");
    assert.deepEqual([fallback.kind, fallback.text], ["payload", JSON.stringify(completion.payload, null, 2)]);
    assert.ok(api.paths.includes(agentChatRoutes.itemOutput(THREAD, "shell-done")), "the join was asked, and its miss read as none");
    await host.stop();
  });

  it("a shell that printed past its agent's 200-row window: its start is gone, its latest chunk is the entry and the id", async () => {
    const host = createTestHost();
    await host.createThread({ threadId: THREAD });
    for (const event of [
      sinkEvent(host, "ask:sent", "thread.message-sent", { messageId: "ask", role: "user", text: "start the dev server", streaming: false, turnId: null }),
      sinkEvent(host, "ask:start", "thread.turn-start-requested", { turnId: null, messageId: "ask", interactionMode: "default" }),
      sinkEvent(host, "turn-1:running", "thread.session-set", { session: { status: "running", activeTurnId: "turn-1" } })
    ]) await host.orchestrator.ingestionSink(THREAD, [event]);
    await host.orchestrator.ingestionSink(THREAD, [shellRow(host, "shell-start", "tool.started", { itemType: "command_execution", title: "Background shell", status: "inProgress", agentId: "task-1", data: DATA })]);
    // 300 chunks of the shell's output, and 300 rows of the parent's own work between them.
    const lines = Array.from({ length: 300 }, (_, i) => `request ${i} served\n`);
    for (const [i, delta] of lines.entries()) {
      host.clock.advance(1);
      const at = host.clock.nowIso();
      await host.orchestrator.ingestionSink(THREAD, [
        shellRow(host, `chunk-${i}`, "tool.output", { streamKind: "command_output", delta }),
        sinkEvent(host, `parent-${i}`, "thread.activity-appended", { activity: { kind: "activity", id: `parent-${i}`, tone: "info", activityKind: "runtime.warning", summary: `parent row ${i}`, payload: { message: `parent row ${i}` }, turnId: "turn-1", createdAt: at, updatedAt: at } })
      ]);
    }
    await host.settle();
    const snap = await host.orchestrator.readThread(THREAD);
    assert.ok(snap.kind === "snapshot");
    assert.equal(snap.thread.items.some((item) => item.id === "shell-start"), false, "retention dropped the shell's start");
    assert.ok(snap.thread.items.some((item) => item.id === "chunk-299"));

    const api = hostApi(host);
    const entry = await shellEntry(api);
    assert.deepEqual(entry, {
      turn: 1, turnId: "turn-1", kind: "tool", createdAt: (snap.thread.items.find((item) => item.id === "chunk-299") as ThreadActivityItem).createdAt, agentId: "task-1",
      tool: { type: "command_execution", title: "Tool output", status: "inProgress" }, outputItemId: "chunk-299"
    });
    // The whole output, from the log — the chunks the window dropped included.
    const whole = await outputTool.run(parse(outputTool, { sessionId: THREAD, itemId: entry.outputItemId! }), ctx(api));
    assert.deepEqual([whole.kind, whole.text, whole.running, "nextOffset" in whole], ["command-output", lines.join(""), true, false]);
    // Read in small windows, from a windowing host and from one that answers the whole join: the same pages, byte for byte.
    const older = hostApi(host, { olderHostWithRoute: true });
    for (const maxBytes of [7, 100, 1_001]) {
      const pages = async (from: DaemonApi): Promise<Record<string, unknown>[]> => {
        const all: Record<string, unknown>[] = [];
        for (let offset: number | undefined = 0; offset !== undefined;) {
          const next = await outputTool.run(parse(outputTool, { sessionId: THREAD, itemId: entry.outputItemId!, offset, maxBytes }), ctx(from));
          all.push(next);
          offset = next.nextOffset as number | undefined;
        }
        return all;
      };
      const windowed = await pages(api);
      assert.deepEqual(windowed, await pages(older), `maxBytes ${maxBytes}`);
      assert.equal(windowed.map((page) => page.text).join(""), lines.join(""), `maxBytes ${maxBytes}`);
    }
    await host.stop();
  });
});

describe("fixture claude/14a through the real ingestion and store: a file change is never a command's output", () => {
  const FIXTURE_THREAD = "thread-fixture";

  /** read_tool_output's routes, answered as the host answers them, over the real store. */
  function storeApi(store: ReturnType<typeof createThreadStore>): DaemonApi & { paths: string[] } {
    const wire = (status: number, body: unknown): DaemonResponse => ({ status, body: JSON.parse(JSON.stringify(body)) as unknown });
    const paths: string[] = [];
    return {
      fsRoot: "/work",
      workspacesDir: "/work",
      paths,
      async request(method: DaemonMethod, path_: string, opts?: { query?: Record<string, string> }): Promise<DaemonResponse> {
        paths.push(path_);
        if (method === "GET" && path_ === "/api/sessions") return wire(200, [chatSummary({ id: FIXTURE_THREAD })]);
        const match = method === "GET" ? ITEM_ROUTE.exec(path_) : null;
        if (match && decodeURIComponent(match[1]!) === FIXTURE_THREAD) {
          const itemId = decodeURIComponent(match[2]!);
          if (!match[3]) {
            const item = await store.readItem(FIXTURE_THREAD, itemId);
            return item ? wire(200, { item }) : wire(404, { error: { code: "THREAD_NOT_FOUND", message: `No item '${itemId}'.` } });
          }
          const joined = await itemOutputAnswer({
            window: (id, window) => store.readToolOutputWindow(FIXTURE_THREAD, id, window),
            whole: (id) => store.readToolOutput(FIXTURE_THREAD, id)
          }, itemId, opts?.query);
          return joined ? wire(200, joined) : wire(404, { error: { code: "ITEM_NOT_FOUND", message: `No tool call behind item '${itemId}'.` } });
        }
        return wire(404, { error: { code: "NOT_FOUND", message: `${method} ${path_}` } });
      },
      async uploadAttachment() { throw new Error("not a route these tests read"); },
      subscribe: () => () => {}
    };
  }

  it("the Write's completion answers its payload, its input included; the Bash call's answers its output", async (t) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "orq-output-14a-"));
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const store = createThreadStore({ rootDir, sweepIntervalMs: 0 });
    t.after(() => store.close());
    await store.append({ threadId: FIXTURE_THREAD, events: [{
      eventId: "created", threadId: FIXTURE_THREAD, type: "thread.created",
      payload: { projectPath: "/work/p", cwd: "/work/p", title: "14a", adapter: "claude", refId: "claude", accountId: "", home: "system", modelSelection: { model: "sonnet" }, runtimeMode: "auto-accept-edits" },
      occurredAt: "2026-09-21T00:00:00.000Z", commandId: null, causationEventId: null, metadata: {}
    } as AppendableDomainEvent] });
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingestion = createIngestion({
      sink: async (threadId, events) => { await store.append({ threadId, events }); },
      liveness: new RecordingLiveness(),
      clock,
      idGen: counterIdGen(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    });
    for (const event of replayClaudeFixture("14a-accept-edits-edit.ndjson").events) await ingestion.ingest(event);
    await ingestion.drain();
    await store.drain();

    const rows = (await store.readAll(FIXTURE_THREAD)).events.flatMap((event) => (event.type === "thread.activity-appended" ? [event.payload.activity] : []));
    const completion = (itemType: string) => rows.find((row) => row.activityKind === "tool.completed" && (row.payload as { itemType?: unknown }).itemType === itemType)!;
    const write = completion("file_change");
    const bash = completion("command_execution");
    // The Write's result text went out as a streamed chunk of its own call — the output the join would give.
    assert.ok(rows.some((row) => row.activityKind === "tool.output" && (row.payload as { streamKind?: unknown; toolUseId?: unknown }).streamKind === "file_change_output"
      && (row.payload as { toolUseId?: unknown }).toolUseId === (write.payload as { toolUseId?: unknown }).toolUseId));

    const api = storeApi(store);
    const r = await outputTool.run(parse(outputTool, { sessionId: FIXTURE_THREAD, itemId: write.id }), ctx(api));
    assert.deepEqual([r.kind, r.text], ["payload", JSON.stringify(write.payload, null, 2)]);
    assert.ok((r.text as string).includes("\"input\""), "the whole payload, the Write's input included");
    assert.ok(!api.paths.some((p_) => p_.endsWith("/output")), "a file change never asks for the join");
    const b = await outputTool.run(parse(outputTool, { sessionId: FIXTURE_THREAD, itemId: bash.id }), ctx(api));
    assert.equal(b.kind, "command-output");
    // The Bash call's own result is its output: its streamed copy, read through the store's cache one window at a time,
    // is the same text as its whole join.
    const joined = await store.readToolOutput(FIXTURE_THREAD, bash.id);
    assert.ok(joined !== null && joined.output.length > 0, "the Bash call streamed its result");
    let windowed = "";
    for (let offset: number | undefined = 0; offset !== undefined;) {
      const window = await store.readToolOutputWindow(FIXTURE_THREAD, bash.id, { offset, maxBytes: 5 });
      assert.ok(window !== null);
      windowed += window.text;
      offset = window.nextOffset;
    }
    assert.equal(windowed, joined.output);
  });
});
