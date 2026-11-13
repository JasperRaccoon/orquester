/**
 * The embed's full-output read through the host's loaders: the reads the
 * app's viewer makes, each through its loader.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadItem } from "@orquester/api/agent-chat";

import { activity } from "../../../../packages/ui/src/lib/agent-chat/test-helpers";

import { loadFullOutput, type FullOutputLoaders } from "./full-output";

const SESSION = "chat-embed-1";

function loaders(item: ThreadItem, output: Awaited<ReturnType<FullOutputLoaders["itemOutput"]>>) {
  const calls = { item: [] as unknown[], itemOutput: [] as unknown[] };
  const value: FullOutputLoaders = {
    item: (request) => {
      calls.item.push(request);
      return Promise.resolve({ item });
    },
    itemOutput: (request) => {
      calls.itemOutput.push(request);
      return Promise.resolve(output);
    }
  };
  return { value, calls };
}

describe("embed loadFullOutput", () => {
  it("reads an agent's cut launch prompt through the item loader, titled for a prompt", async () => {
    const launch = activity(
      "task.started",
      { taskId: "agent-1", prompt: "Audit every table of the database, then report." },
      { id: "launch-1", turnId: "t1" }
    );
    const { value, calls } = loaders(launch, null);
    const result = await loadFullOutput(value, SESSION, "launch-1", "prompt", new AbortController().signal);
    assert.deepEqual(result, {
      kind: "output",
      title: "Prompt",
      text: "Audit every table of the database, then report.",
      notes: []
    });
    assert.deepEqual(calls.item, [{ sessionId: SESSION, itemId: "launch-1" }]);
    assert.equal(calls.itemOutput.length, 0);
  });

  it("reads the item when a streamed row's output route has none (null, its 404)", async () => {
    const command = activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call-1", data: { item: { aggregatedOutput: "the whole output" } } },
      { id: "cmd-1", turnId: "t1", status: "completed" }
    );
    const { value, calls } = loaders(command, null);
    const result = await loadFullOutput(value, SESSION, "cmd-1", "streamed", new AbortController().signal);
    assert.deepEqual(result, { kind: "output", title: "Full output", text: "the whole output", notes: [] });
    assert.equal(calls.itemOutput.length, 1);
    assert.deepEqual(calls.item, [{ sessionId: SESSION, itemId: "cmd-1" }]);
  });

  it("shows the viewer's unavailable copy when the item loader rejects", async () => {
    const result = await loadFullOutput(
      { item: () => Promise.reject(new Error("403")), itemOutput: () => Promise.resolve(null) },
      SESSION,
      "launch-1",
      "prompt",
      new AbortController().signal
    );
    assert.deepEqual(result, { kind: "error", title: "Prompt", error: "That prompt is no longer available." });
  });
});
