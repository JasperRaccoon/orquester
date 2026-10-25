import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { BoxConfigChangesResponse, BoxConfigChangeSet, BoxPathMap } from "@orquester/api";
import { secretFilesDir, sessionProfilePreparedRootDir } from "@orquester/config";

import { agentHookScript } from "../../agent-hooks.ts";
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
    else if (!entry.isSymbolicLink()) out.push(path); // a mirrored link: its target is listed where it is
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

test("initial sync mirrors dir links, materializes file links, blanks secrets and never sends credentials or transcripts", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());

  const boxHome = f.box1.local(f.home);
  assert.equal((await lstat(join(boxHome, "skills"))).isSymbolicLink(), true, "a linked dir is the same link in the box");
  assert.equal(await realpath(join(boxHome, "skills")), f.box1.local(join(f.system, "skills")), "to the box's copy of the shared dir");
  assert.equal((await lstat(f.box1.local(join(f.system, "skills")))).isDirectory(), true);
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

test("the managed hook script the synced configs run is in the box at its host path, written once per connection", async () => {
  const f = await fixture();
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const script = f.box1.local(join(f.appdir, "daemon", "hooks", "agent-hook.sh"));
  assert.equal(await readFile(script, "utf8"), agentHookScript());
  assert.notEqual((await stat(script)).mode & 0o111, 0, "executable");
  // Without the daemon's socket it exits 0: no failed hook in the chat.
  const code = await new Promise<number>((resolve) => {
    const child = execFile(script, ["codex", "PreToolUse"], { env: { PATH: "/usr/bin:/bin" } }, (error) => resolve(error ? Number(error.code ?? 1) : 0));
    // It may exit before reading the payload (no session id): a closed stdin is no failure.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end('{"tool_name":"Bash"}');
  });
  assert.equal(code, 0);
  await rm(script);
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(await exists(script), false, "not written again on the same connection");
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
    f.box1.writes.slice(writes).sort(),
    [join(f.home, "CLAUDE.md"), join(f.system, "commands", "new.md")].sort()
  );
  await sync.close();
});

test("host watchers push a host edit to a watching box on their own", async () => {
  const f = await fixture();
  const sync = new BoxConfigSyncService({ appdir: f.appdir, hub: f.hub, hostDebounceMs: 20 });
  await sync.ensureSynced("b1", f.scope, signal());
  sync.watch("b1", f.scope);
  await sync.idle();
  const target = join(f.system, "commands", "watched.md");
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
  await sync.idle();
  const target = join(f.system, "skills", "later", "SKILL.md");
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
  await sync.close();
});

