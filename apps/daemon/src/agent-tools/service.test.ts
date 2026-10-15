import { strict as assert } from "node:assert";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { AgentToolsChangedPayload } from "@orquester/api";

import { AgentToolsError, AgentToolsService } from "./service.ts";

const NOW = Date.parse("2026-10-15T10:00:00.000Z");

async function harness(t: TestContext, contents?: string, opts: { projectExists?: (path: string) => boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-agent-tools-"));
  const file = join(dir, "agent-tools.json");
  if (contents !== undefined) await writeFile(file, contents);
  let now = NOW;
  let n = 0;
  const published: AgentToolsChangedPayload[] = [];
  const warnings: unknown[][] = [];
  const service = new AgentToolsService({
    file,
    publish: (payload) => published.push(payload),
    now: () => now,
    newId: () => `g${++n}`,
    logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    ...(opts.projectExists ? { projectExists: opts.projectExists } : {})
  });
  t.after(async () => {
    await service.flush();
    await chmod(file, 0o600).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });
  await service.load();
  return {
    dir,
    file,
    service,
    published,
    warnings,
    advance: (ms: number) => {
      now += ms;
    },
    async disk(): Promise<Record<string, unknown>> {
      await service.flush();
      return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    }
  };
}

const fullAccess = { callerRuntimeMode: "full-access", workflowOwned: false, threadId: "t1", projectPath: "/w/ws/p", projects: ["/w/ws/p"] };

test("a missing file is the defaults (nothing written); settings view lists every toolset with core locked on", async (t) => {
  const h = await harness(t);
  const view = h.service.settingsView();
  assert.equal(view.revision, 0);
  assert.equal(view.enabled, true);
  assert.deepEqual(view.toolsets.map((ts) => ts.id), ["core", "reads", "notes", "chat-extras", "files-git", "workflow-authoring", "agent-profile-editing", "desktops"]);
  assert.equal(view.toolsets[0]!.locked, true);
  assert.deepEqual(view.grants, []);
  assert.deepEqual(await readdir(h.dir), []);
  assert.deepEqual(h.service.resolvedToolsets("t1", "claude"), ["core", "reads"]);
});

test("settings: revision guards the write (409 on a stale one); cells merge and null clears; locked/unknown refused", async (t) => {
  const h = await harness(t);
  const next = h.service.updateSettings({ revision: 0, defaults: { notes: { claude: true, codex: true } } });
  assert.equal(next.revision, 1);
  assert.equal(next.toolsets.find((ts) => ts.id === "notes")!.defaults.claude, true);
  assert.deepEqual(h.published.at(-1), { revision: 1 });
  assert.throws(() => h.service.updateSettings({ revision: 0, enabled: false }), (e: AgentToolsError) => e.status === 409 && e.code === "REVISION_MISMATCH");
  assert.throws(() => h.service.updateSettings({ revision: 1, defaults: { core: { claude: false } } }), (e: AgentToolsError) => e.code === "TOOLSET_LOCKED");
  assert.throws(() => h.service.updateSettings({ revision: 1, defaults: { nope: { claude: false } } }), (e: AgentToolsError) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => h.service.updateSettings({ revision: 1, defaults: { notes: { robot: true } } }), (e: AgentToolsError) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => h.service.updateSettings({ revision: 1, defaults: { notes: { claude: "yes" } } }), (e: AgentToolsError) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => h.service.updateSettings({ revision: 1, extra: 1 }), (e: AgentToolsError) => e.code === "INVALID_ARGUMENT");
  const cleared = h.service.updateSettings({ revision: 1, enabled: false, defaults: { notes: { codex: null } } });
  assert.equal(cleared.enabled, false);
  assert.deepEqual(h.service.resolvedToolsets("t1", "claude"), ["core"], "master switch off: only core");
  const disk = await h.disk();
  assert.deepEqual((disk.toolsets as { defaults: unknown }).defaults, { notes: { claude: true } });
  assert.equal(disk.revision, 2);
});

test("store tolerance: unknown keys, toolsets, agents and grant families survive a rewrite; unreadable grants are kept but never honoured", async (t) => {
  const raw = {
    version: 1,
    revision: 7,
    enabled: true,
    futureTopLevel: { keep: true },
    toolsets: {
      defaults: { notes: { claude: true, robot: true }, "future-toolset": { claude: true } },
      threads: { t1: { "workflow-authoring": true, "future-toolset": false } },
      futureMatrix: 1
    },
    toolsetDeclines: {},
    grants: [
      { id: "g-old", family: "desktops", scope: "project", projectPath: "/w/ws/p", createdAt: "2026-10-01T00:00:00.000Z", futureField: "x" },
      { id: "g-new", family: "future-family", scope: "chat", projectPath: "/w/ws/p", threadId: "t1", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: 42, junk: true }
    ]
  };
  const h = await harness(t, JSON.stringify(raw));
  h.service.updateThreadToolsets("t1", { toolsets: { notes: true } }, { agent: "claude", projectPath: "/w/ws/p", workflowOwned: false });
  const disk = await h.disk();
  assert.deepEqual(disk.futureTopLevel, { keep: true });
  assert.deepEqual((disk.toolsets as Record<string, unknown>).futureMatrix, 1);
  assert.deepEqual((disk.toolsets as { defaults: unknown }).defaults, raw.toolsets.defaults);
  assert.deepEqual((disk.toolsets as { threads: unknown }).threads, { t1: { "workflow-authoring": true, "future-toolset": false, notes: true } });
  assert.deepEqual(disk.grants, raw.grants);
  assert.equal(h.service.findGrant({ ...fullAccess, family: "future-family" }), null);
  assert.equal(h.service.findGrant({ ...fullAccess, family: "desktops" })?.id, "g-old");
});

test("a corrupt file is moved aside: defaults apply and no grant is honoured (fail closed)", async (t) => {
  const h = await harness(t, '{"version": 1, "grants": [{"id":"g1","family":"desktops","scope":"project","projectPath":"/w/ws/p","createdAt":"x"}], "toolsets": [] }');
  const files = await readdir(h.dir);
  assert.ok(files.some((f) => f.startsWith("agent-tools.json.corrupt-")), files.join());
  assert.equal(h.service.findGrant({ ...fullAccess, family: "desktops" }), null);
  assert.ok(h.warnings.length > 0);
  // The store works from the defaults on.
  h.service.updateSettings({ revision: 0, enabled: true });
  assert.equal((await h.disk()).revision, 1);
  // Bad JSON and another version too.
  const bad = await harness(t, "{nope");
  assert.ok((await readdir(bad.dir)).some((f) => f.includes(".corrupt-")));
  const v2 = await harness(t, '{"version": 2}');
  assert.ok((await readdir(v2.dir)).some((f) => f.includes(".corrupt-")));
});

test("an unreadable file makes the store read-only: no grants, every mutation 503, nothing written over it", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const h0 = await harness(t, JSON.stringify({ version: 1, grants: [{ id: "g1", family: "desktops", scope: "project", projectPath: "/w/ws/p", createdAt: "x" }] }));
  await chmod(h0.file, 0o000);
  const service = new AgentToolsService({ file: h0.file, logger: { error: () => undefined } });
  await service.load();
  assert.equal(service.isReadOnly(), true);
  assert.equal(service.findGrant({ ...fullAccess, family: "desktops" }), null);
  assert.throws(() => service.updateSettings({ revision: 0, enabled: false }), (e: AgentToolsError) => e.status === 503);
  await chmod(h0.file, 0o600);
  assert.equal(JSON.parse(await readFile(h0.file, "utf8")).grants.length, 1, "untouched");
});

