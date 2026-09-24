/**
 * Codex adapter — a command's completion keeps its whole output, bounded
 * (plan `2026-09-24-follow-ups-adapters-output-composer-history`, Task 3).
 *
 * Codex delivers a command's output whole in `item/completed.aggregatedOutput`
 * (`item/commandExecution/outputDelta` never fired in the captures, fixtures
 * README observation 18), and the completion kept none of it in `data`: its
 * `detail` — cut to 180 characters by ingestion — was all that survived.
 * `data.item.aggregatedOutput` now keeps it, where every reader of a command's
 * output already looks (`commandOutputText`, the wire slimmer's
 * `projectCommandData`), up to 64 KiB of UTF-8. Past that the stored text is
 * its head, cut on a character boundary, and the row says so
 * (`payload.truncated`), so `read_tool_output` reads the call's streamed join
 * instead of answering a cut text as the whole output.
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
import type { CodexProtocol } from "./_generated/index.ts";
import { ingestCodexDrafts, loggedActivities } from "./fold-testing.ts";
import { projectCodexHistory } from "./history.ts";
import { classifyItem } from "./items.ts";
import { CodexNormaliser, type RuntimeEventDraft } from "./normalise.ts";
import { CodexUsageTracker } from "./usage.ts";

/** The most a completion stores of a command's output, in UTF-8 bytes. */
const CAP = 64 * 1024;
const PARENT = "parent-thread";
const TURN = "turn-1";
const CALL = "call_1";

function make(): CodexNormaliser {
  return new CodexNormaliser({ usage: new CodexUsageTracker(), ownThreadId: () => PARENT });
}

function turnStarted(n: CodexNormaliser): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.TurnStartedNotification = {
    threadId: PARENT,
    turn: {
      id: TURN,
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: 0,
      completedAt: null,
      durationMs: null
    }
  };
  return n.notification("turn/started", params);
}

function command(
  status: CodexProtocol.v2.CommandExecutionStatus,
  aggregatedOutput: string | null
): Extract<CodexProtocol.v2.ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id: CALL,
    pluginId: null,
    scriptPath: null,
    command: "pnpm test",
    cwd: "/w/p",
    processId: null,
    source: "unifiedExecStartup",
    status,
    commandActions: [],
    aggregatedOutput,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 5 : null
  };
}

function started(n: CodexNormaliser): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.ItemStartedNotification = {
    item: command("inProgress", null),
    threadId: PARENT,
    turnId: TURN,
    startedAtMs: 0
  };
  return n.notification("item/started", params);
}

function completed(n: CodexNormaliser, output: string): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.ItemCompletedNotification = {
    item: command("completed", output),
    threadId: PARENT,
    turnId: TURN,
    completedAtMs: 1
  };
  return n.notification("item/completed", params);
}

