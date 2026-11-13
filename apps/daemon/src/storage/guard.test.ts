import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStorageGuard, readMountPoints, type StorageGuard } from "./guard.ts";

// A miniature host: `root` plays "/", the appdir is the service user's home
// (as on a deployed host), `/data` is a second volume.
interface Host {
  root: string;
  appdir: string;
  workspaces: string;
  guard: StorageGuard;
  p(...segments: string[]): string;
}

async function host(t: test.TestContext): Promise<Host> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-storage-guard-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = (...segments: string[]): string => join(root, ...segments);
  const appdir = p("var", "lib", "orquester");
  const workspaces = join(appdir, "workspaces");
  for (const dir of [
    join(workspaces, "acme", "game", "src"),
    join(appdir, "daemon", "agent-accounts", "claude", "a1", "home"),
    join(appdir, ".ssh"),
    join(appdir, ".claude"),
    join(appdir, ".cache", "pip"),
    join(appdir, ".npm", "_cacache"),
    join(appdir, "go", "pkg", "mod"),
    join(appdir, "bin"),
    p("var", "lib", "orquester2", "junk"),
    p("opt", "orquester", "apps"),
    p("opt", "orquester-tools", "gdu", "v5"),
    p("etc", "orquester"),
    p("data", "foo"),
    p("usr", "share")
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(appdir, ".ssh", "id_ed25519"), "KEY");
  await writeFile(join(appdir, ".claude.json"), "{}");
  await writeFile(join(appdir, ".claude.json.bak-1"), "{}");
  await writeFile(join(appdir, "daemon", "agent-accounts", "claude", "a1", "home", ".credentials.json"), "{}");
  await writeFile(join(workspaces, "acme", "game", "src", "main.ts"), "x");
  const guard = createStorageGuard({
    rootDir: root,
    mountPoints: () => [root, p("data"), p("var", "lib", "docker", "overlay", "abc", "merged")],
    appdir,
    homeDir: appdir,
    workspacesDir: workspaces,
    fsRoot: workspaces,
    daemonCheckoutDir: p("opt", "orquester"),
    toolDirs: [p("opt", "orquester-tools", "gdu")],
    secretPaths: [p("etc", "orquester")]
  });
  return { root, appdir, workspaces, guard, p };
}

test("delete and rename refuse the system skeleton, mount points and Orquester's own state, with a reason", async (t) => {
  const h = await host(t);
  const refused = [
    h.root, // the root
    h.p("usr"), // a direct child of the root
    h.p("data"), // a volume root (mount point)
    h.p("var", "lib", "docker", "overlay", "abc", "merged"), // a nested mount point
    h.p("var", "lib", "docker"), // an ancestor of a mount point
    join(h.appdir, "daemon"),
    join(h.appdir, "daemon", "agent-accounts", "claude"), // inside the daemon state
    join(h.appdir, "app", "remotes.json"), // inside the client state
    h.p("opt", "orquester", "apps"), // inside the running checkout
    h.workspaces, // the workspaces root (and fsRoot) itself
    h.p("opt", "orquester-tools", "gdu", "v5"), // inside a tool dir
    join(h.appdir, ".ssh", "id_ed25519"), // inside a protected home entry
    join(h.appdir, ".claude.json"),
    join(h.appdir, "bin"),
    join(h.appdir, "tmp"), // protected whether or not it exists yet
    h.p("etc", "orquester"),
    h.appdir, // ancestors of protected entries
    h.p("var", "lib")
  ];
  for (const path of refused) {
    const actions = h.guard.actionsFor(path, "dir");
    assert.equal(typeof actions.delete, "string", `delete ${path}`);
    assert.ok(actions.delete, `delete ${path} has a reason`);
    assert.equal(typeof actions.rename, "string", `rename ${path}`);
  }
});

test("caches, project contents, top-level folders of a data volume and look-alike names stay actionable", async (t) => {
  const h = await host(t);
  const allowed = [
    join(h.appdir, ".cache"),
    join(h.appdir, ".npm", "_cacache"),
    join(h.appdir, "go", "pkg", "mod"),
    h.p("data", "foo"),
    join(h.workspaces, "acme"),
    join(h.workspaces, "acme", "game", "src", "main.ts"),
    // segment-aware prefixes: none of these is inside (or an ancestor of) a protected path
    h.p("var", "lib", "orquester2", "junk"),
    join(h.appdir, "daemon2"),
    join(h.appdir, ".sshx"),
    h.p("opt", "orquester-tools", "gdux"),
    // contents of protected parents' siblings, and of a direct child of the root
    h.p("usr", "share")
  ];
  for (const path of allowed) {
    const actions = h.guard.actionsFor(path, "dir");
    assert.equal(actions.delete, null, `delete ${path}: ${actions.delete}`);
    assert.equal(actions.rename, null, `rename ${path}: ${actions.rename}`);
  }
});

