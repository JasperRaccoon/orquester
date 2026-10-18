import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { SessionProfileAgentId, SessionProfileItemDraft, SessionProfilePrepareStatusResponse } from "@orquester/api";
import {
  sessionProfilePreparedKeyDir,
  sessionProfilePreparedRootDir,
  sessionProfileStagingDir
} from "@orquester/config";
import type { AgentHomes } from "../agent-profile/adapters/types.ts";
import { SessionProfileError } from "./errors.ts";
import { SESSION_PROFILE_HANDOUT_GRACE_MS, SessionProfileLifecycle, readCurrentVersion, type SessionProfileLifecycleOptions } from "./lifecycle.ts";
import { readPreparedManifest } from "./manifest.ts";
import type { SessionProfilePrepareContext, SessionProfilePreparer, SessionProfilePreparers } from "./preparer.ts";
import { SessionProfileService } from "./service.ts";
import { SessionProfileStore } from "./store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SECRET = "ghp_THE_SECRET_TOKEN_VALUE";
const MCP: SessionProfileItemDraft = {
  kind: "mcp",
  agents: "all",
  mcp: { name: "github", transport: "stdio", command: "gh-mcp", env: [{ key: "GITHUB_TOKEN", value: SECRET }] }
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

interface FakeOptions {
  perAccount?: boolean;
  version?: string;
  inputs?: string[];
  /** Runs inside `prepare` after the file is written; throw to fail. */
  during?: (ctx: SessionProfilePrepareContext) => Promise<void> | void;
}

/** A preparer that writes `content.txt` (revision + preparedDir) and records every call. */
function fakePreparer<A extends SessionProfileAgentId>(agent: A, options: FakeOptions = {}) {
  const calls: SessionProfilePrepareContext[] = [];
  let running = 0;
  let maxRunning = 0;
  const preparer: SessionProfilePreparer<A> & { calls: typeof calls; maxRunning: () => number } = {
    agent,
    perAccount: options.perAccount ?? false,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.inputs ? { inputs: () => options.inputs ?? [] } : {}),
    calls,
    maxRunning: () => maxRunning,
    async prepare(ctx) {
      calls.push(ctx as SessionProfilePrepareContext);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        await writeFile(join(ctx.stagingDir, "content.txt"), `${ctx.resolved.revision}\n${ctx.preparedDir}\n`);
        await options.during?.(ctx as SessionProfilePrepareContext);
        return {} as never;
      } finally {
        running -= 1;
      }
    }
  };
  return preparer;
}

interface Harness {
  appdir: string;
  homes: AgentHomes;
  store: SessionProfileStore;
  service: SessionProfileService;
  lifecycle: SessionProfileLifecycle;
  events: SessionProfilePrepareStatusResponse[];
  logs: string[];
  make(overrides?: Partial<SessionProfileLifecycleOptions>): SessionProfileLifecycle;
}

async function setup(preparers: Partial<SessionProfilePreparers>, overrides: Partial<SessionProfileLifecycleOptions> = {}): Promise<Harness> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-session-profile-lifecycle-"));
  roots.push(appdir);
  const home = join(appdir, "home");
  const homes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir: join(home, ".config", "opencode"),
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  const store = new SessionProfileStore({ appdir });
  await store.init();
  const events: SessionProfilePrepareStatusResponse[] = [];
  const logs: string[] = [];
  const all: SessionProfilePreparers = { claude: null, codex: null, grok: null, opencode: null, ...preparers };
  const make = (more: Partial<SessionProfileLifecycleOptions> = {}): SessionProfileLifecycle => {
    const lifecycle = new SessionProfileLifecycle({
      appdir,
      store,
      systemHomes: homes,
      accountHome: (agent, accountId) => (accountId.startsWith("acc") ? join(appdir, "accounts", agent, accountId, "home") : null),
      preparers: all,
      logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
      ...overrides,
      ...more
    });
    lifecycle.events.on("prepareStatus", (payload) => events.push(payload));
    return lifecycle;
  };
  const lifecycle = make();
  const service = new SessionProfileService({ store, prepareStatus: lifecycle.prepareStatusSource });
  return { appdir, homes, store, service, lifecycle, events, logs, make };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SessionProfileError, String(error));
    return `${error.code}: ${error.message}`;
  }
  assert.fail("expected a rejection");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

