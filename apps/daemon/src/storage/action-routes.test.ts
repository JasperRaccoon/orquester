import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Fastify from "fastify";
import yauzl from "yauzl";

import { storageRoutes } from "@orquester/api";

import { resolveZipTool } from "../zip.ts";
import { registerStorageActionRoutes } from "./action-routes.ts";
import { createStorageGuard } from "./guard.ts";

interface Harness {
  root: string;
  appdir: string;
  workspaces: string;
  inject: ReturnType<typeof Fastify>["inject"];
  /** Every dependency call, in order. */
  calls: string[];
  /** Whether each closeTreeUsers call saw its tree still on disk. */
  closedWhileExisting: boolean[];
}

async function harness(t: test.TestContext, options: { supported?: boolean } = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-storage-routes-")));
  const appdir = join(root, "var", "lib", "orquester");
  const workspaces = join(appdir, "workspaces");
  await mkdir(join(workspaces, "acme", "game", "build"), { recursive: true });
  await mkdir(join(appdir, ".ssh"), { recursive: true });
  await mkdir(join(appdir, "daemon"), { recursive: true });
  await mkdir(join(root, "data", "foo", "nested"), { recursive: true });
  await writeFile(join(appdir, ".ssh", "id_ed25519"), "KEY");
  await writeFile(join(root, "data", "foo", "nested", "a.txt"), "alpha");
  await writeFile(join(root, "data", "foo", "b.bin"), Buffer.from([0, 1, 2, 250]));
  const guard = createStorageGuard({
    rootDir: root,
    mountPoints: () => [root, join(root, "data")],
    appdir,
    homeDir: appdir,
    workspacesDir: workspaces,
    fsRoot: workspaces,
    daemonCheckoutDir: join(root, "opt", "orquester"),
    toolDirs: []
  });
  const calls: string[] = [];
  const closedWhileExisting: boolean[] = [];
  const app = Fastify();
  registerStorageActionRoutes(app, {
    guard,
    supported: options.supported ?? true,
    tree: {
      sizeOf: (path) => (calls.push(`sizeOf ${path}`), 4096),
      applyDelete: async (path) => void calls.push(`applyDelete ${path}`),
      applyRename: async (from, to) => void calls.push(`applyRename ${from} ${to}`)
    },
    closeTreeUsers: async (canonicalPath, rawPath) => {
      calls.push(`closeTreeUsers ${canonicalPath} ${rawPath}`);
      closedWhileExisting.push(existsSync(canonicalPath));
    },
    notifyWorkspacesChanged: async (dir) => void calls.push(`notify ${dir}`)
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, appdir, workspaces, inject: app.inject.bind(app), calls, closedWhileExisting };
}

const del = (h: Harness, payload: object) => h.inject({ method: "POST", url: storageRoutes.delete, payload });
const ren = (h: Harness, payload: object) => h.inject({ method: "POST", url: storageRoutes.rename, payload });
const download = (h: Harness, path: string) =>
  h.inject({ method: "GET", url: `${storageRoutes.download}?path=${encodeURIComponent(path)}` });

test("delete outside the workspaces root needs the typed name, then frees the scanned size", async (t) => {
  const h = await harness(t);
  const target = join(h.root, "data", "foo");

  const mismatch = await del(h, { path: target, confirm: "fo" });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().code, "STORAGE_CONFIRM_MISMATCH");
  const missing = await del(h, { path: target });
  assert.equal(missing.json().code, "STORAGE_CONFIRM_MISMATCH");
  assert.ok(existsSync(target));
  assert.deepEqual(h.calls, []);

  const ok = await del(h, { path: target, confirm: "foo" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ok: true, freedBytes: 4096 });
  assert.equal(existsSync(target), false);
  // Nothing of a project can be rooted out here: no session closing, no workspace notice.
  assert.deepEqual(h.calls, [`sizeOf ${target}`, `applyDelete ${target}`]);
});

test("delete inside the workspaces root closes what is rooted there first, then notifies", async (t) => {
  const h = await harness(t);
  const target = join(h.workspaces, "acme", "game");
  // Addressed through a symlink outside the workspaces root: judged (and closed) at its real place.
  await symlink(join(h.workspaces, "acme"), join(h.root, "data", "acme-link"));
  const raw = join(h.root, "data", "acme-link", "game");

  const res = await del(h, { path: raw });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(existsSync(target), false);
  assert.deepEqual(h.calls, [
    `sizeOf ${target}`,
    `closeTreeUsers ${target} ${raw}`,
    `notify ${join(h.workspaces, "acme")}`,
    `applyDelete ${target}`
  ]);
  assert.deepEqual(h.closedWhileExisting, [true]);
});