test("a host dir that appears gets a second look: files written into it after the pass that saw it empty still reach the box", async () => {
  const f = await fixture();
  // No host watchers: nothing but the second look can notice the file.
  const sync = f.make({ hostDebounceMs: 20 });
  await sync.ensureSynced("b1", f.scope, signal());
  sync.watch("b1", f.scope);
  await sync.idle();
  const target = join(f.system, "skills", "fresh", "SKILL.md");
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
  const byPath = new Map(set.files.map((file) => [file.path.slice((file.path.startsWith(`${f.home}/`) ? f.home : f.system).length + 1), file]));
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
  await put(join(boxHome, "skills", "box-new", "SKILL.md"), "---\nname: box-new\n---\nNew.\n");
  await sync.turnEnded("b1", "t1");
  const set = pendingSet(f.published);
  const settingsFile = set.files.find((file) => file.path.endsWith("settings.json"))!;
  assert.equal(settingsFile.executable, true, "a hook change is executable");
  assert.ok(!settingsFile.diff.includes("ghp_settingssecret"), "diffs show blanked secrets only");

  const decided = await sync.decide(set.id, "deny");
  assert.equal(decided.state, "denied");
  assert.equal(await readFile(join(boxHome, "settings.json"), "utf8"), boxSettings);
  assert.equal(await exists(join(boxHome, "commands", "extra.md")), false);
  assert.equal(await exists(join(boxHome, "skills", "box-new")), false, "a denied new skill leaves no empty dir");
  assert.equal(await exists(join(boxHome, "skills", "review")), true, "dirs the host has stay");
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
    (call) => call.method === "fs.watch" && (call.params as { path: string }).path === join(f.system, "commands")
  );
  assert.ok(watchCall, "the commands dir is watched in the box");
  const { watchId } = watchCall.params as { watchId: string };
  const published = f.nextPublish();
  await put(join(f.box1.local(f.home), "commands", "typed.md"), "Typed in a terminal.\n");
  f.box1.emitEvent("fs.change", { watchId, changes: [{ path: join(f.system, "commands", "typed.md"), type: "create" }] });
  const payload = await published;
  const set = payload.changes.find((change) => change.state === "pending")!;
  assert.equal(set.threadId, null);
  assert.deepEqual(
    set.files.map((file) => file.path),
    [join(f.system, "commands", "typed.md")]
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
    (call) => call.method === "fs.watch" && (call.params as { path: string }).path === join(f.system, "commands")
  );
  assert.ok(watchCall, "the commands dir is watched in the box");
  const { watchId } = watchCall.params as { watchId: string };
  // The agent host marked a turn, then went away without ending it.
  sync.turnStarted("b1", "t-lost");
  nowMs += 60_001;
  const published = f.nextPublish();
  await put(join(f.box1.local(f.home), "commands", "later.md"), "Made after the lost turn.\n");
  f.box1.emitEvent("fs.change", { watchId, changes: [{ path: join(f.system, "commands", "later.md"), type: "create" }] });
  const set = (await published).changes.find((change) => change.state === "pending")!;
  assert.equal(set.threadId, null, "grouped by the idle debounce again");
  assert.deepEqual(
    set.files.map((file) => file.path),
    [join(f.system, "commands", "later.md")]
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

// ---------------------------------------------------------------------------
// Bulk pushes, mirrored links, the plugin cache, progress
// ---------------------------------------------------------------------------

/** `count` files under `<home>/agents` (a real dir of the account), and one executable script. */
async function manyAgents(home: string, count: number): Promise<string[]> {
  const paths: string[] = [];
  for (let index = 0; index < count; index++) {
    const path = join(home, "agents", `group-${index % 7}`, `agent-${index}.md`);
    await put(path, `# Agent ${index}\n${"x".repeat(index * 13)}\n`);
    paths.push(path);
  }
  const script = join(home, "agents", "bin", "run.sh");
  await put(script, "#!/bin/sh\necho run\n", 0o755);
  paths.push(script);
  return paths;
}

/** A hasher that records what it is asked to hash (a pass that trusts its baseline asks for nothing). */
function countingHasher(): { hasher: BoxHasher; hashed: string[] } {
  const hashed: string[] = [];
  return {
    hashed,
    hasher: async (connection, items, hashSignal) => {
      hashed.push(...items.map((item) => item.path));
      return execBoxHasher(connection, items, hashSignal);
    }
  };
}

test("a big first sync goes as one gzipped tar per root: modes kept, baseline right, a second pass sends and hashes nothing", async () => {
  const f = await fixture();
  const paths = await manyAgents(f.home, 60);
  const { hasher, hashed } = countingHasher();
  const progress: { root: string; done: number; total: number }[] = [];
  const sync = f.make({ bulkMinFiles: 16, hasher });
  await sync.ensureSynced("b1", f.scope, signal(), { onProgress: (step) => void progress.push(step) });

  const homeTars = f.box1.tars.filter((entry) => entry.path === f.home);
  assert.equal(homeTars.length, 1, "the account root's files went as one stream");
  assert.equal(homeTars[0]!.compression, "gzip");
  for (const path of paths) {
    assert.equal(await readFile(f.box1.local(path), "utf8"), await readFile(path, "utf8"));
    assert.ok(!f.box1.writes.includes(path), "not also sent one by one");
  }
  assert.equal((await stat(f.box1.local(join(f.home, "agents", "bin", "run.sh")))).mode & 0o111, 0o111, "exec bits survive");
  assert.deepEqual(progress[0], { root: f.home, done: 0, total: 0 }, "comparing first");
  assert.ok(
    progress.some((step) => step.total >= paths.length && step.done === step.total),
    "progress reached the end of the bulk push"
  );

  const writes = f.box1.writes.length;
  const tars = f.box1.tars.length;
  hashed.length = 0;
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(f.box1.writes.length, writes, "nothing sent file by file");
  assert.equal(f.box1.tars.length, tars, "nothing sent in bulk");
  assert.deepEqual(hashed, [], "every box file matched its baseline's size and mtime");

  // A box edit after the bulk push is still a box change.
  await put(f.box1.local(paths[3]!), "edited in the box\n");
  await sync.turnEnded("b1", "t1");
  assert.deepEqual(
    pendingSet(f.published).files.map((file) => file.path),
    [paths[3]]
  );
  await sync.close();
});

test("a box that cannot inflate gets a plain tar; one whose tar-write fails gets the files one by one", async () => {
  const f = await fixture();
  const paths = await manyAgents(f.home, 30);
  const warnings: string[] = [];
  const original = f.box1.writeTar.bind(f.box1);
  const seen: (string | null)[] = [];
  f.box1.writeTar = async (path, tar, options) => {
    seen.push(options?.compression ?? null);
    if (options?.compression === "gzip") {
      tar.resume();
      throw new Error("TAR_FAILED: tar: Archive is compressed. Use -z option");
    }
    return original(path, tar, options);
  };
  const sync = f.make({ bulkMinFiles: 16, logger: { warn: (message) => void warnings.push(message) } });
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(seen[0], "gzip");
  assert.ok(seen.length >= 2 && seen.slice(1).every((compression) => compression === null), "plain from then on");
  for (const path of paths) assert.equal(await readFile(f.box1.local(path), "utf8"), await readFile(path, "utf8"));
  assert.ok(warnings.some((message) => message.includes("sending it plain")));

  // Another box whose tar-write fails outright: file by file, and the baseline still holds.
  f.box2.writeTar = async (_path, tar) => {
    tar.resume();
    throw new Error("UNKNOWN channel kind");
  };
  await sync.ensureSynced("b2", f.scope, signal());
  for (const path of paths) {
    assert.equal(await readFile(f.box2.local(path), "utf8"), await readFile(path, "utf8"));
    assert.ok(f.box2.writes.includes(path));
  }
  assert.equal((await stat(f.box2.local(join(f.home, "agents", "bin", "run.sh")))).mode & 0o111, 0o111);
  assert.ok(warnings.some((message) => message.includes("one by one")));
  const writes = f.box2.writes.length;
  await sync.ensureSynced("b2", f.scope, signal());
  assert.equal(f.box2.writes.length, writes, "a second pass sends nothing");
  await sync.close();
});

/** Another Claude account home linking the fixture's shared dirs. */
async function secondHome(f: Awaited<ReturnType<typeof fixture>>, id = "a2"): Promise<{ home: string; scope: BoxSyncScope }> {
  const home = join(f.appdir, "daemon", "agent-accounts", "claude", id, "home");
  await mkdir(home, { recursive: true });
  await symlink(join(f.system, "skills"), join(home, "skills"));
  await symlink(join(f.system, "commands"), join(home, "commands"));
  await put(join(home, "CLAUDE.md"), `# ${id}\n`);
  return { home, scope: { agent: "claude", configRoots: [home], threadId: "t1" } };
}

test("a dir every account home links to is sent once per box, and a box change under it is one change, approved once", async () => {
  const f = await fixture();
  const a2 = await secondHome(f);
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  await sync.ensureSynced("b1", a2.scope, signal());
  await sync.ensureSynced("b2", f.scope, signal());
  sync.watch("b1", f.scope);
  sync.watch("b1", a2.scope);
  sync.watch("b2", f.scope);
  await sync.idle();

  const shared = join(f.system, "skills", "review", "SKILL.md");
  assert.equal(f.box1.writes.filter((path) => path === shared).length, 1, "the shared skill went to box 1 once");
  assert.ok(!f.box1.writes.some((path) => path.startsWith(`${f.home}/skills/`) || path.startsWith(`${a2.home}/skills/`)), "never per account");
  for (const home of [f.home, a2.home]) {
    assert.equal(await realpath(f.box1.local(join(home, "skills"))), f.box1.local(join(f.system, "skills")));
    assert.equal(await readFile(f.box1.local(join(home, "skills", "review", "SKILL.md")), "utf8"), "---\nname: review\n---\nReview carefully.\n");
  }

  // Account 2's CLI adds a skill (through its link): one file, at the shared path.
  sync.turnStarted("b1", "t1");
  await put(f.box1.local(join(a2.home, "skills", "made", "SKILL.md")), "---\nname: made\n---\nIn the box.\n");
  await sync.turnEnded("b1", "t1");
  const set = pendingSet(f.published);
  assert.deepEqual(
    set.files.map((file) => file.path),
    [join(f.system, "skills", "made", "SKILL.md")]
  );
  await sync.decide(set.id, "approve");
  assert.equal(await readFile(join(f.system, "skills", "made", "SKILL.md"), "utf8"), "---\nname: made\n---\nIn the box.\n");
  await sync.idle();
  assert.equal(await readFile(f.box2.local(join(f.home, "skills", "made", "SKILL.md")), "utf8"), "---\nname: made\n---\nIn the box.\n", "and box 2 got it");
  await sync.turnEnded("b1", "t2");
  assert.equal((await sync.listChanges()).filter((change) => change.state === "pending").length, 0, "nothing left over");
  await sync.close();
});

test("a link into a denied place is never mirrored nor synced; a link that stops being one becomes a real dir in the box", async () => {
  const f = await fixture();
  const denied = join(secretFilesDir(f.appdir), "skills");
  await put(join(denied, "x", "SKILL.md"), "DENIED-CONTENT");
  const a3 = await secondHome(f, "a3");
  await rm(join(a3.home, "skills"));
  await symlink(denied, join(a3.home, "skills"));
  const sync = f.make();
  await sync.ensureSynced("b1", a3.scope, signal());
  assert.equal(await exists(f.box1.local(join(a3.home, "skills"))), false, "no link, no copy");
  assert.equal(await exists(f.box1.local(denied)), false);
  assert.ok(!f.box1.calls.some((call) => JSON.stringify(call.params).includes(secretFilesDir(f.appdir))), "the denied dir is never named to the box");

  // The fixture's account: `commands` stops being a link (the host made it a real dir).
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal((await lstat(f.box1.local(join(f.home, "commands")))).isSymbolicLink(), true);
  await rm(join(f.home, "commands"));
  await put(join(f.home, "commands", "own.md"), "Own.\n");
  await sync.ensureSynced("b1", f.scope, signal());
  const boxCommands = f.box1.local(join(f.home, "commands"));
  assert.equal((await lstat(boxCommands)).isDirectory(), true, "a real dir in the box now");
  assert.deepEqual(await readdir(boxCommands), ["own.md"]);
  assert.equal(await readFile(f.box1.local(join(f.system, "commands", "ship.md")), "utf8"), "Ship it.\n", "the shared copy was not written through");
  await sync.turnEnded("b1", "t1");
  assert.equal(f.published.length, 0, "no change set");
  await sync.close();
});

test("a box synced while links were materialized: its per-account copy becomes the shared copy, with its baseline", async () => {
  const f = await fixture();
  // A box that could not make links (and so an older daemon's box): shared dirs copied per account.
  const request = f.box1.request.bind(f.box1);
  f.box1.request = (async (method: string, params: unknown, options: unknown) => {
    if (method === "fs.symlink") throw new Error("EPERM: operation not permitted");
    return request(method as never, params as never, options as never);
  }) as typeof f.box1.request;
  const old = f.make();
  await old.ensureSynced("b1", f.scope, signal());
  assert.equal((await lstat(f.box1.local(join(f.home, "skills")))).isDirectory(), true, "materialized");
  await old.close();
  f.box1.request = request;

  const sync = f.make();
  const writes = f.box1.writes.length;
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal((await lstat(f.box1.local(join(f.home, "skills")))).isSymbolicLink(), true);
  assert.equal(await readFile(f.box1.local(join(f.system, "skills", "review", "SKILL.md")), "utf8"), "---\nname: review\n---\nReview carefully.\n");
  // A new service writes the managed hook script once again; the synced files are not sent.
  const hookScript = join(f.appdir, "daemon", "hooks", "agent-hook.sh");
  assert.deepEqual(
    f.box1.writes.slice(writes).filter((path) => path !== hookScript),
    [],
    "the copy moved: nothing sent again"
  );
  await sync.turnEnded("b1", "t1");
  assert.equal(f.published.length, 0, "the moved copy matches its baseline: no change set");
  await sync.close();
});

/** The fixture's `plugins` with two versions of a plugin, a temp clone, in-use markers and a marketplace. */
async function pluginLayout(f: Awaited<ReturnType<typeof fixture>>) {
  const plugins = join(f.home, "plugins");
  const cache = join(plugins, "cache");
  await put(join(cache, "m", "p", "1.0", "skills", "a", "SKILL.md"), "p 1.0\n");
  await put(join(cache, "m", "p", "1.0", ".in_use", "3010287"), "");
  await put(join(cache, "m", "p", "0.9", "skills", "a", "SKILL.md"), "p 0.9 (old)\n");
  await put(join(cache, "temp_git_1791328646189_oneqrz", "README.md"), "temp\n");
  await put(join(plugins, "marketplaces", "m", ".claude-plugin", "marketplace.json"), '{"name":"m"}');
  await put(join(plugins, "marketplaces", "m", ".github", "workflows", "ci.yml"), "on: push\n");
  await put(join(plugins, "known_marketplaces.json"), '{"m":{"source":{"source":"github","repo":"o/m"},"lastUpdated":"2026-10-01"}}');
  const installed = (entries: Record<string, string>): string =>
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        Object.entries(entries).map(([id, version]) => {
          const [name, market] = id.split("@");
          return [id, [{ scope: "user", installPath: join(cache, market!, name!, version), version }]];
        })
      )
    });
  await put(join(plugins, "installed_plugins.json"), installed({ "p@m": "1.0" }));
  return { plugins, cache, installed };
}

