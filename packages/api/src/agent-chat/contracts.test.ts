/** Public route encoding, output-window validation and provider task classification. */
import assert from "node:assert/strict";
import test from "node:test";
import { agentChatCommandPath, agentChatRoutes, classifyTaskAgentKind, isThreadItemOutputWindow } from "./index.ts";

test("route builders produce the §6 paths and encode their segments", () => {
  assert.equal(agentChatRoutes.turn("s1"), "/api/sessions/s1/turn");
  assert.equal(agentChatRoutes.sessionStop("s1"), "/api/sessions/s1/session/stop");
  assert.equal(agentChatRoutes.events("s1"), "/api/sessions/s1/events");
  assert.equal(agentChatRoutes.turnDiff("s1", 7), "/api/sessions/s1/turns/7/diff");
  assert.equal(agentChatRoutes.item("s1", "a/b"), "/api/sessions/s1/items/a%2Fb");
  // A tool call's streamed output hangs off its item: the id stays one encoded segment.
  assert.equal(agentChatRoutes.itemOutput("s1", "bgshell:t/1"), "/api/sessions/s1/items/bgshell%3At%2F1/output");
  assert.equal(agentChatRoutes.providers, "/api/agent/providers");
  assert.equal(agentChatRoutes.hostStop, "/api/agent-host/stop");

  assert.equal(agentChatCommandPath("s1", "session/stop"), "/api/sessions/s1/session/stop");
  assert.equal(agentChatCommandPath("s1", "task/stop"), "/api/sessions/s1/task/stop");
  assert.equal(agentChatCommandPath("s1", "background"), "/api/sessions/s1/background");
});

test("isThreadItemOutputWindow accepts one window of a join, and never the whole join a host that ignores the query answers", () => {
  const window = { toolUseId: "bgshell:task-1", offset: 4, text: "two\n", totalBytes: 12, nextOffset: 8, complete: false, truncated: false };
  assert.equal(isThreadItemOutputWindow(window), true);
  // The last window has no nextOffset; a join that streamed nothing is an empty window at 0.
  const { nextOffset: _last, ...last } = window;
  assert.equal(isThreadItemOutputWindow(last), true);
  assert.equal(isThreadItemOutputWindow({ ...last, offset: 0, text: "", totalBytes: 0 }), true);
  // The legacy body: the whole join as `output`, no window.
  assert.equal(isThreadItemOutputWindow({ toolUseId: "bgshell:task-1", output: "one\ntwo\n", complete: false, truncated: false }), false);
  // Anything that is not exactly the shape.
  for (const broken of [
    null,
    "one\n",
    [window],
    { ...window, text: 7 },
    { ...window, toolUseId: undefined },
    { ...window, offset: -1 },
    { ...window, offset: 1.5 },
    { ...window, offset: "4" },
    { ...window, totalBytes: Number.MAX_SAFE_INTEGER + 2 },
    { ...window, nextOffset: null },
    { ...window, nextOffset: "8" },
    { ...window, complete: "false" },
    { ...window, truncated: undefined }
  ]) {
    assert.equal(isThreadItemOutputWindow(broken), false, JSON.stringify(broken));
  }
});

test("classifyTaskAgentKind is a denylist, and nesting flips it", () => {
  assert.equal(classifyTaskAgentKind({ taskType: "subagent" }), "agent");
  assert.equal(classifyTaskAgentKind({ taskType: "local_agent" }), "agent", "drifted names pass");
  assert.equal(classifyTaskAgentKind({ taskType: "shell" }), "background");
  assert.equal(classifyTaskAgentKind({ taskType: "plan" }), "background");
  // A provider's scheduled prompt and its autonomous goal run nothing of their
  // own: their fires, turns and subagents are the work (Grok fixtures 29, 30).
  assert.equal(classifyTaskAgentKind({ taskType: "scheduled" }), "background");
  assert.equal(classifyTaskAgentKind({ taskType: "goal" }), "background");
  // Launched from inside a subagent: background unless itself agent-flavoured.
  assert.equal(classifyTaskAgentKind({ taskType: "shell", agentId: "a1" }), "background");
  assert.equal(classifyTaskAgentKind({ taskType: "subagent", agentId: "a1" }), "agent");
  assert.equal(classifyTaskAgentKind({ agentId: "a1" }), "background");
  assert.equal(classifyTaskAgentKind({}), "agent");
});
