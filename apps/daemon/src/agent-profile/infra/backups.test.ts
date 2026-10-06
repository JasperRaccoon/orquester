import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfileBackups } from "./backups.ts";

async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orquester-profile-backups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A clock that ticks one second per call. */
function ticking(): () => Date {
  let n = 0;
  return () => new Date(Date.UTC(2026, 8, 28, 10, 0, n++));
}

test("save copies a file with its mode, and answers null for a missing path", async (t) => {
  const root = await scratch(t);
  const backups = new ProfileBackups({ dir: join(root, "backups"), now: ticking() });
  const file = join(root, "claude.json");
  await writeFile(file, '{"a":1}\n');
  await chmod(file, 0o600);

  const saved = await backups.save("claude", file);
  assert.ok(saved !== null);
  assert.equal(await readFile(saved, "utf8"), '{"a":1}\n');
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "backups", "claude"))).mode & 0o777, 0o700);

  assert.equal(await backups.save("claude", join(root, "missing.json")), null);
  await assert.rejects(backups.save("../x", file), { code: "INVALID_NAME" });
});

test("save copies a directory tree, keeping inner symlinks as symlinks", async (t) => {
  const root = await scratch(t);
  const backups = new ProfileBackups({ dir: join(root, "backups"), now: ticking() });
  const skill = join(root, "skills", "review");
  await mkdir(join(skill, "refs"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: review\n---\n");
  await writeFile(join(skill, "refs", "a.md"), "A");
  await symlink("/etc/hostname", join(skill, "link"));

  const saved = await backups.save("claude", skill);
  assert.ok(saved !== null);
  assert.equal(await readFile(join(saved, "SKILL.md"), "utf8"), "---\nname: review\n---\n");
  assert.equal(await readFile(join(saved, "refs", "a.md"), "utf8"), "A");
  assert.ok((await lstat(join(saved, "link"))).isSymbolicLink());
  assert.equal(await readlink(join(saved, "link")), "/etc/hostname");
});

test("the ring keeps the newest 50 entries per agent", async (t) => {
  const root = await scratch(t);
  const backups = new ProfileBackups({ dir: join(root, "backups"), now: ticking() });
  const file = join(root, "settings.json");
  for (let i = 0; i < 52; i += 1) {
    await writeFile(file, `v${i}`);
    await backups.save("claude", file);
  }
  await writeFile(file, "codex");
  await backups.save("codex", file);

  const kept = (await readdir(join(root, "backups", "claude"))).sort().map((name) => join(root, "backups", "claude", name));
  assert.equal(kept.length, 50);
  assert.deepEqual(
    await Promise.all(kept.map((path) => readFile(path, "utf8"))),
    Array.from({ length: 50 }, (_, i) => `v${i + 2}`),
    "oldest pruned first"
  );
  assert.equal((await readdir(join(root, "backups", "codex"))).length, 1, "another agent's ring is separate");
});

test("two saves in one millisecond both survive, in order", async (t) => {
  const root = await scratch(t);
  const fixed = new Date(Date.UTC(2026, 8, 28));
  const backups = new ProfileBackups({ dir: join(root, "backups"), now: () => fixed });
  const file = join(root, "a.md");
  await writeFile(file, "one");
  await backups.save("claude", file);
  await writeFile(file, "two");
  await backups.save("claude", file);
  const names = await readdir(join(root, "backups", "claude"));
  assert.equal(names.length, 2);
  assert.deepEqual(
    await Promise.all(names.sort().map((name) => readFile(join(root, "backups", "claude", name), "utf8"))),
    ["one", "two"]
  );
});
