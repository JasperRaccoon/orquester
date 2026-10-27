import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { SecretFilesChangedPayload, SecretVaultDetail } from "@orquester/api";
import { SecretFilesError, SecretFilesService, type SecretFilesProject } from "./service.ts";
import { SecretVaultStore } from "./vault-store.ts";

// End to end over the REAL vault store, on-disk helpers and git, in temp dirs: clones of one repo
// get the vault's files, a push from one updates the others, a clone with its own copy stays
// flagged. Watchers are a no-op and timers never fire: every pass here is driven explicitly.

const run = promisify(execFile);
const WS = "acme";
const REPO = "github.com/acme/engine";
const quiet = { warn: () => {}, error: () => {} };

async function gitClone(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: path });
  await writeFile(join(path, ".gitignore"), ".env\n.env.*\n");
}

const stateOf = (detail: SecretVaultDetail, name: string, path = ".env") =>
  detail.clones.find((clone) => clone.projectName === name)?.files.find((file) => file.path === path)?.state;

test("two clones stay in sync through setup and push; a modified third stays flagged; git-tracked copies are refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orquester-secret-files-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projects: SecretFilesProject[] = [];
  for (const name of ["a", "b", "c", "d"]) {
    const path = join(dir, "workspaces", WS, name);
    await gitClone(path);
    projects.push({ workspace: WS, name, path, repoKey: REPO });
  }
  const [a, b, c, d] = projects.map((project) => project.path) as [string, string, string, string];
  const outside = join(dir, "outside");
  await gitClone(outside);
  const escaped = join(dir, "workspaces", WS, "escaped");
  await symlink(outside, escaped);
  projects.push({ workspace: WS, name: "escaped", path: escaped, repoKey: REPO });
  await writeFile(join(a, ".env"), "API_KEY=fake-one\nDB=fake-db\n", { mode: 0o640 });
  await writeFile(join(c, ".env"), "API_KEY=fake-c-own\n");
  await writeFile(join(d, ".env"), "API_KEY=fake-tracked\n");
  await run("git", ["add", "-f", ".env"], { cwd: d });

  const store = new SecretVaultStore({ dir: join(dir, "appdir", "daemon", "secret-files"), logger: quiet });
  await store.load();
  const events: SecretFilesChangedPayload[] = [];
  const service = new SecretFilesService({
    store,
    listProjects: async () => projects,
    pluginEnabled: () => true,
    onPluginChange: () => () => {},
    publish: (payload) => events.push(payload),
    watch: () => ({ close: () => {} }),
    timers: { setTimeout: () => null, clearTimeout: () => {}, setInterval: () => null, clearInterval: () => {} },
    workspacesRoot: () => join(dir, "workspaces"),
    logger: quiet
  });
  t.after(() => service.stop());
  await service.start();
  await service.idle();

  const scan = await service.candidates({ workspace: WS, repoKey: REPO });
  const env = scan.candidates.find((candidate) => candidate.path === ".env");
  assert.ok(env, "the gitignored .env is a candidate");
  assert.deepEqual(env.refused, [{ projectPath: d, refusal: "tracked" }]);
  assert.equal(env.variants.length, 2);

  const setup = await service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: a } }], excluded: [] });
  assert.equal(stateOf(setup, "a"), "synced");
  assert.equal(stateOf(setup, "b"), "synced");
  assert.equal(stateOf(setup, "c"), "modified");
  assert.equal(stateOf(setup, "d"), "refused");
  await assert.rejects(readFile(join(outside, ".env")), { code: "ENOENT" }, "automatic sync never writes outside the workspaces root");
  assert.equal(await readFile(join(b, ".env"), "utf8"), "API_KEY=fake-one\nDB=fake-db\n");
  assert.equal((await stat(join(b, ".env"))).mode & 0o777, 0o600);

  // Edit one clone, push it: the other synced clone updates (keeping its mode), c stays flagged.
  await writeFile(join(a, ".env"), "API_KEY=fake-two\nDB=fake-db\nNEW=fake-new\n");
  await service.reconcile();
  assert.equal(stateOf((await service.getVault(WS, REPO)), "a"), "modified");
  const pushed = await service.push({ workspace: WS, repoKey: REPO, projectPath: a });
  assert.equal(stateOf(pushed, "a"), "synced");
  assert.equal(stateOf(pushed, "b"), "synced");
  assert.equal(stateOf(pushed, "c"), "modified");
  assert.equal(await readFile(join(b, ".env"), "utf8"), "API_KEY=fake-two\nDB=fake-db\nNEW=fake-new\n");
  assert.equal((await stat(join(b, ".env"))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(c, ".env"), "utf8"), "API_KEY=fake-c-own\n");
  await writeFile(join(outside, ".env"), "USER=outside\n");
  await assert.rejects(
    service.reset({ workspace: WS, repoKey: REPO, projectPath: escaped }),
    (error: unknown) => error instanceof SecretFilesError && error.code === "SECRET_FILES_ERROR"
  );
  assert.equal(await readFile(join(outside, ".env"), "utf8"), "USER=outside\n", "reset never overwrites an outside clone");

  const compare = await service.compare({ workspace: WS, repoKey: REPO, projectPath: c, path: ".env" });
  assert.equal(compare.compare.format, "env");

  // A new clone gets the files when it is created.
  const e = join(dir, "workspaces", WS, "e");
  await gitClone(e);
  projects.push({ workspace: WS, name: "e", path: e, repoKey: REPO });
  await service.notifyProjectCreated(e);
  assert.equal(await readFile(join(e, ".env"), "utf8"), "API_KEY=fake-two\nDB=fake-db\nNEW=fake-new\n");

  // The store persisted it: a fresh store reads the same vault back.
  const reread = new SecretVaultStore({ dir: join(dir, "appdir", "daemon", "secret-files"), logger: quiet });
  await reread.load();
  assert.equal(reread.get(WS, REPO)?.files[0]?.versions.length, 2);
  assert.doesNotMatch(JSON.stringify(events), /fake-/);
});

