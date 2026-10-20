import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { BoxConfigChangesResponse, BoxConfigChangeSet, BoxPathMap } from "@orquester/api";
import { sessionProfilePreparedRootDir } from "@orquester/config";

import type { BoxSyncScope } from "../contracts.ts";
import { execBoxHasher, type BoxHasher } from "./box-fs.ts";
import { BoxConfigSyncService, BoxSyncError, type BoxConfigSyncOptions } from "./config-sync.ts";
import { BoxConfigWatches } from "./watches.ts";
import { fakeBoxHub, mappedBoxConnection, type MappedBoxConnection } from "./testing.ts";

const SECRETS = ["ghp_mcpsecret", "ghp_settingssecret", "CREDENTIALS-CONTENT", "PRIVATE-KEY-CONTENT"];

async function put(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (mode !== undefined) await chmod(path, mode);
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(path)));
    else out.push(path);
  }
  return out;
}

/**
 * A Claude account home like `syncAccountHome` leaves it: `skills`, `commands` and `settings.json`
 * are links into the shared system `~/.claude`, the rest is the account's own.
 */
async function fixture(options: { paths?: BoxPathMap } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "orq-sync-")));
  const appdir = join(base, "app");
  const system = join(base, "host", ".claude");
  const home = join(appdir, "daemon", "agent-accounts", "claude", "a1", "home");
  const project = join(base, "w", "proj");
  await put(join(system, "skills", "review", "SKILL.md"), "---\nname: review\n---\nReview carefully.\n");
  await put(join(system, "commands", "ship.md"), "Ship it.\n");
  await put(
    join(system, "settings.json"),
    JSON.stringify({ env: { GITHUB_TOKEN: "ghp_settingssecret", MAX_THINKING_TOKENS: "1000" }, hooks: { Stop: [] } }, null, 2)
  );
  await mkdir(home, { recursive: true });
  await symlink(join(system, "skills"), join(home, "skills"));
  await symlink(join(system, "commands"), join(home, "commands"));
  await symlink(join(system, "settings.json"), join(home, "settings.json"));
  await put(join(home, "CLAUDE.md"), "# Global rules\n");
  await put(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "owner@example.com" },
      userID: "user-1",
      numStartups: 3,
      mcpServers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "ghp_mcpsecret" } } },
      projects: { [project]: { hasTrustDialogAccepted: true, lastCost: 2 } }
    })
  );
  await put(join(home, ".credentials.json"), "CREDENTIALS-CONTENT");
  await put(join(home, "projects", "-w-proj", "s1.jsonl"), '{"type":"user"}\n');
  await put(join(home, "todos", "t.json"), "[]");
  await put(join(home, "statsig", "x"), "1");
  await put(join(home, "plugins", "cache", "m", "p", "1.0", "hooks", "run.sh"), "#!/bin/sh\necho hi\n", 0o755);
  await put(join(home, "plugins", "installed_plugins.json"), '{"version":2}');
  // Symlink tricks: innocent names pointing at credentials.
  await put(join(base, "host", ".ssh", "id_ed25519"), "PRIVATE-KEY-CONTENT");
  await symlink(join(home, ".credentials.json"), join(system, "skills", "review", "notes.md"));
  await symlink(join(base, "host", ".ssh", "id_ed25519"), join(system, "commands", "deploy.md"));
  await symlink(join(base, "host", ".ssh"), join(system, "skills", "keys"));

  const box1 = mappedBoxConnection({ boxId: "b1", boxRoot: join(base, "box1"), paths: options.paths });
  const box2 = mappedBoxConnection({ boxId: "b2", boxRoot: join(base, "box2"), paths: options.paths });
  const hub = fakeBoxHub({ b1: box1, b2: box2 });
  const published: BoxConfigChangesResponse[] = [];
  const listeners: ((payload: BoxConfigChangesResponse) => void)[] = [];
  const make = (overrides: Partial<BoxConfigSyncOptions> = {}): BoxConfigSyncService =>
    new BoxConfigSyncService({
      appdir,
      hub,
      watchHost: false,
      idleFlushMs: 10,
      boxEventDebounceMs: 1,
      publish: (payload) => {
        published.push(payload);
        for (const listener of listeners.splice(0)) listener(payload);
      },
      ...overrides
    });
  const scope: BoxSyncScope = { agent: "claude", configRoots: [home], threadId: "t1" };
  const nextPublish = (): Promise<BoxConfigChangesResponse> => new Promise((resolve) => listeners.push(resolve));
  return { base, appdir, system, home, project, box1, box2, hub, published, make, scope, nextPublish };
}

