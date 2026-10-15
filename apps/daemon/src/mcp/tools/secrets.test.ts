/**
 * `request_secret` as the catalog serves it (unified MCP design 2026-10-15 §4 row 44, §12.5;
 * design 2026-10-14 §5 "Secrets"), ported from `session-tools/secrets/index.test.ts` and run
 * through THE executor as a chat caller: strict arguments, each outcome's result, the value only in
 * a provided answer's result (and named for the host's masking), the waiting call's signal and
 * delivery promise handed to the port.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { secretValuesOf } from "../../agent-host/session-tools/index.ts";
import type { SessionSecretRequestResult, SessionSecretRequests } from "../../session-tools/contract.ts";
import type { ThreadCaller, ToolCaller } from "../catalog/contract.ts";
import { toolByName } from "../catalog/index.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { executeToolCall } from "../executor.ts";
import { SECRET_REQUEST_NOTES, secretsFamily } from "./secrets.ts";

const VALUE = "tok_live_0123456789";
const tool = secretsFamily.find((entry) => entry.name === "request_secret")!;

/** A port that answers every request with `answer`, recording what was asked. */
function port(answer: SessionSecretRequestResult) {
  const asked: Array<{ threadId: string; input: unknown; signal: AbortSignal; delivered?: Promise<boolean> }> = [];
  const requests: SessionSecretRequests = {
    request: async (threadId, input, signal, delivered) => {
      asked.push({ threadId, input, signal, ...(delivered ? { delivered } : {}) });
      return answer;
    }
  };
  return { requests, asked };
}

function chatCaller(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "thread-7", title: "Deploy", projectPath: "", workspace: "", cwd: "/work/p", agentId: "codex", callId: "call-1",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

const call = (
  args: unknown,
  opts: { secretRequests?: SessionSecretRequests; signal?: AbortSignal; caller?: ToolCaller } = {}
): Promise<CallToolResult> =>
  executeToolCall(
    { approvals: null, enabledToolsets: async () => new Set(["core"]), ...(opts.secretRequests ? { secretRequests: opts.secretRequests } : {}) },
    { name: "request_secret", arguments: args },
    { caller: opts.caller ?? chatCaller(), api: {} as DaemonApi, signal: opts.signal ?? new AbortController().signal }
  );

const json = (result: CallToolResult): Record<string, unknown> => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

describe("request_secret", () => {
  it("is the catalog's chat-only core Act tool, plan-safe, naming its secret result key", () => {
    assert.equal(toolByName("request_secret", "chat"), tool);
    assert.equal(toolByName("request_secret", "external"), undefined);
    assert.deepEqual([tool.audiences, tool.toolset, tool.tier, tool.planSafe], [["chat"], "core", "act", true]);
    assert.deepEqual(tool.secretResultKeys, ["value"]);
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    for (const fragment of ["private card", "10 minutes", "never print, echo, log or commit it", "`declined`", "`timed_out`", "Never ask for a secret in chat"]) {
      assert.ok(tool.description.includes(fragment), fragment);
    }
  });

  it("asks as the calling chat and returns the value to this call", async () => {
    const { requests, asked } = port({ outcome: "provided", value: VALUE });
    const signal = new AbortController().signal;
    const delivered = Promise.resolve(true);
    const result = await call({ name: " API_KEY ", prompt: "Paste it.", purpose: "Deploy" }, { secretRequests: requests, signal, caller: chatCaller({ delivered }) });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      asked.map(({ threadId, input }) => ({ threadId, input })),
      [{ threadId: "thread-7", input: { name: "API_KEY", prompt: "Paste it.", purpose: "Deploy" } }]
    );
    assert.equal(asked[0]!.signal, signal, "the call's own signal: a cancelled call closes the card");
    assert.equal(asked[0]!.delivered, delivered, "the delivery promise: an undelivered value is reported truthfully");
    const body = json(result);
    assert.deepEqual(body.secretRequest, { name: "API_KEY", purpose: "Deploy", outcome: "provided" });
    assert.equal(body.value, VALUE);
    assert.equal((result.structuredContent as { value?: unknown }).value, VALUE);
    assert.equal(body.note, SECRET_REQUEST_NOTES.provided);
    assert.match(String(body.note), /never print/);
    // The host learns which field is the secret from the definition.
    assert.deepEqual(secretValuesOf(tool, result), [VALUE]);
  });

  it("every other outcome carries the record and no value", async () => {
    for (const outcome of ["declined", "cancelled", "timed_out"] as const) {
      const { requests } = port({ outcome });
      const result = await call({ name: "K", prompt: "P", purpose: "" }, { secretRequests: requests });
      const body = json(result);
      assert.deepEqual(body.secretRequest, { name: "K", outcome });
      assert.equal("value" in body, false);
      assert.equal(body.note, SECRET_REQUEST_NOTES[outcome]);
      assert.deepEqual(secretValuesOf(tool, result), []);
    }
  });

  it("refuses arguments it does not know, and an empty prompt", async () => {
    const { requests, asked } = port({ outcome: "declined" });
    for (const args of [
      { name: "K", prompt: "P", threadId: "someone-else" },
      { name: "K" },
      { name: "", prompt: "P" },
      { name: "K".repeat(81), prompt: "P" },
      { name: "K", prompt: "   " }
    ]) {
      const result = await call(args, { secretRequests: requests });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal((result.structuredContent as { code?: string }).code, "INVALID_ARGUMENT");
    }
    assert.deepEqual(asked, []);
  });

  it("answers UNAVAILABLE where the daemon wires no secret requests, and a cancelled call never asks", async () => {
    const unavailable = await call({ name: "K", prompt: "P" });
    assert.equal(unavailable.isError, true);
    assert.equal((unavailable.structuredContent as { code?: string }).code, "UNAVAILABLE");
    const { requests, asked } = port({ outcome: "provided", value: VALUE });
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await call({ name: "K", prompt: "P" }, { secretRequests: requests, signal: aborted.signal });
    assert.equal((cancelled.structuredContent as { code?: string }).code, "CANCELLED");
    assert.deepEqual(asked, []);
  });

  it("works while planning and for a workflow-owned chat (no approval card involved); never for an external caller", async () => {
    for (const over of [{ planning: true }, { workflowOwned: true }]) {
      const { requests, asked } = port({ outcome: "declined" });
      const result = await call({ name: "K", prompt: "P" }, { secretRequests: requests, caller: chatCaller(over) });
      assert.equal(result.isError, undefined, JSON.stringify(over));
      assert.equal(asked.length, 1);
    }
    const { requests, asked } = port({ outcome: "provided", value: VALUE });
    const external = await call({ name: "K", prompt: "P" }, { secretRequests: requests, caller: { kind: "external" } });
    assert.equal((external.structuredContent as { code?: string }).code, "TOOL_NOT_FOUND");
    assert.deepEqual(asked, []);
  });
});
