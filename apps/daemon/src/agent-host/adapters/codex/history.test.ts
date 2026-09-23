/**
 * Codex adapter — history projection, replayed from the REAL resume capture
 * (E2E finding E6; §4.5 `readThread`, §7.3).
 *
 * `07-thread-resume-new-process.ndjson` is the capture where a second process
 * resumes a thread and hydrates it with `thread/turns/list`. Its payload is
 * exactly what `readThread` returns, so the test feeds the recorded bytes
 * through the projection rather than a hand-built snapshot.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { HISTORICAL_RAW_SOURCE, type ThreadSnapshot } from "@orquester/api/agent-chat";

import { CODEX_RAW_HISTORY, projectCodexHistory } from "./history.ts";
import type { RuntimeEventDraft } from "./normalise.ts";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/codex"
);

interface Frame {
  id?: number | string;
  method?: string;
  result?: { data?: { id: string; items: unknown[] }[] };
}

/**
 * The `thread/turns/list` result from the capture, shaped exactly as
 * `readThread` shapes it: oldest-first, items verbatim.
 */
function snapshotFromFixture(): ThreadSnapshot {
  const sent = new Map<number | string, string>();
  const turns: { id: string; items: unknown[] }[] = [];

  for (const line of readFileSync(
    join(FIXTURE_DIR, "07-thread-resume-new-process.ndjson"),
    "utf8"
  ).split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = JSON.parse(line) as { dir: string; frame: Frame };
    if (entry.dir === "send" && entry.frame.method !== undefined && entry.frame.id !== undefined) {
      sent.set(entry.frame.id, entry.frame.method);
      continue;
    }
    if (
      entry.dir === "recv" &&
      entry.frame.method === undefined &&
      entry.frame.id !== undefined &&
      sent.get(entry.frame.id) === "thread/turns/list"
    ) {
      for (const turn of entry.frame.result?.data ?? []) {
        turns.push({ id: turn.id, items: [...turn.items] });
      }
    }
  }
  // `thread/turns/list` answers newest-first; `readThread` reverses it.
  return { threadId: "thread-1", turns: [...turns].reverse() };
}

describe("codex history projection — replayed from fixture 07", () => {
  const snapshot = snapshotFromFixture();
  const events = projectCodexHistory(snapshot);

  it("the capture really carries a hydrated turn", () => {
    assert.equal(snapshot.turns.length, 1, "one turn was recorded");
    assert.equal(snapshot.turns[0]!.items.length, 2, "a user message and an assistant message");
  });

  it("brackets every turn with turn.started … turn.completed", () => {
    assert.equal(events[0]!.type, "turn.started");
    assert.equal(events.at(-1)!.type, "turn.completed");
    assert.equal(
      events.filter((event) => event.type === "turn.started").length,
      snapshot.turns.length
    );
    assert.equal(
      events.filter((event) => event.type === "turn.completed").length,
      snapshot.turns.length
    );
  });

  it("settles each turn completed and claims NO token usage", () => {
    const completed = events.find((event) => event.type === "turn.completed")!;
    const payload = completed.payload as {
      state: string;
      tokenUsage?: { usageStatus: string; hasSubagents: boolean };
    };
    assert.equal(payload.state, "completed");
    // Re-reading the thread total would charge every replayed turn the whole
    // conversation, and `turn/completed` carries no usage on the wire anyway.
    assert.equal(payload.tokenUsage?.usageStatus, "unavailable");
    assert.equal(payload.tokenUsage?.hasSubagents, false);
  });

  it("projects the user message with its text as `detail`", () => {
    const user = events.find(
      (event) =>
        event.type === "item.completed" &&
        (event.payload as { itemType: string }).itemType === "user_message"
    );
    assert.ok(user !== undefined, "the user's own turn must not vanish on resume");
    assert.equal(
      (user.payload as { detail?: string }).detail,
      "Remember the codeword: pineapple-42. Reply with just: ok"
    );
  });

  it("projects the assistant message with its text as `detail`", () => {
    // `detail` on an `item.completed` is what ingestion treats as "a snapshot
    // standing in for deltas that never arrived" — the history case exactly.
    const assistant = events.find(
      (event) =>
        event.type === "item.completed" &&
        (event.payload as { itemType: string }).itemType === "assistant_message"
    );
    assert.ok(assistant !== undefined);
    assert.equal((assistant.payload as { detail?: string }).detail, "ok");
    assert.deepEqual((assistant.payload as { data?: unknown }).data, { phase: "final_answer" });
  });

  it("carries the provider ids so a row groups exactly like a live one", () => {
    for (const event of events) {
      assert.equal(event.turnId, snapshot.turns[0]!.id);
      assert.equal(event.providerRefs?.providerTurnId, snapshot.turns[0]!.id);
    }
    const items = events.filter((event) => event.type === "item.completed");
    for (const item of items) {
      // `itemId` is what ingestion turns into `toolUseId`.
      assert.equal(typeof item.itemId, "string");
      assert.equal(item.providerRefs?.providerItemId, item.itemId);
    }
  });

  it("marks EVERY row as history so nothing reads it as live traffic", () => {
    for (const event of events) {
      assert.equal(event.raw?.source, CODEX_RAW_HISTORY, event.type);
    }
    // The marker is the SHARED one, not a Codex-private spelling: the fold
    // must recognise history without knowing which provider wrote it.
    assert.equal(CODEX_RAW_HISTORY, HISTORICAL_RAW_SOURCE);
  });

  it("emits nothing that could look like progress", () => {
    const live = new Set([
      "content.delta",
      "item.started",
      "item.updated",
      "tool.progress",
      "task.progress",
      "request.opened",
      "user-input.requested",
      "session.state.changed",
      "thread.token-usage.updated"
    ]);
    for (const event of events) {
      assert.equal(live.has(event.type), false, `${event.type} is live-only`);
    }
  });
});

