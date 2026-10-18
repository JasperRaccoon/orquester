/**
 * Agent Profiles: the refresh of a profile thread's launch before every session start (spec
 * 2026-10-18 §5.6, §6.5) — a new version is picked up, a removed one never fails the start, a
 * daemon that cannot be asked leaves the persisted version only while its manifest validates, a
 * deleted profile falls back to Global with the notice — and the prepared-dir leases.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { DomainEvent, ThreadActivityItem } from "@orquester/api/agent-chat";

import type { StartSessionInput } from "../adapter.ts";
import { agentHostAuthValue, daemonRoutesForHost, type HostThreadProfile, type ThreadLaunchProfileResponse } from "../host-protocol.ts";
import { writePreparedManifest } from "../../session-profiles/manifest.ts";
import type { LaunchProfileAnswer } from "./launch-profile.ts";
import { createDaemonLaunchProfileClient, parseLaunchProfileResponse } from "./launch-profile.ts";
import { createTestHost, type TestHost } from "./testing/index.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

let commandSeq = 0;
const cmd = (): string => `refresh-${(commandSeq += 1)}`;

const V3: HostThreadProfile = { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/claude/shared/v3" };
const V4: HostThreadProfile = { profileId: "p1", revision: "4", preparedDir: "/prepared/p1/claude/shared/v4" };

const starts = (host: TestHost, threadId: string): StartSessionInput[] =>
  host.adapter.calls.filter((call) => call.kind === "startSession" && call.threadId === threadId).map((call) => call.detail as StartSessionInput);

const logOf = (host: TestHost, threadId: string): DomainEvent[] => host.store.logs.get(threadId) ?? [];

const activitiesOf = (host: TestHost, threadId: string): ThreadActivityItem[] =>
  logOf(host, threadId)
    .filter((event): event is Extract<DomainEvent, { type: "thread.activity-appended" }> => event.type === "thread.activity-appended")
    .map((event) => event.payload.activity);

async function turn(host: TestHost, threadId: string, input = "work"): Promise<void> {
  await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input });
  await host.settle();
}

async function completeTurn(host: TestHost, threadId: string): Promise<void> {
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `turn-end-${cmd()}`,
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

/** A daemon whose answers a test scripts, recording what it was asked. */
function scriptedDaemon(answer: (threadId: string, profileId: string) => LaunchProfileAnswer) {
  const asked: Array<[string, string]> = [];
  return {
    asked,
    launchProfile: async (threadId: string, profileId: string): Promise<LaunchProfileAnswer> => {
      asked.push([threadId, profileId]);
      return answer(threadId, profileId);
    }
  };
}

const launch = (body: ThreadLaunchProfileResponse): LaunchProfileAnswer => ({ kind: "launch", launch: body });

async function realPreparedDir(profile: Omit<HostThreadProfile, "preparedDir">): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-refresh-"));
  roots.push(dir);
  await writePreparedManifest(dir, {
    schema: 1,
    profileId: profile.profileId,
    revision: profile.revision,
    agent: "claude",
    accountKey: "shared",
    preparedAt: "2026-10-18T00:00:00.000Z",
    agentSection: { plugins: [], mcpServerNames: [], hooks: {}, disableWorkflows: false }
  });
  return dir;
}

