/**
 * Projecting the native transcript into a timeline (E6).
 *
 * The content is real: fixture 11 is the resume-and-fork capture, replayed
 * through the normaliser to build the turns a `readThread` would hold, and
 * those turns are then projected. Fixture 11 is also the capture that proves
 * why this exists — `replayUuids: []`, a resume puts nothing on the stream.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent, ThreadSnapshot } from "@orquester/api/agent-chat";
import { HISTORICAL_RAW_SOURCE } from "@orquester/api/agent-chat";

import { countingIds, fixedClock, readClaudeFixture, replayClaudeFixture } from "./fixtures.ts";
import { projectClaudeHistory, readHistoryMessage } from "./project-history.ts";
import { groupClaudeHistoryTurns } from "./rollback.ts";

type EventOf<T extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: T }>;

function allOf<T extends RuntimeEvent["type"]>(
  events: readonly RuntimeEvent[],
  type: T
): Array<EventOf<T>> {
  return events.filter((event): event is EventOf<T> => event.type === type);
}

function project(snapshot: ThreadSnapshot): RuntimeEvent[] {
  return projectClaudeHistory(snapshot, { clock: fixedClock(), ids: countingIds() });
}

/**
 * The turns a `readThread` would hold for this capture: what the CLI streamed
 * back (from the normaliser) with each turn's human prompt at its head, which
 * is what a native transcript contains and the live stream never does.
 */
function snapshotFromFixture(name: string): ThreadSnapshot {
  const prompts = new Map<string, unknown>();
  for (const line of readClaudeFixture(name)) {
    if (line.kind !== "input") {
      continue;
    }
    const data = line.data as { uuid?: unknown; message?: unknown };
    if (typeof data.uuid === "string") {
      prompts.set(data.uuid, data.message);
    }
  }
  const { normalizer } = replayClaudeFixture(name);
  return {
    threadId: "thread-fixture",
    turns: normalizer.turns.map((turn) => {
      const prompt = prompts.get(turn.id);
      return {
        id: turn.id,
        items: prompt === undefined ? [...turn.items] : [prompt, ...turn.items]
      };
    })
  };
}

describe("claude history projection — fixture 11 (resume and fork)", () => {
  const snapshot = snapshotFromFixture("11-resume-and-fork.ndjson");

  it("the capture really does replay nothing on resume", () => {
    // The reason this projection exists at all.
    const note = readClaudeFixture("11-resume-and-fork.ndjson").find(
      (line) =>
        line.kind === "note" && "replayUuids" in (line.data as Record<string, unknown>)
    );
    assert.ok(note, "fixture 11 must carry the replayUuids note");
    assert.deepEqual((note.data as { replayUuids: unknown[] }).replayUuids, []);
  });

  it("projects one turn.started/turn.completed pair per turn", () => {
    assert.ok(snapshot.turns.length >= 2, "the capture must hold turns to project");
    const events = project(snapshot);
    const started = allOf(events, "turn.started");
    const completed = allOf(events, "turn.completed");
    assert.equal(started.length, snapshot.turns.length);
    assert.equal(completed.length, snapshot.turns.length);
    assert.deepEqual(
      started.map((event) => event.turnId),
      snapshot.turns.map((turn) => turn.id)
    );
    // Every turn is settled, and none claims token totals a transcript cannot
    // know.
    for (const event of completed) {
      assert.equal(event.payload.state, "completed");
      assert.equal(event.payload.tokenUsage?.usageStatus, "unavailable");
      assert.equal(event.payload.tokenUsage?.hasSubagents, false);
      assert.equal(event.payload.totalCostUsd, undefined);
    }
  });

  it("stamps every event as historical, never as a live frame", () => {
    const events = project(snapshot);
    assert.ok(events.length > 0);
    for (const event of events) {
      assert.equal(event.raw?.source, HISTORICAL_RAW_SOURCE, event.type);
      assert.equal(event.threadId, "thread-fixture");
      assert.equal(typeof event.eventId, "string");
      assert.ok(event.turnId, `${event.type} must be attributed to a turn`);
    }
    // Nothing that could move a live turn or open a card.
    for (const type of [
      "request.opened",
      "user-input.requested",
      "session.started",
      "session.exited",
      "task.started",
      "turn.aborted"
    ] as const) {
      assert.equal(allOf(events, type).length, 0, type);
    }
  });

  it("carries the messages' text on item.completed rows", () => {
    const events = project(snapshot);
    const items = allOf(events, "item.completed");
    const user = items.filter((event) => event.payload.itemType === "user_message");
    const assistant = items.filter((event) => event.payload.itemType === "assistant_message");
    assert.ok(user.length >= 2, "the capture's prompts must appear");
    assert.ok(assistant.length >= 2, "the capture's replies must appear");
    for (const event of [...user, ...assistant]) {
      assert.equal(event.payload.status, "completed");
      const text = (event.payload.data as { text?: unknown }).text;
      assert.equal(typeof text, "string");
      assert.ok((text as string).length > 0);
      assert.ok((event.payload.detail?.length ?? 0) > 0);
    }
    // The model's answers from the capture survive the round trip.
    const replies = assistant
      .map((event) => (event.payload.data as { text: string }).text)
      .join(" ");
    assert.ok(replies.includes("ZEBRA"), replies.slice(0, 200));

    // Assistant text also arrives as a delta, exactly as the live path emits
    // it, and on the same item id.
    const deltas = allOf(events, "content.delta").filter(
      (event) => event.payload.streamKind === "assistant_text"
    );
    assert.ok(deltas.length >= assistant.length);
    assert.ok(deltas.every((delta) => assistant.some((item) => item.itemId === delta.itemId)));
  });
});

