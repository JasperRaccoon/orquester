import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { boxesStorePath } from "@orquester/config";

import type { BoxSyncScope } from "../contracts.ts";
import { localBoxConnection } from "../testing.ts";
import { BoxError } from "./errors.ts";
import { connectProvider, FakeAdapter, isolatedBoxConnection, testBoxService, testClock } from "./testing.ts";

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com"
};

/** A bare repo with one commit on `main` and a `feature` branch. */
function bareRepo(root: string): string {
  const work = join(root, "seed");
  const bare = join(root, "app.git");
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
  execFileSync("mkdir", ["-p", work]);
  git(["init", "-q", "-b", "main"], work);
  execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: work });
  git(["add", "."], work);
  git(["commit", "-qm", "init"], work);
  git(["branch", "feature"], work);
  git(["clone", "-q", "--bare", work, bare], root);
  return bare;
}

test("a temporary box: the record is written before the provider call, then create → connect → ready", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });

  let seenOnDisk = false;
  adapter.onCreate = (request) => {
    assert.equal(service.registry.get(request.boxId)?.state, "provisioning");
    seenOnDisk = true;
  };
  const box = await service.createTemporaryBox({ threadId: "thread-1", kind: "linux", lifetimeMinutes: 60, purposeNote: "build the engine" });
  assert.ok(seenOnDisk);
  assert.equal(box.state, "ready");
  assert.equal(box.purpose, "temporary");
  assert.equal(box.size, "small", "the cheapest size");
  assert.equal(box.region, "fsn1", "a region the size is offered in");
  assert.equal(box.hourlyUsd, 0.05);
  assert.ok(box.deadlineAt, "a temporary box has a deadline");
  assert.deepEqual(
    box.setup.map((step) => [step.id, step.state]),
    [
      ["create", "done"],
      ["connect", "done"],
      ["ready", "done"]
    ]
  );
  const stored = JSON.parse(await readFile(boxesStorePath(base), "utf8")).boxes[box.id];
  assert.equal(stored.state, "ready");
  // The installation id (made with the first box) is in the name and the tags.
  const installation = String(stored.name).split("-")[1]!;
  assert.match(installation, /^[0-9a-f]{8}$/);
  assert.equal(JSON.parse(await readFile(boxesStorePath(base), "utf8")).installationId, installation);
  assert.equal(adapter.creates[0]!.name, `orq-${installation}-${box.id}`);
  assert.deepEqual(adapter.creates[0]!.tags, { "orquester-box": box.id, "orquester-install": installation });
  assert.match(adapter.creates[0]!.sshPublicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ orquester-box$/);
  const log = await service.setupLog(box.id);
  assert.match(log, /\[connect\] Done/);
  assert.ok(!log.includes(hub.tokens.get(box.id)!), "the bootstrap token never reaches the setup log");
});

test("the connect step keeps orq-agent's KVM report on the record and the summary (unknown from older agents)", async (t) => {
  const base = await tempDir(t, "orq-box-kvm-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);

  hub.autoConnect = (boxId) => localBoxConnection({ boxId, sys: { kvm: true } });
  const withKvm = await service.createTemporaryBox({ threadId: "thread-1", kind: "linux", lifetimeMinutes: 60, purposeNote: "emulators" });
  assert.equal(withKvm.kvm, true);
  assert.equal(JSON.parse(await readFile(boxesStorePath(base), "utf8")).boxes[withKvm.id].kvm, true);
  assert.equal(adapter.creates[0]!.prepare, undefined, "only device hosts prepare devices");

  hub.autoConnect = (boxId) => localBoxConnection({ boxId, sys: { kvm: false } });
  assert.equal((await service.createTemporaryBox({ threadId: "thread-2", kind: "linux", lifetimeMinutes: 60, purposeNote: "x" })).kvm, false);

  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const older = await service.createTemporaryBox({ threadId: "thread-3", kind: "linux", lifetimeMinutes: 60, purposeNote: "x" });
  assert.ok(!("kvm" in older), "an orq-agent without the probe leaves it unknown");
});

test("a failed create tears the box down (provisioning-failed) and the caller sees why", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  adapter.failCreate = new Error("quota exceeded");
  await assert.rejects(
    service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" }),
    (error: unknown) => error instanceof BoxError && /quota exceeded/.test(error.message)
  );
  const [record] = service.registry.list();
  assert.equal(record!.state, "destroyed");
  assert.equal(record!.destroyedReason, "provisioning-failed");
});

