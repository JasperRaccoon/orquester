/**
 * OpenCode adapter — a command whose final output OpenCode cut itself is
 * stored marked cut, and `read_tool_output` reads the whole of it.
 *
 * 1.18.32's `ShellTool.run` (read from the source, not captured — fixtures
 * README observation 28) keeps a command's output past its limits only in
 * part: the END of it (`es` walks the lines from the last one), behind
 * `...output truncated...\n\nFull output saved to: <file>\n\n`. The completion
 * carried that part in `data.result` unmarked, so the MCP's step 1 answered it
 * as the whole output while the GUI's viewer read the call's streamed join.
 * Marked `truncated` (as Codex marks a completion it bounded), both readers
 * follow `storedCommandOutput`: the join first, else the kept part as text.
 *
 * Frames are 1.18.32-shaped from its source, as the replay tests' own
 * builders are from fixture 04.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  agentChatRoutes,
  type DomainEvent,
  type ThreadActivityItem,
  type ThreadItem
} from "@orquester/api/agent-chat";

import { chatSummary, shellSummary } from "../../../mcp/fixtures.ts";
import { FakeDaemonApi } from "../../../mcp/testing.ts";
import type { ToolContext } from "../../../mcp/tool.ts";
import { outputTools } from "../../../mcp/tools/output.ts";
import { parseItemOutputWindow } from "../../server/http-server.ts";
import { joinToolOutput, toolOutputWindow } from "../../store/tool-output.ts";
import { normalizeOpenCodeEvent } from "./normalize.ts";
import type { OpenCodeRawEvent } from "./protocol.ts";
import { createSessionState } from "./state.ts";
import { createHostIngestion, HOST_THREAD_ID, loggedActivities } from "./testing/host.ts";

const SESSION = "ses_parent";
const PROMPT = "msg_prompt";
const MESSAGE = "msg_answer";
const CALL = "call_bash";
const SAVED = "/home/u/.local/share/opencode/tool-output/tool_0c9a";
const INPUT = { command: "seq -f 'line %05g' 0 3099", description: "Print 3100 lines" };

/** A `bash` part of the answer in `state`, as `message.part.updated` carries it. */
function bashPart(state: Record<string, unknown>): OpenCodeRawEvent {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: {
        id: "prt_bash",
        messageID: MESSAGE,
        sessionID: SESSION,
        type: "tool",
        tool: "bash",
        callID: CALL,
        state
      }
    }
  };
}

const pending = bashPart({ status: "pending", input: {}, raw: "" });

/** `metadata.output` as `ShellTool.run` restates it: all of it, or `"...\n\n"` and its last 30 000 characters. */
function running(printed: string): OpenCodeRawEvent {
  const output = printed.length <= 30_000 ? printed : `...\n\n${printed.slice(-30_000)}`;
  return bashPart({
    status: "running",
    input: INPUT,
    title: INPUT.command,
    metadata: { output, description: INPUT.description },
    time: { start: 1 }
  });
}

/** The completion: `output` the final text, `metadata.output` the last running value. */
function completed(output: string, last: string, cut: boolean): OpenCodeRawEvent {
  return bashPart({
    status: "completed",
    input: INPUT,
    output,
    title: INPUT.command,
    metadata: {
      output: last,
      exit: 0,
      description: INPUT.description,
      truncated: cut,
      ...(cut ? { outputPath: SAVED } : {})
    },
    time: { start: 1, end: 2 }
  });
}

/** `count` numbered lines from `from`, 11 characters each. */
function lines(from: number, count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${String(from + index).padStart(5, "0")}\n`).join("");
}

const PRINTED = lines(0, 3_100);
/** What the tool keeps of it: the note, then its last 2 000 lines. */
const KEPT = `...output truncated...\n\nFull output saved to: ${SAVED}\n\n${PRINTED.split("\n").slice(-2_001).join("\n")}`;
/** The window the last running frame restated. */
const LAST = `...\n\n${PRINTED.slice(-30_000)}`;

/** `frames` through the normaliser on a turn and the host's real ingestion: the log they write. */
async function ingested(frames: readonly OpenCodeRawEvent[]): Promise<DomainEvent[]> {
  const state = createSessionState({
    threadId: HOST_THREAD_ID,
    openCodeSessionId: SESSION,
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  state.activeTurnId = PROMPT;
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => "2026-09-25T10:00:00.000Z" };
  const host = createHostIngestion();
  for (const frame of frames) {
    await host.ingest(normalizeOpenCodeEvent(state, frame, ctx).events);
  }
  return host.log();
}

/** The call's completion as the host stores it and `GET …/items/:itemId` serves it. */
function completionOf(events: readonly DomainEvent[]): ThreadActivityItem {
  const row = loggedActivities(events).find(
    (activity) =>
      activity.activityKind === "tool.completed" &&
      (activity.payload as { toolUseId?: unknown } | null)?.toolUseId === CALL
  );
  assert.ok(row !== undefined, "the call's completion row");
  return row;
}

// --- read_tool_output, as an agent calls it over the MCP -----------------------------------------

const tool = outputTools.find((candidate) => candidate.name === "read_tool_output")!;
const ctx = (api: FakeDaemonApi): ToolContext => ({
  api,
  todos: {} as never,
  files: {} as never,
  signal: new AbortController().signal,
  now: () => 0
});

/**
 * A daemon whose chat session c1 holds `item` as the host stores it, and whose
 * host joins the item's call from `events` — one window at a time, by the
 * host's own rules — as `GET …/items/:itemId/output` does.
 */
function daemon(item: ThreadItem, events: readonly DomainEvent[]): FakeDaemonApi {
  return new FakeDaemonApi()
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), shellSummary()] })
    .on("GET", agentChatRoutes.item("c1", item.id), { status: 200, body: { item } })
    .on("GET", agentChatRoutes.itemOutput("c1", item.id), ({ query }) => {
      const joined = joinToolOutput(events, item.id);
      if (joined === null) {
        return { status: 404, body: { error: { code: "ITEM_NOT_FOUND", message: "No tool call behind item." } } };
      }
      const window = parseItemOutputWindow(
        new URL(`http://agent-host.localhost/?${new URLSearchParams(query ?? {})}`)
      );
      return { status: 200, body: window === null ? joined : toolOutputWindow(joined, window) };
    });
}