/** The version dirs of a key, sorted. */
async function versionsOf(keyDir: string): Promise<string[]> {
  return (await readdir(keyDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("v-"))
    .map((entry) => join(keyDir, entry.name))
    .sort();
}

/** A leases source whose answer the test controls; `fail` makes `inUse()` reject. */
function leasesOf(...dirs: string[]) {
  const set = new Set(dirs);
  const leases = { set, fail: false, calls: 0, inUse: async () => {
    leases.calls += 1;
    if (leases.fail) throw new Error("agent host unreachable");
    return new Set(set);
  } };
  return leases;
}

/** A clock the test moves. */
function clock(start = Date.parse("2026-10-18T10:00:00Z")) {
  let ms = start;
  return { now: () => new Date(ms), advance: (by: number) => void (ms += by) };
}

describe("SessionProfileLifecycle", () => {
  it("prepares atomically for the final path and answers the ready dir", async () => {
    const claude = fakePreparer("claude");
    const h = await setup({ claude });
    const profile = await h.service.create({ name: "Dev" });
    const ready = await h.lifecycle.ensureReady(profile.id, "claude", "acc-ignored");
    const keyDir = sessionProfilePreparedKeyDir(h.appdir, profile.id, "claude", "shared");
    const version = await readCurrentVersion(keyDir);
    assert.match(version ?? "", /^v-[0-9a-f]{12}-[0-9a-z]+-[0-9a-f]{8}$/);
    const dir = join(keyDir, version!);
    assert.deepEqual(ready, { profileId: profile.id, agent: "claude", accountKey: "shared", revision: "1", preparedDir: dir });
    // Path contract: built in staging, told the final versioned path, renamed there.
    assert.equal(claude.calls[0]!.preparedDir, dir);
    assert.equal(claude.calls[0]!.previousPreparedDir, null);
    assert.notEqual(claude.calls[0]!.stagingDir, dir);
    assert.equal(claude.calls[0]!.accountHome, null);
    assert.deepEqual((await readdir(keyDir)).sort(), ["current.json", version!].sort());
    assert.equal(await readFile(join(dir, "content.txt"), "utf8"), `1\n${dir}\n`);
    const manifest = await readPreparedManifest(dir, { profileId: profile.id, revision: "1", agent: "claude" });
    assert.match(manifest.fingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(await readdir(sessionProfileStagingDir(h.appdir)), []);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);

    // Current: no second preparation.
    await h.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(claude.calls.length, 1);
    assert.deepEqual(
      h.events.map((event) => event.agents.find((agent) => agent.agent === "claude")?.state),
      ["preparing", "ready"]
    );
    const detail = await h.service.get(profile.id);
    assert.equal(detail.preparation.find((status) => status.agent === "claude")?.state, "ready");
  });

  it("refuses an agent without a preparer and reports it not-prepared with the reason", async () => {
    const h = await setup({});
    const profile = await h.service.create({ name: "Dev" });
    assert.match(await code(h.lifecycle.ensureReady(profile.id, "grok", null)), /^PROFILE_UNSUPPORTED_AGENT: .*Grok/);
    const status = h.lifecycle.status(profile.id).find((entry) => entry.agent === "grok");
    assert.equal(status?.state, "not-prepared");
    assert.match(status?.reason ?? "", /not supported/);
    assert.match(await code(h.lifecycle.ensureReady("no-such-profile", "claude", null)), /^PROFILE_UNSUPPORTED_AGENT/);
  });

  it("answers PROFILE_NOT_FOUND for an unknown profile", async () => {
    const h = await setup({ claude: fakePreparer("claude") });
    assert.match(await code(h.lifecycle.ensureReady("no-such-profile", "claude", null)), /^PROFILE_NOT_FOUND/);
    assert.match(await code(h.lifecycle.ensureReady("../evil", "claude", null)), /^PROFILE_NOT_FOUND/);
  });

  it("keeps the previous ready dir when a preparation fails, reports the reason and never leaks a secret", async () => {
    let fail = false;
    const claude = fakePreparer("claude", {
      during: (ctx) => {
        if (fail) throw new Error(`MCP server failed with token ${ctx.resolved.mcpServers[0]?.env.GITHUB_TOKEN}`);
      }
    });
    const h = await setup({ claude });
    const created = await h.service.create({ name: "Dev" });
    const { profile } = await h.service.createItem(created.id, created.revision, MCP);
    const first = await h.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(first.revision, "2");

    fail = true;
    const updated = await h.service.update(profile.id, { revision: profile.revision, description: "changed" });
    const message = await code(h.lifecycle.ensureReady(profile.id, "claude", null));
    assert.match(message, /^PROFILE_NOT_READY: MCP server failed with token •••/);
    assert.ok(!message.includes(SECRET));

    // The previous ready dir is intact; staging is empty.
    assert.equal(await readFile(join(first.preparedDir, "content.txt"), "utf8"), `2\n${first.preparedDir}\n`);
    await readPreparedManifest(first.preparedDir, { profileId: profile.id, revision: "2", agent: "claude" });
    assert.deepEqual(await readdir(sessionProfileStagingDir(h.appdir)), []);

    const status = h.lifecycle.status(profile.id).find((entry) => entry.agent === "claude");
    assert.equal(status?.state, "failed");
    assert.match(status?.reason ?? "", /token •••/);
    const last = h.events.at(-1)!;
    assert.equal(last.revision, updated.revision);
    assert.equal(last.agents.find((entry) => entry.agent === "claude")?.state, "failed");
    assert.ok(!JSON.stringify(h.events).includes(SECRET), "no secret in events");
    assert.ok(!h.logs.join("\n").includes(SECRET), "no secret in logs");
    assert.ok(h.logs.some((line) => line.includes("failed: MCP server failed with token •••")));

    // A launch retries a failure (no job in flight); fixed → ready again.
    fail = false;
    const again = await h.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(again.revision, updated.revision);
    assert.equal(h.lifecycle.status(profile.id).find((entry) => entry.agent === "claude")?.state, "ready");
  });

  it("dedupes launches onto the preparation in flight", async () => {
    const gate = deferred();
    const started = deferred();
    const claude = fakePreparer("claude", {
      during: async () => {
        started.resolve();
        await gate.promise;
      }
    });
    const h = await setup({ claude });
    const profile = await h.service.create({ name: "Dev" });
    const a = h.lifecycle.ensureReady(profile.id, "claude", null);
    const b = h.lifecycle.ensureReady(profile.id, "claude", null);
    await started.promise;
    const c = h.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(h.lifecycle.status(profile.id).find((entry) => entry.agent === "claude")?.state, "preparing");
    gate.resolve();
    const results = await Promise.all([a, b, c]);
    assert.equal(claude.calls.length, 1);
    assert.ok(results.every((result) => result.preparedDir === results[0]!.preparedDir && result.revision === "1"));
  });

  it("answers a waiting launch with the failure in flight instead of retrying", async () => {
    const gate = deferred();
    const started = deferred();
    const claude = fakePreparer("claude", {
      during: async () => {
        started.resolve();
        await gate.promise;
        throw new Error("validation failed");
      }
    });
    const h = await setup({ claude });
    const profile = await h.service.create({ name: "Dev" });
    const a = h.lifecycle.ensureReady(profile.id, "claude", null);
    await started.promise;
    const b = h.lifecycle.ensureReady(profile.id, "claude", null);
    gate.resolve();
    assert.match(await code(a), /^PROFILE_NOT_READY: validation failed/);
    assert.match(await code(b), /^PROFILE_NOT_READY: validation failed/);
    assert.equal(claude.calls.length, 1);
  });

  it("serializes one key, runs different keys concurrently, and caps them globally", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const starts = [deferred(), deferred(), deferred()];
    let n = 0;
    const claude = fakePreparer("claude", {
      during: async () => {
        const i = n++;
        starts[i]?.resolve();
        await gates[i]?.promise;
      }
    });
    const h = await setup({ claude }, { concurrency: 2 });
    const one = await h.service.create({ name: "One" });
    const two = await h.service.create({ name: "Two" });
    const three = await h.service.create({ name: "Three" });

    // Same key: markStale while preparing queues behind, never overlaps.
    const first = h.lifecycle.ensureReady(one.id, "claude", null);
    await starts[0]!.promise;
    h.lifecycle.markStale(one.id, "claude", null);
    // Another key runs at once (slot 2 of 2) …
    const second = h.lifecycle.ensureReady(two.id, "claude", null);
    await starts[1]!.promise;
    // … a third waits for a slot.
    const third = h.lifecycle.ensureReady(three.id, "claude", null);
    assert.equal(claude.calls.length, 2);
    gates[0]!.resolve();
    await first;
    await starts[2]!.promise; // the freed slot goes to the next waiter
    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all([second, third]);
    await h.lifecycle.idle();
    assert.equal(claude.calls.length, 4); // + the markStale re-preparation of `one`
    assert.equal(claude.calls.filter((ctx) => ctx.resolved.profileId === one.id).length, 2);
    assert.equal(claude.maxRunning(), 2);
  });

  it("re-prepares on a revision, preparer version, CLI version or Global input change", async () => {
    const h = await setup({ claude: fakePreparer("claude") });
    const input = join(h.homes.claudeDir, "settings.json");
    await mkdir(h.homes.claudeDir, { recursive: true });
    await writeFile(input, '{"model":"a"}');
    let cli = "1.0.0";
    const make = (version: string) => {
      const preparer = fakePreparer("claude", { version, inputs: [input] });
      return { preparer, lifecycle: h.make({ preparers: { claude: preparer, codex: null, grok: null, opencode: null }, cliVersion: () => cli }) };
    };
    const profile = await h.service.create({ name: "Dev" });
    const v1 = make("1");
    v1.lifecycle.attach(h.service.events);
    await v1.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(v1.preparer.calls.length, 1);

    // Revision: the service's `changed` re-prepares in the background.
    await h.service.update(profile.id, { revision: profile.revision, description: "x" });
    await v1.lifecycle.idle();
    assert.equal(v1.preparer.calls.length, 2);
    assert.equal(v1.preparer.calls[1]!.resolved.revision, "2");

    // Global input: an unrelated change is a no-op; a content change re-prepares.
    v1.lifecycle.globalConfigChanged("claude");
    await v1.lifecycle.idle();
    assert.equal(v1.preparer.calls.length, 2);
    await writeFile(input, '{"model":"b"}');
    v1.lifecycle.globalConfigChanged("claude");
    await v1.lifecycle.idle();
    assert.equal(v1.preparer.calls.length, 3);
    // An input that disappears counts as a change too.
    await rm(input);
    await v1.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(v1.preparer.calls.length, 4);

    // CLI version.
    cli = "1.1.0";
    await v1.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(v1.preparer.calls.length, 5);
    v1.lifecycle.stop();

    // Preparer version: a new build reads the dir on disk as stale.
    const v2 = make("2");
    await v2.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(v2.preparer.calls.length, 1);
    const same = make("2");
    await same.lifecycle.ensureReady(profile.id, "claude", null);
    assert.equal(same.preparer.calls.length, 0, "a fresh lifecycle reuses a current dir from disk");
  });

  it("prepares a new profile in the background and removes a deleted one after its jobs settle", async () => {
    const gate = deferred();
    const started = deferred();
    let hold = false;
    const claude = fakePreparer("claude", {
      during: async () => {
        if (!hold) return;
        started.resolve();
        await gate.promise;
      }
    });
    const codex = fakePreparer("codex", { perAccount: true });
    const h = await setup({ claude, codex }, { defaultAccountId: (agent) => (agent === "codex" ? "acc-1" : null), leases: leasesOf(), handoutGraceMs: 0 });
    h.lifecycle.attach(h.service.events);
    const profile = await h.service.create({ name: "Dev" });
    await h.lifecycle.idle();
    assert.equal(claude.calls.length, 1);
    assert.equal(codex.calls.length, 1);
    assert.equal(codex.calls[0]!.accountKey, "acc-1");
    assert.equal(codex.calls[0]!.accountHome, join(h.appdir, "accounts", "codex", "acc-1", "home"));
    const root = join(sessionProfilePreparedRootDir(h.appdir), profile.id);
    assert.ok(await exists(join(root, "claude", "shared")));
    assert.ok(await exists(join(root, "codex", "acc-1")));

    // Delete while a re-preparation is in flight: removal waits, nothing is recreated.
    hold = true;
    const changed = await h.service.update(profile.id, { revision: profile.revision, description: "x" });
    await started.promise;
    await h.service.remove(profile.id, changed.revision);
    assert.match(await code(h.lifecycle.ensureReady(profile.id, "claude", null)), /^PROFILE_NOT_FOUND/);
    gate.resolve();
    await h.lifecycle.idle();
    assert.equal(await exists(root), false);
    assert.deepEqual(await readdir(sessionProfileStagingDir(h.appdir)), []);
  });

  it("keys per account for a perAccount preparer and aggregates their status", async () => {
    const codex = fakePreparer("codex", {
      perAccount: true,
      during: (ctx) => {
        if (ctx.accountKey === "acc-bad") throw new Error("initialize failed");
      }
    });
    const h = await setup({ codex });
    const profile = await h.service.create({ name: "Dev" });
    const system = await h.lifecycle.ensureReady(profile.id, "codex", null);
    assert.equal(system.accountKey, "system");
    assert.equal(codex.calls[0]!.accountHome, h.homes.codexHome);
    assert.equal((await h.lifecycle.ensureReady(profile.id, "codex", "system")).preparedDir, system.preparedDir);
    const one = await h.lifecycle.ensureReady(profile.id, "codex", "acc-1");
    assert.equal(dirname(one.preparedDir), sessionProfilePreparedKeyDir(h.appdir, profile.id, "codex", "acc-1"));
    assert.equal(h.lifecycle.status(profile.id).find((entry) => entry.agent === "codex")?.state, "ready");

    assert.match(await code(h.lifecycle.ensureReady(profile.id, "codex", "gone")), /^PROFILE_NOT_READY: The account "gone" no longer exists/);
    assert.match(await code(h.lifecycle.ensureReady(profile.id, "codex", "acc-bad")), /^PROFILE_NOT_READY: initialize failed/);
    const status = h.lifecycle.status(profile.id).find((entry) => entry.agent === "codex");
    assert.equal(status?.state, "failed");
    assert.equal(status?.reason, "initialize failed");
  });

  it("re-prepares a key marked stale (Codex re-seed)", async () => {
    const codex = fakePreparer("codex", { perAccount: true });
    const h = await setup({ codex });
    const profile = await h.service.create({ name: "Dev" });
    await h.lifecycle.ensureReady(profile.id, "codex", "acc-1");
    h.lifecycle.markStale(profile.id, "codex", "acc-1");
    await h.lifecycle.ensureReady(profile.id, "codex", "acc-1");
    assert.equal(codex.calls.length, 2);
    await h.lifecycle.ensureReady(profile.id, "codex", "acc-1");
    assert.equal(codex.calls.length, 2);
  });

  it("re-prepares a current version its preparer calls unusable (Codex: state DB gone) and hands preparers the CLI binary", async () => {
    const codex = fakePreparer("codex", { perAccount: true });
    let broken: string | null = null;
    const preparer = { ...codex, unusableReason: (dir: string) => Promise.resolve(dir === broken ? "its state DB is missing" : null) };
    const h = await setup({ codex: preparer }, { cliBin: (agent) => `/opt/bin/${agent}` });
    const profile = await h.service.create({ name: "Dev" });
    const first = await h.lifecycle.ensureReady(profile.id, "codex", "acc-1");
    assert.equal(codex.calls[0]!.cliBin, "/opt/bin/codex");
    // Usable: answered as is.
    assert.equal((await h.lifecycle.ensureReady(profile.id, "codex", "acc-1")).preparedDir, first.preparedDir);
    assert.equal(codex.calls.length, 1);
    // Unusable: a NEW version, never the broken one.
    broken = first.preparedDir;
    const second = await h.lifecycle.ensureReady(profile.id, "codex", "acc-1");
    assert.notEqual(second.preparedDir, first.preparedDir);
    assert.equal(codex.calls.length, 2);
    assert.ok(h.logs.some((line) => line.includes("cannot be used (its state DB is missing)")));
  });

  it("cleans staging at boot, drops prepared dirs of deleted profiles and re-prepares stale ones", async () => {
    const h = await setup({ claude: fakePreparer("claude") }, { leases: leasesOf() });
    const profile = await h.service.create({ name: "Dev" });
    await h.lifecycle.ensureReady(profile.id, "claude", null);
    const staging = sessionProfileStagingDir(h.appdir);
    await mkdir(join(staging, "leftover.claude.shared.x", "skills"), { recursive: true });
    await writeFile(join(staging, "leftover.claude.shared.x", "skills", "a"), "half");
    const orphan = join(sessionProfilePreparedRootDir(h.appdir), "gone-profile", "claude", "shared");
    await mkdir(join(orphan, "v-0123456789ab-k1-deadbeef"), { recursive: true });
    await writeFile(join(orphan, "current.json"), '{"schema":1,"version":"v-0123456789ab-k1-deadbeef"}');

    const preparer = fakePreparer("claude", { version: "2" });
    const booted = h.make({ preparers: { claude: preparer, codex: null, grok: null, opencode: null } });
    await booted.start();
    assert.deepEqual(await readdir(staging), []);
    assert.equal(await exists(join(orphan, "current.json")), false, "a deleted profile's pointer goes at once");
    assert.equal(booted.status(profile.id).find((entry) => entry.agent === "claude")?.state !== "not-prepared", true);
    await booted.idle();
    assert.equal(await exists(join(sessionProfilePreparedRootDir(h.appdir), "gone-profile")), false);
    assert.equal(preparer.calls.length, 1, "the stale dir (older preparer version) is re-prepared in the background");
    assert.equal(booted.status(profile.id).find((entry) => entry.agent === "claude")?.state, "ready");

    // A second boot with the same version finds it current.
    const again = fakePreparer("claude", { version: "2" });
    const rebooted = h.make({ preparers: { claude: again, codex: null, grok: null, opencode: null } });
    await rebooted.start();
    await rebooted.idle();
    assert.equal(again.calls.length, 0);
  });

  it("refuses launches after stop and passes an aborted signal to preparations in flight", async () => {
    const started = deferred();
    const claude = fakePreparer("claude", {
      during: async (ctx) => {
        started.resolve();
        await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
      }
    });
    const h = await setup({ claude });
    const profile = await h.service.create({ name: "Dev" });
    const pending = h.lifecycle.ensureReady(profile.id, "claude", null);
    await started.promise;
    h.lifecycle.stop();
    assert.match(await code(pending), /^PROFILE_NOT_READY/);
    assert.match(await code(h.lifecycle.ensureReady(profile.id, "claude", null)), /^PROFILE_NOT_READY: The daemon is stopping/);
    await h.lifecycle.idle();
  });
});