describe("claude history projection — shapes", () => {
  const toolTurn: ThreadSnapshot = {
    threadId: "t",
    turns: [
      {
        id: "turn-1",
        items: [
          { role: "user", content: [{ type: "text", text: "read a.txt" }] },
          {
            role: "assistant",
            model: "claude-sonnet-5",
            content: [
              { type: "thinking", thinking: "The file is small." },
              { type: "text", text: "Reading it." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Bash",
                input: { command: "cat a.txt" }
              }
            ]
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "alpha", is_error: false }
            ]
          },
          { role: "assistant", content: [{ type: "text", text: "alpha" }] }
        ]
      }
    ]
  };

  it("pairs a tool_use with its tool_result on one item keyed by the tool-use id", () => {
    const events = project(toolTurn);
    const tools = allOf(events, "item.completed").filter(
      (event) => event.payload.itemType === "command_execution"
    );
    assert.equal(tools.length, 1);
    const tool = tools[0]!;
    assert.equal(tool.itemId, "toolu_1");
    assert.equal(tool.providerRefs?.providerItemId, "toolu_1");
    assert.equal(tool.payload.status, "completed");
    assert.equal(tool.payload.title, "Command run");
    const data = tool.payload.data as Record<string, unknown>;
    assert.equal(data.toolUseId, "toolu_1");
    assert.equal(data.toolName, "Bash");
    assert.deepEqual(data.input, { command: "cat a.txt" });
    assert.ok(data.result);
    // One row, not two: the call spans two transcript items.
    assert.equal(allOf(events, "item.started").length, 0);
  });

  it("projects reasoning as a reasoning row plus a summary delta", () => {
    const events = project(toolTurn);
    const reasoning = allOf(events, "item.completed").filter(
      (event) => event.payload.itemType === "reasoning"
    );
    assert.equal(reasoning.length, 1);
    assert.equal((reasoning[0]!.payload.data as { text: string }).text, "The file is small.");
    const summary = allOf(events, "content.delta").filter(
      (event) => event.payload.streamKind === "reasoning_summary_text"
    );
    assert.equal(summary.length, 1);
    assert.equal(summary[0]!.itemId, reasoning[0]!.itemId);
  });

  it("carries the turn's model onto turn.started", () => {
    const events = project(toolTurn);
    assert.equal(allOf(events, "turn.started")[0]!.payload.model, "claude-sonnet-5");
  });

  it("closes a tool call whose result never arrived rather than leaving it live", () => {
    const events = project({
      threadId: "t",
      turns: [
        {
          id: "turn-1",
          items: [
            { role: "user", content: [{ type: "text", text: "go" }] },
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "sleep 99" } }
              ]
            }
          ]
        }
      ]
    });
    const tool = allOf(events, "item.completed").find((event) => event.itemId === "toolu_9");
    assert.ok(tool);
    assert.equal(tool.payload.status, "failed");
  });

  it("renders a CLI denial as declined, not as a plain failure", () => {
    const events = project({
      threadId: "t",
      turns: [
        {
          id: "turn-1",
          items: [
            { role: "user", content: [{ type: "text", text: "go" }] },
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "toolu_d", name: "Bash", input: { command: "sleep 120" } }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_d",
                  content: "<tool_use_error>Blocked: sleep 120</tool_use_error>",
                  is_error: true
                }
              ]
            }
          ]
        }
      ]
    });
    const tool = allOf(events, "item.completed").find((event) => event.itemId === "toolu_d");
    assert.equal(tool?.payload.status, "declined");
    assert.ok((tool?.payload.data as { deniedReason?: string }).deniedReason?.includes("Blocked"));
  });

  it("reads both item shapes and skips anything else", () => {
    // A live turn's item is a bare body…
    assert.equal(readHistoryMessage({ role: "user", content: [] })?.role, "user");
    // …a transcript row wraps it and names its own type.
    assert.equal(
      readHistoryMessage({ type: "assistant", uuid: "u", message: { role: "assistant", content: [] } })
        ?.role,
      "assistant"
    );
    for (const bad of [null, undefined, 7, "x", {}, { type: "system", message: {} }]) {
      assert.equal(readHistoryMessage(bad), undefined, JSON.stringify(bad));
    }
  });

  it("survives a string `content`, which is what a compacted thread holds", () => {
    const events = project({
      threadId: "t",
      turns: [
        {
          id: "turn-1",
          items: [
            { role: "user", content: "This session is being continued from a previous…" }
          ]
        }
      ]
    });
    const item = allOf(events, "item.completed")[0];
    assert.equal(item?.payload.itemType, "user_message");
    assert.ok((item?.payload.data as { text: string }).text.startsWith("This session"));
  });

  it("projects nothing for a turn with nothing projectable", () => {
    assert.deepEqual(
      project({ threadId: "t", turns: [{ id: "turn-1", items: [{ type: "system" }] }] }),
      []
    );
    assert.deepEqual(project({ threadId: "t", turns: [] }), []);
  });
});