test("only installed plugin versions sync: no old versions, temp clones or in-use markers", async () => {
  const f = await fixture();
  const { cache } = await pluginLayout(f);
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(await readFile(f.box1.local(join(cache, "m", "p", "1.0", "skills", "a", "SKILL.md")), "utf8"), "p 1.0\n");
  for (const absent of [join(cache, "m", "p", "0.9"), join(cache, "temp_git_1791328646189_oneqrz"), join(cache, "m", "p", "1.0", ".in_use")]) {
    assert.equal(await exists(f.box1.local(absent)), false, absent);
  }
  await sync.close();
});

test("the box CLI's housekeeping (in-use markers, marketplace refresh, old-version GC) makes no change set; a real install does", async () => {
  const f = await fixture();
  const { plugins, cache, installed } = await pluginLayout(f);
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  const box = (path: string): string => f.box1.local(path);

  // What a box CLI start did (set d71dfec9): its own in-use marker, the official marketplace
  // refreshed from a snapshot (.gcs-sha added, .github gone), known_marketplaces.json rewritten,
  // an orphaned version collected.
  sync.turnStarted("b1", "t1");
  await put(box(join(cache, "m", "p", "1.0", ".in_use", "1935")), "");
  await put(box(join(plugins, "marketplaces", "m", ".gcs-sha")), "abc123\n");
  await rm(box(join(plugins, "marketplaces", "m", ".github")), { recursive: true });
  await put(box(join(plugins, "known_marketplaces.json")), '{"m":{"source":{"source":"gcs"},"lastUpdated":"2026-10-23"}}');
  await put(box(join(cache, "m", "p", "0.8", "old.md")), "orphan\n");
  await rm(box(join(cache, "m", "p", "0.8")), { recursive: true });
  await sync.turnEnded("b1", "t1");
  assert.equal(f.published.length, 0, "no change set");

  // Nor fought: the next pass leaves the box CLI's marketplace as it made it.
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(await readFile(box(join(plugins, "marketplaces", "m", ".gcs-sha")), "utf8"), "abc123\n");
  assert.equal(await exists(box(join(plugins, "marketplaces", "m", ".github"))), false);
  assert.match(await readFile(box(join(plugins, "known_marketplaces.json")), "utf8"), /gcs/);
  assert.equal(await exists(box(join(cache, "m", "p", "1.0", ".in_use", "1935"))), true);
  // A host change there is still pushed.
  await put(join(plugins, "marketplaces", "m", ".claude-plugin", "marketplace.json"), '{"name":"m","v":2}');
  await sync.ensureSynced("b1", f.scope, signal());
  assert.equal(await readFile(box(join(plugins, "marketplaces", "m", ".claude-plugin", "marketplace.json")), "utf8"), '{"name":"m","v":2}');

  // A real install in the box: its list entry and its new cache dir, in one set.
  sync.turnStarted("b1", "t2");
  await put(box(join(plugins, "installed_plugins.json")), installed({ "p@m": "1.0", "q@m": "2.0" }));
  await put(box(join(cache, "m", "q", "2.0", ".claude-plugin", "plugin.json")), '{"name":"q"}');
  await put(box(join(cache, "m", "q", "2.0", "hooks", "go.sh")), "#!/bin/sh\n", 0o755);
  await put(box(join(cache, "m", "q", "2.0", ".in_use", "1935")), "");
  await sync.turnEnded("b1", "t2");
  const set = pendingSet(f.published);
  assert.deepEqual(
    set.files.map((file) => file.path.slice(plugins.length + 1)).sort(),
    ["cache/m/q/2.0/.claude-plugin/plugin.json", "cache/m/q/2.0/hooks/go.sh", "installed_plugins.json"]
  );
  await sync.decide(set.id, "approve");
  assert.equal(await readFile(join(cache, "m", "q", "2.0", ".claude-plugin", "plugin.json"), "utf8"), '{"name":"q"}');
  assert.equal(await exists(join(cache, "m", "q", "2.0", ".in_use")), false, "no box marker reaches the host");
  await sync.close();
});

test("a deleted file is never executable on the card", async () => {
  const f = await fixture();
  await put(join(f.home, "hooks", "old.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  const sync = f.make();
  await sync.ensureSynced("b1", f.scope, signal());
  await rm(f.box1.local(join(f.home, "hooks", "old.sh")));
  await put(f.box1.local(join(f.home, "hooks", "new.sh")), "#!/bin/sh\nexit 1\n", 0o755);
  await sync.turnEnded("b1", "t1");
  const files = new Map(pendingSet(f.published).files.map((file) => [file.path.slice(f.home.length + 1), file]));
  assert.equal(files.get("hooks/old.sh")!.change, "deleted");
  assert.equal(files.get("hooks/old.sh")!.executable, false);
  assert.equal(files.get("hooks/new.sh")!.executable, true);
  await sync.close();
});
