import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FsSandboxError } from "@orquester/config/fs";

import { BoxFsUnavailableError } from "./errors.ts";
import { BoxPaths } from "./paths.ts";
import { BoxProjectFs, HostProjectFs, locateProjectFs } from "./project-fs.ts";
import { boxDiskConnection, fakeBoxRegistry } from "./test-box.ts";

// --- the mapping layer ------------------------------------------------------------------

test("Windows mapping: host → box → host round-trips, and outside paths answer null", () => {
  const paths = new BoxPaths({ kind: "windows-prefix", prefix: "C:\\orq" });
  for (const host of ["/var/lib/orquester/workspaces/acme/engine", "/var/lib/a b/ü.txt", "/"]) {
    const box = paths.toBox(host);
    assert.ok(box.startsWith("C:\\orq"), box);
    assert.equal(paths.toHost(box), host);
  }
  assert.equal(paths.toBox("/var/lib/x/../y//z"), "C:\\orq\\var\\lib\\y\\z", "normalized before mapping");
  assert.equal(paths.toHost("c:/ORQ/var/lib/x"), "/var/lib/x", "case and separators as Windows reads them");
  assert.equal(paths.toHost("C:\\orq\\var\\lib\\x\\..\\y"), "/var/lib/y");
  assert.equal(paths.toHost("D:\\other\\x"), null);
  assert.equal(paths.toHost("C:\\orquester\\x"), null, "a sibling of the prefix is outside it");
  assert.throws(() => paths.toBox("relative/path"));
});

test("Windows mapping: containment compares case-insensitively; POSIX does not", () => {
  const windows = new BoxPaths({ kind: "windows-prefix", prefix: "C:\\orq" });
  assert.deepEqual(windows.segmentsInside("C:\\orq\\var\\Proj", "c:\\ORQ\\var\\proj\\src\\a.ts"), ["src", "a.ts"]);
  assert.deepEqual(windows.segmentsInside("C:\\orq\\var\\proj", "C:\\orq\\var\\proj"), []);
  assert.equal(windows.segmentsInside("C:\\orq\\var\\proj", "C:\\orq\\var\\project2\\a"), null);
  assert.equal(windows.segmentsInside("C:\\orq\\var\\proj", "C:\\orq\\var"), null);

  const posixPaths = new BoxPaths({ kind: "identity" });
  assert.equal(posixPaths.toBox("/a/b"), "/a/b");
  assert.equal(posixPaths.toHost("/a/b"), "/a/b");
  assert.equal(posixPaths.toHost("relative"), null);
  assert.equal(posixPaths.segmentsInside("/a/Proj", "/a/proj/x"), null);
  assert.deepEqual(posixPaths.segmentsInside("/a/proj", "/a/proj/x/y"), ["x", "y"]);
});

// --- containment through the box -----------------------------------------------------------

