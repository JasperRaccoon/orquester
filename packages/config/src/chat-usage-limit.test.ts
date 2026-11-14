import assert from "node:assert/strict";
import test from "node:test";

import { agentPrefsSchema, parseAppConfig, parseSessionsConfig } from "./index.ts";

function chatRecord(chat: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "s1",
    title: "chat",
    order: 0,
    projectPath: "/w/p",
    refId: "claude",
    kind: "agent-chat",
    cwd: "/w/p",
    createdAt: "2026-10-20T12:00:00.000Z",
    chat: { threadId: "s1", accountId: "acc1", home: "account", lastSeq: 3, ...chat }
  };
}

const LIMIT = {
  noticeId: "a1",
  turnId: "t1",
  detectedAt: "2026-10-20T12:00:00.000Z",
  limitedAt: "2026-10-20T11:59:00.000Z",
  resetAt: "2026-10-20T15:40:00.000Z",
  accountId: "acc1",
  parked: false,
  autoResume: "armed",
  resumeAt: "2026-10-20T15:40:45.000Z"
};

test("the usage-limit settings default to resume on, failover off — also for an app.json without them", () => {
  assert.deepEqual(
    [agentPrefsSchema.parse({}).autoResumeLimitedChats, agentPrefsSchema.parse({}).switchAccountOnUsageLimit],
    [true, false]
  );
  const config = parseAppConfig({ agents: { continueThreadsAfterRestart: true } });
  assert.equal(config.agents.autoResumeLimitedChats, true);
  assert.equal(config.agents.switchAccountOnUsageLimit, false);
  assert.equal(parseAppConfig({ agents: { autoResumeLimitedChats: false, switchAccountOnUsageLimit: true } }).agents.switchAccountOnUsageLimit, true);
});

test("a chat record's usage-limit state round-trips, keeping fields a newer daemon wrote", () => {
  const parsed = parseSessionsConfig({
    sessions: [chatRecord({ usageLimit: { ...LIMIT, futureField: { x: 1 } }, limitFailover: { fromAccountId: "acc1", toAccountId: "acc2", at: "2026-10-20T12:01:00.000Z", automatic: true, note: "kept" } })]
  });
  const chat = parsed.sessions[0]?.chat;
  assert.equal(chat?.usageLimit?.autoResume, "armed");
  assert.equal(chat?.usageLimit?.resetAt, LIMIT.resetAt);
  assert.deepEqual((chat?.usageLimit as Record<string, unknown> | undefined)?.futureField, { x: 1 });
  assert.equal((chat?.limitFailover as Record<string, unknown> | undefined)?.note, "kept");
});

test("a malformed field falls back on its own; a block that does not parse is dropped, never the record", () => {
  const tolerant = parseSessionsConfig({
    sessions: [chatRecord({ usageLimit: { ...LIMIT, autoResume: "someday", resetAt: "soon", parked: "yes", action: { kind: "teleport" } } })]
  });
  const limit = tolerant.sessions[0]?.chat?.usageLimit;
  assert.equal(limit?.autoResume, "off");
  assert.equal(limit?.resetAt, null);
  assert.equal(limit?.parked, false);
  assert.equal(limit?.action, undefined);

  const broken = parseSessionsConfig({ sessions: [chatRecord({ usageLimit: { noticeId: 7 }, limitFailover: "nope" })] });
  assert.equal(broken.sessions.length, 1, "the tab survives");
  assert.equal(broken.sessions[0]?.chat?.usageLimit, undefined);
  assert.equal(broken.sessions[0]?.chat?.limitFailover, undefined);
  assert.equal(broken.sessions[0]?.chat?.lastSeq, 3);
});

const BUSY_SWITCH = {
  commandId: "switch-1",
  fromAccountId: "acc1",
  toAccountId: "acc2",
  startedAt: "2026-11-14T06:00:00.000Z",
  step: "settling",
  goal: "continuing"
};

test("a chat record's busy account switch round-trips, keeping fields a newer daemon wrote", () => {
  const parsed = parseSessionsConfig({ sessions: [chatRecord({ accountSwitch: { ...BUSY_SWITCH, futureField: [1] } })] });
  const state = parsed.sessions[0]?.chat?.accountSwitch;
  assert.equal(state?.step, "settling");
  assert.equal(state?.goal, "continuing");
  assert.deepEqual((state as Record<string, unknown> | undefined)?.futureField, [1]);
});

test("a busy switch with an unknown goal keeps going without one; one without its step or start is dropped alone", () => {
  const tolerant = parseSessionsConfig({ sessions: [chatRecord({ accountSwitch: { ...BUSY_SWITCH, goal: "orbiting" } })] });
  assert.equal(tolerant.sessions[0]?.chat?.accountSwitch?.goal, null);

  for (const broken of [{ ...BUSY_SWITCH, step: "teleporting" }, { ...BUSY_SWITCH, startedAt: "soon" }, "nope"]) {
    const parsed = parseSessionsConfig({ sessions: [chatRecord({ accountSwitch: broken })] });
    assert.equal(parsed.sessions.length, 1, "the tab survives");
    assert.equal(parsed.sessions[0]?.chat?.accountSwitch, undefined);
  }
});
