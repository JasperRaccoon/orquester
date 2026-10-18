/**
 * Agent Profiles on the host side (spec 2026-10-18 §5.3, §5.6, §7): the profile a thread was
 * created with is recorded in the log, persisted in `launch.json`, handed to EVERY session start,
 * and switched mid-chat through the identity request — a profile-only switch keeping the
 * conversation and never reading as an account switch.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DomainEvent, ThreadActivityItem } from "@orquester/api/agent-chat";
import { PROFILE_CHANGED_ACTIVITY_KIND } from "@orquester/api/agent-chat";

import type { StartSessionInput } from "../adapter.ts";
import type { HostThreadProfile } from "../host-protocol.ts";
import { createScriptedAdapter, createTestHost, type TestHost } from "./testing/index.ts";

let commandSeq = 0;
const cmd = (): string => `profile-${(commandSeq += 1)}`;

const P1: HostThreadProfile = {
  profileId: "p1",
  revision: "3",
  preparedDir: "/appdir/daemon/session-profiles/prepared/p1/claude/shared"
};
const P2: HostThreadProfile = {
  profileId: "p2",
  revision: "1",
  preparedDir: "/appdir/daemon/session-profiles/prepared/p2/claude/shared"
};

const starts = (host: TestHost, threadId = "thread-1"): StartSessionInput[] =>
  host.adapter.calls
    .filter((call) => call.kind === "startSession" && call.threadId === threadId)
    .map((call) => call.detail as StartSessionInput);

const logOf = (host: TestHost, threadId = "thread-1"): DomainEvent[] => host.store.logs.get(threadId) ?? [];

const activitiesOf = (host: TestHost, threadId = "thread-1"): ThreadActivityItem[] =>
  logOf(host, threadId)
    .filter(
      (event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> =>
        event.type === "thread.activity-appended"
    )
    .map((event) => event.payload.activity);

const kinds = (host: TestHost, threadId = "thread-1"): string[] =>
  activitiesOf(host, threadId).map((activity) => activity.activityKind);

/** As ingestion does at a provider's turn end: the turn settles, the child stays live. */
async function completeTurn(host: TestHost, threadId = "thread-1"): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `turn-end-${threadId}-${cmd()}`,
      threadId,
      type: "thread.session-set",
      payload: { session: { status: "ready", activeTurnId: null } },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    }
  ]);
  await host.settle();
}

async function turn(host: TestHost, threadId = "thread-1", input = "work"): Promise<void> {
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input });
  await host.settle();
}

/** A profile thread that ran one turn: it has a cursor, a live session, and is idle. */
async function idleProfileThread(
  options: { profile?: HostThreadProfile } = {}
): Promise<{ host: TestHost; threadId: string }> {
  const host = createTestHost();
  void host.orchestrator.consume(host.adapter);
  const threadId = await host.createThread({
    accountId: "acc1",
    home: "account",
    homePath: "/homes/acc1",
    launchEnv: { CLAUDE_CONFIG_DIR: "/homes/acc1" },
    profile: options.profile ?? P1
  });
  await turn(host, threadId);
  await completeTurn(host, threadId);
  return { host, threadId };
}

describe("a profile thread's durable record and launch config", () => {
  it("records the profile on thread.created, the head and launch.json, and starts with it", async () => {
    const host = createTestHost();
    const threadId = await host.createThread({ profile: P1, homePath: "/homes/acc1" });

    const created = logOf(host, threadId).find((event) => event.type === "thread.created");
    assert.equal((created?.payload as { profileId?: string }).profileId, "p1");
    assert.equal((created?.payload as { profileRevision?: string }).profileRevision, "3");
    assert.equal(host.store.heads.get(threadId)?.profileId, "p1");
    assert.deepEqual(host.launchConfigs.entries.get(threadId)?.profile, P1);
    assert.equal(host.launchConfigs.entries.get(threadId)?.homePath, "/homes/acc1");

    await turn(host, threadId);
    assert.deepEqual(host.adapter.lastStart?.profile, P1);
    await host.stop();
  });

  it("a thread without one is Global: no profile anywhere", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await turn(host, threadId);
    const created = logOf(host, threadId).find((event) => event.type === "thread.created");
    assert.equal("profileId" in (created?.payload ?? {}), false);
    assert.equal(host.store.heads.get(threadId)?.profileId, undefined);
    assert.equal("profile" in (host.launchConfigs.entries.get(threadId) ?? {}), false);
    assert.equal("profile" in (host.adapter.lastStart ?? {}), false);
    await host.stop();
  });

  it("refuses a profileId without its prepared profile, a mismatch, and a profile that does not read", async () => {
    const host = createTestHost();
    const base = {
      projectPath: "/work/project",
      cwd: "/work/project",
      title: "t",
      refId: "claude",
      accountId: "acc1",
      home: "account" as const,
      modelSelection: { model: "m" },
      runtimeMode: "approval-required"
    };
    for (const [threadId, fields] of [
      ["a", { profileId: "p1" }],
      ["b", { profileId: "p2", profile: P1 }],
      ["c", { profile: { ...P1, preparedDir: "relative" } }],
      ["d", { profile: null }]
    ] as const) {
      await assert.rejects(
        () => host.orchestrator.createThread({ ...base, threadId, ...(fields as object) }),
        (error: { code?: string }) => error.code === "INVALID_COMMAND",
        threadId
      );
      assert.equal(logOf(host, threadId).length, 0, `nothing created for ${threadId}`);
    }
    await host.stop();
  });
});

