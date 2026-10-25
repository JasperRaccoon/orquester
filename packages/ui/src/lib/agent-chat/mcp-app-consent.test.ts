import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionActivity } from "@orquester/api";

import { bucketOf } from "../../components/attention/agent-sessions";
import { McpAppConsentQueue, consentActivity, withConsentAttention } from "./mcp-app-consent";

const ask = { sessionId: "s1", kind: "tool" as const, appName: "charts", title: "Run show_chart?", detail: "{}" };
const idle: SessionActivity = { state: "idle", attention: null, lastOutputAt: null, needsAttentionAt: null };

describe("a waiting MCP App consent raises attention", () => {
  it("the queue says which sessions wait, and since when, until answered", () => {
    const queue = new McpAppConsentQueue();
    queue.attachDock("s1");
    const before = queue.waiting();
    assert.equal(before.size, 0);
    void queue.ask("frame-1", ask);
    const waiting = queue.waiting();
    assert.ok(waiting.get("s1"));
    queue.answer(queue.pending("s1")[0]!.id, true);
    assert.equal(queue.waiting().size, 0);
  });

  it("withdrawing the frame or unmounting the dock clears it", () => {
    const queue = new McpAppConsentQueue();
    const detach = queue.attachDock("s1");
    void queue.ask("frame-1", ask);
    queue.withdraw("frame-1");
    assert.equal(queue.waiting().size, 0);
    void queue.ask("frame-1", ask);
    detach();
    assert.equal(queue.waiting().size, 0);
  });

  it("a session that waits reads as needing input — the attention bucket", () => {
    const folded = consentActivity(idle, "2026-10-14T10:00:00.000Z")!;
    assert.equal(folded.attention, "needs-input");
    assert.equal(folded.state, "waiting");
    assert.equal(folded.needsAttentionAt, "2026-10-14T10:00:00.000Z");
    assert.equal(bucketOf({ status: "running" } as never, folded), "attention");
    assert.equal(consentActivity(idle, undefined), idle, "nothing waits: unchanged");
    assert.equal(consentActivity(undefined, "t")?.attention, "needs-input", "no activity reported yet");
  });

  it("folds only the waiting sessions", () => {
    const activity = { s1: idle, s2: { ...idle, state: "working" as const } };
    assert.deepEqual(withConsentAttention(activity, new Map()), activity);
    const waiting = new Map([["s1", "t"]]);
    const folded = withConsentAttention(activity, waiting);
    assert.equal(folded.s1?.attention, "needs-input");
    assert.deepEqual(folded.s2, { ...idle, state: "working" });
  });
});