const signal = (): AbortSignal => new AbortController().signal;

function pendingSet(published: BoxConfigChangesResponse[]): BoxConfigChangeSet {
  const last = published[published.length - 1];
  const set = last?.changes.find((change) => change.state === "pending");
  assert.ok(set, "a pending change set was published");
  return set;
}

test("initial sync materializes links, blanks secrets and never sends credentials or transcripts", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());

  const boxHome = f.box1.local(f.home);
  assert.equal((await lstat(join(boxHome, "skills"))).isDirectory(), true, "a linked dir becomes a real dir");
  assert.equal((await lstat(join(boxHome, "settings.json"))).isFile(), true, "a linked file becomes a real file");
  assert.equal(await readFile(join(boxHome, "skills", "review", "SKILL.md"), "utf8"), "---\nname: review\n---\nReview carefully.\n");
  assert.equal(await readFile(join(boxHome, "commands", "ship.md"), "utf8"), "Ship it.\n");
  assert.equal(await readFile(join(boxHome, "CLAUDE.md"), "utf8"), "# Global rules\n");
  const settings = JSON.parse(await readFile(join(boxHome, "settings.json"), "utf8"));
  assert.equal(settings.env.GITHUB_TOKEN, "");
  assert.equal(settings.env.MAX_THINKING_TOKENS, "1000");
  const claudeJson = JSON.parse(await readFile(join(boxHome, ".claude.json"), "utf8"));
  assert.equal(claudeJson.mcpServers.gh.env.GH_TOKEN, "");
  assert.equal(claudeJson.oauthAccount, undefined);
  assert.equal(claudeJson.hasCompletedOnboarding, true);
  assert.equal(((await stat(join(boxHome, "plugins", "cache", "m", "p", "1.0", "hooks", "run.sh"))).mode & 0o111) !== 0, true);

  for (const absent of [".credentials.json", "projects", "todos", "statsig", "skills/review/notes.md", "commands/deploy.md", "skills/keys"]) {
    assert.equal(await exists(join(boxHome, absent)), false, absent);
  }
  for (const file of await allFiles(join(f.base, "box1"))) {
    const content = await readFile(file, "utf8");
    for (const secret of SECRETS) assert.ok(!content.includes(secret), `${file} holds no secret`);
  }
  await sync.close();
});

test("incremental sync pushes only what changed, deletes what the host removed, prunes emptied dirs", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const writes = f.box1.writes.length;
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(f.box1.writes.length, writes, "an unchanged scope writes nothing");

  await put(join(f.home, "CLAUDE.md"), "# Global rules\nBe brief.\n");
  await rm(join(f.system, "skills", "review"), { recursive: true });
  await put(join(f.system, "commands", "new.md"), "New.\n");
  // A host write outside what syncs (Claude's own state in .claude.json) is no change.
  const claudeJson = JSON.parse(await readFile(join(f.home, ".claude.json"), "utf8"));
  await put(join(f.home, ".claude.json"), JSON.stringify({ ...claudeJson, numStartups: 4 }));
  sync.watch("b1", f.scope);
  await sync.hostChanged("b1");
  await sync.idle();
  const boxHome = f.box1.local(f.home);
  assert.equal(await readFile(join(boxHome, "CLAUDE.md"), "utf8"), "# Global rules\nBe brief.\n");
  assert.equal(await readFile(join(boxHome, "commands", "new.md"), "utf8"), "New.\n");
  assert.equal(await exists(join(boxHome, "skills", "review")), false, "the emptied skill dir is pruned");
  assert.deepEqual(
    f.box1.writes.slice(writes).map((path) => path.slice(f.home.length + 1)).sort(),
    ["CLAUDE.md", "commands/new.md"]
  );
  await sync.close();
});

