/**
 * §12.1 at the orchestrator (unified MCP design 2026-10-15; final-review ruling F1): a chat whose
 * MCP denials are unknown — a cold host, and a daemon that cannot answer its manifest — never
 * starts its provider session without them. The turn fails with a retryable row on the thread;
 * the next message, once the daemon answers, starts the session with the denials.
 *
 * The REAL session-tools host, its manifest client replaced by a switch; the provider is the
 * scripted adapter, entered through the same `issueSessionToolsGrant` every endpoint provider uses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DomainEvent, ThreadActivityItem } from "@orquester/api/agent-chat";

import { createScriptedAdapter, createTestHost } from "../orchestration/testing/index.ts";
import type { ManifestAnswer } from "./forwarder.ts";
import { createSessionToolsHost, DENIALS_UNKNOWN_MESSAGE, issueSessionToolsGrant, launchHomeKey } from "./index.ts";

const cmd = (() => {
  let next = 0;
  return () => `cmd-denials-${(next += 1)}`;
})();

function activities(events: readonly DomainEvent[]): ThreadActivityItem[] {
  return events
    .filter((event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> => event.type === "thread.activity-appended")
    .map((event) => event.payload.activity);
}

test("a cold host with no manifest refuses the session (retryable row), then starts it with the denials", async (t) => {
  let up = false;
  const sessionTools = createSessionToolsHost({
    forward: async () => ({ content: [] }),
    manifest: async (): Promise<ManifestAnswer> =>
      up ? { kind: "manifest", manifest: { tools: [], instructions: "", deny: ["orquester_remote"] } } : { kind: "unavailable" },
    // The bounded wait is the behaviour under test; its bound is kept short.
    denialsWaitMs: 20
  });
  t.after(() => sessionTools.stop());

  const adapter = createScriptedAdapter({ id: "claude" });
  const scriptedStart = adapter.startSession.bind(adapter);
  const launchedWith: string[][] = [];
  adapter.startSession = async (input) => {
    const tools = await issueSessionToolsGrant({ sessionTools, logger: { warn: () => undefined } }, input.threadId, {
      agent: "claude",
      home: launchHomeKey(input.home),
      project: input.projectPath ?? input.cwd
    });
    launchedWith.push([...(tools.prepared?.deny ?? [])]);
    tools.grant?.revoke();
    return scriptedStart(input);
  };
  const host = createTestHost({ adapters: { claude: adapter } });
  t.after(() => host.stop());
  const threadId = await host.createThread();

  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "hello" });
  await host.settle();
  assert.deepEqual(launchedWith, [], "no provider session started without its denials");
  const failure = activities(host.store.logs.get(threadId) ?? []).find((row) => row.activityKind === "provider.turn.start.failed");
  assert.ok(failure, "the refusal is a row on the thread");
  assert.equal((failure.payload as { detail?: unknown }).detail, DENIALS_UNKNOWN_MESSAGE);

  // The daemon answers now: the next message starts the session — with the denials.
  up = true;
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "again" });
  await host.settle();
  assert.deepEqual(launchedWith, [["orquester_remote"]]);
  assert.equal(adapter.calls.filter((call) => call.kind === "sendTurn").length, 1, "the retry's turn was sent");
});
