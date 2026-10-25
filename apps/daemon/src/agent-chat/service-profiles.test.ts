/**
 * Agent Profiles' launch plumbing on the daemon side (spec 2026-10-18 §5.3, §5.5, §5.6, §6.5,
 * §7): create, fork, its reconcile, the account switch and the profile switch all resolve the
 * profile (a fake lifecycle + contributor), apply the contribution over the account's launch,
 * send `profile` to the host and persist `profileId` on the tab; the refresh the host asks before
 * every session start; the leases read; the capability refusal; the unattended fail-fast.
 */

import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import type { RegistryEntry, SessionSummary } from "@orquester/api";
import { agentHostSocketPath, agentHostTokenPath } from "@orquester/config";

import {
  daemonRoutesForHost,
  type CreateHostThreadRequest,
  type ForkHostThreadRequest,
  type SetThreadIdentityRequest
} from "../agent-host/host-protocol.ts";
import { sessionProfileErrors } from "../session-profiles/errors.ts";
import {
  applyProfileContribution,
  type ProfileLaunchContribution,
  type ProfileLaunchRequest
} from "../session-profiles/launch.ts";
import { ChatSessionError } from "./chat-sessions.ts";
import { AgentHostSupervisor, type AgentHostStatus } from "./supervisor.ts";
import { registerThreadLaunchProfileRoute } from "./profile-launch-route.ts";
import { AgentChatService, type ChatLaunchEnv } from "./service.ts";

const CODEX: RegistryEntry = {
  id: "codex",
  name: "Codex",
  kind: "agent",
  bin: ["codex"],
  resolvedBin: "/usr/bin/codex",
  enabled: true,
  installState: "idle",
  env: { FROM_ENV_FILE: "1" },
  chat: { adapter: "codex" }
};

/** What the fake lifecycle answers per profile id. */
type ProfileBehaviour = "ready" | "deleted" | "not-ready";

interface Fixture {
  service: AgentChatService;
  created: CreateHostThreadRequest[];
  forks: Array<{ parentId: string; body: ForkHostThreadRequest }>;
  identities: Array<{ threadId: string; body: SetThreadIdentityRequest }>;
  resolves: ProfileLaunchRequest[];
  profiles: Map<string, ProfileBehaviour>;
  refuseIdentity: { status: number; body: unknown } | null;
  /** Drop the next fork's answer after the host took it (a lost answer), once. */
  dropForkAnswer: boolean;
  leasesAnswer: { status: number; body: unknown };
  /** Set: the identity answer's `profileId` (what the host's thread names, e.g. a replayed receipt's). */
  identityProfileId: string | null | undefined;
  /** What `/health` reports as the host's instance (a change = another host took over). */
  hostInstanceId: string;
  cleanup(): Promise<void>;
}

/** The fake per-agent contribution: a prepared CODEX_HOME and a keyed server, per profile. */
const contributionFor = (profileId: string): ProfileLaunchContribution => ({
  env: { CODEX_HOME: `/prepared/${profileId}/home`, PROFILE_MARK: profileId },
  unsetEnv: ["OPENAI_API_KEY"],
  serverPool: { key: `profile:${profileId}` }
});