test("host watchers push a host edit to a watching box on their own", async () => {
  const f = await fixture();
  const sync = new BoxConfigSyncService({ appdir: f.appdir, hub: f.hub, hostDebounceMs: 20 });
  await sync.ensureSynced("b1", f.scope, signal());
  sync.watch("b1", f.scope);
  await sync.idle();
  const target = join(f.home, "commands", "watched.md");
  const written = new Promise<void>((resolve) => {
    const original = f.box1.writeFile.bind(f.box1);
    f.box1.writeFile = async (path, data, options) => {
      await original(path, data, options);
      if (path === target) resolve();
    };
  });
  await put(join(f.system, "commands", "watched.md"), "Watched.\n");
  await written;
  assert.equal(await readFile(f.box1.local(target), "utf8"), "Watched.\n");
  await sync.close();
});

test("a scope synced through BoxConfigWatches.syncing stays watched: a later host edit reaches the box with no launch", async () => {
  const f = await fixture();
  const sync = new BoxConfigSyncService({ appdir: f.appdir, hub: f.hub, hostDebounceMs: 20 });
  const watches = new BoxConfigWatches({ sync, active: (boxId) => boxId === "b1" });
  await watches.syncing(sync).ensureSynced("b1", f.scope, signal());
  assert.equal(watches.watched("b1"), 1);
  await sync.idle();
  const target = join(f.home, "skills", "later", "SKILL.md");
  const written = new Promise<void>((resolve) => {
    const original = f.box1.writeFile.bind(f.box1);
    f.box1.writeFile = async (path, data, options) => {
      await original(path, data, options);
      if (path === target) resolve();
    };
  });
  await put(join(f.system, "skills", "later", "SKILL.md"), "---\nname: later\n---\nAdded on the host.\n");
  await written;
  assert.equal(await readFile(f.box1.local(target), "utf8"), "---\nname: later\n---\nAdded on the host.\n");
  watches.release("b1");
  assert.equal(watches.watched("b1"), 0);
  await sync.close();
});

test("a host dir that appears gets a second look: files written into it after the pass that saw it empty still reach the box", async () => {
  const f = await fixture();
  // No host watchers: nothing but the second look can notice the file.
  const sync = f.make({ hostDebounceMs: 20 });
  await sync.ensureSynced("b1", f.scope, signal());
  sync.watch("b1", f.scope);
  await sync.idle();
  const target = join(f.home, "skills", "fresh", "SKILL.md");
  const written = new Promise<void>((resolve) => {
    const original = f.box1.writeFile.bind(f.box1);
    f.box1.writeFile = async (path, data, options) => {
      await original(path, data, options);
      if (path === target) resolve();
    };
  });
  // A skill installed as mkdir, then its file: the pass runs in between.
  await mkdir(join(f.system, "skills", "fresh"));
  await sync.hostChanged("b1");
  assert.equal(await exists(f.box1.local(target)), false, "the pass saw the dir empty");
  await put(join(f.system, "skills", "fresh", "SKILL.md"), "---\nname: fresh\n---\nNew.\n");
  await written;
  assert.equal(await readFile(f.box1.local(target), "utf8"), "---\nname: fresh\n---\nNew.\n");
  await sync.close();
});

