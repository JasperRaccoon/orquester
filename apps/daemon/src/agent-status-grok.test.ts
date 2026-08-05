import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAgentEvent } from "./agent-status.ts";

const grok = (event: string, payload: unknown = {}) => classifyAgentEvent("grok", event, payload);

test("grok Stop counts as done only for a completed turn", () => {
  assert.equal(grok("Stop", { reason: "end_turn" }), "done");
  // Observe-only teardown fires Stop too — that is not a finished turn.
  assert.equal(grok("Stop", { reason: "channel_closed" }), null);
  assert.equal(grok("Stop", { reason: "shutdown" }), null);
  assert.equal(grok("Stop", {}), null);
  assert.equal(grok("Stop", null), null);
});

test("grok attention events map to waiting", () => {
  assert.equal(grok("Notification"), "waiting");
  assert.equal(grok("PermissionDenied"), "waiting");
});

test("grok progress events map to working", () => {
  assert.equal(grok("UserPromptSubmit"), "working");
  assert.equal(grok("PreToolUse"), "working");
});

test("unknown grok events are ignored", () => {
  assert.equal(grok("PostToolUse"), null);
  assert.equal(grok("SessionStart"), null);
  assert.equal(grok(""), null);
});