test("a box that never connects is destroyed at the provider", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.refuseConnect = new Error("timed out");
  await assert.rejects(service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" }));
  const [record] = service.registry.list();
  assert.equal(record!.state, "destroyed");
  assert.match(String(record!.stateReason), /did not connect/);
  assert.deepEqual(adapter.destroyed, ["i-1"]);
  assert.equal(adapter.instances.size, 0);
  assert.deepEqual(hub.revoked, [record!.id]);
});

test("a project box: host paths, config sync, clone at a ref with the workspace identity, toolchain, ready", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const root = await tempDir(t, "orq-box-repo-");
  const boxHome = await tempDir(t, "orq-box-home-");
  const workspaceDir = join(base, "workspaces", "acme");
  await mkdir(workspaceDir, { recursive: true });
  const bare = bareRepo(root);
  const adapter = new FakeAdapter();
  const synced: BoxSyncScope[] = [];
  const { service, hub } = testBoxService({
    baseDir: base,
    adapters: [adapter],
    overrides: {
      managedAgentHomes: () => [{ agent: "claude", accountId: "acc-1", home: join(base, "daemon", "agent-accounts", "claude", "acc-1", "home") }],
      configSync: {
        ensureSynced: async (_boxId, scope) => void synced.push(scope),
        watch: () => () => undefined,
        turnEnded: async () => undefined
      }
    }
  });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => isolatedBoxConnection(boxId, boxHome);

  const project = await service.projects.create({
    workspace: "acme",
    workspaceDir,
    gitAccountId: "acct",
    body: { source: "clone", url: bare, name: "app", ref: "feature", location: { kind: "box", boxKind: "linux", provider: "hetzner", size: "big", region: "ash" } }
  });
  assert.equal(project.box?.state, "provisioning");
  await service.settled();

  const record = service.registry.get(project.box!.boxId)!;
  assert.equal(record.state, "ready", String(record.stateReason));
  assert.deepEqual(
    record.setup!.map((step) => [step.id, step.state]),
    [
      ["create", "done"],
      ["connect", "done"],
      ["paths", "done"],
      ["config", "done"],
      ["tooling", "skipped"],
      ["clone", "done"],
      ["toolchain", "done"],
      ["agents", "skipped"],
      ["ready", "done"]
    ]
  );
  assert.equal(record.project?.ref, "feature");
  assert.equal(synced.length, 1);
  assert.equal(await readFile(join(workspaceDir, "app", "README.md"), "utf8"), "hello\n");
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: join(workspaceDir, "app"), env: GIT_ENV }).toString().trim();
  assert.equal(branch, "feature");
  const gitconfig = await readFile(join(boxHome, ".gitconfig"), "utf8");
  assert.match(gitconfig, /name = Octo Cat/);
  assert.match(gitconfig, /email = octo@example.com/);
  // SSH only: no credential helper, the account's HTTPS URLs rewritten, the git host's keys pinned.
  assert.doesNotMatch(gitconfig, /git-credential/);
  assert.match(gitconfig, /helper = \n/);
  assert.match(gitconfig, /\[url "git@github.com:"\]\n\tinsteadOf = https:\/\/github.com\//);
  assert.match(gitconfig, /sshCommand = ssh -o UserKnownHostsFile=.* -o StrictHostKeyChecking=yes/);
  assert.ok(!gitconfig.includes("ghp_"), "no token in the box");
  assert.match(await readFile(join(boxHome, ".ssh", "orquester_known_hosts"), "utf8"), /^github\.com ssh-ed25519 /m);
  // The host paths a box mirrors were created.
  assert.ok((await stat(join(base, "daemon", "agent-accounts"))).isDirectory());
  assert.ok((await stat(join(base, "daemon", "agent", "threads"))).isDirectory());
});