describe("every session start carries the profile", () => {
  it("a create-time resume's eager start", async () => {
    const host = createTestHost();
    const threadId = await host.createThread({
      profile: P1,
      resume: { home: "account", conversationId: "conv-profile" }
    });
    await host.settle();
    assert.equal(starts(host, threadId).length, 1);
    assert.deepEqual(starts(host, threadId)[0]?.profile, P1);
    await host.stop();
  });

  it("the restart of a session that crashed into error", async () => {
    const { host, threadId } = await idleProfileThread();
    await host.orchestrator.ingestionSink(threadId, [
      {
        eventId: "crash",
        threadId,
        type: "thread.session-set",
        payload: { session: { status: "error", activeTurnId: null, lastError: "exited" } },
        occurredAt: host.clock.nowIso(),
        commandId: null,
        causationEventId: null,
        metadata: {}
      }
    ]);
    await host.settle();
    await turn(host, threadId, "again");
    assert.equal(starts(host, threadId).length, 2);
    assert.deepEqual(starts(host, threadId)[1]?.profile, P1);
    await host.stop();
  });

  it("a host restart's rehydrate, from launch.json and the log alone", async () => {
    const { host: first, threadId } = await idleProfileThread();
    await first.stop();

    const next = createTestHost({ store: first.store, launchConfigs: first.launchConfigs });
    await turn(next, threadId, "after the restart");
    assert.deepEqual(next.adapter.lastStart?.profile, P1);
    assert.equal(next.store.heads.get(threadId)?.profileId, "p1");
    await next.stop();
  });

  it("is REFUSED, not started as Global, when the log names a profile launch.json lost", async () => {
    const { host: first, threadId } = await idleProfileThread();
    await first.stop();
    const launch = first.launchConfigs.entries.get(threadId)!;
    const { profile: _lost, ...withoutProfile } = launch;
    void _lost;
    first.launchConfigs.entries.set(threadId, withoutProfile);

    const next = createTestHost({ store: first.store, launchConfigs: first.launchConfigs });
    await turn(next, threadId, "after the restart");
    assert.equal(starts(next, threadId).length, 0, "no provider child was started");
    const failed = activitiesOf(next, threadId).filter((row) => row.activityKind === "provider.turn.start.failed");
    assert.match(String(failed.at(-1)?.payload && (failed.at(-1)?.payload as { detail?: string }).detail), /Agent Profile/);

    // Naming the profile again repairs it.
    await next.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1",
      profile: P1
    });
    await turn(next, threadId, "repaired");
    assert.deepEqual(next.adapter.lastStart?.profile, P1);
    await next.stop();
  });

  it("an unreadable profile in launch.json fails the start too", async () => {
    const host = createTestHost();
    const threadId = await host.createThread({ profile: P1 });
    host.launchConfigs.entries.set(threadId, { profileUnreadable: true });
    const next = createTestHost({ store: host.store, launchConfigs: host.launchConfigs });
    await turn(next, threadId);
    assert.equal(starts(next, threadId).length, 0);
    assert.match(next.store.heads.get(threadId)?.session.lastError ?? "", /could not be read/);
    await host.stop();
    await next.stop();
  });
});