describe("codex history projection — item selection", () => {
  const project = (items: unknown[]): RuntimeEventDraft[] =>
    projectCodexHistory({ threadId: "t", turns: [{ id: "turn-1", items }] });

  const itemTypes = (items: unknown[]): string[] =>
    project(items)
      .filter((event) => event.type === "item.completed")
      .map((event) => (event.payload as { itemType: string }).itemType);

  it("keeps tool-lifecycle items, classified on the typed discriminants", () => {
    assert.deepEqual(
      itemTypes([
        {
          type: "commandExecution",
          id: "c1",
          pluginId: null,
          scriptPath: null,
          command: "ls -1",
          cwd: "/tmp",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "a.ts\n",
          exitCode: 0,
          durationMs: 5
        },
        {
          type: "fileChange",
          id: "f1",
          changes: [{ path: "/tmp/a", kind: { type: "add" }, diff: "+x\n" }],
          status: "completed"
        },
        {
          type: "mcpToolCall",
          id: "m1",
          server: "s",
          tool: "t",
          status: "completed",
          arguments: {},
          appContext: null,
          pluginId: null,
          readOnlyHint: true,
          result: null,
          error: null,
          durationMs: 1
        }
      ]),
      ["command_execution", "file_change", "mcp_tool_call"]
    );
  });

  it("drops the provider's internal chatter", () => {
    assert.deepEqual(
      itemTypes([
        { type: "reasoning", id: "r1", summary: [], content: [] },
        { type: "plan", id: "p1", text: "a plan" },
        { type: "enteredReviewMode", id: "e1", review: "r" },
        { type: "exitedReviewMode", id: "x1", review: "r" },
        { type: "contextCompaction", id: "k1" },
        { type: "hookPrompt", id: "h1", fragments: [] },
        { type: "subAgentActivity", id: "s1", kind: "started", agentThreadId: "a", agentPath: "/root/x" }
      ]),
      [],
      "a resumed transcript shows the conversation, not the internals"
    );
  });

  it("never replays an item as still running", () => {
    // A rollout read back mid-item would otherwise put a spinner on a turn
    // that finished days ago.
    const [item] = project([
      {
        type: "commandExecution",
        id: "c1",
        pluginId: null,
        scriptPath: null,
        command: "sleep 30",
        cwd: "/tmp",
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    ]).filter((event) => event.type === "item.completed");
    assert.equal((item!.payload as { status?: string }).status, "completed");
  });

  it("preserves a declined item's status", () => {
    const [item] = project([
      {
        type: "fileChange",
        id: "f1",
        changes: [{ path: "/tmp/a", kind: { type: "add" }, diff: "" }],
        status: "declined"
      }
    ]).filter((event) => event.type === "item.completed");
    assert.equal((item!.payload as { status?: string }).status, "declined");
  });

  it("skips an empty message rather than emitting a blank row", () => {
    assert.deepEqual(
      itemTypes([
        { type: "userMessage", id: "u1", clientId: null, content: [] },
        {
          type: "agentMessage",
          id: "a1",
          text: "   ",
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null
        }
      ]),
      []
    );
  });

  it("joins a multi-part user message and ignores non-text parts", () => {
    const [user] = project([
      {
        type: "userMessage",
        id: "u1",
        clientId: null,
        content: [
          { type: "text", text: "look at", text_elements: [] },
          { type: "localImage", path: "/tmp/a.png" },
          { type: "text", text: "this", text_elements: [] }
        ]
      }
    ]).filter((event) => event.type === "item.completed");
    assert.equal((user!.payload as { detail?: string }).detail, "look at\nthis");
  });

  it("drops the `Attached files:` block the adapter appended from a replayed prompt", () => {
    // The rollout keeps the text the adapter SENT, suffix included
    // (`attachment-lines.ts`); the row is the user's own text.
    const [user] = project([
      {
        type: "userMessage",
        id: "u1",
        clientId: null,
        content: [
          { type: "text", text: "hello\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx", text_elements: [] },
          { type: "localImage", path: "/tmp/a.png" }
        ]
      }
    ]).filter((event) => event.type === "item.completed");
    assert.equal((user!.payload as { detail?: string }).detail, "hello");

    // A prompt that was nothing but the block is an attachment-only message,
    // and a replay has no attachment chips to show instead: the block stays.
    const [alone] = project([
      {
        type: "userMessage",
        id: "u2",
        clientId: null,
        content: [{ type: "text", text: "Attached files:\n- q3.xlsx: /a/q3.xlsx", text_elements: [] }]
      }
    ]).filter((event) => event.type === "item.completed");
    assert.equal(
      (alone!.payload as { detail?: string }).detail,
      "Attached files:\n- q3.xlsx: /a/q3.xlsx"
    );
  });

  it("tolerates a malformed item instead of throwing on a corrupt rollout", () => {
    assert.deepEqual(itemTypes([null, "nonsense", 42, {}, { type: "userMessage" }]), []);
  });

  it("an empty snapshot projects nothing at all", () => {
    assert.deepEqual(projectCodexHistory({ threadId: "t", turns: [] }), []);
  });

  it("keeps turns in order across several of them", () => {
    const events = projectCodexHistory({
      threadId: "t",
      turns: [
        { id: "turn-1", items: [] },
        { id: "turn-2", items: [] }
      ]
    });
    assert.deepEqual(
      events.map((event) => `${event.type}:${String(event.turnId)}`),
      [
        "turn.started:turn-1",
        "turn.completed:turn-1",
        "turn.started:turn-2",
        "turn.completed:turn-2"
      ]
    );
  });
});