test("chat toolsets: overrides set and cleared, locked/unknown refused, toolsetsChanged fired, view resolves and reports declines", async (t) => {
  const h = await harness(t);
  const info = { agent: "codex" as const, projectPath: "/w/ws/p", workflowOwned: false };
  const changed: (string | null)[] = [];
  h.service.onToolsetsChanged((id) => changed.push(id));
  let view = h.service.updateThreadToolsets("t1", { toolsets: { "workflow-authoring": true, reads: false } }, info);
  assert.deepEqual(view.overrides, { "workflow-authoring": true, reads: false });
  assert.deepEqual(view.resolved, ["core", "workflow-authoring"]);
  assert.deepEqual(changed, [], "listeners run asynchronously, never inside the write");
  await Promise.resolve();
  assert.deepEqual(changed, ["t1"]);
  assert.deepEqual(h.published.at(-1), { revision: 0, threadId: "t1" });
  assert.throws(() => h.service.updateThreadToolsets("t1", { toolsets: { core: false } }, info), (e: AgentToolsError) => e.code === "TOOLSET_LOCKED");
  assert.throws(() => h.service.updateThreadToolsets("t1", { toolsets: { bogus: true } }, info), (e: AgentToolsError) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => h.service.updateThreadToolsets("t1", { toolsets: { notes: 1 } }, info), (e: AgentToolsError) => e.code === "INVALID_ARGUMENT");
  view = h.service.updateThreadToolsets("t1", { toolsets: { reads: null } }, info);
  assert.deepEqual(view.overrides, { "workflow-authoring": true });
  assert.equal(view.appliesAtNextIdle, false, "nothing reported as advertised");
  h.service.setAdvertisedToolsets(() => ["core", "reads"]);
  assert.equal(h.service.threadView("t1", info).appliesAtNextIdle, true);
  // Declines: 30 minutes.
  const until = h.service.recordToolsetDecline("t1", "desktops");
  assert.equal(until, new Date(NOW + 30 * 60 * 1000).toISOString());
  assert.deepEqual(h.service.threadView("t1", info).declines, { desktops: until });
  h.advance(30 * 60 * 1000);
  assert.equal(h.service.toolsetDeclinedUntil("t1", "desktops"), null);
  // A settings change reaches every chat.
  h.service.updateSettings({ revision: 0, defaults: { notes: { codex: true } } });
  await Promise.resolve();
  assert.deepEqual(changed, ["t1", "t1", null]);
});

