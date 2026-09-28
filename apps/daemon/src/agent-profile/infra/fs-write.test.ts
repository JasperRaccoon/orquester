import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfileBackups } from "./backups.ts";
import {
  readTextIfExists,
  removeProfilePath,
  resolveWriteTarget,
  writeProfileFile,
  writeProfileFileVerified
} from "./fs-write.ts";
import { copyTree, pathKind } from "./tree.ts";

interface Scratch {
  root: string;
  backups: ProfileBackups;
  opts: { backups: ProfileBackups; agent: string };
}

async function scratch(t: test.TestContext): Promise<Scratch> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-write-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let n = 0;
  const backups = new ProfileBackups({ dir: join(root, "backups"), now: () => new Date(Date.UTC(2026, 8, 28, 0, 0, n++)) });
  return { root, backups, opts: { backups, agent: "claude" } };
}

test("a new file gets the default mode, parents are created, no backup is taken", async (t) => {
  const { root, opts, backups } = await scratch(t);
  const target = join(root, "home", ".claude", "commands", "git", "pr.md");
  const result = await writeProfileFile(target, "hello", opts);
  assert.deepEqual(result, { path: target, backup: null });
  assert.equal(await readFile(target, "utf8"), "hello");
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  assert.deepEqual(await backups.list("claude"), []);

  const secret = join(root, "home", "secret.json");
  await writeProfileFile(secret, "{}", { ...opts, defaultMode: 0o600 });
  assert.equal((await stat(secret)).mode & 0o777, 0o600);
});

test("an existing file keeps its mode and its previous version is backed up", async (t) => {
  const { root, opts } = await scratch(t);
  const target = join(root, ".claude.json");
  await writeFile(target, "v1");
  await chmod(target, 0o600);
  const result = await writeProfileFile(target, "v2", opts);
  assert.equal(await readFile(target, "utf8"), "v2");
  assert.equal((await stat(target)).mode & 0o777, 0o600, "0600 stays 0600");
  assert.ok(result.backup !== null);
  assert.equal(await readFile(result.backup, "utf8"), "v1");
  // No temp file is left beside it.
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp")), []);
});

test("writing through a symlink updates the target and keeps the link", async (t) => {
  const { root, opts } = await scratch(t);
  await mkdir(join(root, "dotfiles"));
  await mkdir(join(root, "home"));
  const real = join(root, "dotfiles", "settings.json");
  const link = join(root, "home", "settings.json");
  await writeFile(real, "old");
  await chmod(real, 0o640);
  await symlink(real, link);

  const result = await writeProfileFile(link, "new", opts);
  assert.equal(result.path, real);
  assert.ok((await lstat(link)).isSymbolicLink(), "the link is still a link");
  assert.equal(await readlink(link), real);
  assert.equal(await readFile(real, "utf8"), "new");
  assert.equal((await stat(real)).mode & 0o777, 0o640);
  assert.equal(await readFile(result.backup!, "utf8"), "old");
});

test("a write through a symlinked parent directory lands in the real directory", async (t) => {
  const { root, opts } = await scratch(t);
  await mkdir(join(root, "shared", "skills"), { recursive: true });
  await mkdir(join(root, "home"));
  await symlink(join(root, "shared", "skills"), join(root, "home", "skills"));
  const result = await writeProfileFile(join(root, "home", "skills", "x", "SKILL.md"), "s", opts);
  assert.equal(result.path, join(root, "shared", "skills", "x", "SKILL.md"));
  assert.equal(await readFile(result.path, "utf8"), "s");
  assert.ok((await lstat(join(root, "home", "skills"))).isSymbolicLink());
});

test("a dangling symlink is followed to the file it names, which is created", async (t) => {
  const { root, opts } = await scratch(t);
  await mkdir(join(root, "home"));
  const real = join(root, "system", "CLAUDE.md");
  await symlink("../system/CLAUDE.md", join(root, "home", "CLAUDE.md"));
  assert.equal(await resolveWriteTarget(join(root, "home", "CLAUDE.md")), real);
  await writeProfileFile(join(root, "home", "CLAUDE.md"), "hi", opts);
  assert.equal(await readFile(real, "utf8"), "hi");
  assert.ok((await lstat(join(root, "home", "CLAUDE.md"))).isSymbolicLink());
  assert.equal(await readFile(join(root, "home", "CLAUDE.md"), "utf8"), "hi");
});

test("a symlink loop is refused", async (t) => {
  const { root, opts } = await scratch(t);
  await symlink(join(root, "b"), join(root, "a"));
  await symlink(join(root, "a"), join(root, "b"));
  await assert.rejects(writeProfileFile(join(root, "a"), "x", opts));
});

test("writing onto a directory is refused", async (t) => {
  const { root, opts } = await scratch(t);
  await mkdir(join(root, "dir"));
  await assert.rejects(writeProfileFile(join(root, "dir"), "x", opts), { code: "INVALID_REQUEST" });
});

