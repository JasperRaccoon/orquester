import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CloneFileError, scanCandidates, trackedPaths } from "../../../secret-files/files.ts";
import { onPath } from "../../../archive.ts";
import { BoxProjectFs } from "./project-fs.ts";
import { boxAwareSecretFileIo, boxGitRunner, readBoxCloneFile, watchBoxDir, writeBoxCloneFile } from "./secret-files.ts";
import { boxDiskConnection, fakeBoxRegistry, type BoxDiskConnection } from "./test-box.ts";

// The secret-files disk operations for a clone in a box: the host's safety rules, through the box link.

const CLONE = "/ws/acme/engine";

async function setup(t: test.TestContext): Promise<{ fs: BoxProjectFs; connection: BoxDiskConnection; local: (rel?: string) => string; disk: string }> {
  const disk = await realpath(await mkdtemp(join(tmpdir(), "orq-box-secrets-")));
  t.after(() => rm(disk, { recursive: true, force: true }));
  // `ln` names the temp file and the target by their box paths.
  const connection = boxDiskConnection({ disk, argRoots: ["/ws"] });
  const fs = new BoxProjectFs(connection);
  const root = connection.local(fs.toBox(CLONE));
  await mkdir(root, { recursive: true });
  return { fs, connection, disk, local: (rel = "") => (rel ? join(root, ...rel.split("/")) : root) };
}

test("readBoxCloneFile reads a regular file and refuses links, nested repos and outsiders", async (t) => {
  const { fs, local, connection } = await setup(t);
  await mkdir(local("config"), { recursive: true });
  await writeFile(local("config/.env"), "TOKEN=abc\n", { mode: 0o640 });
  const read = await readBoxCloneFile(fs, CLONE, "config/.env");
  assert.equal(read.kind, "file");
  assert.equal(read.kind === "file" && Buffer.from(read.content).toString(), "TOKEN=abc\n");
  assert.equal(read.kind === "file" && read.mode, 0o640);

  assert.deepEqual(await readBoxCloneFile(fs, CLONE, "config/.env.local"), { kind: "missing", parentExists: true });
  assert.deepEqual(await readBoxCloneFile(fs, CLONE, "nope/.env"), { kind: "missing", parentExists: false });

  await mkdir(connection.local("/etc"), { recursive: true });
  await writeFile(connection.local("/etc/.env"), "BOX=secret\n");
  await symlink(connection.local("/etc/.env"), local(".env"));
  assert.deepEqual(await readBoxCloneFile(fs, CLONE, ".env"), { kind: "refused", refusal: "symlink" });
  await symlink(connection.local("/etc"), local("linked"));
  assert.deepEqual(await readBoxCloneFile(fs, CLONE, "linked/.env"), { kind: "refused", refusal: "symlink" });
  await mkdir(local("vendor/sub/.git"), { recursive: true });
  await writeFile(local("vendor/sub/.env"), "X=1\n");
  assert.deepEqual(await readBoxCloneFile(fs, CLONE, "vendor/sub/.env"), { kind: "refused", refusal: "outside" });
  await mkdir(local("dir.env"));
  assert.deepEqual(await readBoxCloneFile(fs, CLONE, "dir.env"), { kind: "refused", refusal: "not-a-file" });

  connection.setConnected(false);
  const io = boxAwareSecretFileIo(() => fakeBoxRegistry({ projectPath: CLONE, connection }));
  assert.deepEqual(await io.files.readCloneFile(CLONE, "config/.env"), { kind: "refused", refusal: "unreadable" }, "an unreachable box reads as unreadable");
});

test("writeBoxCloneFile writes atomically with the mode, never creates folders, and createOnly never replaces", async (t) => {
  const { fs, local } = await setup(t);
  await writeBoxCloneFile(fs, CLONE, ".env", new TextEncoder().encode("A=1\n"), 0o640);
  assert.equal(await readFile(local(".env"), "utf8"), "A=1\n");
  assert.equal((await lstat(local(".env"))).mode & 0o777, 0o640);
  await writeBoxCloneFile(fs, CLONE, ".env", new TextEncoder().encode("A=2\n"));
  assert.equal(await readFile(local(".env"), "utf8"), "A=2\n");

  await assert.rejects(
    writeBoxCloneFile(fs, CLONE, ".env", new TextEncoder().encode("A=3\n"), undefined, { createOnly: true }),
    (error: unknown) => error instanceof CloneFileError && error.exists === true
  );
  assert.equal(await readFile(local(".env"), "utf8"), "A=2\n");
  await writeBoxCloneFile(fs, CLONE, ".env.local", new TextEncoder().encode("B=1\n"), undefined, { createOnly: true });
  assert.equal(await readFile(local(".env.local"), "utf8"), "B=1\n");

  await assert.rejects(
    writeBoxCloneFile(fs, CLONE, "missing/.env", new TextEncoder().encode("x")),
    (error: unknown) => error instanceof CloneFileError && error.parentMissing === true
  );
  await assert.rejects(
    writeBoxCloneFile(fs, CLONE, ".env", new TextEncoder().encode("x"), undefined, { containedIn: "/elsewhere" }),
    (error: unknown) => error instanceof CloneFileError && error.refusal === "outside"
  );
  await writeBoxCloneFile(fs, CLONE, ".env", new TextEncoder().encode("A=4\n"), undefined, { containedIn: "/ws" });
  assert.equal(await readFile(local(".env"), "utf8"), "A=4\n");
  assert.deepEqual((await readdir(local())).filter((name) => name.includes("orq-tmp")), [], "no temp left");
});