async function makeFixture(options: { capability?: boolean; profiles?: false } = {}): Promise<Fixture> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-chat-profiles-"));
  const socketPath = agentHostSocketPath(appdir, "linux");
  await mkdir(join(appdir, "daemon"), { recursive: true });
  await writeFile(agentHostTokenPath(appdir), "test-token\n", { mode: 0o600 });
  const state: Fixture = {
    service: null as unknown as AgentChatService,
    created: [],
    forks: [],
    identities: [],
    resolves: [],
    profiles: new Map([["p1", "ready"], ["p2", "ready"]]),
    refuseIdentity: null,
    dropForkAnswer: false,
    leasesAnswer: { status: 200, body: { preparedDirs: ["/prepared/p1/v3"] } },
    hostInstanceId: "host-1",
    identityProfileId: undefined,
    cleanup: async () => {
      await state.service.stop();
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await rm(appdir, { recursive: true, force: true });
    }
  };
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const host = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "/";
      if (url === "/health") {
        return send(res, 200, {
          ok: true,
          protocolVersion: 1,
          hostInstanceId: state.hostInstanceId,
          liveThreadIds: [],
          activeTurnThreadIds: [],
          pid: 111,
          startedAt: "2026-10-18T00:00:00.000Z",
          ...(options.capability === false ? {} : { capabilities: { sessionProfiles: 1 } })
        });
      }
      if (url === "/threads" && req.method === "POST") {
        state.created.push(JSON.parse(body) as CreateHostThreadRequest);
        return send(res, 200, {});
      }
      const fork = /^\/threads\/([^/]+)\/fork$/.exec(url);
      if (fork && req.method === "POST") {
        const request = JSON.parse(body) as ForkHostThreadRequest;
        state.forks.push({ parentId: decodeURIComponent(fork[1]!), body: request });
        if (state.dropForkAnswer) {
          state.dropForkAnswer = false;
          req.socket.destroy();
          return;
        }
        const lineage = { parentThreadId: decodeURIComponent(fork[1]!), relation: "fork", forkedFrom: { turnId: "t1" }, createdAt: "2026-10-18T00:00:00.000Z" };
        return send(res, 200, { head: { id: request.threadId, lineage }, strategy: "native", lineage });
      }
      const identity = /^\/threads\/([^/]+)\/identity$/.exec(url);
      if (identity && req.method === "POST") {
        state.identities.push({ threadId: decodeURIComponent(identity[1]!), body: JSON.parse(body) as SetThreadIdentityRequest });
        if (state.refuseIdentity) return send(res, state.refuseIdentity.status, state.refuseIdentity.body);
        return send(res, 200, { seq: 42, ...(state.identityProfileId !== undefined ? { profileId: state.identityProfileId } : {}) });
      }
      if (url === "/profiles/leases" && req.method === "GET") {
        return send(res, state.leasesAnswer.status, state.leasesAnswer.body);
      }
      return send(res, 200, {});
    });
  });
  host.keepAliveTimeout = 0;
  host.headersTimeout = 0;
  host.requestTimeout = 0;
  await new Promise<void>((resolve) => host.listen(socketPath, resolve));
  state.service = new AgentChatService({
    baseDir: appdir,
    daemonDir: join(appdir, "daemon"),
    platform: "linux",
    cwd: appdir,
    sessionPath: "/usr/bin",
    env: {},
    tmux: {
      hasServiceSession: async () => false,
      killServiceSession: async () => { throw new Error("the fixture must never kill a host"); },
      newServiceSession: async () => { throw new Error("the fixture must adopt the fake host"); }
    },
    broadcaster: { publish: () => undefined },
    push: { notifyStructural: async () => undefined },
    registryEntry: (refId) => (refId === CODEX.id ? CODEX : undefined),
    resolveLaunchEnv: async (_entry, ctx): Promise<ChatLaunchEnv | null> => {
      const accountId = ctx.accountId === "system" ? undefined : (ctx.accountId ?? "acc-1");
      return accountId
        ? { env: { CODEX_HOME: `/homes/${accountId}`, OPENAI_API_KEY: "never-in-a-profile" }, accountId }
        : { env: {} };
    },
    listManagedAccounts: () => ({
      accounts: ["acc-1", "acc-2"].map((id) => ({ id, agent: "codex", label: id }) as never)
    }),
    systemClaudeConfigFile: () => join(appdir, ".claude.json"),
    resolveTrustedProjectDir: async () => null,
    sendAttachment: async (reply) => reply,
    ...(options.profiles === false
      ? {}
      : {
          sessionProfiles: {
            resolve: async (request) => {
              state.resolves.push(request);
              const behaviour = state.profiles.get(request.profileId) ?? "deleted";
              if (behaviour === "deleted") throw sessionProfileErrors.notFound(request.profileId);
              if (behaviour === "not-ready") throw sessionProfileErrors.notReady("Preparing Codex failed: no login.");
              const accountKey = request.accountId || "system";
              return {
                profile: { profileId: request.profileId, revision: "3", preparedDir: `/prepared/${request.profileId}/codex/${accountKey}` },
                fields: applyProfileContribution(request.base, contributionFor(request.profileId), "CODEX_HOME")
              };
            },
            // As `index.ts` wires it: the store's durable `deleted.json`, read on demand.
            profileName: async (profileId) => (profileId === "gone" ? "Video" : undefined),
            catalog: async (profileId, agent) => {
              if (profileId === "gone") throw sessionProfileErrors.notFound(profileId);
              return { slashCommands: [{ name: "compact" }], skills: [{ name: `${profileId}-${agent}`, path: "/s/SKILL.md", enabled: true }] };
            }
          }
        })
  });
  await state.service.init();
  return state;
}