describe("the refresh before a profile thread's session start", () => {
  it("picks up the profile's new version and launch fields, rewrites launch.json, and does not restart for it again", async () => {
    const daemon = scriptedDaemon(() =>
      launch({ profile: V4, launchEnv: { CODEX_HOME: "/prepared/v4/home" }, homePath: "/prepared/v4/home", serverPool: { key: "profile:p1" } })
    );
    const host = createTestHost({ launchProfile: daemon.launchProfile });
    void host.orchestrator.consume(host.adapter);
    // Created with v3, whose directory the GC has since removed: the start never reads it.
    const threadId = await host.createThread({ profile: V3, launchEnv: { CODEX_HOME: "/homes/acc1" }, homePath: "/homes/acc1" });
    await turn(host, threadId);
    assert.deepEqual(daemon.asked, [[threadId, "p1"]]);
    const first = starts(host, threadId)[0]!;
    assert.deepEqual(first.profile, V4);
    assert.deepEqual(first.serverPool, { key: "profile:p1" });
    assert.equal(first.home.path, "/prepared/v4/home", "the refreshed homePath is the one resolveHome reads");
    const saved = host.launchConfigs.entries.get(threadId)!;
    assert.deepEqual(saved.profile, V4);
    assert.deepEqual(saved.launchEnv, { CODEX_HOME: "/prepared/v4/home" });
    assert.equal(
      logOf(host, threadId).filter((event) => event.type === "thread.meta-updated").length,
      0,
      "the same profile: nothing to record on the log"
    );
    await completeTurn(host, threadId);
    await turn(host, threadId, "again");
    assert.equal(starts(host, threadId).length, 1, "the live session is bound to v4: no profile restart");
    await host.stop();
  });

  it("asks nothing for a Global thread", async () => {
    const daemon = scriptedDaemon(() => ({ kind: "refused", code: "X", message: "never" }));
    const host = createTestHost({ launchProfile: daemon.launchProfile });
    const threadId = await host.createThread();
    await turn(host, threadId);
    assert.equal(daemon.asked.length, 0);
    assert.equal(starts(host, threadId).length, 1);
    await host.stop();
  });

  it("fails the start with the daemon's reason when it refuses (never Global)", async () => {
    const daemon = scriptedDaemon(() => ({ kind: "refused", code: "PROFILE_NOT_READY", message: "Preparing Claude failed: disk full." }));
    const host = createTestHost({ launchProfile: daemon.launchProfile });
    const threadId = await host.createThread({ profile: V3 });
    await turn(host, threadId);
    assert.equal(starts(host, threadId).length, 0);
    assert.match(host.store.heads.get(threadId)?.session.lastError ?? "", /disk full/);
    assert.equal(host.store.heads.get(threadId)?.profileId, "p1", "still the profile's thread");
    await host.stop();
  });

  it("with the daemon down, launches the persisted version while its manifest validates", async () => {
    const dir = await realPreparedDir({ profileId: "p1", revision: "3" });
    const persisted: HostThreadProfile = { ...V3, preparedDir: dir };
    const daemon = scriptedDaemon(() => ({ kind: "unavailable", reason: "ECONNREFUSED" }));
    const host = createTestHost({ launchProfile: daemon.launchProfile });
    const threadId = await host.createThread({ profile: persisted });
    await turn(host, threadId);
    assert.deepEqual(starts(host, threadId)[0]?.profile, persisted);
    assert.ok(host.logger.entries.some((entry) => /could not refresh/.test(entry.message)), "said so in the log");
    await host.stop();
  });

  it("with the daemon down and the persisted version gone (or another one), fails the start", async () => {
    const dir = await realPreparedDir({ profileId: "p1", revision: "2" });
    for (const profile of [V3, { ...V3, preparedDir: dir }]) {
      const daemon = scriptedDaemon(() => ({ kind: "unavailable", reason: "the daemon answered 503" }));
      const host = createTestHost({ launchProfile: daemon.launchProfile });
      const threadId = await host.createThread({ profile });
      await turn(host, threadId);
      assert.equal(starts(host, threadId).length, 0, profile.preparedDir);
      assert.match(host.store.heads.get(threadId)?.session.lastError ?? "", /could not be reached/);
      await host.stop();
    }
  });

  it("a deleted profile's fallback: Global on the log and in launch.json, the notice, and no refresh after", async () => {
    let asked = 0;
    const host = createTestHost({
      launchProfile: async () => {
        asked += 1;
        return launch({
          profile: null,
          launchEnv: { CODEX_HOME: "/homes/acc1" },
          homePath: "/homes/acc1",
          fallback: { previousProfileId: "p1", notice: 'Agent Profile "Video" was deleted; this chat now uses Global.' }
        });
      }
    });
    void host.orchestrator.consume(host.adapter);
    const threadId = await host.createThread({ profile: V3, homePath: "/homes/acc1" });
    await turn(host, threadId);
    const first = starts(host, threadId)[0]!;
    assert.equal("profile" in first, false, "started Global");
    assert.equal(host.store.heads.get(threadId)?.profileId, undefined);
    assert.equal("profile" in host.launchConfigs.entries.get(threadId)!, false);
    const meta = logOf(host, threadId).filter((event) => event.type === "thread.meta-updated");
    assert.deepEqual(meta.map((event) => (event.payload as { profileId?: string }).profileId), [""]);
    const notice = activitiesOf(host, threadId).find((row) => row.activityKind === "runtime.warning");
    assert.equal(notice?.summary, 'Agent Profile "Video" was deleted; this chat now uses Global.');
    assert.deepEqual(
      { profileId: (notice?.payload as Record<string, unknown>).profileId, previousProfileId: (notice?.payload as Record<string, unknown>).previousProfileId },
      { profileId: null, previousProfileId: "p1" }
    );

    await completeTurn(host, threadId);
    await host.orchestrator.command(threadId, "session/stop", { commandId: cmd() });
    await host.settle();
    await turn(host, threadId, "later");
    assert.equal(asked, 1, "a Global thread asks nothing");
    assert.equal(starts(host, threadId).length, 2);
    await host.stop();
  });

  it("repairs a launch config that lost the profile the log names, from the daemon's answer", async () => {
    const first = createTestHost();
    const threadId = await first.createThread({ profile: V3 });
    await first.stop();
    first.launchConfigs.entries.set(threadId, {});
    const next = createTestHost({
      store: first.store,
      launchConfigs: first.launchConfigs,
      launchProfile: async (_threadId, profileId) => {
        assert.equal(profileId, "p1", "asked for the profile the head names");
        return launch({ profile: V4 });
      }
    });
    await turn(next, threadId);
    assert.deepEqual(starts(next, threadId)[0]?.profile, V4);
    await next.stop();
  });
});