test("the agents step puts each managed account's agent CLI in the box once; a failed install fails the step, not the box", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const boxHome = await tempDir(t, "orq-box-home-");
  const workspaceDir = join(base, "workspaces", "acme");
  await mkdir(workspaceDir, { recursive: true });
  const adapter = new FakeAdapter();
  const ensured: string[] = [];
  let codexFails = false;
  const accountHome = (agent: string, id: string) => join(base, "daemon", "agent-accounts", agent, id, "home");
  const { service, hub } = testBoxService({
    baseDir: base,
    adapters: [adapter],
    overrides: {
      managedAgentHomes: () => [
        { agent: "claude", accountId: "c-1", home: accountHome("claude", "c-1") },
        { agent: "claude", accountId: "c-2", home: accountHome("claude", "c-2") },
        { agent: "codex", accountId: "x-1", home: accountHome("codex", "x-1") }
      ],
      agentClis: {
        ensure: async (_connection, agent, onProgress) => {
          ensured.push(agent);
          if (agent === "codex" && codexFails) throw new Error("Codex is not installed in the box, and `npm install -g @openai/codex` failed there.");
          onProgress(`checked ${agent}`);
          return { installed: agent === "codex" };
        }
      }
    }
  });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => isolatedBoxConnection(boxId, boxHome);
  const location = { kind: "box", boxKind: "linux", provider: "hetzner", size: "big", region: "ash" } as const;
  const agentsStep = (boxId: string) => service.registry.get(boxId)!.setup!.find((step) => step.id === "agents")!;

  const ok = await service.projects.create({ workspace: "acme", workspaceDir, gitAccountId: null, body: { source: "empty", name: "one", location } });
  await service.settled();
  assert.deepEqual(ensured, ["claude", "codex"], "one install per agent, not per account");
  assert.equal(agentsStep(ok.box!.boxId).state, "done");
  assert.equal(agentsStep(ok.box!.boxId).message, "Installed Codex; Claude already there.");
  assert.match(await service.setupLog(ok.box!.boxId), /\[agents\] checked claude/);

  ensured.length = 0;
  codexFails = true;
  const failed = await service.projects.create({ workspace: "acme", workspaceDir, gitAccountId: null, body: { source: "empty", name: "two", location } });
  await service.settled();
  const record = service.registry.get(failed.box!.boxId)!;
  assert.deepEqual(ensured, ["claude", "codex"]);
  assert.equal(agentsStep(record.id).state, "failed");
  assert.equal(agentsStep(record.id).message, "Could not install Codex; see the setup log.");
  assert.equal(record.state, "ready");
  assert.match(String(record.stateReason), /Install the agent CLIs/);
  assert.match(await service.setupLog(record.id), /\[agents\] Codex: Codex is not installed in the box/);
});