test("grants: full-access only; lastUsedAt stamped; revocation effective for the next call; workflows ids appended", async (t) => {
  const h = await harness(t);
  const desk = h.service.addGrant({ family: "desktops", scope: "chat", projectPath: "/w/ws/p", threadId: "t1" });
  assert.equal(h.service.addGrant({ family: "desktops", scope: "chat", projectPath: "/w/ws/p", threadId: "t1" }), desk, "no duplicate");
  assert.equal(h.service.findGrant({ ...fullAccess, family: "desktops", callerRuntimeMode: "auto" }), null, "below full access: never");
  assert.equal(h.service.findGrant({ ...fullAccess, family: "desktops", workflowOwned: true }), null, "workflow-owned: never");
  assert.equal(h.service.findGrant({ ...fullAccess, family: "desktops", threadId: "t2" }), null, "another chat: never");
  h.advance(1000);
  assert.equal(h.service.findGrant({ ...fullAccess, family: "desktops" })?.lastUsedAt, new Date(NOW + 1000).toISOString());
  assert.equal(((await h.disk()).grants as { lastUsedAt?: string }[])[0]!.lastUsedAt, new Date(NOW + 1000).toISOString());
  h.service.revokeGrant(desk);
  assert.equal(h.service.findGrant({ ...fullAccess, family: "desktops" }), null, "revoked: the next call cards again");
  assert.throws(() => h.service.revokeGrant(desk), (e: AgentToolsError) => e.status === 404 && e.code === "GRANT_NOT_FOUND");

  const wf = h.service.addGrant({ family: "workflows", scope: "chat", projectPath: "/w/ws/p", threadId: "t1", workflowId: "wf1" });
  assert.equal(h.service.findGrant({ ...fullAccess, family: "workflows", workflowId: "wf1" })?.id, wf);
  assert.equal(h.service.findGrant({ ...fullAccess, family: "workflows", workflowId: "wf2" }), null, "not approved in this chat");
  assert.equal(h.service.findGrant({ ...fullAccess, family: "workflows" }), null, "a create is never covered");
  assert.equal(h.service.recordWorkflowInGrant({ threadId: "t1", callerProjectPath: "/w/ws/p", workflowId: "wf2", grantId: wf }), wf);
  assert.equal(h.service.findGrant({ ...fullAccess, family: "workflows", workflowId: "wf2" })?.id, wf);
  assert.equal(h.service.recordWorkflowInGrant({ threadId: "t9", callerProjectPath: "/w/ws/p", workflowId: "wf3", grantId: wf }), null, "another chat's");
  assert.equal(h.service.recordWorkflowInGrant({ threadId: "t1", callerProjectPath: "/w/ws/p", workflowId: "wf3", grantId: "g-unknown" }), null, "no fallback");
  assert.equal(h.service.findGrant({ ...fullAccess, family: "workflows", workflowId: "wf1", projects: ["/w/ws/p", "/w/ws/other"] }), null, "a project union beyond the caller's");

  const target = h.service.addGrant({ family: "cross-project", scope: "chat", projectPath: "/w/ws/p", threadId: "t1", targetProjectPath: "/w/other/q" });
  assert.equal(h.service.findGrant({ ...fullAccess, family: "cross-project", targetProjectPath: "/w/other/q" })?.id, target);
  assert.equal(h.service.findGrant({ ...fullAccess, family: "cross-project", targetProjectPath: "/w/other/r" }), null);
  h.service.addGrant({ family: "desktops", scope: "project", projectPath: "/w/ws/p", threadId: "t1" });
  assert.equal(h.service.revokeGrants("t1"), 2, "one chat's grants (its chat grants only)");
  assert.equal(h.service.settingsView().grants.length, 1);
  assert.equal(h.service.revokeGrants(), 1, "Revoke all");
});

