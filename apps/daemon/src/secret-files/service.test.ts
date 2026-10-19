import assert from "node:assert/strict";
import test from "node:test";
import { SECRET_FILES_MAX_PER_VAULT, type SecretFilesErrorCode, type SecretVaultDetail } from "@orquester/api";
import { SecretFilesError, cloneFileState } from "./service.ts";
import { REPO, WS, bytes, makeHarness, root, sha, text, type Harness } from "./test-fakes.ts";
import type { VaultFileRecord } from "./vault-store.ts";

// The sync engine over in-memory fakes (test-fakes.ts): every §4 row, the automatic actions, push /
// reset / setup, the plugin switch, the reconcile triggers, the watchers (fired by hand), events,
// and that no secret value or content hash ever leaves the service.

async function refused(promise: Promise<unknown>, code: SecretFilesErrorCode): Promise<SecretFilesError> {
  let caught: unknown;
  await promise.then(
    () => assert.fail(`expected ${code}`),
    (error: unknown) => {
      caught = error;
    }
  );
  assert.ok(caught instanceof SecretFilesError, `expected a SecretFilesError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

function stateOf(detail: SecretVaultDetail, cloneName: string, path: string): string | undefined {
  const clone = detail.clones.find((candidate) => candidate.projectName === cloneName);
  const file = clone?.files.find((candidate) => candidate.path === path);
  return file ? (file.refusal ? `${file.state}:${file.refusal}` : file.state) : undefined;
}

function states(detail: SecretVaultDetail, path: string): Record<string, string | undefined> {
  return Object.fromEntries(detail.clones.map((clone) => [clone.projectName, stateOf(detail, clone.projectName, path)]));
}

/** Fire debounced checks until nothing is pending (bounded: a feedback loop fails the test). */
async function drain(h: Harness): Promise<number> {
  let rounds = 0;
  await h.settle();
  while (h.timers.pending("timeout").length > 0) {
    rounds += 1;
    assert.ok(rounds <= 5, "debounced checks keep re-arming themselves (a feedback loop)");
    h.timers.fireTimeouts();
    await h.settle();
  }
  return rounds;
}

async function setupEnv(h: Harness, source: string, files = [".env"]): Promise<SecretVaultDetail> {
  const detail = await h.service.setup({
    workspace: WS,
    repoKey: REPO,
    files: files.map((path) => ({ path, source: { projectPath: root(source) } })),
    excluded: []
  });
  await drain(h);
  return detail;
}

const lastVault = (h: Harness): SecretVaultDetail => {
  for (let index = h.events.length - 1; index >= 0; index--) {
    const event = h.events[index]!;
    if ("vault" in event) return event.vault;
  }
  throw new Error("no vault event");
};

// ---------------------------------------------------------------------------
// §4 table, row by row
// ---------------------------------------------------------------------------

test("cloneFileState: every row of the §4 table", () => {
  const v1 = { id: "v_00000001", sha256: sha("A=1\n"), updatedAt: "2026-10-19T00:00:00.000Z", updatedBy: { kind: "user" as const } };
  const v2 = { id: "v_00000002", sha256: sha("A=2\n"), updatedAt: "2026-10-19T00:00:01.000Z", updatedBy: { kind: "user" as const } };
  const file: VaultFileRecord = { path: ".env", versions: [v2, v1] };
  const read = (content: string) => ({ kind: "file" as const, content: bytes(content), mode: 0o600, mtimeMs: 1 });

  assert.deepEqual(cloneFileState(file, read("A=2\n"), undefined), { state: "synced" });
  assert.deepEqual(cloneFileState(file, read("A=2\n"), v1.id), { state: "synced" });
  assert.deepEqual(cloneFileState(file, { kind: "missing", parentExists: true }, undefined), { state: "missing" });
  assert.deepEqual(cloneFileState(file, { kind: "missing", parentExists: false }, undefined), { state: "missing-dir" });
  assert.deepEqual(cloneFileState(file, { kind: "missing", parentExists: true }, v1.id), { state: "deleted" });
  assert.deepEqual(cloneFileState(file, read("A=1\n"), v1.id), { state: "outdated" });
  assert.deepEqual(cloneFileState(file, read("A=3\n"), v1.id), { state: "modified" });
  // First setup: no baseline, a copy that isn't the vault's.
  assert.deepEqual(cloneFileState(file, read("A=1\n"), undefined), { state: "modified" });
  // A baseline evicted from the history is unknown.
  assert.deepEqual(cloneFileState(file, read("A=1\n"), "v_evicted0"), { state: "modified" });
  assert.deepEqual(cloneFileState(file, { kind: "refused", refusal: "symlink" }, v1.id), { state: "refused", refusal: "symlink" });
});

test("setup: missing copies land, other copies are flagged, refused / tracked / missing-dir stay untouched", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  const c = h.clone("c");
  const d = h.clone("d");
  const e = h.clone("e");
  const f = h.clone("f");
  const archived = h.clone("g", { isArchived: true });
  const elsewhere = h.clone("a", { workspace: "other" });
  const unrelated = h.clone("u", { repoKey: "github.com/acme/other" });
  h.fs.put(`${a}/.env`, "KEY=one\n");
  h.fs.put(`${a}/api/.env`, "API=one\n");
  h.fs.mkdir(`${b}/api`);
  h.fs.put(`${d}/.env`, "KEY=two\n");
  h.fs.put(`${e}/.env`, "KEY=one\n");
  h.fs.tracked.set(e, new Set([".env"]));
  h.fs.refusals.set(`${f}/.env`, "symlink");

  const detail = await setupEnv(h, "a", [".env", "api/.env"]);

  assert.deepEqual(states(detail, ".env"), { a: "synced", b: "synced", c: "synced", d: "modified", e: "refused:tracked", f: "refused:symlink" });
  assert.deepEqual(states(detail, "api/.env"), { a: "synced", b: "synced", c: "missing-dir", d: "missing-dir", e: "missing-dir", f: "missing-dir" });
  assert.equal(h.fs.read(`${b}/.env`), "KEY=one\n");
  assert.equal(h.fs.read(`${b}/api/.env`), "API=one\n");
  assert.equal(h.fs.mode(`${b}/.env`), 0o600, "a new file is 0600");
  assert.equal(h.fs.read(`${c}/.env`), "KEY=one\n");
  assert.equal(h.fs.read(`${d}/.env`), "KEY=two\n", "a differing copy is never overwritten");
  assert.equal(h.fs.dirs.has(`${c}/api`), false, "no directory is created");
  for (const untouched of [archived, elsewhere, unrelated]) assert.equal(h.fs.read(`${untouched}/.env`), undefined);
  assert.deepEqual(
    detail.clones.map((clone) => clone.projectName),
    ["a", "b", "c", "d", "e", "f"]
  );
  assert.equal(detail.clonesNeedingAttention, 4, "c (missing-dir), d, e and f");
  assert.equal(detail.fileCount, 2);

  // Every written or matching clone has the vault version as its baseline; the flagged ones none.
  const record = h.store.get(WS, REPO)!;
  const current = record.files.find((file) => file.path === ".env")!.versions[0]!.id;
  for (const clone of [a, b, c]) assert.equal(record.clones[clone]?.baselines[".env"], current, clone);
  assert.equal(record.clones[d]?.baselines[".env"], undefined);
  assert.deepEqual(detail.files[0]?.updatedBy, { kind: "user", projectName: "a" });
});

test("deleted: a clone's file removed after it had it is flagged, never restored nor pushed; reset restores it", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  await setupEnv(h, "a");
  h.fs.remove(`${b}/.env`, { notify: true });
  await drain(h);
  assert.equal(stateOf(lastVault(h), "b", ".env"), "deleted");
  assert.equal(h.fs.read(`${b}/.env`), undefined, "a deletion is not undone automatically");
  await refused(h.service.push({ workspace: WS, repoKey: REPO, projectPath: b }), "NOTHING_TO_PUSH");

  await h.service.reconcile();
  assert.equal(h.fs.read(`${b}/.env`), undefined, "nor by a reconcile");

  const reset = await h.service.reset({ workspace: WS, repoKey: REPO, projectPath: b });
  assert.equal(stateOf(reset, "b", ".env"), "synced");
  assert.equal(h.fs.read(`${b}/.env`), "KEY=one\n");
});

// ---------------------------------------------------------------------------
// Push and reset
// ---------------------------------------------------------------------------

test("push: the vault moves on, synced and outdated clones update (keeping their mode), modified ones stay flagged", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  const c = h.clone("c");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  h.fs.put(`${c}/.env`, "KEY=c-own\n");
  await setupEnv(h, "a");
  h.fs.put(`${b}/.env`, "KEY=one\n", { mode: 0o640 });

  h.fs.put(`${a}/.env`, "KEY=one\nNEW=1\n", { notify: true });
  await drain(h);
  assert.equal(stateOf(lastVault(h), "a", ".env"), "modified");

  const pushed = await h.service.push({ workspace: WS, repoKey: REPO, projectPath: a });
  assert.deepEqual(states(pushed, ".env"), { a: "synced", b: "synced", c: "modified" });
  assert.equal(h.fs.read(`${b}/.env`), "KEY=one\nNEW=1\n");
  assert.equal(h.fs.mode(`${b}/.env`), 0o640, "an update keeps the clone file's mode");
  assert.equal(h.fs.read(`${c}/.env`), "KEY=c-own\n");
  const record = h.store.get(WS, REPO)!;
  const file = record.files[0]!;
  assert.equal(file.versions.length, 2);
  assert.equal(file.versions[0]!.sha256, sha("KEY=one\nNEW=1\n"));
  assert.equal(record.clones[a]?.baselines[".env"], file.versions[0]!.id);
  assert.equal(pushed.files[0]!.version, file.versions[0]!.id);
  await drain(h);

  // A second, divergent push from c: compared against the new version, it wins only by being pushed.
  const second = await h.service.push({ workspace: WS, repoKey: REPO, projectPath: c, files: [".env"] });
  assert.deepEqual(states(second, ".env"), { a: "synced", b: "synced", c: "synced" });
  assert.equal(h.fs.read(`${a}/.env`), "KEY=c-own\n");
  assert.equal(h.store.get(WS, REPO)!.files[0]!.versions.length, 3, "the first push stays in the history");
  assert.deepEqual(second.files[0]!.updatedBy, { kind: "user", projectName: "c" });
});

test("push: an outdated clone that also edited stays modified; refusals and selection rules", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  h.fs.put(`${a}/.env.local`, "LOCAL=1\n");
  await setupEnv(h, "a", [".env", ".env.local"]);
  await refused(h.service.push({ workspace: WS, repoKey: REPO, projectPath: a }), "NOTHING_TO_PUSH");
  await refused(h.service.push({ workspace: WS, repoKey: REPO, projectPath: a, files: ["nope/.env"] }), "FILE_NOT_MANAGED");
  await refused(h.service.push({ workspace: WS, repoKey: REPO, projectPath: "/ws/acme/zzz" }), "INVALID_CLONE");
  await refused(h.service.push({ workspace: WS, repoKey: REPO, projectPath: a, files: ["../x"] }), "INVALID_PATH");

  h.fs.put(`${a}/.env`, "KEY=two\n", { notify: true });
  h.fs.put(`${b}/.env.local`, "LOCAL=b\n", { notify: true });
  await drain(h);
  // Only the selected modified file is pushed.
  const pushed = await h.service.push({ workspace: WS, repoKey: REPO, projectPath: a, files: [".env", ".env.local"] });
  assert.equal(stateOf(pushed, "b", ".env"), "synced");
  assert.equal(stateOf(pushed, "b", ".env.local"), "modified");
  assert.equal(h.store.get(WS, REPO)!.files.find((file) => file.path === ".env.local")!.versions.length, 1);
  // The project may be named through a symlinked path that resolves to the listed clone.
  const viaAlias = await h.service.push({ workspace: WS, repoKey: REPO, projectPath: "/alias/acme/b" });
  assert.equal(stateOf(viaAlias, "a", ".env.local"), "synced");
  assert.equal(h.fs.read(`${a}/.env.local`), "LOCAL=b\n");
});

test("reset: modified, outdated and missing files take the vault's copy; refused and missing-dir stay", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  h.fs.put(`${a}/api/.env`, "API=1\n");
  h.fs.put(`${b}/.env`, "KEY=b\n", { mode: 0o640 });
  await setupEnv(h, "a", [".env", "api/.env"]);
  assert.equal(stateOf(lastVault(h), "b", "api/.env"), "missing-dir");

  const reset = await h.service.reset({ workspace: WS, repoKey: REPO, projectPath: b });
  assert.equal(stateOf(reset, "b", ".env"), "synced");
  assert.equal(stateOf(reset, "b", "api/.env"), "missing-dir");
  assert.equal(h.fs.read(`${b}/.env`), "KEY=one\n");
  assert.equal(h.fs.mode(`${b}/.env`), 0o640, "reset keeps the mode");
  const record = h.store.get(WS, REPO)!;
  assert.equal(record.clones[b]?.baselines[".env"], record.files[0]!.versions[0]!.id);

  // A reset with nothing to do changes nothing.
  const writes = h.fs.writes.length;
  await h.service.reset({ workspace: WS, repoKey: REPO, projectPath: b });
  assert.equal(h.fs.writes.length, writes);
});

// ---------------------------------------------------------------------------
// Setup sources, files list
// ---------------------------------------------------------------------------

test("setup: merge takes the union of keys, the primary's values winning; bad sources are refused", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  const c = h.clone("c");
  h.fs.put(`${a}/.env`, "A=1\nB=2\n");
  h.fs.put(`${b}/.env`, "A=9\nC=3\n");
  h.fs.put(`${a}/notes.txt`, "plain text\nnot env\n");
  h.fs.put(`${b}/notes.txt`, "other\n");
  h.fs.tracked.set(c, new Set([".env"]));
  h.fs.put(`${c}/.env`, "TRACKED=1\n");

  await refused(
    h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: "notes.txt", source: { merge: true, primary: a } }], excluded: [] }),
    "NOT_ENV_FORMAT"
  );
  await refused(h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: c } }], excluded: [] }), "FILE_REFUSED");
  await refused(h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env.x", source: { projectPath: a } }], excluded: [] }), "SOURCE_MISSING");
  h.fs.refusals.set(`${b}/big.env`, "too-large");
  await refused(h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: "big.env", source: { projectPath: b } }], excluded: [] }), "FILE_REFUSED");
  await refused(h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: "/ws/other/a" } }], excluded: [] }), "INVALID_CLONE");
  await refused(
    h.service.setup({
      workspace: WS,
      repoKey: REPO,
      files: Array.from({ length: SECRET_FILES_MAX_PER_VAULT + 1 }, (_, index) => ({ path: `f${index}.env`, source: { projectPath: a } })),
      excluded: []
    }),
    "TOO_MANY_FILES"
  );
  assert.equal(h.store.list().length, 0, "nothing was created");

  const detail = await h.service.setup({
    workspace: WS,
    repoKey: REPO,
    files: [{ path: ".env", source: { merge: true, primary: a } }],
    excluded: [".env.local"]
  });
  const vault = h.store.get(WS, REPO)!;
  const merged = text(await h.store.readContent(vault.files[0]!.versions[0]!.sha256));
  const parsed = h.fs.ops.parseEnv(bytes(merged))!;
  assert.deepEqual([...parsed.entries()], [["A", "1"], ["B", "2"], ["C", "3"]]);
  assert.deepEqual(states(detail, ".env"), { a: "modified", b: "modified", c: "refused:tracked" });
  assert.deepEqual(detail.excluded, [".env.local"]);
  assert.deepEqual(detail.files[0]!.updatedBy, { kind: "user", projectName: "a" });
});

test("files: add, exclude (stops managing), include and unmanage; the per-vault limit holds", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  h.clone("b");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  h.fs.put(`${a}/.env.local`, "LOCAL=1\n");
  h.fs.put(`${a}/deploy/targets.conf`, "host a\n");
  await setupEnv(h, "a");
  assert.deepEqual(lastVault(h).candidates, [".env.local"]);
  assert.equal(lastVault(h).newCandidates, 1);

  await refused(h.service.updateFiles({ workspace: WS, repoKey: REPO }), "INVALID_REQUEST");
  await refused(h.service.updateFiles({ workspace: WS, repoKey: REPO, unmanage: ["deploy/targets.conf"] }), "FILE_NOT_MANAGED");
  await refused(h.service.updateFiles({ workspace: WS, repoKey: REPO, exclude: [".env"], unmanage: [".env"] }), "INVALID_REQUEST");
  await refused(h.service.updateFiles({ workspace: "other", repoKey: REPO, exclude: [".env.local"] }), "VAULT_NOT_FOUND");

  let detail = await h.service.updateFiles({
    workspace: WS,
    repoKey: REPO,
    add: [{ path: "deploy/targets.conf", source: { projectPath: a } }],
    exclude: [".env.local"]
  });
  assert.deepEqual(detail.files.map((file) => file.path), [".env", "deploy/targets.conf"]);
  assert.deepEqual(detail.excluded, [".env.local"]);
  assert.deepEqual(detail.candidates, []);
  assert.equal(stateOf(detail, "b", "deploy/targets.conf"), "missing-dir");

  detail = await h.service.updateFiles({ workspace: WS, repoKey: REPO, include: [".env.local"], unmanage: ["deploy/targets.conf"] });
  assert.deepEqual(detail.files.map((file) => file.path), [".env"]);
  assert.deepEqual(detail.excluded, []);
  assert.deepEqual(detail.candidates, [".env.local"]);
  assert.equal(h.fs.read(`${a}/deploy/targets.conf`), "host a\n", "clone files stay");
  for (const clone of Object.values(h.store.get(WS, REPO)!.clones)) assert.equal(clone.baselines["deploy/targets.conf"], undefined);

  detail = await h.service.updateFiles({ workspace: WS, repoKey: REPO, exclude: [".env"] });
  assert.deepEqual(detail.files, []);
  assert.deepEqual(detail.excluded, [".env"]);
});

// ---------------------------------------------------------------------------
// Plugin switch, store availability
// ---------------------------------------------------------------------------

test("plugin off: no watcher, no timer, no write; mutations 409, reads answer; turning it on reconciles", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  await setupEnv(h, "a");
  assert.ok(h.fs.openWatches().length > 0);
  assert.equal(h.timers.pending("interval").length, 1);

  h.plugin.set(false);
  await h.settle();
  assert.equal(h.fs.openWatches().length, 0, "every watcher stops");
  assert.equal(h.timers.pending("interval").length, 0);
  assert.equal(h.service.isEnabled, false);

  const b = h.clone("b");
  const writes = h.fs.writes.length;
  h.service.notifyProjectsListed();
  await h.service.notifyProjectCreated(b);
  await h.service.reconcile();
  assert.equal(h.timers.pending("timeout").length, 0);

  const read = await h.service.getVault(WS, REPO);
  assert.equal(stateOf(read, "b", ".env"), "missing");
  assert.equal((await h.service.list()).vaults.length, 1);
  assert.equal((await h.service.candidates({ workspace: WS, repoKey: REPO })).candidates.length, 1);
  assert.equal((await h.service.compare({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env" })).compare.format, "missing");

  await refused(h.service.setup({ workspace: WS, repoKey: REPO, files: [], excluded: [] }), "SECRET_FILES_DISABLED");
  await refused(h.service.updateFiles({ workspace: WS, repoKey: REPO, exclude: [".env.local"] }), "SECRET_FILES_DISABLED");
  await refused(h.service.push({ workspace: WS, repoKey: REPO, projectPath: a }), "SECRET_FILES_DISABLED");
  await refused(h.service.reset({ workspace: WS, repoKey: REPO, projectPath: b }), "SECRET_FILES_DISABLED");
  await refused(h.service.deleteVault(WS, REPO), "SECRET_FILES_DISABLED");
  assert.equal(h.fs.writes.length, writes, "nothing was touched");
  assert.equal(h.fs.read(`${b}/.env`), undefined);

  h.plugin.set(true);
  await h.settle();
  assert.equal(h.fs.read(`${b}/.env`), "KEY=one\n", "turning the plugin on reconciles");
  assert.equal(h.timers.pending("interval").length, 1);
});

test("a plugin that is off at start arms nothing; an unreadable store answers 503 on mutations", async () => {
  const h = await makeHarness({ enabled: false });
  assert.equal(h.timers.timers.length, 0);
  h.store.writable = false;
  h.plugin.set(true);
  await h.settle();
  h.clone("a");
  await refused(h.service.setup({ workspace: WS, repoKey: REPO, files: [], excluded: [] }), "SECRET_FILES_UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// Reconcile triggers
// ---------------------------------------------------------------------------

test("reconcile triggers: a projects listing (debounced), a created project (immediate), the interval", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  await setupEnv(h, "a");

  // Listing: debounced into one pass.
  const b = h.clone("b");
  h.service.notifyProjectsListed();
  h.service.notifyProjectsListed();
  assert.equal(h.timers.pending("timeout", 1000).length, 1);
  assert.equal(h.fs.read(`${b}/.env`), undefined);
  h.timers.fireTimeouts(1000);
  await h.settle();
  assert.equal(h.fs.read(`${b}/.env`), "KEY=one\n");

  // A server clone gets its files before the create route answers.
  const c = h.clone("c");
  await h.service.notifyProjectCreated(c);
  assert.equal(h.fs.read(`${c}/.env`), "KEY=one\n");
  // An unrelated or archived project: nothing.
  const other = h.clone("x", { repoKey: "github.com/acme/other" });
  await h.service.notifyProjectCreated(other);
  assert.equal(h.fs.read(`${other}/.env`), undefined);

  // The 5-minute safety net (a clone made by hand in a terminal).
  const d = h.clone("d");
  assert.equal(h.timers.pending("interval", 5 * 60_000).length, 1);
  h.timers.fireIntervals();
  await h.settle();
  assert.equal(h.fs.read(`${d}/.env`), "KEY=one\n");
});

test("reconcile prunes clones no longer listed with the repo; an archived clone keeps its baseline", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  const c = h.clone("c");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  await setupEnv(h, "a");
  assert.ok(h.store.get(WS, REPO)!.clones[b]);
  h.projects.splice(h.projects.findIndex((project) => project.path === b), 1);
  h.projects.find((project) => project.path === c)!.isArchived = true;
  await h.service.reconcile();
  const record = h.store.get(WS, REPO)!;
  assert.equal(record.clones[b], undefined);
  assert.ok(record.clones[c]?.baselines[".env"]);
  assert.deepEqual(lastVault(h).clones.map((clone) => clone.projectName), ["a"]);
});

// ---------------------------------------------------------------------------
// Watchers, feedback, events
// ---------------------------------------------------------------------------

test("watchers: per directory with a managed file plus the root, filtered by name, debounced per clone", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  h.clone("b");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  h.fs.put(`${a}/api/.env`, "API=1\n");
  await setupEnv(h, "a", [".env", "api/.env"]);
  const dirs = h.fs
    .openWatches()
    .map((watch) => watch.dir)
    .sort();
  // b has no api/ directory: only its root is watched (the root sees api/ appear).
  assert.deepEqual(dirs, [a, `${a}/api`, root("b")].sort());

  // An unrelated name: nothing scheduled.
  h.fs.put(`${a}/README.md`, "x", { notify: true });
  assert.equal(h.timers.pending("timeout").length, 0);
  // A burst of events: one debounced check.
  const events = h.events.length;
  h.fs.put(`${a}/.env`, "KEY=two\n", { notify: true });
  h.fs.put(`${a}/.env`, "KEY=three\n", { notify: true });
  h.fs.put(`${a}/api/.env`, "API=2\n", { notify: true });
  assert.equal(h.timers.pending("timeout", 500).length, 1);
  assert.equal(h.events.length, events, "nothing happens before the debounce fires");
  h.timers.fireTimeouts(500);
  await h.settle();
  assert.equal(h.events.length, events + 1);
  assert.equal(stateOf(lastVault(h), "a", ".env"), "modified");
  assert.equal(stateOf(lastVault(h), "a", "api/.env"), "modified");

  // A watch that errors is re-armed by the next check of that clone.
  const rootWatch = h.fs.openWatches().find((watch) => watch.dir === a)!;
  rootWatch.onError(new Error("EIO"));
  h.fs.emit(`${a}/api/.env`);
  h.timers.fireTimeouts(500);
  await h.settle();
  assert.ok(h.fs.openWatches().some((watch) => watch.dir === a), "the root watch is back");

  // A parent directory that appears: the root sees it, the check copies the file in.
  const c = h.clone("c");
  await h.service.reconcile(false);
  assert.equal(stateOf(lastVault(h), "c", "api/.env"), "missing-dir");
  h.fs.mkdir(`${c}/api`);
  for (const watch of h.fs.openWatches()) if (watch.dir === c) watch.onChange("api");
  h.timers.fireTimeouts(500);
  await h.settle();
  assert.equal(h.fs.read(`${c}/api/.env`), "API=1\n");
});

test("the service's own writes settle: no feedback loop, no extra write, store write or event", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  h.clone("b");
  h.clone("c");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  await setupEnv(h, "a");
  h.fs.put(`${a}/.env`, "KEY=two\n", { notify: true });
  await drain(h);
  await h.service.push({ workspace: WS, repoKey: REPO, projectPath: a });
  // Writes into b and c fired their watches.
  assert.ok(h.timers.pending("timeout").length > 0);
  const writes = h.fs.writes.length;
  const updates = h.store.updates;
  const events = h.events.length;
  const rounds = await drain(h);
  assert.equal(rounds, 1);
  assert.equal(h.fs.writes.length, writes);
  assert.equal(h.store.updates, updates);
  assert.equal(h.events.length, events);
});

test("events go out only when a vault's detail changed; deleting the vault announces it and leaves clone files", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  await setupEnv(h, "a");
  const count = h.events.length;
  assert.ok(count >= 1);
  await h.service.getVault(WS, REPO);
  await h.service.list();
  await h.service.reconcile();
  h.fs.emit(`${a}/.env`);
  await drain(h);
  assert.equal(h.events.length, count, "nothing changed, nothing published");

  await h.service.deleteVault(WS, REPO);
  assert.deepEqual(h.events.at(-1), { workspace: WS, repoKey: REPO, deleted: true });
  assert.equal(h.fs.read(`${b}/.env`), "KEY=one\n");
  assert.equal(h.fs.openWatches().length, 0);
  await refused(h.service.getVault(WS, REPO), "VAULT_NOT_FOUND");
  await refused(h.service.deleteVault(WS, REPO), "VAULT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Reads: candidates, compare
// ---------------------------------------------------------------------------

test("candidates: variants grouped by content, newest first, value classes without values, refusals", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  const c = h.clone("c");
  const d = h.clone("d");
  h.fs.put(`${a}/.env`, "A=1\nB=2\n", { mtimeMs: 1000 });
  h.fs.put(`${b}/.env`, "A=1\nB=3\nC=4\n", { mtimeMs: 3000 });
  h.fs.put(`${c}/.env`, "A=1\nB=2\n", { mtimeMs: 2000 });
  h.fs.put(`${d}/.env`, "A=1\n");
  h.fs.tracked.set(d, new Set([".env"]));
  h.fs.put(`${d}/.env.local`, "L=1\n");
  h.fs.put(`${a}/deploy/targets.conf`, "one\ntwo\n");

  const scan = await h.service.candidates({ workspace: WS, repoKey: REPO });
  assert.deepEqual(scan.clones.map((clone) => clone.projectName), ["a", "b", "c", "d"]);
  assert.deepEqual(scan.candidates.map((candidate) => candidate.path), [".env", ".env.local"]);
  const env = scan.candidates[0]!;
  assert.equal(env.format, "env");
  assert.equal(env.conventional, true);
  assert.equal(env.managed, false);
  assert.deepEqual(env.variants, [
    { variantId: "v1", projectPaths: [b], modifiedAt: new Date(3000).toISOString(), keyCount: 3 },
    { variantId: "v2", projectPaths: [a, c], modifiedAt: new Date(2000).toISOString(), keyCount: 2 }
  ]);
  assert.equal(env.defaultVariantId, "v1");
  assert.deepEqual(env.keys, [
    { key: "A", byVariant: { v1: 0, v2: 0 } },
    { key: "B", byVariant: { v1: 0, v2: 1 } },
    { key: "C", byVariant: { v1: 0, v2: null } }
  ]);
  assert.deepEqual(env.refused, [{ projectPath: d, refusal: "tracked" }]);

  const single = await h.service.candidates({ workspace: WS, repoKey: REPO, path: "deploy/targets.conf" });
  assert.equal(single.candidates.length, 1);
  assert.equal(single.candidates[0]!.format, "lines");
  assert.equal(single.candidates[0]!.conventional, false);
  assert.deepEqual(single.candidates[0]!.variants.map((variant) => variant.lineCount), [2]);
  await refused(h.service.candidates({ workspace: WS, repoKey: REPO, path: "/etc/passwd" }), "INVALID_PATH");
  await refused(h.service.candidates({ workspace: "../x", repoKey: REPO }), "INVALID_REQUEST");
  await refused(h.service.candidates({ workspace: WS, repoKey: "Not/A/Key" }), "INVALID_REQUEST");
});

test("compare: names only, the clone on the left; unmanaged or refused files are refused", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  const c = h.clone("c");
  h.fs.put(`${a}/.env`, "A=1\nB=2\n");
  h.fs.put(`${b}/.env`, "A=1\nB=9\nC=3\n");
  await setupEnv(h, "a");
  const compared = await h.service.compare({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env" });
  assert.deepEqual(compared, {
    path: ".env",
    compare: {
      format: "env",
      keys: [
        { key: "A", change: "same" },
        { key: "B", change: "changed" },
        { key: "C", change: "added" }
      ]
    }
  });
  await refused(h.service.compare({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env.other" }), "FILE_NOT_MANAGED");
  h.fs.refusals.set(`${c}/.env`, "symlink");
  await refused(h.service.compare({ workspace: WS, repoKey: REPO, projectPath: c, path: ".env" }), "FILE_REFUSED");
  await refused(h.service.compare({ workspace: WS, repoKey: REPO, projectPath: "/ws/acme/none", path: ".env" }), "INVALID_CLONE");
});

test("an agent's push is stamped with its thread", async () => {
  const h = await makeHarness();
  const a = h.clone("a");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  await setupEnv(h, "a");
  h.fs.put(`${a}/.env`, "KEY=two\n");
  const pushed = await h.service.push({ workspace: WS, repoKey: REPO, projectPath: a }, { kind: "agent", threadId: "thread-1" });
  assert.deepEqual(pushed.files[0]!.updatedBy, { kind: "agent", threadId: "thread-1", projectName: "a" });
});

// ---------------------------------------------------------------------------
// Secrets never leak
// ---------------------------------------------------------------------------

test("no secret value or content hash ever appears in a result, an error, an event or a log line", async () => {
  const SECRET_A = "sk_live_SUPERSECRET_alpha_7f3k";
  const SECRET_B = "sk_live_SUPERSECRET_bravo_9q2z";
  const SECRET_C = "hunter2-SUPERSECRET-charlie";
  const h = await makeHarness();
  const a = h.clone("a");
  const b = h.clone("b");
  const c = h.clone("c");
  const contents = [
    `API_KEY=${SECRET_A}\nDB=${SECRET_B}\n`,
    `API_KEY=${SECRET_B}\nOTHER=${SECRET_C}\n`,
    `just a ${SECRET_C} line\n`,
    `API_KEY=${SECRET_C}\n`
  ];
  h.fs.put(`${a}/.env`, contents[0]!);
  h.fs.put(`${b}/.env`, contents[1]!);
  h.fs.put(`${a}/deploy/targets.conf`, contents[2]!);
  h.fs.put(`${b}/deploy/targets.conf`, `host ${SECRET_B}\n`);
  h.fs.mkdir(`${c}/deploy`);
  h.fs.refusals.set(`${c}/.env`, "symlink");

  const outputs: unknown[] = [];
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      outputs.push(await run());
    } catch (error) {
      outputs.push({ name: (error as Error).name, message: (error as Error).message, code: (error as SecretFilesError).code });
    }
  };
  await attempt(() => h.service.candidates({ workspace: WS, repoKey: REPO }));
  await attempt(() => h.service.candidates({ workspace: WS, repoKey: REPO, path: "deploy/targets.conf" }));
  await attempt(() => h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: "deploy/targets.conf", source: { merge: true, primary: a } }], excluded: [] }));
  await attempt(() => h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: c } }], excluded: [] }));
  await attempt(() =>
    h.service.setup({
      workspace: WS,
      repoKey: REPO,
      files: [
        { path: ".env", source: { merge: true, primary: a } },
        { path: "deploy/targets.conf", source: { projectPath: a } }
      ],
      excluded: []
    })
  );
  await drain(h);
  h.fs.put(`${b}/.env`, contents[3]!, { notify: true });
  await drain(h);
  await attempt(() => h.service.compare({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env" }));
  await attempt(() => h.service.compare({ workspace: WS, repoKey: REPO, projectPath: b, path: "deploy/targets.conf" }));
  await attempt(() => h.service.compare({ workspace: WS, repoKey: REPO, projectPath: c, path: ".env" }));
  await attempt(() => h.service.push({ workspace: WS, repoKey: REPO, projectPath: b }));
  await attempt(() => h.service.push({ workspace: WS, repoKey: REPO, projectPath: b }));
  // A write that fails logs a line.
  h.fs.refusals.set(`${a}/deploy/targets.conf`, "outside");
  await attempt(() => h.service.reset({ workspace: WS, repoKey: REPO, projectPath: a }));
  await attempt(() => h.service.getVault(WS, REPO));
  await attempt(() => h.service.list());
  await drain(h);

  const everything = JSON.stringify({ outputs, events: h.events, logs: h.logs });
  assert.ok(h.events.length > 0 && outputs.length > 10);
  assert.doesNotMatch(everything, /SUPERSECRET/);
  const hashes = new Set<string>([...h.store.blobs.keys(), ...contents.map((content) => sha(content))]);
  for (const record of h.store.list()) for (const file of record.files) for (const version of file.versions) hashes.add(version.sha256);
  for (const hash of hashes) assert.ok(!everything.includes(hash), "a content hash leaked");
});