const create = (f: Fixture, extra: Record<string, unknown> = {}): Promise<SessionSummary> =>
  f.service.createSession({ kind: "agent-chat", refId: "codex", projectPath: "/w/p", cwd: "/w/p", accountId: "acc-1", ...extra } as never, 0);

test("a create with a profile applies its contribution, sends it to the host and records it on the tab", async () => {
  const f = await makeFixture();
  const summary = await create(f, { profileId: "p1" });
  assert.deepEqual(f.resolves.map((r) => [r.profileId, r.agent, r.accountId, r.projectPath]), [["p1", "codex", "acc-1", "/w/p"]]);
  const body = f.created[0]!;
  assert.deepEqual(body.profile, { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/codex/acc-1" });
  assert.equal(body.profileId, "p1");
  assert.equal(body.launchEnv?.CODEX_HOME, "/prepared/p1/home", "the contribution wins over the account's home");
  assert.equal(body.launchEnv?.FROM_ENV_FILE, "1", "the registry entry's env is still there");
  assert.equal(body.launchEnv?.OPENAI_API_KEY, undefined, "unset by the contribution");
  assert.deepEqual(body.unsetEnv, ["OPENAI_API_KEY"]);
  assert.equal(body.homePath, "/prepared/p1/home", "homePath follows the home variable to the prepared home");
  assert.deepEqual(body.serverPool, { key: "profile:p1" });
  assert.equal(summary.profileId, "p1");
  const record = f.service.chat.records().find((r) => r.id === summary.id)!;
  assert.equal(record.chat?.profileId, "p1");
  assert.equal(record.chat?.unattended, undefined);
  await f.cleanup();
});

test("the composer's fallback catalog is the chat's profile's, for the chat's agent; none for Global or a gone profile", async () => {
  const f = await makeFixture();
  const catalog = f.service.routeDeps().profileCatalog!;
  const profiled = await create(f, { profileId: "p1" });
  assert.deepEqual(await catalog(profiled), { slashCommands: [{ name: "compact" }], skills: [{ name: "p1-codex", path: "/s/SKILL.md", enabled: true }] });
  assert.equal(await catalog(await create(f)), null, "a Global chat");
  assert.equal(await catalog({ ...profiled, profileId: "gone" }), null, "a profile that cannot be read");
  await f.cleanup();
});

test("a create without one is Global: no profile on the wire, null on the summary", async () => {
  const f = await makeFixture();
  const summary = await create(f);
  assert.equal(f.resolves.length, 0);
  assert.equal("profile" in f.created[0]!, false);
  assert.equal(f.created[0]!.launchEnv?.CODEX_HOME, "/homes/acc-1");
  assert.equal(f.created[0]!.homePath, "/homes/acc-1");
  assert.equal(summary.profileId, null);
  await f.cleanup();
});

test("a create naming a profile that is gone or not ready fails with the profile's code, and opens no tab", async () => {
  const f = await makeFixture();
  f.profiles.set("p3", "not-ready");
  await assert.rejects(create(f, { profileId: "gone" }), (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_FOUND");
  await assert.rejects(
    create(f, { profileId: "p3" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_READY" && /no login/.test(e.message)
  );
  await assert.rejects(create(f, { profileId: "" }), (e: unknown) => e instanceof ChatSessionError && e.code === "INVALID_COMMAND");
  assert.equal(f.created.length, 0);
  assert.equal(f.service.chat.list().length, 0);
  await f.cleanup();
});

test("a profile is refused while the host does not run profile threads, or before profiles are wired", async () => {
  const older = await makeFixture({ capability: false });
  await assert.rejects(create(older, { profileId: "p1" }), (e: unknown) => e instanceof ChatSessionError && e.code === "COMMAND_REJECTED" && /updated agent host/.test(e.message));
  assert.equal(older.created.length, 0);
  const global = await create(older);
  await assert.rejects(
    older.service.switchProfile(global.id, { commandId: "c1", profileId: "p1" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "COMMAND_REJECTED"
  );
  assert.equal(older.identities.length, 0);
  await older.cleanup();
  const unwired = await makeFixture({ profiles: false });
  await assert.rejects(create(unwired, { profileId: "p1" }), (e: unknown) => e instanceof ChatSessionError && e.code === "COMMAND_REJECTED");
  await unwired.cleanup();
});

test("an unattended create persists the flag on the tab record", async () => {
  const f = await makeFixture();
  const summary = await create(f, { profileId: "p1", chat: { modelSelection: { model: "" }, unattended: true } });
  assert.equal(f.service.chat.records().find((r) => r.id === summary.id)?.chat?.unattended, true);
  assert.equal(f.service.chat.isUnattended(summary.id), true);
  await f.cleanup();
});

test("a fork inherits the parent's profile under the parent's account unless the request names one", async () => {
  const f = await makeFixture();
  const parent = await create(f, { profileId: "p1" });
  f.resolves.length = 0;
  const inherited = await f.service.forkSession(parent.id, {}, 1);
  assert.deepEqual(f.resolves.map((r) => [r.profileId, r.accountId]), [["p1", "acc-1"]]);
  assert.deepEqual(f.forks[0]!.body.profile, { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/codex/acc-1" });
  assert.equal(f.forks[0]!.body.launchEnv?.CODEX_HOME, "/prepared/p1/home");
  assert.equal(inherited.session.profileId, "p1");

  const other = await f.service.forkSession(parent.id, { profileId: "p2" }, 2);
  assert.equal(f.forks[1]!.body.profile?.profileId, "p2");
  assert.deepEqual(f.forks[1]!.body.serverPool, { key: "profile:p2" });
  assert.equal(other.session.profileId, "p2");

  const global = await f.service.forkSession(parent.id, { profileId: null }, 3);
  assert.equal(f.forks[2]!.body.profile, null, "Global, said explicitly so the host does not inherit");
  assert.equal(f.forks[2]!.body.profileId, null);
  assert.equal(f.forks[2]!.body.launchEnv?.CODEX_HOME, "/homes/acc-1");
  assert.equal(global.session.profileId, null);
  await f.cleanup();
});

test("a fork of a chat whose profile was deleted goes ahead interactively as Global with the notice, never unattended", async () => {
  const f = await makeFixture();
  f.profiles.set("doomed", "ready");
  const parent = await create(f, { profileId: "doomed" });
  f.profiles.set("doomed", "deleted");
  const child = await f.service.forkSession(parent.id, {}, 1);
  const body = f.forks[0]!.body;
  // Global now, said explicitly: the parent's launch.json names a version the delete may have collected.
  assert.equal(body.profile, null);
  assert.equal(body.profileId, null);
  assert.deepEqual(body.profileFallback, { previousProfileId: "doomed", notice: "This chat's Agent Profile was deleted; it now uses Global." });
  assert.equal(body.launchEnv?.CODEX_HOME, "/homes/acc-1");
  assert.equal(child.session.profileId, null, "the tab mirrors Global");
  await assert.rejects(
    f.service.forkSession(parent.id, { unattended: true }, 2),
    (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_FOUND"
  );
  await assert.rejects(
    f.service.forkSession(parent.id, { profileId: "doomed" }, 3),
    (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_FOUND",
    "a profile the request names must apply"
  );
  assert.equal(f.forks.length, 1);
  await f.cleanup();
});

test("a fork's reconcile re-sends the child's profile with confirmOnly", async () => {
  const f = await makeFixture();
  const parent = await create(f, { profileId: "p1" });
  f.dropForkAnswer = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k1", profileId: "p2" }, 1));
  await f.service.reconcileForks();
  const confirm = f.forks.find((fork) => fork.body.confirmOnly === true)!;
  assert.ok(confirm, "the reconcile asked the host");
  assert.equal(confirm.body.profile?.profileId, "p2");
  assert.equal(confirm.body.launchEnv?.CODEX_HOME, "/prepared/p2/home");
  await f.cleanup();
});

test("an account switch sends the profile prepared for the NEW account; a deleted one is left to the refresh", async () => {
  const f = await makeFixture();
  const summary = await create(f, { profileId: "p1" });
  f.resolves.length = 0;
  await f.service.switchAccount(summary.id, { commandId: "c1", accountId: "acc-2" });
  assert.deepEqual(f.resolves.map((r) => [r.profileId, r.accountId]), [["p1", "acc-2"]]);
  const body = f.identities[0]!.body;
  assert.equal(body.accountId, "acc-2");
  assert.deepEqual(body.profile, { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/codex/acc-2" });
  assert.equal(body.homePath, "/prepared/p1/home");

  f.profiles.set("p1", "not-ready");
  await assert.rejects(
    f.service.switchAccount(summary.id, { commandId: "c2", accountId: "acc-1" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_READY"
  );
  assert.equal(f.service.chat.get(summary.id)?.accountId, "acc-2", "a refused switch moves nothing");

  f.profiles.set("p1", "deleted");
  await f.service.switchAccount(summary.id, { commandId: "c3", accountId: "acc-1" });
  const last = f.identities.at(-1)!.body;
  assert.equal("profile" in last, false, "absent = the thread keeps its profile until its next start's refresh");
  assert.equal(last.launchEnv?.CODEX_HOME, "/homes/acc-1");
  await f.cleanup();
});

test("a profile switch resolves the profile, switches the host with it, THEN records it on the tab", async () => {
  const f = await makeFixture();
  const summary = await create(f);
  const receipt = await f.service.switchProfile(summary.id, { commandId: "c1", profileId: "p2" });
  assert.deepEqual(receipt, { seq: 42 });
  const body = f.identities[0]!.body;
  assert.equal(body.commandId, "c1");
  assert.equal(body.accountId, "acc-1", "the account stays pinned");
  assert.deepEqual(body.profile, { profileId: "p2", revision: "3", preparedDir: "/prepared/p2/codex/acc-1" });
  assert.equal(body.profileId, "p2");
  assert.equal(body.launchEnv?.CODEX_HOME, "/prepared/p2/home");
  assert.deepEqual(body.serverPool, { key: "profile:p2" });
  assert.equal(f.service.chat.get(summary.id)?.profileId, "p2");
  assert.equal(f.service.chat.records().find((r) => r.id === summary.id)?.chat?.profileId, "p2");

  await f.service.switchProfile(summary.id, { commandId: "c2", profileId: null });
  const back = f.identities[1]!.body;
  assert.equal(back.profile, null);
  assert.equal(back.profileId, null);
  assert.equal(back.launchEnv?.CODEX_HOME, "/homes/acc-1");
  assert.equal(f.service.chat.get(summary.id)?.profileId, null);
  assert.equal(f.service.chat.records().find((r) => r.id === summary.id)?.chat?.profileId, undefined);
  await f.cleanup();
});

test("a profile switch is idempotent by commandId; a reused id with another profile conflicts; a refusal moves nothing", async () => {
  const f = await makeFixture();
  const summary = await create(f);
  const [a, b] = await Promise.all([
    f.service.switchProfile(summary.id, { commandId: "c1", profileId: "p1" }),
    f.service.switchProfile(summary.id, { commandId: "c1", profileId: "p1" })
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(await f.service.switchProfile(summary.id, { commandId: "c1", profileId: "p1" }), a);
  assert.equal(f.identities.length, 1, "one host call for every repeat");
  await assert.rejects(
    f.service.switchProfile(summary.id, { commandId: "c1", profileId: "p2" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "COMMAND_ID_CONFLICT"
  );

  f.refuseIdentity = { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "Wait for the turn to finish." } } };
  await assert.rejects(
    f.service.switchProfile(summary.id, { commandId: "c2", profileId: "p2" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "COMMAND_REJECTED"
  );
  assert.equal(f.service.chat.get(summary.id)?.profileId, "p1", "the tab keeps what the host has");
  f.refuseIdentity = null;
  await f.service.switchProfile(summary.id, { commandId: "c2", profileId: "p2" });
  assert.equal(f.service.chat.get(summary.id)?.profileId, "p2", "a refused commandId may be retried");

  f.profiles.set("p3", "not-ready");
  await assert.rejects(
    f.service.switchProfile(summary.id, { commandId: "c3", profileId: "p3" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_READY"
  );
  await assert.rejects(
    f.service.switchProfile(summary.id, { commandId: "c4", profileId: 5 as never }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "INVALID_COMMAND"
  );
  await assert.rejects(
    f.service.switchProfile("nope", { commandId: "c5", profileId: "p1" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "THREAD_NOT_FOUND"
  );
  await f.cleanup();
});

test("a reused commandId the host answers with another profile (a receipt this daemon forgot) conflicts, and the tab mirrors the host", async (t) => {
  const f = await makeFixture();
  t.after(() => f.cleanup());
  const summary = await create(f, { profileId: "p1" });
  // As after a daemon restart: the host replays an earlier receipt of this commandId, whose
  // command left the thread on p1 — not the p2 asked now.
  f.identityProfileId = "p1";
  await assert.rejects(
    f.service.switchProfile(summary.id, { commandId: "c-old", profileId: "p2" }),
    (e: unknown) => e instanceof ChatSessionError && e.code === "COMMAND_ID_CONFLICT"
  );
  assert.equal(f.service.chat.get(summary.id)?.profileId, "p1", "never a profile the host did not apply");
  // An answer that matches records it; an older host's answer (no profileId) records the request.
  f.identityProfileId = "p2";
  await f.service.switchProfile(summary.id, { commandId: "c-new", profileId: "p2" });
  assert.equal(f.service.chat.get(summary.id)?.profileId, "p2");
  f.identityProfileId = undefined;
  await f.service.switchProfile(summary.id, { commandId: "c-newer", profileId: null });
  assert.equal(f.service.chat.get(summary.id)?.profileId, null);
});

test("the refresh at a session start answers the current version, or the deleted profile's fallback with its notice", async () => {
  const f = await makeFixture();
  const summary = await create(f, { profileId: "p1" });
  const current = await f.service.threadLaunchProfile(summary.id, "p1");
  assert.deepEqual(current.profile, { profileId: "p1", revision: "3", preparedDir: "/prepared/p1/codex/acc-1" });
  assert.equal(current.launchEnv?.CODEX_HOME, "/prepared/p1/home");
  assert.equal(current.homePath, "/prepared/p1/home");
  assert.equal(current.fallback, undefined);

  f.profiles.set("p1", "deleted");
  f.profiles.set("gone", "deleted");
  const fallback = await f.service.threadLaunchProfile(summary.id, "gone");
  assert.equal(fallback.profile, null);
  assert.equal(fallback.launchEnv?.CODEX_HOME, "/homes/acc-1", "the account's own launch");
  assert.deepEqual(fallback.fallback, {
    previousProfileId: "gone",
    notice: 'Agent Profile "Video" was deleted; this chat now uses Global.'
  });
  assert.equal(f.service.chat.get(summary.id)?.profileId, null, "the tab mirrors the fallback");
  await f.cleanup();
});

test("the refresh never falls back for an unattended chat, and passes every other refusal through", async () => {
  const f = await makeFixture();
  const summary = await create(f, { profileId: "p1", unattended: true });
  f.profiles.set("p1", "deleted");
  await assert.rejects(
    f.service.threadLaunchProfile(summary.id, "p1"),
    (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_FOUND" && /unattended/.test(e.message)
  );
  assert.equal(f.service.chat.get(summary.id)?.profileId, "p1");
  f.profiles.set("p1", "not-ready");
  await assert.rejects(
    f.service.threadLaunchProfile(summary.id, "p1"),
    (e: unknown) => e instanceof ChatSessionError && e.code === "PROFILE_NOT_READY"
  );
  await assert.rejects(
    f.service.threadLaunchProfile("nope", "p1"),
    (e: unknown) => e instanceof ChatSessionError && e.code === "THREAD_NOT_FOUND"
  );
  await f.cleanup();
});

test("the leases are the host's live prepared dirs, and unknown (a rejection) whenever the host cannot say", async () => {
  const f = await makeFixture();
  assert.deepEqual([...(await f.service.profileLeases())], ["/prepared/p1/v3"]);
  f.leasesAnswer = { status: 404, body: { error: { message: "No route for GET /profiles/leases" } } };
  await assert.rejects(f.service.profileLeases(), /did not report/);
  f.leasesAnswer = { status: 200, body: { preparedDirs: [7] } };
  await assert.rejects(f.service.profileLeases());
  await f.cleanup();
});

test("the refresh realigns the tab with the account the host's thread names (an account switch whose answer was lost)", async (t) => {
  const f = await makeFixture();
  t.after(() => f.cleanup());
  const summary = await create(f, { profileId: "p1" });
  assert.equal(f.service.chat.get(summary.id)?.accountId, "acc-1");
  // The host accepted a switch to acc-2, the daemon died before `setAccount`: the host says so.
  const answer = await f.service.threadLaunchProfile(summary.id, "p1", "acc-2");
  assert.equal(f.resolves.at(-1)?.accountId, "acc-2", "the profile prepared for the host's account");
  assert.equal(answer.launchEnv?.FROM_ENV_FILE, "1");
  assert.equal(f.resolves.at(-1)?.base.launchEnv.CODEX_HOME, "/homes/acc-2", "that account's credentials, never the stale tab's");
  assert.equal(f.service.chat.get(summary.id)?.accountId, "acc-2", "the tab mirrors the host again");
  // An older host (no account in the request): the tab's.
  await f.service.threadLaunchProfile(summary.id, "p1");
  assert.equal(f.resolves.at(-1)?.accountId, "acc-2");
});

test("onHostHealthy fires when a host becomes healthy (the leases are knowable again), not on every health tick", async (t) => {
  const f = await makeFixture();
  // The supervisor owns probing; this service boundary turns status events into
  // availability edges for prepared-directory GC.
  const listeners = new Set<(status: AgentHostStatus) => void>();
  t.mock.method(AgentHostSupervisor.prototype, "onChange", (listener: (status: AgentHostStatus) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const emit = (hostInstanceId: string) => {
    const status: AgentHostStatus = {
      state: "healthy", hostInstanceId, protocolVersion: 1,
      pendingVersionRestart: false, pid: 111, reason: null
    };
    for (const listener of listeners) listener(status);
  };
  let fired = 0;
  const unsubscribe = f.service.onHostHealthy(() => void (fired += 1));
  emit("host-1");
  assert.equal(fired, 0, "the same healthy host: no edge");
  emit("host-2");
  assert.equal(fired, 1, "another host took over");
  emit("host-2");
  assert.equal(fired, 1);
  unsubscribe();
  emit("host-3");
  assert.equal(fired, 1, "unsubscribed");
  await f.cleanup();
});

test("the host's refresh route is the host's alone, and maps each answer to the status the host reads", async () => {
  const app = Fastify({ logger: false });
  const answers: Record<string, () => Promise<unknown>> = {
    ok: async () => ({ profile: null, launchEnv: {} }),
    missing: async () => { throw new ChatSessionError("No chat session with that id.", "THREAD_NOT_FOUND"); },
    refused: async () => { throw new ChatSessionError("Preparing Codex failed.", "PROFILE_NOT_READY"); },
    starting: async () => { throw new ChatSessionError("Orquester is still starting.", "PROFILES_UNAVAILABLE"); },
    broken: async () => { throw new Error("boom"); }
  };
  const accounts: Array<string | undefined> = [];
  registerThreadLaunchProfileRoute(app, {
    authorizeHost: (authorization) => authorization === "Bearer host",
    resolve: (threadId, _profileId, accountId) => {
      accounts.push(accountId);
      return answers[threadId]!() as never;
    }
  });
  await app.ready();
  const post = (threadId: string, authorization = "Bearer host", profileId: unknown = "p1") =>
    app.inject({ method: "POST", url: daemonRoutesForHost.threadLaunchProfile, headers: { authorization }, payload: { threadId, profileId } });
  assert.equal((await post("ok", "Bearer nope")).statusCode, 401);
  assert.equal((await post("ok", "Bearer host", 3)).statusCode, 400);
  assert.equal((await post("ok")).statusCode, 200);
  const withAccount = await app.inject({
    method: "POST",
    url: daemonRoutesForHost.threadLaunchProfile,
    headers: { authorization: "Bearer host" },
    payload: { threadId: "ok", profileId: "p1", accountId: "acc-2" }
  });
  assert.equal(withAccount.statusCode, 200);
  assert.deepEqual(accounts.slice(-2), [undefined, "acc-2"], "the host's account passes through; absent from an older host");
  assert.deepEqual((await post("missing")).json(), { code: "THREAD_NOT_FOUND", message: "No chat session with that id." });
  assert.equal((await post("missing")).statusCode, 404);
  const refused = await post("refused");
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "PROFILE_NOT_READY");
  assert.equal((await post("starting")).statusCode, 503);
  assert.equal((await post("broken")).statusCode, 503);
  await app.close();
});
