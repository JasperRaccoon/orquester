/**
 * The drill-in's timeline callbacks (§7.6): "the child view dispatches no
 * commands", but navigation and reads are no commands — the host's own
 * handlers pass through, and every command is inert.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { drillInTimelineCallbacks } from "./drill-in-callbacks";

describe("drillInTimelineCallbacks", () => {
  const openFile = (_path: string): void => {};
  const loadFullOutput = (_itemId: string): void => {};
  const openAgent = (_agentId: string): void => {};
  const host = { onOpenFile: openFile, onLoadFullOutput: loadFullOutput, onOpenAgent: openAgent };

  it("hands the host's navigation and reads through: a file, a whole output, a nested agent", () => {
    const callbacks = drillInTimelineCallbacks(host);
    assert.equal(callbacks.onOpenFile, openFile, "a file link in a child's words opens the file");
    assert.equal(callbacks.onLoadFullOutput, loadFullOutput);
    assert.equal(callbacks.onOpenAgent, openAgent, "a nested spawn row's member opens that agent");
  });

  it("keeps every command inert: no rewind, no turn diff, no queue", () => {
    const callbacks = drillInTimelineCallbacks(host);
    assert.equal(callbacks.canRevert, false);
    for (const command of [
      callbacks.onRevert,
      callbacks.onOpenTurnDiff,
      callbacks.onSendQueuedNow,
      callbacks.onReturnQueuedToComposer
    ]) {
      assert.notEqual(command, openFile);
      assert.notEqual(command, loadFullOutput);
      assert.notEqual(command, openAgent);
      assert.doesNotThrow(() => (command as (value?: unknown) => void)(undefined));
    }
  });

  it("a host that offers nothing gets inert navigation, never a crash", () => {
    const callbacks = drillInTimelineCallbacks({});
    assert.doesNotThrow(() => callbacks.onOpenFile("src/a.ts"));
    assert.doesNotThrow(() => callbacks.onLoadFullOutput("item-1"));
    assert.doesNotThrow(() => callbacks.onOpenAgent("agent-2"));
  });

  it("is one object per host, so the timeline's context holds still", () => {
    assert.deepEqual(drillInTimelineCallbacks(host), drillInTimelineCallbacks(host));
  });
});