test("the config step says which account it syncs and how many files are sent, at most once a second", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const root = await tempDir(t, "orq-box-repo-");
  const boxHome = await tempDir(t, "orq-box-home-");
  const workspaceDir = join(base, "workspaces", "acme");
  await mkdir(workspaceDir, { recursive: true });
  const bare = bareRepo(root);
  const adapter = new FakeAdapter();
  let nowMs = Date.parse("2026-10-23T10:00:00Z");
  const messages: string[] = [];
  let boxId = "";
  let onMessage: ((message: string) => void) | null = null;
  const sawMessage = (want: string) =>
    new Promise<void>((resolve) => {
      if (messages.includes(want)) return resolve();
      onMessage = (message) => {
        if (message === want) resolve();
      };
    });
  const { service, hub } = testBoxService({
    baseDir: base,
    adapters: [adapter],
    overrides: {
      clock: testClock(() => nowMs),
      managedAgentHomes: () => [
        { agent: "claude", accountId: "acc-1", home: join(base, "h1") },
        { agent: "claude", accountId: "acc-2", home: join(base, "h2") }
      ],
      configSync: {
        ensureSynced: async (_boxId, scope, _signal, options) => {
          assert.deepEqual(scope.configRoots, [join(base, "h1"), join(base, "h2")], "one call for the agent's homes");
          await sawMessage("Claude account 1 of 2 · comparing files");
          nowMs += 1500;
          options?.onProgress?.({ root: join(base, "h1"), done: 1240, total: 2000 });
          await sawMessage("Claude account 1 of 2 · 1,240 of 2,000 files");
          // Within the second: not written (the newest line replaces it, or the step ends first).
          options?.onProgress?.({ root: join(base, "h1"), done: 1500, total: 2000 });
        },
        watch: () => () => undefined,
        turnEnded: async () => undefined
      }
    }
  });
  t.after(() => service.stop());
  service.registry.onChange((id) => {
    const step = service.registry.get(id)?.setup?.find((candidate) => candidate.id === "config");
    if (!step?.message || messages[messages.length - 1] === step.message) return;
    boxId = id;
    messages.push(step.message);
    onMessage?.(step.message);
  });
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (id) => isolatedBoxConnection(id, boxHome);
  await service.projects.create({
    workspace: "acme",
    workspaceDir,
    gitAccountId: "acct",
    body: { source: "clone", url: bare, name: "app", location: { kind: "box", boxKind: "linux", provider: "hetzner", size: "big", region: "ash" } }
  });
  await service.settled();
  assert.deepEqual(messages, ["Claude account 1 of 2 · comparing files", "Claude account 1 of 2 · 1,240 of 2,000 files", "2 account homes synced."]);
  const config = service.registry.get(boxId)!.setup!.find((step) => step.id === "config")!;
  assert.equal(config.state, "done");
});

test("a destroy the provider does not confirm leaves destroy-failed; a retry succeeds", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const box = await service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" });

  adapter.failDestroy = new Error("503 from the API");
  await assert.rejects(service.destroyBox(box.id, "agent"), (error: unknown) => error instanceof BoxError && error.code === "BOX_PROVIDER_ERROR");
  assert.equal(service.registry.get(box.id)!.state, "destroy-failed");
  assert.equal(adapter.instances.size, 1, "still there");

  adapter.failDestroy = null;
  const destroyed = await service.destroyBox(box.id, "agent");
  assert.equal(destroyed.state, "destroyed");
  assert.equal(destroyed.destroyedReason, "agent");
  assert.equal(adapter.instances.size, 0);
});

test("after a restart, a provisioning record is resumed from where it stopped", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  adapter.instances.set("i-9", { ref: { id: "i-9" }, name: "orq-abcdefabcdef", boxId: "abcdefabcdef", state: "running", createdAt: new Date().toISOString() });
  const file = boxesStorePath(base);
  await mkdir(dirname(file), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      boxes: {
        abcdefabcdef: {
          id: "abcdefabcdef",
          purpose: "temporary",
          kind: "linux",
          provider: "hetzner",
          region: "fsn1",
          size: "small",
          name: "orq-abcdefabcdef",
          createdAt: now,
          state: "provisioning",
          setup: [{ id: "create", label: "Create", state: "running" }]
        }
      }
    })
  );
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  // A temporary box mid-setup is torn down (nobody waits for it); its found instance is destroyed.
  await service.reconcileNow();
  await service.settled();
  const record = service.registry.get("abcdefabcdef")!;
  assert.equal(record.state, "destroyed");
  assert.equal(record.destroyedReason, "provisioning-failed");
  assert.deepEqual(adapter.destroyed, ["i-9"]);
});

test("a project box left provisioning by a restart finishes its setup", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const workspaceDir = join(base, "workspaces", "acme");
  await mkdir(join(workspaceDir, "empty"), { recursive: true });
  const adapter = new FakeAdapter();
  adapter.instances.set("i-7", { ref: { id: "i-7" }, name: "orq-0123456789ab", boxId: "0123456789ab", state: "running", createdAt: new Date().toISOString() });
  const file = boxesStorePath(base);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      boxes: {
        "0123456789ab": {
          id: "0123456789ab",
          purpose: "project",
          kind: "linux",
          provider: "hetzner",
          region: "fsn1",
          size: "small",
          name: "orq-0123456789ab",
          createdAt: new Date().toISOString(),
          state: "provisioning",
          providerRef: { id: "i-7" },
          project: { workspace: "acme", name: "empty", path: join(workspaceDir, "empty"), source: "empty" },
          setup: [
            { id: "create", label: "Create", state: "done" },
            { id: "connect", label: "Connect", state: "running" }
          ]
        }
      }
    })
  );
  const boxHome = await tempDir(t, "orq-box-home-");
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => isolatedBoxConnection(boxId, boxHome);
  await service.reconcileNow();
  await service.settled();
  const record = service.registry.get("0123456789ab")!;
  assert.equal(record.state, "ready", String(record.stateReason));
  assert.equal(adapter.creates.length, 0, "nothing was created twice");
  assert.match(String(record.setup!.find((step) => step.id === "clone")!.message), /empty project/);
});