describe("switching the profile mid-chat (spec §5.3)", () => {
  it("profile-only: rewrites launch.json, records it, restarts with reason profile and KEEPS the cursor", async () => {
    const { host, threadId } = await idleProfileThread();
    const cursor = host.store.bindings.get(threadId)?.resumeCursor;
    assert.ok(cursor, "the first turn learned a cursor");
    const startsBefore = starts(host, threadId).length;

    const receipt = await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1",
      launchEnv: { CLAUDE_CONFIG_DIR: "/homes/acc1" },
      profileId: "p2",
      profile: P2
    });
    await host.settle();
    assert.ok(receipt.seq > 0);
    assert.equal(starts(host, threadId).length, startsBefore, "the switch itself starts nothing");
    assert.deepEqual(host.launchConfigs.entries.get(threadId)?.profile, P2);
    assert.equal(host.store.heads.get(threadId)?.profileId, "p2");
    assert.equal(host.store.heads.get(threadId)?.accountId, "acc1");
    const meta = logOf(host, threadId).filter((event) => event.type === "thread.meta-updated").at(-1);
    assert.deepEqual(meta?.payload, { profileId: "p2", profileRevision: "1" }, "no account fields");
    assert.ok(kinds(host, threadId).includes(PROFILE_CHANGED_ACTIVITY_KIND));
    assert.ok(!kinds(host, threadId).includes("session.identity-changed"), "not an account switch");
    const row = activitiesOf(host, threadId).find((a) => a.activityKind === PROFILE_CHANGED_ACTIVITY_KIND);
    assert.deepEqual(row?.payload, { profileId: "p2", previousProfileId: "p1" });

    await turn(host, threadId, "again");
    assert.equal(starts(host, threadId).length, startsBefore + 1);
    const restart = host.adapter.lastStart!;
    assert.deepEqual(restart.profile, P2);
    assert.deepEqual(restart.resumeCursor, cursor, "the conversation is kept");
    assert.equal(restart.carryGoal, undefined, "a goal is not re-created: the account did not move");
    assert.equal(host.store.bindings.get(threadId)?.providerInstanceId, "account:acc1");
    assert.equal(host.store.bindings.get(threadId)?.resumeCursor !== undefined, true);
    assert.ok(
      host.logger.entries.some(
        (entry) =>
          entry.message === "agent-host: restarting provider session" &&
          JSON.stringify(entry.detail).includes('"profile"') &&
          !JSON.stringify(entry.detail).includes('"account"')
      ),
      "the restart's reason is the profile alone"
    );
    await host.stop();
  });

  it("to Global (profile: null): the launch config, the head and the next start drop it", async () => {
    const { host, threadId } = await idleProfileThread();
    const cursor = host.store.bindings.get(threadId)?.resumeCursor;
    await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc1",
      home: "account",
      homePath: "/homes/acc1",
      profile: null,
      profileId: null
    });
    assert.equal("profile" in (host.launchConfigs.entries.get(threadId) ?? {}), false);
    assert.equal(host.store.heads.get(threadId)?.profileId, undefined);
    const row = activitiesOf(host, threadId).find((a) => a.activityKind === PROFILE_CHANGED_ACTIVITY_KIND);
    const meta = logOf(host, threadId).filter((event) => event.type === "thread.meta-updated").at(-1);
    assert.deepEqual(meta?.payload, { profileId: "" }, "the log's Global is the empty string");
    assert.equal(row?.summary, "Switched to Global");
    assert.deepEqual(row?.payload, { profileId: null, previousProfileId: "p1" });

    await turn(host, threadId, "again");
    assert.equal("profile" in host.adapter.lastStart!, false);
    assert.deepEqual(host.adapter.lastStart?.resumeCursor, cursor);
    await host.stop();
  });

  it("account-only (profile absent): the thread keeps its profile across the account switch", async () => {
    const { host, threadId } = await idleProfileThread();
    await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc2",
      home: "account",
      homePath: "/homes/acc2"
    });
    assert.deepEqual(host.launchConfigs.entries.get(threadId)?.profile, P1);
    assert.equal(host.store.heads.get(threadId)?.profileId, "p1");
    assert.ok(kinds(host, threadId).includes("session.identity-changed"));
    assert.ok(!kinds(host, threadId).includes(PROFILE_CHANGED_ACTIVITY_KIND));
    const meta = logOf(host, threadId).filter((event) => event.type === "thread.meta-updated").at(-1);
    assert.deepEqual(meta?.payload, { accountId: "acc2", home: "account" });

    await turn(host, threadId, "again");
    assert.deepEqual(host.adapter.lastStart?.profile, P1);
    assert.equal(host.adapter.lastStart?.home.path, "/homes/acc2");
    assert.equal(host.store.bindings.get(threadId)?.providerInstanceId, "account:acc2");
    await host.stop();
  });

  it("both: an account switch and a profile switch in one, each recorded", async () => {
    const { host, threadId } = await idleProfileThread();
    const cursor = host.store.bindings.get(threadId)?.resumeCursor;
    await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc2",
      home: "account",
      homePath: "/homes/acc2",
      profile: P2
    });
    const meta = logOf(host, threadId).filter((event) => event.type === "thread.meta-updated").at(-1);
    assert.deepEqual(meta?.payload, { accountId: "acc2", home: "account", profileId: "p2", profileRevision: "1" });
    assert.ok(kinds(host, threadId).includes("session.identity-changed"));
    assert.ok(kinds(host, threadId).includes(PROFILE_CHANGED_ACTIVITY_KIND));
    assert.equal(host.store.heads.get(threadId)?.accountId, "acc2");
    assert.equal(host.store.heads.get(threadId)?.profileId, "p2");

    await turn(host, threadId, "again");
    const restart = host.adapter.lastStart!;
    assert.deepEqual(restart.profile, P2);
    assert.equal(restart.home.path, "/homes/acc2");
    assert.deepEqual(restart.resumeCursor, cursor, "as today's account switch: the cursor travels");
    assert.equal(restart.carryGoal, true, "as today's account switch: the goal is carried");
    await host.stop();
  });

  it("a switch with nothing new is a no-op receipt; a mismatched profileId is refused", async () => {
    const { host, threadId } = await idleProfileThread();
    const before = logOf(host, threadId).length;
    await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc1",
      home: "account",
      profile: P1
    });
    assert.equal(logOf(host, threadId).length, before);
    await assert.rejects(
      () =>
        host.orchestrator.setIdentity(threadId, {
          commandId: cmd(),
          accountId: "acc1",
          home: "account",
          profile: P2,
          profileId: "p1"
        }),
      (error: { code?: string }) => error.code === "INVALID_COMMAND"
    );
    assert.equal(host.store.heads.get(threadId)?.profileId, "p1");
    await host.stop();
  });

  it("is refused while a turn runs, in the words of a profile switch", async () => {
    const host = createTestHost();
    void host.orchestrator.consume(host.adapter);
    const threadId = await host.createThread({ profile: P1 });
    await turn(host, threadId);
    await assert.rejects(
      () => host.orchestrator.setIdentity(threadId, { commandId: cmd(), accountId: "acc1", home: "account", profile: P2 }),
      (error: { code?: string; message?: string }) =>
        error.code === "COMMAND_REJECTED" && /switching profiles/.test(error.message ?? "")
    );
    assert.deepEqual(host.launchConfigs.entries.get(threadId)?.profile, P1);
    await host.stop();
  });

  it("OpenCode takes a profile switch onto the new profile's server, but still no account switch", async () => {
    const opencode = createScriptedAdapter({ id: "opencode" });
    const host = createTestHost({ adapters: { opencode } });
    void host.orchestrator.consume(opencode);
    const oldPool = { key: "profile-p1", env: { OPENCODE_CONFIG_DIR: "/prepared/p1/opencode" } };
    const newPool = { key: "profile-p2", env: { OPENCODE_CONFIG_DIR: "/prepared/p2/opencode" } };
    const threadId = await host.createThread({
      refId: "opencode",
      home: "system",
      accountId: "",
      serverPool: oldPool,
      profile: P1
    });
    await turn(host, threadId);
    await completeTurn(host, threadId);
    const cursor = host.store.bindings.get(threadId)?.resumeCursor;
    assert.deepEqual(opencode.lastStart?.serverPool, oldPool);

    await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "",
      home: "system",
      serverPool: newPool,
      profile: P2
    });
    assert.deepEqual(host.launchConfigs.entries.get(threadId)?.serverPool, newPool, "serverPool is rewritten");
    await turn(host, threadId, "again");
    assert.deepEqual(opencode.lastStart?.serverPool, newPool);
    assert.deepEqual(opencode.lastStart?.profile, P2);
    assert.deepEqual(opencode.lastStart?.resumeCursor, cursor, "the shared session store resumes on any server");
    await completeTurn(host, threadId);

    // Back to Global: the global server (no serverPool) and no profile.
    await host.orchestrator.setIdentity(threadId, { commandId: cmd(), accountId: "", home: "system", profile: null });
    assert.equal("serverPool" in (host.launchConfigs.entries.get(threadId) ?? {}), false);
    await turn(host, threadId, "global");
    assert.equal("serverPool" in opencode.lastStart!, false);
    assert.equal("profile" in opencode.lastStart!, false);
    await completeTurn(host, threadId);

    await assert.rejects(
      () => host.orchestrator.setIdentity(threadId, { commandId: cmd(), accountId: "acc2", home: "account", profile: P2 }),
      (error: { code?: string }) => error.code === "INVALID_COMMAND"
    );
    await host.stop();
  });

  it("an older daemon's account switch (no profile, no serverPool) keeps the profile", async () => {
    const { host, threadId } = await idleProfileThread();
    await host.orchestrator.setIdentity(threadId, {
      commandId: cmd(),
      accountId: "acc2",
      home: "account",
      homePath: "/homes/acc2",
      launchEnv: { CLAUDE_CONFIG_DIR: "/homes/acc2" }
    });
    assert.deepEqual(host.launchConfigs.entries.get(threadId), {
      launchEnv: { CLAUDE_CONFIG_DIR: "/homes/acc2" },
      homePath: "/homes/acc2",
      profile: P1
    });
    await host.stop();
  });
});