test("download refuses secrets and any folder whose zip would contain one", async (t) => {
  const h = await host(t);
  const secrets = [
    join(h.appdir, "daemon", "agent-accounts", "claude", "a1", "home", ".credentials.json"),
    join(h.appdir, ".ssh", "id_ed25519"),
    join(h.appdir, ".claude.json"),
    join(h.appdir, ".claude.json.bak-1"),
    join(h.appdir, "app", "remotes.json"),
    join(h.appdir, ".claude"),
    h.p("etc", "orquester")
  ];
  for (const path of secrets) {
    assert.ok(h.guard.actionsFor(path, "file").download, `download ${path}`);
  }
  for (const path of [h.appdir, h.p("var"), h.p("etc"), h.root]) {
    assert.match(h.guard.actionsFor(path, "dir").download ?? "", /contains/, `download ${path}`);
  }
  for (const path of [h.workspaces, join(h.workspaces, "acme", "game"), h.p("usr"), h.p("data"), join(h.appdir, ".cache")]) {
    assert.equal(h.guard.actionsFor(path, "dir").download, null, `download ${path}`);
  }
});

test("only deletes outside the workspaces root need the typed name", async (t) => {
  const h = await host(t);
  assert.equal(h.guard.actionsFor(join(h.workspaces, "acme", "game"), "dir").confirmDelete, false);
  assert.equal(h.guard.actionsFor(h.p("data", "foo"), "dir").confirmDelete, true);
  assert.equal(h.guard.actionsFor(join(h.appdir, ".cache"), "dir").confirmDelete, true);
});

test("projectFor names the project a path is in", async (t) => {
  const h = await host(t);
  const project = { workspace: "acme", project: "game", projectPath: join(h.workspaces, "acme", "game") };
  assert.deepEqual(h.guard.projectFor(join(h.workspaces, "acme", "game", "src", "main.ts")), project);
  assert.deepEqual(h.guard.projectFor(join(h.workspaces, "acme", "game")), project);
  assert.equal(h.guard.projectFor(join(h.workspaces, "acme")), undefined);
  assert.equal(h.guard.projectFor(`${h.workspaces}2/acme/game`), undefined);
  assert.equal(h.guard.projectFor(h.p("data", "foo")), undefined);
});

test("check judges a path through a symlinked parent where it really is", async (t) => {
  const h = await host(t);
  const link = h.p("data", "foo", "link");
  await symlink(join(h.appdir, "daemon"), link);
  await symlink(join(h.appdir, ".ssh", "id_ed25519"), h.p("data", "foo", "key"));

  const through = await h.guard.check("delete", join(link, "agent-accounts"));
  assert.equal(through.ok, false);
  assert.equal(!through.ok && through.status, 403);
  // `..` is resolved before the symlink is judged too.
  const dotdot = await h.guard.check("rename", h.p("data", "foo", "..", "foo", "link", "agent-accounts"));
  assert.equal(!dotdot.ok && dotdot.code, "STORAGE_FORBIDDEN");

  // The link itself is an entry of /data/foo: deleting it only removes the link.
  const itself = await h.guard.check("delete", link);
  assert.ok(itself.ok);
  assert.equal(itself.ok && itself.path, link);
  assert.ok(itself.ok && itself.stats.isSymbolicLink());

  // Downloading reads through the link, so the target is what is judged.
  const key = await h.guard.check("download", h.p("data", "foo", "key"));
  assert.equal(!key.ok && key.code, "STORAGE_FORBIDDEN");
  const viaParent = await h.guard.check("download", join(link, "agent-accounts"));
  assert.equal(!viaParent.ok && viaParent.code, "STORAGE_FORBIDDEN");
});

test("check answers not found for a missing path", async (t) => {
  const h = await host(t);
  for (const action of ["delete", "rename", "download"] as const) {
    const result = await h.guard.check(action, h.p("data", "nope", "x"));
    assert.equal(!result.ok && result.code, "STORAGE_PATH_NOT_FOUND", action);
  }
});

test("readMountPoints lists every mount point once, decoding escaped characters", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-mountinfo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "mountinfo");
  await writeFile(
    file,
    [
      "22 1 9:2 / / rw,relatime shared:1 - ext4 /dev/md2 rw",
      "30 22 9:2 /etc /etc ro,relatime shared:1 - ext4 /dev/md2 rw",
      "31 22 9:3 / /data rw,relatime shared:2 - ext4 /dev/md3 rw",
      "32 31 9:3 /x /mnt/my\\040disk rw - ext4 /dev/md3 rw",
      "33 22 9:2 /etc /etc ro,relatime shared:1 - ext4 /dev/md2 rw",
      ""
    ].join("\n")
  );
  assert.deepEqual(readMountPoints(file), ["/", "/etc", "/data", "/mnt/my disk"]);
  assert.deepEqual(readMountPoints(join(dir, "missing")), []);
});