test("disconnect → unreachable after the window → ready on reconnect", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  let now = Date.now();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter], overrides: { clock: { now: () => now, wait: async () => undefined } } });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  const connection = localBoxConnection({ boxId: "x" });
  hub.autoConnect = () => connection;
  const box = await service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 600, purposeNote: "x" });
  hub.disconnect(box.id);
  now += 61_000;
  await service.reconcileNow();
  assert.equal(service.registry.get(box.id)!.state, "unreachable");
  connection.setConnected(true);
  hub.connect(box.id, connection);
  await service.settled();
  // The connection change is recorded asynchronously; wait for its store write.
  await new Promise<void>((resolve) => {
    if (service.registry.get(box.id)!.state === "ready") return resolve();
    const off = service.registry.onChange((id) => {
      if (id === box.id && service.registry.get(box.id)!.state === "ready") {
        off();
        resolve();
      }
    });
  });
  assert.equal(service.registry.get(box.id)!.stateReason, null);
});

test("with the plugin off, new boxes are refused and existing ones keep running", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service, hub, setEnabled } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const box = await service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" });
  setEnabled(false);
  assert.equal(service.enabled(), false);
  await assert.rejects(
    service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" }),
    (error: unknown) => error instanceof BoxError && error.code === "BOXES_DISABLED"
  );
  assert.equal(service.registry.get(box.id)!.state, "ready");
  assert.equal(adapter.instances.size, 1);
});

test("without orq-agent builds (no Go on the host) nothing is created and the refusal says why", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  let builds: { version: string } | null = null;
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter], overrides: { agentBuilds: { current: async () => builds } } });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  await assert.rejects(
    service.startTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" }),
    (error: unknown) => error instanceof BoxError && error.code === "BOXES_UNAVAILABLE" && /orq-agent builds are unavailable/.test(error.message)
  );
  assert.equal(service.registry.list().length, 0);
  assert.equal(adapter.instances.size, 0);
  builds = { version: "1" };
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const box = await service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" });
  assert.equal(box.state, "ready");
});

test("a destroy during the provider's create call waits for it and destroys what it made", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  let release!: () => void;
  adapter.holdCreate = new Promise((resolve) => (release = resolve));
  const calling = new Promise<void>((resolve) => (adapter.onCreate = () => resolve()));
  const box = await service.startTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" });
  await calling;
  const destroying = service.destroyBox(box.id, "agent");
  release();
  const destroyed = await destroying;
  assert.equal(destroyed.state, "destroyed");
  assert.equal(destroyed.destroyedReason, "agent");
  assert.deepEqual(adapter.destroyed, ["i-1"], "the instance the create made is destroyed");
  assert.equal(adapter.instances.size, 0);
});

test("a create that failed after the provider accepted it: destroy finds the instance by its marker", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  adapter.failCreateAfterAccept = new Error("socket hang up");
  await assert.rejects(service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" }), /socket hang up/);
  const [record] = service.registry.list();
  assert.equal(record!.state, "destroyed");
  assert.deepEqual(record!.providerRef, { id: "i-1" }, "the found instance is recorded");
  assert.deepEqual(adapter.destroyed, ["i-1"]);
  assert.equal(adapter.instances.size, 0);
});