test("a box change becomes one pending set for its turn; approve writes through links and reaches the other box", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  await sync.ensureSynced("b2", f.scope, signal());
  sync.watch("b1", f.scope);
  sync.watch("b2", f.scope);
  await sync.idle();

  const boxHome = f.box1.local(f.home);
  sync.turnStarted("b1", "t1");
  await put(join(boxHome, "skills", "fresh", "SKILL.md"), "---\nname: fresh\n---\nNew skill.\n");
  await put(join(boxHome, "CLAUDE.md"), "# Global rules\nAdded in the box.\n");
  await put(join(boxHome, "hooks", "check.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  // Never collected: credentials and things outside the include list.
  await put(join(boxHome, ".credentials.json"), "BOX-CREDENTIALS");
  await put(join(boxHome, "skills", "fresh", "api-token.txt"), "BOX-TOKEN");
  await put(join(boxHome, "projects", "-w-proj", "s2.jsonl"), "{}\n");
  await sync.turnEnded("b1", "t1");

  const set = pendingSet(f.published);
  assert.equal(set.threadId, "t1");
  assert.equal(set.boxId, "b1");
  const byPath = new Map(set.files.map((file) => [file.path.slice(f.home.length + 1), file]));
  assert.deepEqual([...byPath.keys()].sort(), ["CLAUDE.md", "hooks/check.sh", "skills/fresh/SKILL.md"]);
  assert.equal(byPath.get("skills/fresh/SKILL.md")!.change, "added");
  assert.equal(byPath.get("CLAUDE.md")!.change, "modified");
  assert.ok(byPath.get("CLAUDE.md")!.diff.includes("+Added in the box."));
  assert.equal(byPath.get("CLAUDE.md")!.executable, false);
  assert.equal(byPath.get("hooks/check.sh")!.executable, true);

  // Still pending: a new sync keeps the box's version live.
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(await readFile(join(boxHome, "CLAUDE.md"), "utf8"), "# Global rules\nAdded in the box.\n");
  assert.equal(await exists(join(f.box2.local(f.home), "skills", "fresh")), false, "a pending change reaches no other box");

  const decided = await sync.decide(set.id, "approve");
  assert.equal(decided.state, "approved");
  assert.equal(await readFile(join(f.system, "skills", "fresh", "SKILL.md"), "utf8"), "---\nname: fresh\n---\nNew skill.\n", "written to the link target");
  assert.equal((await lstat(join(f.home, "skills"))).isSymbolicLink(), true, "the account home's link survives");
  assert.equal(await readFile(join(f.home, "CLAUDE.md"), "utf8"), "# Global rules\nAdded in the box.\n");
  assert.equal(await readFile(join(f.home, ".credentials.json"), "utf8"), "CREDENTIALS-CONTENT", "the box's credentials never reach the host");
  assert.equal(await exists(join(f.system, "skills", "fresh", "api-token.txt")), false);
  await sync.idle();
  const box2Home = f.box2.local(f.home);
  assert.equal(await readFile(join(box2Home, "skills", "fresh", "SKILL.md"), "utf8"), "---\nname: fresh\n---\nNew skill.\n");
  assert.equal(await readFile(join(box2Home, "CLAUDE.md"), "utf8"), "# Global rules\nAdded in the box.\n");

  await assert.rejects(sync.decide(set.id, "deny"), (error: unknown) => error instanceof BoxSyncError && error.code === "BOX_CONFIG_CHANGE_DECIDED");
  await assert.rejects(sync.decide("nope", "deny"), (error: unknown) => error instanceof BoxSyncError && error.status === 404);
  await sync.close();
});

test("deny puts the host version back in the box and deletes what the box added", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const boxHome = f.box1.local(f.home);
  const boxSettings = await readFile(join(boxHome, "settings.json"), "utf8");
  const settings = JSON.parse(boxSettings);
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: "curl evil" }] }];
  await put(join(boxHome, "settings.json"), JSON.stringify(settings, null, 2));
  await put(join(boxHome, "commands", "extra.md"), "Extra.\n");
  await sync.turnEnded("b1", "t1");
  const set = pendingSet(f.published);
  const settingsFile = set.files.find((file) => file.path.endsWith("settings.json"))!;
  assert.equal(settingsFile.executable, true, "a hook change is executable");
  assert.ok(!settingsFile.diff.includes("ghp_settingssecret"), "diffs show blanked secrets only");

  const decided = await sync.decide(set.id, "deny");
  assert.equal(decided.state, "denied");
  assert.equal(await readFile(join(boxHome, "settings.json"), "utf8"), boxSettings);
  assert.equal(await exists(join(boxHome, "commands", "extra.md")), false);
  assert.equal(JSON.parse(await readFile(join(f.system, "settings.json"), "utf8")).hooks.Stop.length, 0, "the host is untouched");
  await sync.turnEnded("b1", "t1");
  assert.equal((await sync.listChanges()).filter((change) => change.state === "pending").length, 0);
  await sync.close();
});