describe("claude history projection — grouping a native transcript", () => {
  it("opens a turn at each human prompt and drops the preamble", () => {
    const turns = groupClaudeHistoryTurns([
      { type: "system", uuid: "s1", message: { notice: "boot" } },
      {
        type: "user",
        uuid: "turn-a",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "one" }] }
      },
      {
        type: "assistant",
        uuid: "a1",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] }
      },
      {
        type: "user",
        uuid: "tr1",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }]
        }
      },
      {
        type: "user",
        uuid: "turn-b",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "two" }] }
      }
    ]);
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ["turn-a", "turn-b"]
    );
    // The tool result belongs to the turn it answered, not to a new one.
    assert.equal(turns[0]!.items.length, 3);
    assert.equal(turns[1]!.items.length, 1);
  });

  it("projects a grouped transcript end to end", () => {
    const turns = groupClaudeHistoryTurns([
      {
        type: "user",
        uuid: "turn-a",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "hello" }] }
      },
      {
        type: "assistant",
        uuid: "a1",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] }
      }
    ]);
    const events = project({ threadId: "t", turns });
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "turn.started",
        "item.completed",
        "content.delta",
        "item.completed",
        "turn.completed"
      ]
    );
    assert.equal(allOf(events, "turn.started")[0]!.turnId, "turn-a");
  });
});
