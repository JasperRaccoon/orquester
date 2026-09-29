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

/* Real host fold/retention must keep transcript output references readable as the command grows or ages out. */

const THREAD = "thread-1";
const SHELL = "bgshell:task-1";
const ITEM_ROUTE = /^\/api\/sessions\/([^/]+)\/items\/([^/]+)(\/output)?$/;

/** DaemonApi routes backed by the real host; bodies cross the JSON wire boundary. */
function hostApi(host: TestHost): DaemonApi {
  const wire = (status: number, body: unknown): DaemonResponse => ({ status, body: JSON.parse(JSON.stringify(body)) as unknown });
  return {
    fsRoot: "/work",
    workspacesDir: "/work",
    async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string> }): Promise<DaemonResponse> {
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
          const joined = await host.orchestrator.readToolOutputWindow(THREAD, itemId, { offset: Number(opts?.query?.offset), maxBytes: Number(opts?.query?.maxBytes) });
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

/** The subagent whose window a test fills past its cap. */
const AGENT = "agent-1";

/** One of {@link AGENT}'s rows of the call `toolUseId`, as ingestion writes it. */
function agentCallRow(host: TestHost, id: string, toolUseId: string, activityKind: string, payload: Record<string, unknown>): AppendableDomainEvent {
  host.clock.advance(1);
  const at = host.clock.nowIso();
  return sinkEvent(host, `ev-${id}`, "thread.activity-appended", {
    activity: { kind: "activity", id, tone: "tool", activityKind, summary: activityKind === "tool.output" ? "Tool output" : "Command run", payload: { toolUseId, ...payload }, turnId: "turn-1", agentId: AGENT, createdAt: at, updatedAt: at }
  });
}

const DATA = { toolName: "Bash", input: { command: "make -j8", description: "Build" }, background: true };
const CHUNKS = ["make: entering\n", "  [ 50%] cc a.o\n", "\n  [100%] linked\n"];

/** A thread whose one turn launched a background shell that has streamed three chunks. */
async function shellThread(): Promise<TestHost> {
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
  it("a running shell grows between two pages: the next page continues at the last one's end, until it finishes", async () => {
    const host = await shellThread();
    const api = hostApi(host);
    const entry = await shellEntry(api);
    assert.deepEqual([entry.tool.status, entry.outputItemId], ["inProgress", "shell-start"]);
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
});

describe("a subagent's command pushed past the cap, through read_transcript and read_tool_output, against the real orchestrator", () => {
  it("past the cap a running command loses its start — sixteen later calls of its agent, all more recently active, hold the slots — so its latest chunk is the entry and the id, and its whole output reads back from the log", async () => {
    const host = createTestHost();
    await host.createThread({ threadId: THREAD });
    for (const event of [
      sinkEvent(host, "ask:sent", "thread.message-sent", { messageId: "ask", role: "user", text: "start the dev server, then build every part", streaming: false, turnId: null }),
      sinkEvent(host, "ask:start", "thread.turn-start-requested", { turnId: null, messageId: "ask", interactionMode: "default" }),
      sinkEvent(host, "turn-1:running", "thread.session-set", { session: { status: "running", activeTurnId: "turn-1" } })
    ]) await host.orchestrator.ingestionSink(THREAD, [event]);
    // 300 rows of the parent's own work: the window's gate (500 activities) is past once the agent's rows come.
    await host.orchestrator.ingestionSink(THREAD, Array.from({ length: 300 }, (_, i) => {
      host.clock.advance(1);
      const at = host.clock.nowIso();
      return sinkEvent(host, `parent-${i}`, "thread.activity-appended", { activity: { kind: "activity", id: `parent-${i}`, tone: "info", activityKind: "runtime.warning", summary: `parent row ${i}`, payload: { message: `parent row ${i}` }, turnId: "turn-1", createdAt: at, updatedAt: at } });
    }));
    // The agent's dev server starts and prints, then goes quiet...
    const lines: string[] = [];
    const served = (id: string, delta: string): AppendableDomainEvent => {
      lines.push(delta);
      return agentCallRow(host, id, "serve", "tool.output", { streamKind: "command_output", delta });
    };
    await host.orchestrator.ingestionSink(THREAD, [
      agentCallRow(host, "serve-start", "serve", "tool.started", { itemType: "command_execution", title: "npm run dev", status: "inProgress", data: { command: "npm run dev" } }),
      ...Array.from({ length: 10 }, (_, i) => served(`serve-${i}`, `ready ${i}\n`))
    ]);
    // ...while sixteen builds the agent starts after it print on. Its 251st row trims its window: all seventeen openings
    // lie behind the cut, and the builds, more recently active, hold the cap's sixteen slots.
    await host.orchestrator.ingestionSink(THREAD, [
      ...Array.from({ length: 16 }, (_, k) => agentCallRow(host, `build-${k}-start`, `build-${k}`, "tool.started", { itemType: "command_execution", title: `make part-${k}`, status: "inProgress" })),
      ...Array.from({ length: 224 }, (_, n) => agentCallRow(host, `build-out-${n}`, `build-${n % 16}`, "tool.output", { streamKind: "command_output", delta: `built ${n}\n` }))
    ]);
    // Then the server prints again.
    await host.orchestrator.ingestionSink(THREAD, Array.from({ length: 5 }, (_, i) => served(`serve-late-${i}`, `request ${i} served\n`)));
    await host.settle();
    const snap = await host.orchestrator.readThread(THREAD);
    assert.ok(snap.kind === "snapshot");
    assert.ok(!snap.thread.items.some((item) => item.id === "serve-start"), "the call really has lost its retained start");

    const api = hostApi(host);
    const read = await transcriptTool.run(parse(transcriptTool, { sessionId: THREAD, agentId: AGENT }), ctx(api));
    const entry = (read.entries as { kind: string; outputItemId?: string }[]).find((e) => e.kind === "tool" && e.outputItemId === "serve-late-4");
    assert.ok(entry, "the retained output chunk links to its full durable output");
    // The whole output, from the log — the chunks the window dropped included.
    const whole = await outputTool.run(parse(outputTool, { sessionId: THREAD, itemId: entry.outputItemId! }), ctx(api));
    assert.deepEqual([whole.kind, whole.text, whole.running, "nextOffset" in whole], ["command-output", lines.join(""), true, false]);
    await host.stop();
  });
});