test("a host edit of a pending file makes the set stale and the host wins", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const boxHome = f.box1.local(f.home);

  // Decided after the host moved: stale, not applied.
  await put(join(boxHome, "CLAUDE.md"), "box edit 1\n");
  await sync.turnEnded("b1", "t1");
  const first = pendingSet(f.published);
  await put(join(f.home, "CLAUDE.md"), "host edit 1\n");
  const decided = await sync.decide(first.id, "approve");
  assert.equal(decided.state, "stale");
  assert.equal(await readFile(join(f.home, "CLAUDE.md"), "utf8"), "host edit 1\n");
  assert.equal(await readFile(join(boxHome, "CLAUDE.md"), "utf8"), "host edit 1\n");

  // Seen by a sync pass while pending: stale at once.
  await put(join(boxHome, "CLAUDE.md"), "box edit 2\n");
  await sync.turnEnded("b1", "t1");
  const second = pendingSet(f.published);
  await put(join(f.home, "CLAUDE.md"), "host edit 2\n");
  await sync.ensureSynced("b1", f.scope, signal());
  const listed = (await sync.listChanges()).find((change) => change.id === second.id)!;
  assert.equal(listed.state, "stale");
  assert.equal(await readFile(join(boxHome, "CLAUDE.md"), "utf8"), "host edit 2\n");
  await sync.close();
});

test("approving a new MCP server keeps the host's secrets and state in .claude.json", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const boxFile = join(f.box1.local(f.home), ".claude.json");
  const box = JSON.parse(await readFile(boxFile, "utf8"));
  box.mcpServers.fs = { command: "fs-mcp", args: ["/w"] };
  box.numStartups = 99; // the box CLI's own state: not part of the change
  await put(boxFile, JSON.stringify(box, null, 2));
  await sync.turnEnded("b1", "t1");
  const set = pendingSet(f.published);
  assert.equal(set.files.length, 1);
  assert.equal(set.files[0]!.executable, true, "an MCP server change runs code");
  await sync.decide(set.id, "approve");
  const host = JSON.parse(await readFile(join(f.home, ".claude.json"), "utf8"));
  assert.equal(host.mcpServers.gh.env.GH_TOKEN, "ghp_mcpsecret");
  assert.deepEqual(host.mcpServers.fs, { command: "fs-mcp", args: ["/w"] });
  assert.equal(host.oauthAccount.emailAddress, "owner@example.com");
  assert.equal(host.numStartups, 3);
  await sync.close();
});

test("box watch events outside a turn are grouped after the idle window with no thread", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  sync.watch("b1", f.scope);
  await sync.idle();
  const watchCall = f.box1.calls.find(
    (call) => call.method === "fs.watch" && (call.params as { path: string }).path === join(f.home, "commands")
  );
  assert.ok(watchCall, "the commands dir is watched in the box");
  const { watchId } = watchCall.params as { watchId: string };
  const published = f.nextPublish();
  await put(join(f.box1.local(f.home), "commands", "typed.md"), "Typed in a terminal.\n");
  f.box1.emitEvent("fs.change", { watchId, changes: [{ path: join(f.home, "commands", "typed.md"), type: "create" }] });
  const payload = await published;
  const set = payload.changes.find((change) => change.state === "pending")!;
  assert.equal(set.threadId, null);
  assert.deepEqual(
    set.files.map((file) => file.path),
    [join(f.home, "commands", "typed.md")]
  );
  await sync.close();
});