test("without a ref, a lookup that cannot list leaves destroy-failed (never destroyed unconfirmed)", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  adapter.failCreateAfterAccept = new Error("socket hang up");
  adapter.failList = new Error("503 Service Unavailable");
  await assert.rejects(service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" }));
  const [record] = service.registry.list();
  assert.equal(record!.state, "destroy-failed");
  assert.match(String(record!.stateReason), /Could not check whether Fake Cloud created the machine/);
  assert.equal(adapter.instances.size, 1, "still there, and still on the record's books");

  adapter.failList = null;
  const destroyed = await service.destroyBox(record!.id, "agent");
  assert.equal(destroyed.state, "destroyed");
  assert.equal(adapter.instances.size, 0);
});

test("a failed status poll during a destroy is retried, not taken as a failed destroy", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const box = await service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" });
  adapter.failStatusTimes = 2;
  const destroyed = await service.destroyBox(box.id, "agent");
  assert.equal(destroyed.state, "destroyed");
  assert.equal(adapter.failStatusTimes, 0);
});

test("with the plugin off, live boxes stay managed: the reconciler still enforces their time limit", { timeout: 30_000 }, async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  let now = Date.now();
  const { service, hub, setEnabled } = testBoxService({ baseDir: base, adapters: [adapter], overrides: { clock: testClock(() => now) } });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const box = await service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" });
  setEnabled(false);
  now += 31 * 60_000;
  const destroyed = new Promise<void>((resolve) => {
    const off = service.registry.onChange((id) => {
      if (id === box.id && service.registry.get(id)?.state === "destroyed") {
        off();
        resolve();
      }
    });
  });
  // Turning the plugin off drops every box's link: the reconciler takes a look.
  hub.disconnect(box.id);
  await destroyed;
  await service.settled();
  assert.equal(service.registry.get(box.id)!.destroyedReason, "time-limit");
  assert.equal(adapter.instances.size, 0);
});

test("two appdirs on one provider account never sweep each other's boxes", async (t) => {
  const adapter = new FakeAdapter();
  let now = Date.now();
  const clock = testClock(() => now);
  const mine = testBoxService({ baseDir: await tempDir(t, "orq-box-life-"), adapters: [adapter], overrides: { clock } });
  const stage = testBoxService({ baseDir: await tempDir(t, "orq-box-life-"), adapters: [adapter], overrides: { clock } });
  t.after(() => Promise.all([mine.service.stop(), stage.service.stop()]));
  for (const { service } of [mine, stage]) {
    await service.start();
    await connectProvider(service, adapter);
  }
  mine.hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  stage.hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const box = await mine.service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 600, purposeNote: "x" });
  const staged = await stage.service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 600, purposeNote: "x" });
  await stage.service.reconcileNow();
  await mine.service.reconcileNow();
  now += 11 * 60_000;
  await stage.service.reconcileNow();
  await mine.service.reconcileNow();
  await Promise.all([mine.service.settled(), stage.service.settled()]);
  assert.deepEqual(adapter.destroyed, []);
  assert.equal(adapter.instances.size, 2);
  assert.equal(mine.service.registry.get(box.id)!.state, "ready");
  assert.equal(stage.service.registry.get(staged.id)!.state, "ready");
});

test("new credentials must see the live boxes: another account's key is refused, a rotated key is not", async (t) => {
  const base = await tempDir(t, "orq-box-life-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });
  const box = await service.createTemporaryBox({ threadId: "t", kind: "linux", lifetimeMinutes: 30, purposeNote: "x" });
  await assert.rejects(
    service.settings.setCredentials(adapter.id, { credentials: { apiKey: adapter.otherAccountKey } }),
    (error: unknown) => error instanceof BoxError && error.status === 409 && /cannot see box/.test(error.message)
  );
  assert.equal(service.settings.providersResponse().providers[0]!.keyHint, "1234", "the old key is kept");
  await service.reconcileNow();
  assert.equal(service.registry.get(box.id)!.state, "ready", "not taken for gone");
  const rotated = await service.settings.setCredentials(adapter.id, { credentials: { apiKey: adapter.rotatedKey } });
  assert.equal(rotated.keyHint, "5678");
});

test("a kind caps lifetimes only when every provider does (Blacksmith Linux next to an uncapped cloud)", async (t) => {
  const base = await tempDir(t, "orq-box-kind-cap-");
  const uncapped = new FakeAdapter({ id: "hetzner" });
  const capped = new FakeAdapter({ id: "vultr", maxLifetimeMinutes: 7200 });
  const { service, hub } = testBoxService({ baseDir: base, adapters: [uncapped, capped] });
  t.after(() => service.stop());
  await service.start();
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });

  await connectProvider(service, capped);
  assert.equal((await service.settings.kinds()).find((entry) => entry.kind === "linux")!.maxLifetimeMinutes, 7200);
  await connectProvider(service, uncapped);
  service.settings.invalidateOffers("hetzner");
  assert.equal((await service.settings.kinds()).find((entry) => entry.kind === "linux")!.maxLifetimeMinutes, null);

  // The capped provider's own boxes keep their deadline.
  const box = await service.createTemporaryBox({ threadId: "thread-1", kind: "linux", provider: "vultr", lifetimeMinutes: 7200, purposeNote: "x" });
  assert.equal(box.provider, "vultr");
  assert.ok(box.deadlineAt);
});