describe("the prepared-dir leases", () => {
  it("name every live profile session's prepared dir, and drop it once the session stops", async () => {
    const host = createTestHost();
    void host.orchestrator.consume(host.adapter);
    const a = await host.createThread({ threadId: "a", profile: V3 });
    const b = await host.createThread({ threadId: "b", profile: V4 });
    const global = await host.createThread({ threadId: "g" });
    assert.deepEqual(host.orchestrator.profileLeases(), [], "nothing runs yet");
    await turn(host, a);
    await turn(host, b);
    await turn(host, global);
    assert.deepEqual(host.orchestrator.profileLeases().sort(), [V3.preparedDir, V4.preparedDir].sort());
    await completeTurn(host, a);
    await host.orchestrator.command(a, "session/stop", { commandId: cmd() });
    await host.settle();
    assert.deepEqual(host.orchestrator.profileLeases(), [V4.preparedDir]);
    await host.stop();
  });
});

describe("parseLaunchProfileResponse", () => {
  it("reads the daemon's answer field-wise and refuses one that does not read", () => {
    assert.deepEqual(parseLaunchProfileResponse({ profile: V3, launchEnv: { A: "1", B: 2 }, unsetEnv: ["X", 3], homePath: "/h", serverPool: { key: "k" }, extra: true }), {
      profile: V3,
      launchEnv: { A: "1" },
      unsetEnv: ["X"],
      homePath: "/h",
      serverPool: { key: "k" }
    });
    assert.deepEqual(parseLaunchProfileResponse({ profile: null, fallback: { previousProfileId: "p1", notice: "gone" } }), {
      profile: null,
      fallback: { previousProfileId: "p1", notice: "gone" }
    });
    assert.equal(parseLaunchProfileResponse({ profile: { ...V3, preparedDir: "relative" } }), null);
    assert.equal(parseLaunchProfileResponse({}), null);
    assert.equal(parseLaunchProfileResponse("nope"), null);
  });
});

describe("createDaemonLaunchProfileClient", () => {
  it("asks the daemon's socket with the host's bearer and reads each kind of answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-refresh-sock-"));
    roots.push(dir);
    const socketPath = join(dir, "daemon.sock");
    const seen: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { profile: V3 } };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const fetch = createDaemonLaunchProfileClient({ socketPath: () => socketPath, token: "tok" });
      assert.deepEqual(await fetch("t1", "p1"), { kind: "launch", launch: { profile: V3 } });
      assert.deepEqual(seen[0], { url: daemonRoutesForHost.threadLaunchProfile, auth: agentHostAuthValue("tok"), body: { threadId: "t1", profileId: "p1" } });
      answer = { status: 409, body: { code: "PROFILE_NOT_READY", message: "Preparing failed." } };
      assert.deepEqual(await fetch("t1", "p1"), { kind: "refused", code: "PROFILE_NOT_READY", message: "Preparing failed." });
      answer = { status: 404, body: { code: "THREAD_NOT_FOUND", message: "No chat." } };
      assert.equal((await fetch("t1", "p1")).kind, "refused");
      answer = { status: 404, body: { message: "Route POST:/api/agent-host/threads/launch-profile not found" } };
      assert.equal((await fetch("t1", "p1")).kind, "unavailable", "a daemon that predates the route");
      answer = { status: 503, body: { code: "UNAVAILABLE", message: "starting" } };
      assert.equal((await fetch("t1", "p1")).kind, "unavailable");
      answer = { status: 200, body: { profile: "garbled" } };
      assert.equal((await fetch("t1", "p1")).kind, "unavailable");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const gone = createDaemonLaunchProfileClient({ socketPath: () => join(dir, "no-daemon.sock"), token: "tok" });
    assert.equal((await gone("t1", "p1")).kind, "unavailable");
  });
});