// A deadline, not a wait: a mark that never expired would hold the publish back for good.
test("a turn mark whose end never came stops holding the idle flush once it is older than turnMarkMaxMs", { timeout: 30_000 }, async () => {
  const f = await fixture();
  let nowMs = Date.parse("2026-10-20T10:00:00Z");
  const warnings: string[] = [];
  const sync = f.make({ now: () => new Date(nowMs), turnMarkMaxMs: 60_000, logger: { warn: (message) => void warnings.push(message) } });
  await sync.ensureSynced("b1", f.scope, signal());
  sync.watch("b1", f.scope);
  await sync.idle();
  const watchCall = f.box1.calls.find(
    (call) => call.method === "fs.watch" && (call.params as { path: string }).path === join(f.home, "commands")
  );
  assert.ok(watchCall, "the commands dir is watched in the box");
  const { watchId } = watchCall.params as { watchId: string };
  // The agent host marked a turn, then went away without ending it.
  sync.turnStarted("b1", "t-lost");
  nowMs += 60_001;
  const published = f.nextPublish();
  await put(join(f.box1.local(f.home), "commands", "later.md"), "Made after the lost turn.\n");
  f.box1.emitEvent("fs.change", { watchId, changes: [{ path: join(f.home, "commands", "later.md"), type: "create" }] });
  const set = (await published).changes.find((change) => change.state === "pending")!;
  assert.equal(set.threadId, null, "grouped by the idle debounce again");
  assert.deepEqual(
    set.files.map((file) => file.path),
    [join(f.home, "commands", "later.md")]
  );
  assert.ok(warnings.some((message) => message.includes("t-lost")));
  await sync.close();
});

test("prepared profile dirs are host → box only", async () => {
  const f = await fixture();
  const prepared = join(sessionProfilePreparedRootDir(f.appdir), "p1", "claude", "shared", "v-1");
  await put(join(prepared, "plugin", "skills", "x", "SKILL.md"), "Profile skill.\n");
  await put(join(prepared, "mcp-servers.json"), JSON.stringify({ mcpServers: { db: { command: "db", env: { DB_PASSWORD: "pw-secret" } } } }));
  await put(join(prepared, "manifest.json"), "{}");
  const sync = f.make();
  const scope: BoxSyncScope = { agent: "claude", configRoots: [f.home, prepared], threadId: null };
  await sync.ensureSynced("b1", scope, signal());
  const boxPrepared = f.box1.local(prepared);
  assert.equal(await readFile(join(boxPrepared, "plugin", "skills", "x", "SKILL.md"), "utf8"), "Profile skill.\n");
  assert.ok(!(await readFile(join(boxPrepared, "mcp-servers.json"), "utf8")).includes("pw-secret"));
  assert.equal(await exists(join(boxPrepared, "manifest.json")), false);
  await put(join(boxPrepared, "plugin", "skills", "x", "SKILL.md"), "Changed in the box.\n");
  await sync.turnEnded("b1", "t1");
  assert.equal(f.published.length, 0, "no approval for a prepared dir");
  await sync.ensureSynced("b1", scope, signal());
  assert.equal(await readFile(join(boxPrepared, "plugin", "skills", "x", "SKILL.md"), "utf8"), "Profile skill.\n");
  await sync.close();
});

