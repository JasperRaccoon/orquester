/**
 * `request_secret` as the daemon runs it (design 2026-10-14 §5 "Secrets"):
 * strict arguments, each outcome's result, and the value only in a provided
 * answer's result.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { secretValuesOf } from "../../agent-host/session-tools/index.ts";
import type { DaemonApi } from "../../mcp/daemon-api.ts";
import type { SessionSecretRequestResult, SessionSecretRequests, SessionToolContext } from "../contract.ts";
import { executeSessionToolCall } from "../executor.ts";
import { createSessionToolRegistry } from "../registry.ts";
import { secretsToolkit } from "./index.ts";

const registry = createSessionToolRegistry([secretsToolkit]);
const VALUE = "tok_live_0123456789";

/** A port that answers every request with `answer`, recording what was asked. */
function port(answer: SessionSecretRequestResult) {
  const asked: Array<{ threadId: string; input: unknown }> = [];
  const requests: SessionSecretRequests = {
    request: async (threadId, input) => {
      asked.push({ threadId, input });
      return answer;
    }
  };
  return { requests, asked };
}

function ctx(secretRequests?: SessionSecretRequests, signal = new AbortController().signal): SessionToolContext {
  return {
    threadId: "thread-7",
    projectPath: "/work/p",
    cwd: "/work/p",
    agentId: "codex",
    callId: "call-1",
    signal,
    api: {} as DaemonApi,
    ...(secretRequests !== undefined ? { secretRequests } : {}),
    now: () => 0
  };
}

const call = (args: unknown, context: SessionToolContext): Promise<CallToolResult> =>
  executeSessionToolCall(registry, { name: "request_secret", arguments: args }, context);

const json = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

describe("request_secret", () => {
  it("asks as the calling thread and returns the value to this call", async () => {
    const { requests, asked } = port({ outcome: "provided", value: VALUE });
    const result = await call({ name: " API_KEY ", prompt: "Paste it.", purpose: "Deploy" }, ctx(requests));
    assert.equal(result.isError, undefined);
    assert.deepEqual(asked, [{ threadId: "thread-7", input: { name: "API_KEY", prompt: "Paste it.", purpose: "Deploy" } }]);
    const body = json(result);
    assert.deepEqual(body.secretRequest, { name: "API_KEY", purpose: "Deploy", outcome: "provided" });
    assert.equal(body.value, VALUE);
    assert.equal((result.structuredContent as { value?: unknown }).value, VALUE);
    assert.match(String(body.note), /never print/);
    // The host learns which field is the secret from the definition.
    assert.deepEqual(secretValuesOf(registry.get("request_secret"), result), [VALUE]);
  });

  it("every other outcome carries the record and no value", async () => {
    for (const outcome of ["declined", "cancelled", "timed_out"] as const) {
      const { requests } = port({ outcome });
      const result = await call({ name: "K", prompt: "P" }, ctx(requests));
      const body = json(result);
      assert.deepEqual(body.secretRequest, { name: "K", outcome });
      assert.equal("value" in body, false);
      assert.deepEqual(secretValuesOf(registry.get("request_secret"), result), []);
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
      const result = await call(args, ctx(requests));
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal((result.structuredContent as { code?: string }).code, "INVALID_ARGUMENT");
    }
    assert.deepEqual(asked, []);
  });

  it("answers UNAVAILABLE where the daemon wires no secret requests, and a cancelled call never asks", async () => {
    const unavailable = await call({ name: "K", prompt: "P" }, ctx());
    assert.equal(unavailable.isError, true);
    assert.equal((unavailable.structuredContent as { code?: string }).code, "UNAVAILABLE");
    const { requests, asked } = port({ outcome: "provided", value: VALUE });
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await call({ name: "K", prompt: "P" }, ctx(requests, aborted.signal));
    assert.equal((cancelled.structuredContent as { code?: string }).code, "CANCELLED");
    assert.deepEqual(asked, []);
  });

  it("its instruction paragraph says to ask through the tool, never in chat", () => {
    assert.match(secretsToolkit.instructions ?? "", /request_secret/);
    assert.ok(registry.instructions.endsWith(secretsToolkit.instructions ?? "?"));
  });
});