test("over the real store: an unmanaged file keeps its history and its content on disk; expect pins the pushed bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orquester-secret-files-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projects: SecretFilesProject[] = [];
  for (const name of ["a", "b"]) {
    const path = join(dir, "workspaces", WS, name);
    await gitClone(path);
    projects.push({ workspace: WS, name, path, repoKey: REPO });
  }
  const [a, b] = projects.map((project) => project.path) as [string, string];
  await writeFile(join(a, ".env"), "API_KEY=fake-one\n");
  await writeFile(join(a, ".env.local"), "LOCAL=fake-local\n");
  const storeDir = join(dir, "appdir", "daemon", "secret-files");
  const store = new SecretVaultStore({ dir: storeDir, logger: quiet });
  await store.load();
  const service = new SecretFilesService({
    store,
    listProjects: async () => projects,
    pluginEnabled: () => true,
    onPluginChange: () => () => {},
    publish: () => {},
    watch: () => ({ close: () => {} }),
    timers: { setTimeout: () => null, clearTimeout: () => {}, setInterval: () => null, clearInterval: () => {} },
    workspacesRoot: () => join(dir, "workspaces"),
    logger: quiet
  });
  t.after(() => service.stop());
  await service.start();
  await service.idle();
  await service.setup({
    workspace: WS,
    repoKey: REPO,
    files: [
      { path: ".env", source: { projectPath: a } },
      { path: ".env.local", source: { projectPath: a } }
    ],
    excluded: []
  });
  await writeFile(join(a, ".env"), "API_KEY=fake-two\n");
  await service.reconcile();
  await service.push({ workspace: WS, repoKey: REPO, projectPath: a });
  const history = store.get(WS, REPO)!.files.find((file) => file.path === ".env")!.versions;
  assert.equal(history.length, 2);

  // Unmanage: the history is retired, and every version's blob survives this write's sweep and the next.
  await service.updateFiles({ workspace: WS, repoKey: REPO, unmanage: [".env"] });
  await writeFile(join(a, ".env.local"), "LOCAL=fake-local-2\n");
  await service.reconcile();
  await service.push({ workspace: WS, repoKey: REPO, projectPath: a });
  const reread = new SecretVaultStore({ dir: storeDir, logger: quiet });
  await reread.load();
  const retired = reread.get(WS, REPO)?.retired?.find((file) => file.path === ".env");
  assert.deepEqual(retired?.versions.map((version) => version.id), history.map((version) => version.id));
  for (const version of history) {
    assert.ok((await stat(join(storeDir, "blobs", version.sha256))).isFile(), "a retired version's content is kept");
    assert.ok((await reread.readContent(version.sha256)).byteLength > 0);
  }
  assert.equal(await readFile(join(b, ".env"), "utf8"), "API_KEY=fake-two\n", "clones keep the file");

  // expect: the token of the copy the user saw; an edit after it refuses the push, nothing moves.
  await writeFile(join(b, ".env.local"), "LOCAL=fake-b\n");
  await service.reconcile();
  const seen = (await service.compare({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env.local" })).contentToken;
  assert.ok(seen);
  await writeFile(join(b, ".env.local"), "LOCAL=fake-b-later\n");
  await assert.rejects(
    service.push({ workspace: WS, repoKey: REPO, projectPath: b, expect: { ".env.local": seen } }),
    (error: Error & { code?: string }) => error.code === "CONTENT_CHANGED"
  );
  assert.equal(await readFile(join(a, ".env.local"), "utf8"), "LOCAL=fake-local-2\n");
});