async function disk(t: test.TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orq-projectfs-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("assertInside realpaths in the box and answers host paths (POSIX and Windows boxes)", async (t) => {
  for (const windows of [false, true]) {
    const root = await disk(t);
    const connection = boxDiskConnection({ disk: root, windows });
    const fs = new BoxProjectFs(connection);
    const project = "/srv/ws/acme/engine";
    const local = connection.local(fs.toBox(project));
    await mkdir(join(local, "src"), { recursive: true });
    await writeFile(join(local, "src", "a.ts"), "a");
    await mkdir(connection.local(fs.toBox("/etc")), { recursive: true });
    await symlink(connection.local(fs.toBox("/etc")), join(local, "etc-link"));
    await symlink(join(local, "src"), join(local, "src-link"));

    assert.equal(await fs.assertInside(project, `${project}/src/a.ts`), `${project}/src/a.ts`);
    assert.equal(await fs.assertInside(project, `${project}/src/new/deeper.ts`), `${project}/src/new/deeper.ts`, "missing tail kept");
    assert.equal(await fs.assertInside(project, `${project}/src-link/a.ts`), `${project}/src/a.ts`, "an in-project link resolves");
    await assert.rejects(fs.assertInside(project, `${project}/etc-link/passwd`), FsSandboxError);
    await assert.rejects(fs.assertInside(project, `${project}/../other`), FsSandboxError);
    assert.equal(await fs.realpath(`${project}/src-link`), `${project}/src`, windows ? "windows" : "posix");
  }
});

test("assertInside answers the root's host spelling when the box's root realpaths elsewhere (macOS /var)", async (t) => {
  const root = await disk(t);
  const connection = boxDiskConnection({ disk: root });
  const fs = new BoxProjectFs(connection);
  // In the box `/var` is a link to `/private/var`, as on macOS.
  await mkdir(connection.local("/private/var/ws/engine/src"), { recursive: true });
  await symlink(connection.local("/private/var"), connection.local("/var"));
  assert.equal(await fs.assertInside("/var/ws/engine", "/var/ws/engine/src/x.ts"), "/var/ws/engine/src/x.ts");
});

test("HostProjectFs and BoxProjectFs answer the same for the same files", async (t) => {
  const root = await disk(t);
  const connection = boxDiskConnection({ disk: root });
  const box = new BoxProjectFs(connection);
  const host = new HostProjectFs();
  // The box disk's `/p` is the host's `<root>/p`: compare each answer, mapped.
  await mkdir(join(root, "p", "d"), { recursive: true });
  await writeFile(join(root, "p", "f.txt"), "hello");
  const boxStat = await box.stat("/p/f.txt");
  const hostStat = await host.stat(join(root, "p", "f.txt"));
  assert.deepEqual(boxStat, hostStat);
  assert.deepEqual(
    (await box.readdir("/p")).sort((a, b) => a.name.localeCompare(b.name)),
    (await host.readdir(join(root, "p"))).sort((a, b) => a.name.localeCompare(b.name))
  );
  assert.equal((await box.read("/p/f.txt", { offset: 1, length: 3 })).toString(), "ell");
  assert.equal((await host.read(join(root, "p", "f.txt"), { offset: 1, length: 3 })).toString(), "ell");
  assert.equal(await box.stat("/p/missing"), null);
  assert.equal(await host.stat(join(root, "p", "missing")), null);
  await box.writeFile("/p/new/w.txt", "box", { mkdirs: true });
  await host.writeFile(join(root, "p", "new", "h.txt"), "host", { mkdirs: true });
  assert.equal((await host.read(join(root, "p", "new", "w.txt"), { length: 64 })).toString(), "box");
  assert.equal((await box.read("/p/new/h.txt", { length: 64 })).toString(), "host");
});

test("read always asks the box for its length, refuses a missing one, and fails when the box sends more", async (t) => {
  const root = await disk(t);
  await mkdir(join(root, "p"), { recursive: true });
  await writeFile(join(root, "p", "f.txt"), "0123456789");
  const connection = boxDiskConnection({ disk: root });
  const asked: (number | undefined)[] = [];
  const inner = connection.readFile;
  connection.readFile = (path, readOptions) => {
    asked.push(readOptions?.length);
    return inner(path, readOptions);
  };
  const box = new BoxProjectFs(connection);
  const host = new HostProjectFs();

  assert.equal((await box.read("/p/f.txt", { length: 4 })).toString(), "0123");
  assert.equal((await box.read("/p/f.txt", { length: 100 })).toString(), "0123456789", "fewer at the end of the file");
  assert.deepEqual(asked, [4, 100]);
  for (const fs of [box, host]) {
    const path = fs === box ? "/p/f.txt" : join(root, "p", "f.txt");
    for (const length of [undefined, Number.POSITIVE_INFINITY, -1, 2.5]) {
      await assert.rejects(fs.read(path, { length } as { length: number }), RangeError, `${fs.location} ${length}`);
    }
  }
  assert.equal(asked.length, 2, "no read went to the box without a length");

  // A box that ignores the range it was asked for: the read fails instead of growing the buffer.
  connection.readFile = (path) => inner(path, {});
  await assert.rejects(box.read("/p/f.txt", { length: 4 }), /more than the 4 bytes/);
});

// --- selection ------------------------------------------------------------------------------

test("locateProjectFs: host without a registry or outside box projects; 409/410 for unusable boxes", async (t) => {
  const root = await disk(t);
  const connection = boxDiskConnection({ disk: root });
  const registry = fakeBoxRegistry({ projectPath: "/ws/acme/engine", connection });
  assert.deepEqual(locateProjectFs(undefined, "/ws/acme/engine/x"), { kind: "host" });
  assert.deepEqual(locateProjectFs(registry, "/ws/acme/other/x"), { kind: "host" });
  assert.deepEqual(locateProjectFs(registry, "/ws/acme/engine/../other"), { kind: "host" }, "resolved before locating");
  const located = locateProjectFs(registry, "/ws/acme/engine/src");
  assert.equal(located.kind, "box");
  assert.equal(located.kind === "box" && located.projectRoot, "/ws/acme/engine");

  connection.setConnected(false);
  assert.throws(() => locateProjectFs(registry, "/ws/acme/engine"), (error: unknown) => error instanceof BoxFsUnavailableError && error.status === 409 && error.code === "BOX_NOT_READY");
  connection.setConnected(true);
  registry.record.state = "provisioning";
  assert.equal(locateProjectFs(registry, "/ws/acme/engine").kind, "box", "a connected box being set up is usable");
  for (const state of ["destroyed", "destroying"]) {
    registry.record.state = state;
    assert.throws(() => locateProjectFs(registry, "/ws/acme/engine"), (error: unknown) => error instanceof BoxFsUnavailableError && error.status === 410 && error.code === "BOX_DESTROYED");
  }
  const neverConnected = fakeBoxRegistry({ projectPath: "/ws/acme/engine", connection: undefined, boxId: "b2" });
  assert.throws(() => locateProjectFs(neverConnected, "/ws/acme/engine"), (error: unknown) => error instanceof BoxFsUnavailableError && error.status === 409);

  // A link that drops mid-call answers 409, not a file error.
  registry.record.state = "ready";
  const fs = new BoxProjectFs(connection);
  connection.setConnected(false);
  await assert.rejects(fs.stat("/ws/acme/engine"), (error: unknown) => error instanceof BoxFsUnavailableError && error.code === "BOX_NOT_READY");
});