/** Every page of `itemId`, read as a caller is told to: from `nextOffset` until there is none. */
async function readAll(api: FakeDaemonApi, itemId: string): Promise<{ text: string; pages: Record<string, unknown>[] }> {
  const pages: Record<string, unknown>[] = [];
  let text = "";
  let offset = 0;
  for (;;) {
    const args = z.object(tool.input).strict().parse({ sessionId: "c1", itemId, offset }) as never;
    const page = await tool.run(args, ctx(api));
    pages.push(page);
    text += page.text as string;
    if (!("nextOffset" in page)) return { text, pages };
    offset = page.nextOffset as number;
  }
}

// --- the tests -----------------------------------------------------------------------------------

describe("an OpenCode command whose final output the tool cut", () => {
  it("is stored marked cut, and read_tool_output reads the streamed join: all it printed, then where it was saved", async () => {
    // The output streams in two frames — the second a sliding window — and
    // ends in a final output the tool cut.
    const events = await ingested([
      pending,
      running(lines(0, 2_700)),
      running(PRINTED),
      completed(KEPT, LAST, true)
    ]);
    const completion = completionOf(events);
    const payload = completion.payload as { truncated?: boolean; data?: { result?: string } };
    assert.equal(payload.truncated, true, "its data keeps only the part the tool kept");
    assert.equal(payload.data?.result, KEPT);

    const whole = `${PRINTED}\n\nFull output saved to: ${SAVED}`;
    const { text, pages } = await readAll(daemon(completion, events), completion.id);
    assert.equal(text, whole, "every line the command printed, from the join — never the kept part");
    for (const page of pages) {
      assert.equal(page.kind, "command-output");
      assert.equal("truncated" in page, false, "the join itself was not cut");
      assert.equal("running" in page, false, "the call completed");
    }
  });

  it("with nothing streamed, answers the part the tool kept as command-output, marked cut — never as the whole", async () => {
    const events = await ingested([pending, completed(KEPT, LAST, true)]);
    const completion = completionOf(events);
    assert.equal((completion.payload as { truncated?: boolean }).truncated, true);

    const { text, pages } = await readAll(daemon(completion, events), completion.id);
    assert.equal(text, KEPT, "the kept part, as the tool wrote it — its note names the saved file");
    for (const page of pages) {
      assert.equal(page.kind, "command-output");
      assert.equal(page.truncated, true, "only part of it was kept");
    }
  });

  it("a command-named tool the GENERIC truncation cut answers its kept head as command-output, marked cut", async () => {
    // Every tool but the shell goes through 1.18.32's `Truncate.output` (read
    // from the source): an MCP server's `run_command`, say, keeps the HEAD of
    // an output past the limits, its note at the end. Such a tool streams
    // nothing, so no join answers: the kept head does, only part of it.
    const head = PRINTED.split("\n").slice(0, 2_000).join("\n");
    const cutOutput =
      `${head}\n\n...1100 lines truncated...\n\nThe tool call succeeded but the output was truncated. ` +
      `Full output saved to: ${SAVED}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`;
    const completion = bashPart({
      status: "completed",
      input: { command: "seq -f 'line %05g' 0 3099" },
      output: cutOutput,
      title: "run_command",
      metadata: { truncated: true, outputPath: SAVED },
      time: { start: 1, end: 2 }
    });
    const renamed = JSON.parse(JSON.stringify(completion)) as { type: string; properties: { part: { tool: string } } };
    renamed.properties.part.tool = "shell_run_command";
    const events = await ingested([renamed]);
    const stored = completionOf(events);
    assert.deepEqual(
      [(stored.payload as { itemType?: string }).itemType, (stored.payload as { truncated?: boolean }).truncated],
      ["command_execution", true]
    );

    const { text, pages } = await readAll(daemon(stored, events), stored.id);
    assert.equal(text, cutOutput, "the kept head and the tool's note, as it wrote them");
    for (const page of pages) {
      assert.equal(page.kind, "command-output");
      assert.equal(page.truncated, true, "only part of it was kept");
    }
  });

  it("a completion the tool did not cut is unchanged: its data answers its output whole, and the join is never asked", async () => {
    const final = lines(0, 20);
    const events = await ingested([pending, running(lines(0, 10)), running(final), completed(final, final, false)]);
    const completion = completionOf(events);
    assert.equal("truncated" in (completion.payload as object), false);

    const api = daemon(completion, events);
    const { text, pages } = await readAll(api, completion.id);
    assert.equal(text, final);
    assert.deepEqual(pages, [
      { itemId: completion.id, kind: "command-output", text: final, offset: 0, totalBytes: final.length }
    ]);
    assert.ok(!api.calls.some((call) => call.path.endsWith("/output")), "the join was never read");
  });
});