test("a verified write that no longer parses is rolled back from its backup", async (t) => {
  const { root, opts } = await scratch(t);
  const target = join(root, "config.json");
  await writeFile(target, '{"ok":true}');
  await chmod(target, 0o600);
  const verify = (text: string): unknown => JSON.parse(text);

  await assert.rejects(writeProfileFileVerified(target, "{broken", { ...opts, verify }), (error: Error & { code?: string }) => {
    assert.equal(error.code, "WRITE_VERIFY_FAILED");
    assert.match(error.message, /config\.json/);
    return true;
  });
  assert.equal(await readFile(target, "utf8"), '{"ok":true}');
  assert.equal((await stat(target)).mode & 0o777, 0o600);

  const ok = await writeProfileFileVerified(target, '{"ok":false}', { ...opts, verify });
  assert.equal(await readFile(ok.path, "utf8"), '{"ok":false}');
});

test("a verified write of a NEW file that fails removes it again", async (t) => {
  const { root, opts } = await scratch(t);
  const target = join(root, "new.json");
  await assert.rejects(
    writeProfileFileVerified(target, "nope", {
      ...opts,
      verify: () => {
        throw new Error("bad");
      }
    }),
    { code: "WRITE_VERIFY_FAILED" }
  );
  assert.equal(await pathKind(target), null);
});

test("removeProfilePath backs up and deletes files and trees; a symlink loses only the link", async (t) => {
  const { root, opts, backups } = await scratch(t);
  const file = join(root, "cmd.md");
  await writeFile(file, "c");
  const removedFile = await removeProfilePath(file, opts);
  assert.equal(removedFile.removed, true);
  assert.equal(await pathKind(file), null);
  assert.equal(await readFile(removedFile.backup!, "utf8"), "c");

  const dir = join(root, "skills", "one");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "s");
  const removedDir = await removeProfilePath(dir, opts);
  assert.equal(await pathKind(dir), null);
  assert.equal(await readFile(join(removedDir.backup!, "SKILL.md"), "utf8"), "s");

  const shared = join(root, "shared-skill");
  await mkdir(shared);
  await writeFile(join(shared, "SKILL.md"), "keep me");
  const link = join(root, "skills", "linked");
  await symlink(shared, link);
  const removedLink = await removeProfilePath(link, opts);
  assert.equal(await pathKind(link), null);
  assert.equal(await readFile(join(shared, "SKILL.md"), "utf8"), "keep me", "the target is untouched");
  assert.equal(await pathKind(removedLink.backup!), "symlink");

  assert.deepEqual(await removeProfilePath(join(root, "nothing"), opts), { removed: false, backup: null });
  assert.equal((await backups.list("claude")).length, 3);
});

test("readTextIfExists and pathKind", async (t) => {
  const { root } = await scratch(t);
  await writeFile(join(root, "f"), "text");
  await symlink(join(root, "f"), join(root, "l"));
  assert.equal(await readTextIfExists(join(root, "f")), "text");
  assert.equal(await readTextIfExists(join(root, "missing")), null);
  assert.equal(await readTextIfExists(join(root, "f", "under-a-file")), null);
  assert.equal(await pathKind(join(root, "f")), "file");
  assert.equal(await pathKind(join(root, "l")), "symlink");
  assert.equal(await pathKind(root), "dir");
  assert.equal(await pathKind(join(root, "missing")), null);
});

test("copyTree follows the root, refuses or skips inner symlinks", async (t) => {
  const { root } = await scratch(t);
  const src = join(root, "repo", "skill");
  await mkdir(join(src, "scripts"), { recursive: true });
  await writeFile(join(src, "SKILL.md"), "s");
  await writeFile(join(src, "scripts", "run.sh"), "#!/bin/sh\n");
  await chmod(join(src, "scripts", "run.sh"), 0o755);
  await symlink(join(root, "repo", "skill"), join(root, "linked-skill"));

  // The root may be a symlink; without inner links everything is copied, modes kept.
  const plain = await copyTree(join(root, "linked-skill"), join(root, "out", "plain"), { refuseSymlinks: true });
  assert.deepEqual(plain, { files: 2, skipped: [] });
  assert.equal((await stat(join(root, "out", "plain", "scripts", "run.sh"))).mode & 0o777, 0o755);

  await symlink("/etc/passwd", join(src, "scripts", "evil"));
  await assert.rejects(copyTree(src, join(root, "out", "refused"), { refuseSymlinks: true }), (error: Error & { code?: string }) => {
    assert.equal(error.code, "IMPORT_FAILED");
    assert.match(error.message, /scripts\/evil/);
    return true;
  });
  assert.equal(await pathKind(join(root, "out", "refused")), null, "nothing left behind");

  const skipped = await copyTree(src, join(root, "out", "skipped"), { refuseSymlinks: false });
  assert.deepEqual(skipped, { files: 2, skipped: ["scripts/evil"] });
  assert.equal(await pathKind(join(root, "out", "skipped", "scripts", "evil")), null);

  // An existing destination is never merged into.
  await assert.rejects(copyTree(src, join(root, "out", "skipped"), { refuseSymlinks: false }), { code: "EEXIST" });
  assert.equal(await readFile(join(root, "out", "skipped", "SKILL.md"), "utf8"), "s");
});
