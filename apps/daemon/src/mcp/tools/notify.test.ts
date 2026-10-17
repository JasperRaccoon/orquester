import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ThreadCaller, ToolCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";

const caller = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
  kind: "thread", threadId: "me", title: "Me", projectPath: "", workspace: "", cwd: "/", agentId: "codex", callId: "call-1",
  runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
});

async function notify(api: FakeDaemonApi, who: ToolCaller, args: Record<string, unknown>): Promise<CallToolResult> {
  return executeToolCall({ approvals: null }, { name: "notify_user", arguments: args }, { caller: who, api, signal: new AbortController().signal });
}
const answer = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

test("notify_user posts the push for the calling chat (its own session), in every mode and while planning", async () => {
  const api = new FakeDaemonApi().on("POST", "/api/push/notify", { status: 200, body: { sent: 2 } });
  for (const who of [caller(), caller({ planning: true }), caller({ workflowOwned: true })]) {
    const r = await notify(api, who, { title: "Tests pass", body: "Ready for review" });
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.deepEqual(answer(r), { sent: 2 });
  }
  assert.deepEqual(api.calls.map((c) => c.body), Array(3).fill({ title: "Tests pass", body: "Ready for review", sessionId: "me" }));
  // External callers name no chat.
  await notify(api, { kind: "external" }, { title: "Done" });
  assert.deepEqual(api.calls.at(-1)!.body, { title: "Done" });
});

test("notify_user: caps are the contract's, and the daemon's RATE_LIMITED passes through", async () => {
  const api = new FakeDaemonApi().on("POST", "/api/push/notify", { status: 429, body: { code: "RATE_LIMITED", message: "Too many notifications: try again in 300 s.", retryAfterSeconds: 300 } });
  const limited = await notify(api, caller(), { title: "Again" });
  assert.equal(limited.isError, true);
  assert.equal(answer(limited).code, "RATE_LIMITED");
  assert.match(answer(limited).message as string, /300 s/);
  for (const args of [{ title: "" }, { title: "x".repeat(121) }, { title: "ok", body: "y".repeat(301) }, { title: "ok", sessionId: "other" }]) {
    assert.equal(answer(await notify(api, caller(), args)).code, "INVALID_ARGUMENT", JSON.stringify(args).slice(0, 60));
  }
  // A title with nothing visible once flattened is refused before the daemon is asked (no rate slot taken).
  const before = api.calls.length;
  assert.equal(answer(await notify(api, caller(), { title: "\u202e\u200b\u0007" })).code, "INVALID_ARGUMENT");
  assert.equal(api.calls.length, before);
});
