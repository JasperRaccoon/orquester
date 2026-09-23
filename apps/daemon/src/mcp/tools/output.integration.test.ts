import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { isAgentChatCommandError } from "../../agent-host/orchestration/errors.ts";
import { createTestHost, type TestHost } from "../../agent-host/orchestration/testing/index.ts";
import type { AppendableDomainEvent } from "../../agent-host/services.ts";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "../daemon-api.ts";
import { chatSummary } from "../fixtures.ts";
import type { ToolContext, ToolDef } from "../tool.ts";
import { messageTools } from "./messages.ts";
import { outputTools } from "./output.ts";

/*
 * read_transcript's `outputItemId` and read_tool_output against the REAL orchestrator: its fold and snapshot slimming
 * (`slimItemsForRead`), its item read and its join of a call's streamed output (`readToolOutput`, over the in-memory
 * store the host's own tests use) — a Claude background shell seeded as ingestion writes it.
 */

const THREAD = "thread-1";
const SHELL = "bgshell:task-1";
const ITEM_ROUTE = /^\/api\/sessions\/([^/]+)\/items\/([^/]+)(\/output)?$/;

/**
 * The daemon routes the two tools read, answered as the host's HTTP server answers them (agent-host/server/
 * http-server.ts): `…/thread` is `readThread`; `…/items/:itemId` is `readItem`, a miss 404 `THREAD_NOT_FOUND`;
 * `…/items/:itemId/output` is `readToolOutput`, a miss 404 `ITEM_NOT_FOUND` — or, on a host that predates the route,
 * its generic route miss. Every body crosses JSON, as it crosses the socket.
 */
function hostApi(host: TestHost, options: { olderHost?: boolean } = {}): DaemonApi & { paths: string[] } {
  const wire = (status: number, body: unknown): DaemonResponse => ({ status, body: JSON.parse(JSON.stringify(body)) as unknown });
  const paths: string[] = [];
  return {
    fsRoot: "/work",
    workspacesDir: "/work",
    paths,
    async request(method: DaemonMethod, path: string): Promise<DaemonResponse> {
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
          const joined = await host.orchestrator.readToolOutput(THREAD, itemId);
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
    activity: { kind: "activity", id, tone: "tool", activityKind, summary: "Background shell", payload: { toolUseId: SHELL, ...payload }, turnId: "turn-1", agentId: "task-1", createdAt: at, updatedAt: at }
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
});