test("the baseline survives a restart, so a box edit made meanwhile is still a box change", async () => {
  const f = await fixture();
  const first = f.make();
  await first.ensureSynced("b1", f.scope, signal());
  await first.close();
  await put(join(f.box1.local(f.home), "CLAUDE.md"), "edited while the daemon was down\n");
  const second = f.make();
  second.turnStarted("b1", "t9");
  await second.ensureSynced("b1", f.scope, signal());
  assert.equal(await readFile(join(f.box1.local(f.home), "CLAUDE.md"), "utf8"), "edited while the daemon was down\n", "not overwritten");
  await second.turnEnded("b1", "t9");
  const set = pendingSet(f.published);
  assert.equal(set.threadId, "t9");
  await second.close();
});

test("Windows boxes get every file under C:\\orq at the host path's segments", async () => {
  const f = await fixture({ paths: { kind: "windows-prefix", prefix: "C:\\orq" } });
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  assert.ok(f.box1.writes.length > 0);
  for (const path of f.box1.writes) assert.ok(path.startsWith("C:\\orq\\") && !path.includes("/"), path);
  const boxHome = f.box1.local(f.home);
  assert.equal(await readFile(join(boxHome, "CLAUDE.md"), "utf8"), "# Global rules\n");
  const claudeJson = JSON.parse(await readFile(join(boxHome, ".claude.json"), "utf8"));
  assert.deepEqual(Object.keys(claudeJson.projects), [`C:\\orq${f.project.replace(/\//g, "\\")}`]);
  // A box edit maps back to the host path.
  await put(join(boxHome, "commands", "win.md"), "From Windows.\n");
  await sync.turnEnded("b1", "t1");
  const set = pendingSet(f.published);
  assert.deepEqual(
    set.files.map((file) => file.path),
    [join(f.home, "commands", "win.md")]
  );
  await sync.decide(set.id, "approve");
  assert.equal(await readFile(join(f.system, "commands", "win.md"), "utf8"), "From Windows.\n");
  await sync.close();
});

test("box-only credential files are invisible to sync: never sent, deleted, listed or reported", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const boxHome = f.box1.local(f.home);
  // What the agent host writes in a box: access-token-only credentials (and a denied name inside a synced dir).
  await put(join(boxHome, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"box-access-token"}}');
  await put(join(boxHome, "skills", "review", "token.json"), "box-token");
  sync.watch("b1", f.scope);
  await sync.idle();
  const watchCall = f.box1.calls.find((call) => call.method === "fs.watch" && (call.params as { path: string }).path === f.home)!;
  f.box1.emitEvent("fs.change", {
    watchId: (watchCall.params as { watchId: string }).watchId,
    changes: [{ path: join(f.home, ".credentials.json"), type: "update" }]
  });
  // The host removes the skill around the denied file; the dir it sits in stays for it.
  await rm(join(f.system, "skills", "review"), { recursive: true });
  await sync.hostChanged("b1");
  await sync.ensureSynced("b1", f.scope, signal());
  sync.turnStarted("b1", "t1");
  await sync.turnEnded("b1", "t1");
  await sync.idle();

  assert.equal(await readFile(join(boxHome, ".credentials.json"), "utf8"), '{"claudeAiOauth":{"accessToken":"box-access-token"}}');
  assert.equal(await readFile(join(boxHome, "skills", "review", "token.json"), "utf8"), "box-token");
  assert.equal(await exists(join(boxHome, "skills", "review", "SKILL.md")), false);
  assert.equal(await readFile(join(f.home, ".credentials.json"), "utf8"), "CREDENTIALS-CONTENT");
  assert.equal(f.published.length, 0, "no change set mentions them");
  const touched = [...f.box1.writes, ...f.box1.calls.map((call) => (call.params as { path?: string } | null)?.path ?? "")];
  assert.ok(!touched.some((path) => path.endsWith(".credentials.json") || path.endsWith("token.json")), "never read, written, statted or removed");
  await sync.close();
});

