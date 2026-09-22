import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadMessageItem, Turn } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";
import {
  createEscapeSequence,
  deriveRewindTargets,
  ESCAPE_SEQUENCE_WINDOW_MS,
  rewindTargetPreview
} from "./rewind.logic";

function userRow(id: string, text: string, revertTurnCount?: number, attachments = 0): AgentChatTimelineRow {
  const message: ThreadMessageItem = {
    kind: "message",
    id,
    role: "user",
    text,
    turnId: null,
    streaming: false,
    createdAt: `2026-01-01T00:00:0${id.length % 10}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(attachments > 0
      ? {
          attachments: Array.from({ length: attachments }, (_, index) => ({
            type: "file" as const,
            id: `att-${index}`,
            name: `f${index}.txt`,
            mimeType: "text/plain",
            sizeBytes: 1
          }))
        }
      : {})
  };
  return {
    kind: "message",
    id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    ...(revertTurnCount === undefined ? {} : { revertTurnCount })
  };
}

function turn(turnId: string | null): Turn {
  return {
    turnId,
    state: "completed",
    turnCount: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    assistantMessageId: null
  };
}

describe("deriveRewindTargets", () => {
  it("lists rewindable user messages newest first, with the turns each drops", () => {
    const rows = [userRow("u1", "first", 0), userRow("u2", "second", 1), userRow("u3", "third", 2, 2)];
    const turns = [turn("t1"), turn("t2"), turn("t3")];
    const targets = deriveRewindTargets(rows, turns);
    assert.deepEqual(
      targets.map((target) => [target.messageId, target.targetTurnCount, target.droppedTurnCount]),
      [
        ["u3", 2, 1],
        ["u2", 1, 2],
        ["u1", 0, 3]
      ]
    );
    assert.equal(targets[0]?.attachmentCount, 2);
    assert.equal(targets[0]?.text, "third");
  });

  it("is a projection of the rows: a row without revertTurnCount is not a target", () => {
    const rows = [userRow("u1", "steer"), userRow("u2", "prompt", 1)];
    const targets = deriveRewindTargets(rows, [turn("t1"), turn("t2")]);
    assert.deepEqual(
      targets.map((target) => target.messageId),
      ["u2"]
    );
  });

  it("never reports fewer than one dropped turn, even while the turn is pending", () => {
    // The running turn has no id yet, so it is not "started" — but rewinding
    // to its prompt still removes it.
    const rows = [userRow("u1", "go", 0)];
    assert.equal(deriveRewindTargets(rows, [turn(null)])[0]?.droppedTurnCount, 1);
  });
});

describe("rewindTargetPreview", () => {
  it("takes the first non-empty line, collapsed and capped", () => {
    assert.equal(rewindTargetPreview("\n\n  hello   world \nsecond"), "hello world");
    const long = "x".repeat(200);
    const preview = rewindTargetPreview(long, 20);
    assert.equal(preview.length, 20);
    assert.ok(preview.endsWith("…"));
  });

  it("is empty for an empty message", () => {
    assert.equal(rewindTargetPreview("   \n "), "");
  });
});

describe("createEscapeSequence", () => {
  it("completes on the second press inside the window and then starts over", () => {
    const sequence = createEscapeSequence(600);
    assert.equal(sequence.press(1_000), false);
    assert.equal(sequence.press(1_400), true);
    // A third press is a fresh first press, not a second double.
    assert.equal(sequence.press(1_500), false);
    assert.equal(sequence.press(1_900), true);
  });

  it("a press outside the window is a first press", () => {
    const sequence = createEscapeSequence(ESCAPE_SEQUENCE_WINDOW_MS);
    assert.equal(sequence.press(1_000), false);
    assert.equal(sequence.press(1_000 + ESCAPE_SEQUENCE_WINDOW_MS + 1), false);
    assert.equal(sequence.press(1_000 + ESCAPE_SEQUENCE_WINDOW_MS + 100), true);
  });

  it("reset forgets the first press", () => {
    const sequence = createEscapeSequence(600);
    sequence.press(1_000);
    sequence.reset();
    assert.equal(sequence.press(1_100), false);
  });
});
