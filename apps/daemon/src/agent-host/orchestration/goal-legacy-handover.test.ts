/**
 * Goals §5.7 — the other half of a legacy handover.
 *
 * A host from before the goal hold cannot pause a goal, so the daemon stopped
 * a Codex goal thread's session at a turn boundary to let the deploy go ahead,
 * the goal still active in Codex's own store. The next host takes those
 * threads (`POST /goals/resume-sessions` → `resumeGoalSessionsAfterHandover`)
 * and resumes each session WITHOUT a turn, after its gate: Codex continues the
 * goal by itself.
 *
 * Fake adapters only; the store is shared between the two hosts, as the
 * appdir is across a real restart.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AdapterGoalSupport } from "@orquester/api/agent-chat";

import { LEGACY_GOAL_CONTINUATION_GAP_MS, legacyGoalTurnOf } from "../../agent-chat/supervisor.ts";
import type { GoalCommandResult } from "../adapter.ts";
import { createScriptedAdapter, createTestHost, type TestHost } from "./testing/index.ts";

/** Codex's capability (goals §4.5). */
const HOST_GOALS: AdapterGoalSupport = {
  command: "host",
  actions: ["pause", "resume", "clear"],
  continuesAcrossTurns: true
};

let commandSeq = 0;
const cmd = (): string => `legacy-cmd-${(commandSeq += 1)}`;

function codexHost(options: { from?: TestHost; openGate?: boolean } = {}): TestHost {
  const adapter = createScriptedAdapter({
    id: "codex",
    capabilities: { goals: HOST_GOALS },
    goalCommand: async (): Promise<GoalCommandResult> => ({ summary: "" })
  });
  return createTestHost({
    adapters: { codex: adapter },
    ...(options.from !== undefined
      ? { store: options.from.store, launchConfigs: options.from.launchConfigs }
      : {}),
    ...(options.openGate === false ? { openGate: false } : {})
  });
}

/**
 * The old host's side: a Codex thread that ran a turn (so it has a resume
 * cursor), whose session the daemon then stopped — the legacy handover's stop.
 */
async function stoppedGoalThread(threadId = "thread-1"): Promise<TestHost> {
  const first = codexHost();
  await first.createThread({
    threadId,
    refId: "codex",
    accountId: "acc1",
    home: "account",
    homePath: "/homes/acc1"
  });
  await first.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "work" });
  await first.settle();
  await first.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
  await first.settle();
  assert.equal(first.adapter.hasSession(threadId), false, "the handover stopped the session");
  await first.stop();
  return first;
}

const providerCalls = (host: TestHost): string[] =>
  host.adapter.calls
    .map((call) => call.kind)
    .filter((kind) => kind === "startSession" || kind === "sendTurn" || kind === "goalCommand");

describe("goals §5.7 — the next host resumes the goal sessions a legacy handover stopped", () => {
  it("resumes each session without a turn, after the gate, and clears the mark", async () => {
    const first = await stoppedGoalThread();
    const next = codexHost({ from: first, openGate: false });
    const taken = await next.orchestrator.resumeGoalSessionsAfterHandover(["thread-1"]);
    assert.deepEqual(taken, ["thread-1"]);
    assert.equal(next.store.heads.get("thread-1")?.resumeGoalAfterRestart, true, "marked for the resume");
    await next.settle();
    assert.deepEqual(providerCalls(next), [], "nothing before the gate");

    next.orchestrator.openGate();
    await next.settle();
    assert.deepEqual(providerCalls(next), ["startSession"], "the session comes back, and never a turn");
    assert.deepEqual(next.adapter.lastStart?.resumeCursor, { cursor: "turn-1" }, "the same conversation");
    assert.equal(next.adapter.hasSession("thread-1"), true);
    assert.equal(next.store.heads.get("thread-1")?.resumeGoalAfterRestart, undefined, "the mark is spent");
    await next.stop();
  });

  it("takes only threads it knows: an unknown id, an unsafe one or a repeat is skipped", async () => {
    const first = await stoppedGoalThread();
    const next = codexHost({ from: first });
    const taken = await next.orchestrator.resumeGoalSessionsAfterHandover([
      "thread-1",
      "thread-missing",
      "../escape",
      "thread-1"
    ]);
    assert.deepEqual(taken, ["thread-1"]);
    await next.settle();
    assert.deepEqual(providerCalls(next), ["startSession"], "one resume, for the one thread it knows");
    assert.equal(next.store.heads.has("thread-missing"), false, "no runtime was made up for an unknown id");
    await next.stop();
  });

  it("takes nothing once the host has begun to stop", async () => {
    const first = await stoppedGoalThread();
    const next = codexHost({ from: first });
    await next.orchestrator.markThreadsForContinuation();
    assert.deepEqual(await next.orchestrator.resumeGoalSessionsAfterHandover(["thread-1"]), []);
    await next.settle();
    assert.deepEqual(providerCalls(next), []);
    await next.stop();
  });
});

describe("goals §5.7 — the daemon's reading of a legacy host's snapshot, against a real one", () => {
  let eventSeq = 0;
  /** The provider moved the thread's session — a turn started by itself, or one settling. */
  async function sessionSet(host: TestHost, threadId: string, activeTurnId: string | null): Promise<void> {
    eventSeq += 1;
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: `legacy-session-${eventSeq}`,
        threadId,
        type: "thread.session-set",
        payload: { session: { status: activeTurnId === null ? "ready" : "running", activeTurnId } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await host.settle();
  }

  it("a Codex goal loop reads as one off `readThread`'s own answer; a turn started later does not", async () => {
    // The snapshot's envelope and turn rows are the same on the host the
    // deploy replaces (commit 66691b0): a turn the host never saw a command
    // for is adopted without a `userMessageId`.
    const host = codexHost();
    const threadId = await host.createThread({ refId: "codex" });
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "set yourself a goal" });
    await host.settle();
    await sessionSet(host, threadId, null);
    assert.equal(legacyGoalTurnOf(await host.orchestrator.readThread(threadId)), null, "nothing running");

    // Codex continues by itself: two turns, each starting as the last one ends.
    host.clock.advance(40);
    await sessionSet(host, threadId, "goal-2");
    const first = legacyGoalTurnOf(await host.orchestrator.readThread(threadId));
    assert.equal(first?.goalLoop, false, "the first turn after the user's is not a loop yet");
    host.clock.advance(60_000);
    await sessionSet(host, threadId, null);
    host.clock.advance(40);
    await sessionSet(host, threadId, "goal-3");
    const loop = legacyGoalTurnOf(await host.orchestrator.readThread(threadId));
    assert.equal(loop?.goalLoop, true, "a goal loop");
    assert.equal(loop?.turnId, "goal-3");
    assert.equal(loop?.startedAt, host.clock.now().getTime());

    // A turn with no user message that starts well after the last ended — a
    // `/compact` typed after a goal turn — is not one.
    host.clock.advance(60_000);
    await sessionSet(host, threadId, null);
    host.clock.advance(LEGACY_GOAL_CONTINUATION_GAP_MS + 1_000);
    await sessionSet(host, threadId, "later-4");
    assert.equal(legacyGoalTurnOf(await host.orchestrator.readThread(threadId))?.goalLoop, false);
    await host.stop();
  });
});