test("a closed chat's overrides, declines and chat grants are deleted; project grants stay", async (t) => {
  let exists = true;
  const h = await harness(t, undefined, { projectExists: () => exists });
  h.service.updateThreadToolsets("t1", { toolsets: { notes: true } }, { agent: "claude", projectPath: "/w/ws/p", workflowOwned: false });
  h.service.recordToolsetDecline("t1", "desktops");
  h.service.addGrant({ family: "desktops", scope: "chat", projectPath: "/w/ws/p", threadId: "t1" });
  const project = h.service.addGrant({ family: "desktops", scope: "project", projectPath: "/w/ws/p", threadId: "t1" });
  h.service.removeThread("t1");
  const disk = await h.disk();
  assert.deepEqual((disk.toolsets as { threads: unknown }).threads, {});
  assert.deepEqual(disk.toolsetDeclines, {});
  assert.deepEqual((disk.grants as { id: string }[]).map((g) => g.id), [project]);
});

test("a missing project's grants are pruned only after repeated misses over time, never by a read", async (t) => {
  let exists = false;
  const h = await harness(t, undefined, { projectExists: () => exists });
  const grant = h.service.addGrant({ family: "desktops", scope: "project", projectPath: "/w/ws/p", threadId: "t1" });
  const query = { ...fullAccess, family: "desktops" };
  const before = JSON.stringify(await h.disk());
  for (let i = 0; i < 5; i += 1) assert.equal(h.service.settingsView().grants.length, 1, "GET never prunes");
  assert.equal(JSON.stringify(await h.disk()), before, "GET never writes");
  // Misses within the hour: kept, however many.
  for (let i = 0; i < 5; i += 1) h.service.findGrant(query);
  assert.equal(h.service.settingsView().grants.length, 1);
  // The project comes back: the count resets.
  exists = true;
  assert.equal(h.service.findGrant(query)?.id, grant);
  exists = false;
  h.advance(2 * 60 * 60 * 1000);
  h.service.findGrant(query);
  h.service.findGrant(query);
  assert.equal(h.service.settingsView().grants.length, 1, "two misses since the reset");
  h.advance(60 * 60 * 1000);
  h.service.findGrant(query);
  assert.equal(h.service.settingsView().grants.length, 0, "three misses over an hour: pruned");
  assert.deepEqual((await h.disk()).grants, []);
});

test("writes are serialized: the last write carries the last state", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 20; i += 1) h.service.updateSettings({ revision: i, enabled: i % 2 === 0 });
  const disk = await h.disk();
  assert.equal(disk.revision, 20);
  assert.equal(disk.enabled, false);
});