test("delete refuses protected paths, also through a symlinked parent", async (t) => {
  const h = await harness(t);
  await symlink(h.appdir, join(h.root, "data", "foo", "home"));
  for (const path of [join(h.appdir, ".ssh"), join(h.root, "data", "foo", "home", ".ssh"), h.workspaces]) {
    const res = await del(h, { path, confirm: ".ssh" });
    assert.equal(res.statusCode, 403, path);
    assert.equal(res.json().code, "STORAGE_FORBIDDEN");
    assert.ok(res.json().message);
  }
  assert.ok(existsSync(join(h.appdir, ".ssh", "id_ed25519")));
  assert.ok(existsSync(h.workspaces));
  assert.deepEqual(h.calls, []);

  assert.equal((await del(h, { path: join(h.root, "data", "gone"), confirm: "gone" })).json().code, "STORAGE_PATH_NOT_FOUND");
  assert.equal((await del(h, { path: "data/foo" })).json().code, "INVALID_REQUEST");
});

test("rename takes a plain name, never overwrites, and keeps the saved scan in step", async (t) => {
  const h = await harness(t);
  const source = join(h.root, "data", "foo", "nested");

  for (const newName of ["a/b", "..", "  ", "x\\y"]) {
    const res = await ren(h, { path: source, newName });
    assert.equal(res.statusCode, 400, newName);
    assert.equal(res.json().code, "INVALID_REQUEST");
  }
  const conflict = await ren(h, { path: source, newName: "b.bin" });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "STORAGE_EXISTS");
  assert.ok(existsSync(source));
  assert.equal((await readFile(join(h.root, "data", "foo", "b.bin"))).length, 4);

  const forbidden = await ren(h, { path: join(h.appdir, ".ssh"), newName: "ssh-old" });
  assert.equal(forbidden.statusCode, 403);
  assert.ok(existsSync(join(h.appdir, ".ssh")));
  assert.deepEqual(h.calls, []);

  const ok = await ren(h, { path: source, newName: " renamed " });
  const target = join(h.root, "data", "foo", "renamed");
  assert.deepEqual(ok.json(), { ok: true, path: target });
  assert.equal(await readFile(join(target, "a.txt"), "utf8"), "alpha");
  assert.deepEqual(h.calls, [`notify ${join(h.root, "data", "foo")}`, `applyRename ${source} ${target}`]);
});

test("download streams a file, zips a folder, and refuses secrets", async (t) => {
  const h = await harness(t);
  const file = await download(h, join(h.root, "data", "foo", "b.bin"));
  assert.equal(file.statusCode, 200);
  assert.deepEqual([...file.rawPayload], [0, 1, 2, 250]);
  assert.match(String(file.headers["content-disposition"]), /filename="b\.bin"/);

  for (const path of [join(h.appdir, ".ssh", "id_ed25519"), h.appdir]) {
    const res = await download(h, path);
    assert.equal(res.statusCode, 403, path);
    assert.equal(res.json().code, "STORAGE_FORBIDDEN");
  }
  // A link to a secret is judged by its target.
  await symlink(join(h.appdir, ".ssh", "id_ed25519"), join(h.root, "data", "foo", "key"));
  const viaLink = await download(h, join(h.root, "data", "foo", "key"));
  assert.equal(viaLink.statusCode, 403);
  assert.ok(!viaLink.body.includes("KEY"));

  if (!resolveZipTool()) return t.diagnostic("no zip tool on PATH: folder zip not exercised");
  const folder = await download(h, join(h.root, "data", "foo", "nested"));
  assert.equal(folder.statusCode, 200);
  assert.equal(folder.headers["content-type"], "application/zip");
  // bsdtar pads stdout to a block boundary; yauzl requires the ZIP end record at EOF.
  const data = folder.rawPayload;
  const end = data.lastIndexOf(Buffer.from("504b0506", "hex"));
  const zip: Buffer = end >= 0 ? data.subarray(0, end + 22 + data.readUInt16LE(end + 20)) : data;
  const names = await new Promise<string[]>((resolve, reject) => {
    yauzl.fromBuffer(zip, (error, archive) => {
      if (error) return reject(error);
      const seen: string[] = [];
      archive.on("entry", (entry: yauzl.Entry) => seen.push(entry.fileName));
      archive.once("error", reject);
      archive.once("end", () => resolve(seen));
    });
  });
  assert.ok(names.includes("nested/a.txt"), names.join(","));
});

test("every action answers 501 off Linux", async (t) => {
  const h = await harness(t, { supported: false });
  const target = join(h.root, "data", "foo");
  const responses = [
    await del(h, { path: target, confirm: "foo" }),
    await ren(h, { path: target, newName: "bar" }),
    await download(h, target)
  ];
  for (const res of responses) {
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().code, "STORAGE_UNSUPPORTED");
  }
  assert.ok(existsSync(target));
});