test("a device-host box runs create, connect, the device service's `devices` step and ready", async (t) => {
  const base = await tempDir(t, "orq-box-devhost-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });

  const prepared: string[] = [];
  service.setDeviceHostPreparer(async ({ boxId, connection, log }) => {
    assert.equal(connection.boxId, boxId);
    log("Installing the device tools…");
    prepared.push(boxId);
  });
  const box = await service.startDeviceHostBox({ kind: "linux", provider: adapter.id, size: "small", lifetimeMinutes: 60, purposeNote: "  iPhone   simulators " });
  assert.equal(box.purpose, "device-host");
  assert.equal(box.threadId, null);
  assert.equal(box.purposeNote, "iPhone simulators");
  await service.settled();
  const ready = service.registry.summary(box.id)!;
  assert.equal(ready.state, "ready");
  assert.deepEqual(
    ready.setup.map((step) => [step.id, step.state]),
    [
      ["create", "done"],
      ["connect", "done"],
      ["devices", "done"],
      ["ready", "done"]
    ]
  );
  assert.deepEqual(prepared, [box.id]);
  assert.equal(adapter.creates[0]!.prepare, "devices");
  assert.match(await service.setupLog(box.id), /\[devices\] Installing the device tools…/);

  // Destroyed with the device service's own reason line.
  const destroyed = await service.destroyBox(box.id, "deleted", "Idle: no device for 20 min (Settings → Devices).");
  assert.equal(destroyed.stateReason, "Idle: no device for 20 min (Settings → Devices).");
});

test("a device-host box whose `devices` step fails is torn down; without a preparer the step is skipped", async (t) => {
  const base = await tempDir(t, "orq-box-devhost-");
  const adapter = new FakeAdapter();
  const { service, hub } = testBoxService({ baseDir: base, adapters: [adapter] });
  t.after(() => service.stop());
  await service.start();
  await connectProvider(service, adapter);
  hub.autoConnect = (boxId) => localBoxConnection({ boxId });

  service.setDeviceHostPreparer(async () => {
    throw new Error("Node.js 22 or newer is missing");
  });
  const failed = await service.startDeviceHostBox({ kind: "linux", provider: adapter.id, size: "small", lifetimeMinutes: 60, purposeNote: "x" });
  await service.settled();
  const record = service.registry.get(failed.id)!;
  assert.equal(record.state, "destroyed");
  assert.equal(record.destroyedReason, "provisioning-failed");
  assert.match(String(record.stateReason), /Node\.js 22 or newer is missing/);

  service.setDeviceHostPreparer(null);
  const skipped = await service.startDeviceHostBox({ kind: "linux", provider: adapter.id, size: "small", lifetimeMinutes: 60, purposeNote: "x" });
  await service.settled();
  const summary = service.registry.summary(skipped.id)!;
  assert.equal(summary.state, "ready");
  assert.equal(summary.setup.find((step) => step.id === "devices")?.state, "skipped");
  await assert.rejects(service.startDeviceHostBox({ kind: "linux", provider: "byo", size: "small", lifetimeMinutes: 60, purposeNote: "x" }), /own machines/);
});