function streamed(n: CodexNormaliser, delta: string): RuntimeEventDraft[] {
  const params: CodexProtocol.v2.CommandExecutionOutputDeltaNotification = {
    threadId: PARENT,
    turnId: TURN,
    itemId: CALL,
    delta
  };
  return n.notification("item/commandExecution/outputDelta", params);
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

interface StoredCommandPayload {
  detail?: string;
  truncated?: boolean;
  data?: { item?: { aggregatedOutput?: string } };
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

describe("a Codex command's completion keeps its output (Task 3)", () => {
  it("stores a 5 000-character output whole; read_tool_output answers it; the row's detail stays the preview", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `ok ${i} - parses case ${i}`.padEnd(49, "."));
    const output = `${lines.join("\n")}\n`;
    assert.equal(output.length, 5_000);
    const n = make();
    const events = await ingestCodexDrafts([turnStarted(n), started(n), completed(n, output)]);
    const completion = completionOf(events);
    const payload = completion.payload as StoredCommandPayload;

    assert.equal(payload.data?.item?.aggregatedOutput, output, "the whole output, as Codex sent it");
    assert.equal("truncated" in payload, false, "nothing was cut");
    assert.equal(payload.detail, `${output.slice(0, 177)}...`, "the row's detail stays the short preview");

    const { text, pages } = await readAll(daemon(completion, events), completion.id);
    assert.equal(text, output);
    assert.deepEqual(pages, [
      { itemId: completion.id, kind: "command-output", text: output, offset: 0, totalBytes: 5_000 }
    ]);
  });

  it("past 64 KiB stores the head, cut on a character boundary and marked; read_tool_output reads the streamed join", async () => {
    // Four widths of character, so the cap falls inside one: "✓" (3 bytes),
    // "語" (3), "😀" (4) and ASCII.
    const line = (i: number): string => `✓ case ${i} 語 😀\n`;
    const lines: string[] = [];
    for (let i = 0, bytes = 0; bytes <= CAP + 5_000; i += 1) {
      lines.push(line(i));
      bytes += Buffer.byteLength(lines[i]!, "utf8");
    }
    const output = lines.join("");
    const n = make();
    const chunks: RuntimeEventDraft[][] = [];
    for (let i = 0; i < lines.length; i += 500) chunks.push(streamed(n, lines.slice(i, i + 500).join("")));
    const events = await ingestCodexDrafts([turnStarted(n), started(n), ...chunks, completed(n, output)]);
    const completion = completionOf(events);
    const payload = completion.payload as StoredCommandPayload;

    const stored = payload.data?.item?.aggregatedOutput;
    assert.ok(stored !== undefined, "the head is stored");
    assert.equal(payload.truncated, true, "the row says its output was cut");
    assert.ok(output.startsWith(stored), "a head of the output");
    const bytes = Buffer.byteLength(stored, "utf8");
    assert.ok(bytes <= CAP, `${bytes} bytes stored, at most ${CAP}`);
    const next = String.fromCodePoint(output.codePointAt(stored.length)!);
    assert.ok(bytes + Buffer.byteLength(next, "utf8") > CAP, "cut at the last whole character that fits");
    assert.ok(!stored.includes("�"), "no character was split");

    // Stored cut, never the whole: read_tool_output reads the call's join.
    const { text, pages } = await readAll(daemon(completion, events), completion.id);
    assert.equal(text, output, "the whole output, from the streamed join");
    for (const page of pages) {
      assert.equal(page.kind, "command-output");
      assert.equal("truncated" in page, false, "the join itself was not cut");
      assert.equal("running" in page, false, "the call completed");
    }
  });

  it("past 64 KiB with nothing streamed, the cut head is never answered as the whole output", async () => {
    const output = "x".repeat(CAP + 1);
    const n = make();
    const events = await ingestCodexDrafts([turnStarted(n), started(n), completed(n, output)]);
    const completion = completionOf(events);
    assert.equal((completion.payload as StoredCommandPayload).truncated, true);

    const { text, pages } = await readAll(daemon(completion, events), completion.id);
    assert.equal(pages[0]!.kind, "payload", "the item as stored, never 'command-output'");
    assert.equal(text, JSON.stringify(completion.payload, null, 2));
  });

  it("the bound is exact: 64 KiB is whole, a byte more is cut, and a character never straddles it", () => {
    const at = (output: string) => {
      const classified = classifyItem(command("completed", output));
      return {
        stored: (classified.data as StoredCommandPayload["data"])?.item?.aggregatedOutput,
        truncated: (classified as { truncated?: boolean }).truncated
      };
    };
    assert.deepEqual(at("a".repeat(CAP)), { stored: "a".repeat(CAP), truncated: undefined });
    assert.deepEqual(at(`${"a".repeat(CAP)}b`), { stored: "a".repeat(CAP), truncated: true });
    // A 4-byte character with 2 bytes of room left is not stored at all.
    assert.deepEqual(at(`${"a".repeat(CAP - 2)}😀`), { stored: "a".repeat(CAP - 2), truncated: true });
    // No output, nothing stored: a declined command has none.
    const declined = classifyItem(command("declined", null));
    assert.equal((declined.data as StoredCommandPayload["data"])?.item, undefined);
    assert.equal((declined as { truncated?: boolean }).truncated, undefined);
  });

  it("a replayed command keeps its output too, bounded and marked the same way", () => {
    const whole = "done\n";
    const long = "y".repeat(CAP + 10);
    const drafts = projectCodexHistory({
      threadId: "t",
      turns: [{ id: TURN, items: [{ ...command("completed", whole), id: "c1" }, { ...command("completed", long), id: "c2" }] }]
    });
    const rows = drafts.filter((draft) => draft.type === "item.completed");
    const payloads = rows.map((row) => row.payload as StoredCommandPayload);
    assert.deepEqual(
      payloads.map((payload) => [payload.data?.item?.aggregatedOutput?.length, payload.truncated]),
      [
        [whole.length, undefined],
        [CAP, true]
      ]
    );
  });
});