test("writeBoxCloneFile refuses a symlink at the target and never writes through it", async (t) => {
  const { fs, local, connection } = await setup(t);
  await mkdir(connection.local("/etc"), { recursive: true });
  await writeFile(connection.local("/etc/target"), "untouched");
  await symlink(connection.local("/etc/target"), local(".env"));
  await assert.rejects(
    writeBoxCloneFile(fs, CLONE, ".env", new TextEncoder().encode("x")),
    (error: unknown) => error instanceof CloneFileError && error.refusal === "symlink"
  );
  assert.equal(await readFile(connection.local("/etc/target"), "utf8"), "untouched");
});

test("git runs in the box for the candidate scan and the tracked check", { skip: !onPath("git") }, async (t) => {
  const { fs, local, connection } = await setup(t);
  await writeFile(local(".gitignore"), ".env*\n!.env.example\n");
  await writeFile(local(".env"), "A=1\n");
  await writeFile(local(".env.example"), "A=\n");
  await mkdir(local("apps/web"), { recursive: true });
  await writeFile(local("apps/web/.env.local"), "B=1\n");
  execFileSync("git", ["init", "-q"], { cwd: local() });
  execFileSync("git", ["add", ".gitignore", ".env.example"], { cwd: local() });
  const git = boxGitRunner(fs);
  assert.deepEqual(await scanCandidates(CLONE, git), [".env", "apps/web/.env.local"]);
  assert.deepEqual([...(await trackedPaths(CLONE, [".env", ".env.example"], git))], [".env.example"]);
  assert.ok(connection.execs.every((exec) => exec.command === "git" && exec.cwd === CLONE), "git ran in the box, in the clone");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(git(CLONE, ["status"], aborted.signal));
});

test("watchBoxDir filters events, invalidates on a link drop, and unsubscribes on close", async (t) => {
  const { fs, connection } = await setup(t);
  const changes: Array<string | null> = [];
  const errors: Error[] = [];
  const handle = watchBoxDir(fs, `${CLONE}/config`, (name) => changes.push(name), (error) => errors.push(error));
  const watch = connection.calls.find((call) => call.method === "fs.watch");
  assert.ok(watch, "fs.watch was requested");
  const { watchId, path, recursive } = watch.params as { watchId: string; path: string; recursive: boolean };
  assert.equal(path, `${CLONE}/config`);
  assert.equal(recursive, false);

  connection.emitEvent("fs.change", { watchId: "someone-else", changes: [{ path: `${CLONE}/config/x`, type: "update" }] });
  connection.emitEvent("fs.change", { watchId, changes: [{ path: `${CLONE}/config/.env`, type: "update" }, { path: `${CLONE}/config/.env.local`, type: "create" }] });
  assert.deepEqual(changes, [".env", ".env.local"]);

  connection.setConnected(false);
  assert.deepEqual(changes, [".env", ".env.local", null], "a link drop asks for a check");
  assert.equal(errors.length, 1, "and reports the watch dead (the check re-arms it)");
  connection.setConnected(true);
  handle.close();
  connection.emitEvent("fs.change", { watchId, changes: [{ path: `${CLONE}/config/.env`, type: "update" }] });
  assert.equal(changes.length, 3, "nothing after close");
  assert.ok(connection.calls.some((call) => call.method === "fs.unwatch" && (call.params as { watchId: string }).watchId === watchId));
});

test("boxAwareSecretFileIo routes host clones to the host helpers and box clones to the box", async (t) => {
  const { connection, local } = await setup(t);
  const hostClone = await realpath(await mkdtemp(join(tmpdir(), "orq-host-clone-")));
  t.after(() => rm(hostClone, { recursive: true, force: true }));
  await writeFile(join(hostClone, ".env"), "HOST=1\n");
  await writeFile(local(".env"), "BOX=1\n");
  const io = boxAwareSecretFileIo(() => fakeBoxRegistry({ projectPath: CLONE, connection }));
  const fromHost = await io.files.readCloneFile(hostClone, ".env");
  const fromBox = await io.files.readCloneFile(CLONE, ".env");
  assert.equal(fromHost.kind === "file" && Buffer.from(fromHost.content).toString(), "HOST=1\n");
  assert.equal(fromBox.kind === "file" && Buffer.from(fromBox.content).toString(), "BOX=1\n");
  assert.equal(typeof (await io.dirIdentity(CLONE)), "string");
  assert.equal(await io.dirIdentity(`${CLONE}/missing`), null);
  const noBoxes = boxAwareSecretFileIo(() => undefined);
  assert.deepEqual(await noBoxes.files.readCloneFile(CLONE, ".env"), { kind: "missing", parentExists: false }, "plugin off: every path is a host path");
});
