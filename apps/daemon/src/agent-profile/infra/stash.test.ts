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
import { ProfileStash } from "./stash.ts";
import { pathKind } from "./tree.ts";

interface Scratch {
  root: string;
  stash: ProfileStash;
  warnings: string[];
}

async function scratch(t: test.TestContext, stashDir?: string): Promise<Scratch> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-stash-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const stash = new ProfileStash({
    dir: stashDir ?? join(root, "stash"),
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    logger: { warn: (message) => warnings.push(message) }
  });
  return { root, stash, warnings };
}

test("a stashed file moves out and restores byte for byte, mode and all", async (t) => {
  const { root, stash } = await scratch(t);
  const file = join(root, "home", ".claude", "commands", "git", "pr.md");
  await mkdir(join(root, "home", ".claude", "commands", "git"), { recursive: true });
  const bytes = Buffer.from("---\ndescription: PR\n---\r\nbodyé\n", "utf8");
  await writeFile(file, bytes);
  await chmod(file, 0o640);

  const entry = await stash.stashPath("claude", "command", "command:git/pr", "git/pr", file, { description: "PR" });
  assert.equal(await pathKind(file), null, "moved out");
  assert.deepEqual(await readFile(entry.payloadPath!), bytes);

  const manifest = JSON.parse(await readFile(join(entry.dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest, {
    version: 1,
    agent: "claude",
    kind: "command",
    id: "command:git/pr",
    name: "git/pr",
    stashedAt: "2026-09-28T12:00:00.000Z",
    original: { type: "path", path: file },
    meta: { description: "PR" }
  });
  assert.equal((await stat(join(entry.dir, "manifest.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(entry.dir)).mode & 0o777, 0o700);

  const listed = await stash.list("claude");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, "command:git/pr");
  assert.equal(listed[0]?.payloadPath, entry.payloadPath);

  assert.equal(await stash.restorePath("claude", "command", "command:git/pr"), file);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal(await pathKind(entry.dir), null, "the entry is gone");
  assert.deepEqual(await stash.list("claude"), []);
});

test("a stashed directory (with an inner symlink) and a stashed symlink restore intact", async (t) => {
  const { root, stash } = await scratch(t);
  const skill = join(root, "skills", "review");
  await mkdir(join(skill, "refs"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "s");
  await symlink("../SKILL.md", join(skill, "refs", "up"));
  await stash.stashPath("opencode", "skill", "skill:review", "review", skill);
  assert.equal(await pathKind(skill), null);
  await stash.restorePath("opencode", "skill", "skill:review");
  assert.equal(await readFile(join(skill, "SKILL.md"), "utf8"), "s");
  assert.equal(await readlink(join(skill, "refs", "up")), "../SKILL.md");

  const shared = join(root, "shared");
  await mkdir(shared);
  const link = join(root, "skills", "linked");
  await symlink(shared, link);
  const entry = await stash.stashPath("opencode", "skill", "skill:linked", "linked", link);
  assert.ok((await lstat(entry.payloadPath!)).isSymbolicLink(), "the link moved, not its target");
  assert.equal(await pathKind(shared), "dir");
  await stash.restorePath("opencode", "skill", "skill:linked");
  assert.equal(await readlink(link), shared);
});

test("restore refuses with STASH_CONFLICT when the original path is taken, and keeps the entry", async (t) => {
  const { root, stash } = await scratch(t);
  const file = join(root, "cmd.md");
  await writeFile(file, "original");
  await stash.stashPath("claude", "command", "command:cmd", "cmd", file);
  await writeFile(file, "someone else");

  await assert.rejects(stash.restorePath("claude", "command", "command:cmd"), { code: "STASH_CONFLICT" });
  assert.equal(await readFile(file, "utf8"), "someone else");
  const entry = await stash.get("claude", "command", "command:cmd");
  assert.equal(await readFile(entry!.payloadPath!, "utf8"), "original");

  await assert.rejects(stash.restorePath("claude", "command", "command:nope"), { code: "ITEM_NOT_FOUND" });
});

test("stashing an id that is already stashed is refused; remove() then re-stash replaces it", async (t) => {
  const { root, stash } = await scratch(t);
  const file = join(root, "cmd.md");
  await writeFile(file, "first");
  await stash.stashPath("claude", "command", "command:cmd", "cmd", file);
  await writeFile(file, "second");
  await assert.rejects(stash.stashPath("claude", "command", "command:cmd", "cmd", file), { code: "PROFILE_CONFLICT" });
  assert.equal(await readFile(file, "utf8"), "second", "the refused item stays where it was");

  assert.equal(await stash.remove("claude", "command", "command:cmd"), true);
  assert.equal(await stash.remove("claude", "command", "command:cmd"), false);
  const entry = await stash.stashPath("claude", "command", "command:cmd", "cmd", file);
  assert.equal(await readFile(entry.payloadPath!, "utf8"), "second");

  await assert.rejects(stash.stashPath("claude", "command", "command:x", "x", join(root, "missing.md")), {
    code: "ITEM_NOT_FOUND"
  });
});

test("list is sorted, per agent, and skips broken entries with a warning", async (t) => {
  const { root, stash, warnings } = await scratch(t);
  for (const name of ["zeta", "alpha"]) {
    const file = join(root, `${name}.md`);
    await writeFile(file, name);
    await stash.stashPath("grok", "command", `command:${name}`, name, file);
  }
  await stash.stashFragment("grok", "hook", "hook:Stop:0123456789abcdef", "stop", { command: "x" });
  await stash.stashFragment("claude", "hook", "hook:Stop:0123456789abcdef", "stop", { command: "x" });

  // Broken: bad JSON, a foreign manifest, a path entry without payload, an unknown kind dir.
  const commands = join(root, "stash", "grok", "command");
  await mkdir(join(commands, "bad-json"));
  await writeFile(join(commands, "bad-json", "manifest.json"), "{nope");
  await mkdir(join(commands, "foreign"));
  await writeFile(
    join(commands, "foreign", "manifest.json"),
    JSON.stringify({ version: 1, agent: "claude", kind: "command", id: "c", name: "c", stashedAt: "x", original: { type: "path", path: "/x" } })
  );
  await mkdir(join(commands, "no-payload"));
  await writeFile(
    join(commands, "no-payload", "manifest.json"),
    JSON.stringify({ version: 1, agent: "grok", kind: "command", id: "c2", name: "c2", stashedAt: "x", original: { type: "path", path: "/x" } })
  );
  await mkdir(join(root, "stash", "grok", "weird-kind"));
  await mkdir(join(commands, ".in-progress"));

  const listed = await stash.list("grok");
  assert.deepEqual(
    listed.map((entry) => `${entry.kind}:${entry.name}`),
    ["command:alpha", "command:zeta", "hook:stop"]
  );
  assert.equal(warnings.length, 4, warnings.join("\n"));
  assert.deepEqual(await stash.list("opencode"), []);
});

test("a leftover entry that is not usable is replaced instead of blocking the id", async (t) => {
  const { root, stash } = await scratch(t);
  const { dir } = await stash.stashFragment("claude", "command", "command:cmd", "cmd", {});
  await writeFile(join(dir, "manifest.json"), "{half-written");
  const file = join(root, "cmd.md");
  await writeFile(file, "x");
  const entry = await stash.stashPath("claude", "command", "command:cmd", "cmd", file);
  assert.equal(await readFile(entry.payloadPath!, "utf8"), "x");
});

test("long item ids round trip and unsafe stash owners are refused", async (t) => {
  const { stash } = await scratch(t);
  const long = "hook:Stop:" + "x".repeat(1000);
  await stash.stashFragment("claude", "hook", long, "stop", { command: "echo hi" });
  const entry = await stash.get("claude", "hook", long);
  assert.deepEqual(entry?.original, { type: "fragment", data: { command: "echo hi" } });
  await assert.rejects(stash.stashFragment("../outside", "hook", long, "stop", {}), { code: "INVALID_NAME" });
});

test("stash and restore across filesystems copy, fsync and remove", async (t) => {
  let other: string;
  try {
    other = await mkdtemp("/dev/shm/orquester-profile-stash-");
  } catch {
    t.skip("no /dev/shm");
    return;
  }
  t.after(() => rm(other, { recursive: true, force: true }));
  const { root, stash } = await scratch(t, join(other, "stash"));
  if ((await stat(root)).dev === (await stat(other)).dev) {
    t.skip("/dev/shm is on the same filesystem");
    return;
  }
  const skill = join(root, "skills", "x");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "cross");
  await chmod(join(skill, "SKILL.md"), 0o600);
  await symlink("SKILL.md", join(skill, "alias"));
  const entry = await stash.stashPath("claude", "skill", "skill:x", "x", skill);
  assert.equal(await pathKind(skill), null);
  assert.equal(await readFile(join(entry.payloadPath!, "SKILL.md"), "utf8"), "cross");
  await stash.restorePath("claude", "skill", "skill:x");
  assert.equal(await readFile(join(skill, "SKILL.md"), "utf8"), "cross");
  assert.equal((await stat(join(skill, "SKILL.md"))).mode & 0o777, 0o600);
  assert.equal(await readlink(join(skill, "alias")), "SKILL.md");
  assert.deepEqual((await readdir(join(other, "stash", "claude", "skill"))).length, 0);
});