test("C15: a host dir or file that cannot be read is never taken for a deletion", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const boxHome = f.box1.local(f.home);
  await chmod(join(f.system, "commands"), 0o000);
  await chmod(join(f.home, "CLAUDE.md"), 0o000);
  try {
    await sync.ensureSynced("b1", f.scope, signal());
    sync.watch("b1", f.scope);
    await sync.hostChanged("b1");
    await sync.idle();
    assert.equal(await readFile(join(boxHome, "commands", "ship.md"), "utf8"), "Ship it.\n", "an unreadable host dir keeps the box's copies");
    assert.equal(await readFile(join(boxHome, "CLAUDE.md"), "utf8"), "# Global rules\n", "an unreadable host file keeps the box's copy");
  } finally {
    await chmod(join(f.system, "commands"), 0o755);
    await chmod(join(f.home, "CLAUDE.md"), 0o644);
  }
  // Readable again and really removed: now the box copy goes.
  await rm(join(f.system, "commands", "ship.md"));
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(await exists(join(boxHome, "commands", "ship.md")), false);
  await sync.close();
});

test("S5: a large box file is applied only with the exact bytes its card was made of", async () => {
  const f = await fixture();
  // A box that lies about a file it changed after the card: its hash tool keeps answering the old hash.
  const firstHash = new Map<string, string | null>();
  const lyingHasher: BoxHasher = async (connection, items, hashSignal) => {
    const hashes = await execBoxHasher(connection, items, hashSignal);
    return items.map((item, index) => {
      if (!item.path.includes("lies")) return hashes[index]!;
      if (!firstHash.has(item.path)) firstHash.set(item.path, hashes[index]!);
      return firstHash.get(item.path)!;
    });
  };
  const sync = new BoxConfigSyncService({
    appdir: f.appdir,
    hub: f.hub,
    watchHost: false,
    idleFlushMs: 10,
    hasher: lyingHasher,
    publish: (payload) => f.published.push(payload)
  });
  await sync.ensureSynced("b1", f.scope, signal());
  const boxHome = f.box1.local(f.home);
  const big = Buffer.alloc(1536 * 1024, "a");

  // Honest: approved and written as it is.
  await put(join(boxHome, "skills", "assets", "honest.bin"), big.toString("latin1"));
  await sync.turnEnded("b1", "t1");
  const honest = pendingSet(f.published);
  assert.match(honest.files[0]!.diff, /too large/);
  await sync.decide(honest.id, "approve");
  assert.ok((await readFile(join(f.system, "skills", "assets", "honest.bin"))).equals(big));

  // Swapped after the card: never written.
  await put(join(boxHome, "skills", "assets", "lies.bin"), big.toString("latin1"));
  await sync.turnEnded("b1", "t2");
  const card = pendingSet(f.published);
  await put(join(boxHome, "skills", "assets", "lies.bin"), Buffer.alloc(big.length, "e").toString("latin1"));
  await sync.decide(card.id, "approve");
  assert.equal(await exists(join(f.system, "skills", "assets", "lies.bin")), false, "other bytes than the approved ones never reach the host");
  assert.deepEqual((await readdir(join(f.system, "skills", "assets"))).sort(), ["honest.bin"], "and no temp file is left");
  await sync.close();
});

test("S6: a nested permission or env change in settings.json is executable on the card", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const boxSettings = join(f.box1.local(f.home), "settings.json");
  const settings = JSON.parse(await readFile(boxSettings, "utf8"));
  settings.permissions = { defaultMode: "bypassPermissions" };
  await put(boxSettings, JSON.stringify(settings, null, 2));
  await sync.turnEnded("b1", "t1");
  assert.equal(pendingSet(f.published).files[0]!.executable, true);
  await sync.close();
});

test("ensureSynced refuses a box that is not connected", async () => {
  const f = await fixture();
  const sync = f.make();
  f.box1.setConnected(false);
  await assert.rejects(sync.ensureSynced("b1", f.scope, signal()), (error: unknown) => error instanceof BoxSyncError && error.code === "BOX_NOT_READY");
  await sync.close();
});