describe("SessionProfileLifecycle versions and GC", () => {
  it("publishes every preparation as a new version and never touches an older one", async () => {
    const claude = fakePreparer("claude");
    const h = await setup({ claude });
    const profile = await h.service.create({ name: "Dev" });
    const first = await h.lifecycle.ensureReady(profile.id, "claude", null);
    const before = await stat(join(first.preparedDir, "content.txt"));
    await h.service.update(profile.id, { revision: profile.revision, description: "x" });
    const second = await h.lifecycle.ensureReady(profile.id, "claude", null);

    assert.notEqual(second.preparedDir, first.preparedDir);
    assert.equal(dirname(second.preparedDir), dirname(first.preparedDir));
    assert.equal(claude.calls[1]!.previousPreparedDir, first.preparedDir);
    assert.equal(claude.calls[1]!.preparedDir, second.preparedDir);
    assert.equal(await readCurrentVersion(dirname(first.preparedDir)), second.preparedDir.split("/").at(-1));
    // No leases source: the old version stays, byte for byte.
    await h.lifecycle.gc();
    await h.lifecycle.idle();
    assert.equal(await readFile(join(first.preparedDir, "content.txt"), "utf8"), `1\n${first.preparedDir}\n`);
    assert.equal((await stat(join(first.preparedDir, "content.txt"))).mtimeMs, before.mtimeMs);
    await readPreparedManifest(first.preparedDir, { profileId: profile.id, revision: "1", agent: "claude" });
    assert.deepEqual(await versionsOf(dirname(first.preparedDir)), [first.preparedDir, second.preparedDir].sort());
  });

  it("never reuses a version name, even for the same fingerprint at the same instant", async () => {
    const claude = fakePreparer("claude");
    const fixed = clock();
    const h = await setup({ claude }, { now: fixed.now });
    const profile = await h.service.create({ name: "Dev" });
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      h.lifecycle.markStale(profile.id, "claude", null);
      seen.add((await h.lifecycle.ensureReady(profile.id, "claude", null)).preparedDir);
    }
    assert.equal(claude.calls.length, 5);
    assert.equal(seen.size, 5);
    assert.deepEqual(new Set(claude.calls.map((ctx) => ctx.preparedDir)), seen);
  });

  it("keeps a leased old version, removes it once unleased and after the handout grace", async () => {
    const leases = leasesOf();
    const time = clock();
    const h = await setup({ claude: fakePreparer("claude") }, { leases, now: time.now });
    const profile = await h.service.create({ name: "Dev" });
    const v1 = await h.lifecycle.ensureReady(profile.id, "claude", null);
    await h.service.update(profile.id, { revision: profile.revision, description: "x" });
    const v2 = await h.lifecycle.ensureReady(profile.id, "claude", null);
    await h.lifecycle.idle();
    // v1 was handed out a moment ago (its launch may not hold a lease yet): kept.
    assert.ok(await exists(v1.preparedDir));

    time.advance(SESSION_PROFILE_HANDOUT_GRACE_MS + 1);
    leases.set.add(v1.preparedDir);
    await h.lifecycle.gc();
    assert.ok(await exists(v1.preparedDir), "a leased version survives");

    leases.set.delete(v1.preparedDir);
    await h.lifecycle.gc();
    assert.equal(await exists(v1.preparedDir), false, "an unleased old version goes");
    assert.ok(await exists(v2.preparedDir), "the current version is never collected");
    assert.deepEqual(await versionsOf(dirname(v2.preparedDir)), [v2.preparedDir]);
    assert.ok(h.logs.some((line) => line.includes(`removed unused prepared dir ${v1.preparedDir}`)));
  });

  it("removes an unleased old version right after publishing", async () => {
    const leases = leasesOf();
    const h = await setup({ claude: fakePreparer("claude") }, { leases, handoutGraceMs: 0 });
    const profile = await h.service.create({ name: "Dev" });
    const v1 = await h.lifecycle.ensureReady(profile.id, "claude", null);
    await h.service.update(profile.id, { revision: profile.revision, description: "x" });
    const v2 = await h.lifecycle.ensureReady(profile.id, "claude", null);
    await h.lifecycle.idle();
    assert.equal(await exists(v1.preparedDir), false);
    assert.deepEqual(await versionsOf(dirname(v2.preparedDir)), [v2.preparedDir]);
  });

  it("deletes nothing when inUse() fails or no leases source is wired", async () => {
    const leases = leasesOf();
    leases.fail = true;
    const h = await setup({ claude: fakePreparer("claude") }, { leases, handoutGraceMs: 0 });
    const profile = await h.service.create({ name: "Dev" });
    const v1 = await h.lifecycle.ensureReady(profile.id, "claude", null);
    await h.service.update(profile.id, { revision: profile.revision, description: "x" });
    await h.lifecycle.ensureReady(profile.id, "claude", null);
    await h.lifecycle.gc();
    await h.lifecycle.idle();
    assert.ok(leases.calls >= 2);
    assert.ok(await exists(v1.preparedDir));
    assert.ok(h.logs.some((line) => line.includes("keeping them all: agent host unreachable")));

    // A lifecycle without a leases source: even a deleted profile's versions stay.
    const plain = h.make({ leases: undefined, handoutGraceMs: 0 });
    plain.attach(h.service.events);
    const other = await h.service.create({ name: "Other" });
    const o1 = await plain.ensureReady(other.id, "claude", null);
    await h.service.remove(other.id, other.revision);
    await plain.idle();
    assert.equal(await exists(join(dirname(o1.preparedDir), "current.json")), false);
    assert.ok(await exists(o1.preparedDir));
    plain.stop();
  });

  it("on delete removes pointers and unleased versions; a leased one stays until a later GC", async () => {
    const leases = leasesOf();
    const codex = fakePreparer("codex", { perAccount: true });
    const h = await setup({ codex }, { leases, handoutGraceMs: 0 });
    h.lifecycle.attach(h.service.events);
    const profile = await h.service.create({ name: "Dev" });
    const one = await h.lifecycle.ensureReady(profile.id, "codex", "acc-1");
    const two = await h.lifecycle.ensureReady(profile.id, "codex", "acc-2");
    await h.lifecycle.idle();
    leases.set.add(one.preparedDir);

    await h.service.remove(profile.id, profile.revision);
    await h.lifecycle.idle();
    assert.match(await code(h.lifecycle.ensureReady(profile.id, "codex", "acc-1")), /^PROFILE_NOT_FOUND/);
    assert.equal(await exists(join(dirname(one.preparedDir), "current.json")), false);
    assert.ok(await exists(one.preparedDir), "the leased version survives the delete");
    assert.equal(await exists(dirname(two.preparedDir)), false, "the unleased key is gone");

    leases.set.clear();
    await h.lifecycle.gc();
    assert.equal(await exists(join(sessionProfilePreparedRootDir(h.appdir), profile.id)), false);

    // After a restart the deleted profile still answers PROFILE_NOT_FOUND.
    const rebooted = h.make({ preparers: { claude: null, codex, grok: null, opencode: null }, leases });
    await rebooted.start();
    assert.match(await code(rebooted.ensureReady(profile.id, "codex", "acc-1")), /^PROFILE_NOT_FOUND/);
    await rebooted.idle();
  });

  it("flips the pointer atomically: a reader always sees a complete version", async () => {
    const claude = fakePreparer("claude");
    const h = await setup({ claude });
    const profile = await h.service.create({ name: "Dev" });
    const first = await h.lifecycle.ensureReady(profile.id, "claude", null);
    const keyDir = dirname(first.preparedDir);
    let done = false;
    let reads = 0;
    const reader = (async () => {
      while (!done) {
        const version = await readCurrentVersion(keyDir);
        assert.ok(version, "the pointer is never missing");
        await readPreparedManifest(join(keyDir, version), { profileId: profile.id, revision: "1", agent: "claude" });
        reads += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    for (let i = 0; i < 10; i += 1) {
      h.lifecycle.markStale(profile.id, "claude", null);
      await h.lifecycle.ensureReady(profile.id, "claude", null);
    }
    done = true;
    await reader;
    assert.equal(claude.calls.length, 11);
    assert.ok(reads > 0);
  });

  it("treats a legacy unversioned key dir as stale and collects it subject to its lease", async () => {
    const leases = leasesOf();
    const h = await setup({ claude: fakePreparer("claude") }, { leases, handoutGraceMs: 0 });
    const profile = await h.service.create({ name: "Dev" });
    const keyDir = sessionProfilePreparedKeyDir(h.appdir, profile.id, "claude", "shared");
    await mkdir(join(keyDir, "skills", "a"), { recursive: true });
    await writeFile(join(keyDir, "skills", "a", "SKILL.md"), "legacy");
    await writeFile(
      join(keyDir, "manifest.json"),
      JSON.stringify({ schema: 1, profileId: profile.id, revision: "1", agent: "claude", accountKey: "shared", preparedAt: "x", agentSection: {} })
    );
    await writeFile(join(keyDir, ".current.json.stale.tmp"), "half");
    leases.set.add(keyDir); // a chat launched before versioning runs in it

    const preparer = fakePreparer("claude");
    const booted = h.make({ preparers: { claude: preparer, codex: null, grok: null, opencode: null } });
    await booted.start();
    await booted.idle();
    assert.equal(preparer.calls.length, 1, "the legacy dir is not a current version");
    const ready = await booted.ensureReady(profile.id, "claude", null);
    assert.equal(dirname(ready.preparedDir), keyDir);
    assert.ok(await exists(join(keyDir, "manifest.json")), "leased legacy content is kept");
    assert.ok(await exists(join(keyDir, "skills", "a", "SKILL.md")));
    assert.equal(await exists(join(keyDir, ".current.json.stale.tmp")), false);

    leases.set.clear();
    await booted.gc();
    assert.deepEqual((await readdir(keyDir)).sort(), ["current.json", ready.preparedDir.split("/").at(-1)!].sort());
  });
});
