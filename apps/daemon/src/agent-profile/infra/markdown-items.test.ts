import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfileBackups } from "./backups.ts";
import { readSkillFiles, scanCommands, scanSkills, writeSkill } from "./markdown-items.ts";

async function scratch(t: test.TestContext): Promise<{ root: string; backups: ProfileBackups }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-md-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  let n = 0;
  return {
    root,
    backups: new ProfileBackups({ dir: join(root, "backups"), now: () => new Date(Date.UTC(2026, 8, 28, 0, 0, n++)) })
  };
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

test("scanSkills lists skill dirs, follows and marks symlinks, tolerates broken ones", async (t) => {
  const { root } = await scratch(t);
  const skills = join(root, "skills");
  await put(join(skills, "review", "SKILL.md"), "---\nname: review\ndescription: '  Review it  '\n---\nbody");
  await put(join(skills, "bad-yaml", "SKILL.md"), "---\nname: [oops\n---\n");
  await put(join(skills, "no-skill-file", "README.md"), "not a skill");
  await put(join(skills, ".system", "builtin", "SKILL.md"), "---\nname: builtin\n---\n");
  await put(join(skills, ".hidden-skill", "SKILL.md"), "---\nname: hidden\n---\n");
  await put(join(skills, "stray.md"), "a file, not a skill");
  await put(join(root, "shared", "brainstorming", "SKILL.md"), "---\ndescription: Shared\n---\n");
  await symlink(join(root, "shared", "brainstorming"), join(skills, "brainstorming"));
  await symlink(join(root, "shared", "gone"), join(skills, "dangling"));
  await mkdir(join(skills, "dir-skill-file", "SKILL.md"), { recursive: true });

  const found = await scanSkills(skills, { source: "user" });
  assert.deepEqual(
    found.map((skill) => [skill.name, skill.isSymlink, skill.description ?? null, skill.error !== undefined]),
    [
      ["bad-yaml", false, null, true],
      ["brainstorming", true, "Shared", false],
      ["dangling", true, null, true],
      ["dir-skill-file", false, null, true],
      ["review", false, "Review it", false]
    ]
  );
  const review = found.find((skill) => skill.name === "review")!;
  assert.equal(review.dir, join(skills, "review"));
  assert.equal(review.skillFile, join(skills, "review", "SKILL.md"));
  assert.equal(review.source, "user");
  assert.deepEqual(review.frontmatter, { name: "review", description: "  Review it  " });
  assert.match(found.find((skill) => skill.name === "bad-yaml")!.error!, /Invalid YAML/);
  assert.match(found.find((skill) => skill.name === "dangling")!.error!, /Broken symlink/);

  const withHidden = await scanSkills(skills, { includeHidden: true });
  assert.ok(withHidden.some((skill) => skill.name === ".hidden-skill"));
  assert.ok(!withHidden.some((skill) => skill.name === ".system"), ".system holds skills one level down");

  assert.deepEqual(await scanSkills(join(root, "missing")), []);
  assert.deepEqual(await scanSkills(join(skills, "stray.md")), []);
});

test("scanCommands lists .md files, one folder level when nested", async (t) => {
  const { root } = await scratch(t);
  const commands = join(root, "commands");
  await put(join(commands, "review.md"), "---\ndescription: Review\n---\nbody");
  await put(join(commands, "plain.md"), "no frontmatter");
  await put(join(commands, "broken.md"), "---\n: : :\n  - [\n---\n");
  await put(join(commands, "notes.txt"), "ignored");
  await put(join(commands, ".hidden.md"), "ignored");
  await put(join(commands, "git", "pr.md"), "---\ndescription: Open a PR\n---\n");
  await put(join(commands, "git", "deep", "too-deep.md"), "ignored");
  await put(join(root, "elsewhere", "linked.md"), "---\ndescription: Linked\n---\n");
  await symlink(join(root, "elsewhere", "linked.md"), join(commands, "linked.md"));
  await symlink(join(root, "elsewhere", "missing.md"), join(commands, "dangling.md"));

  const flat = await scanCommands(commands, { nested: false });
  assert.deepEqual(
    flat.map((command) => [command.name, command.description ?? null, command.isSymlink, command.error !== undefined]),
    [
      ["broken", null, false, true],
      ["dangling", null, true, true],
      ["linked", "Linked", true, false],
      ["plain", null, false, false],
      ["review", "Review", false, false]
    ]
  );
  const nested = await scanCommands(commands, { nested: true });
  assert.deepEqual(
    nested.map((command) => command.name),
    ["broken", "dangling", "git/pr", "linked", "plain", "review"]
  );
  assert.equal(nested.find((command) => command.name === "git/pr")?.file, join(commands, "git", "pr.md"));
  assert.deepEqual(await scanCommands(join(root, "missing"), { nested: true }), []);
});

test("readSkillFiles lists the other files, skipping node_modules and .git, never following links", async (t) => {
  const { root } = await scratch(t);
  const skill = join(root, "skill");
  await put(join(skill, "SKILL.md"), "s");
  await put(join(skill, "scripts", "run.sh"), "x");
  await put(join(skill, "refs", "SKILL.md"), "a nested SKILL.md is just a file");
  await put(join(skill, "node_modules", "dep", "index.js"), "x");
  await put(join(skill, ".git", "HEAD"), "x");
  await put(join(root, "outside", "secret"), "x");
  await symlink(join(root, "outside"), join(skill, "linked-dir"));

  assert.deepEqual(await readSkillFiles(skill), ["linked-dir", "refs/SKILL.md", "scripts/run.sh"]);

});

test("writeSkill writes through a symlinked skill directory and refuses to merge into a broken file", async (t) => {
  const { root, backups } = await scratch(t);
  const skills = join(root, "skills");
  await put(join(root, "shared", "shared-skill", "SKILL.md"), "---\nname: shared-skill\n---\nold");
  await mkdir(skills);
  await symlink(join(root, "shared", "shared-skill"), join(skills, "shared-skill"));
  const result = await writeSkill(skills, { name: "shared-skill", frontmatter: {}, body: "new" }, { backups, agent: "claude" });
  assert.equal(result.path, join(root, "shared", "shared-skill", "SKILL.md"));
  assert.ok((await lstat(join(skills, "shared-skill"))).isSymbolicLink());

  await put(join(skills, "broken", "SKILL.md"), "---\nname: [\n---\n");
  await assert.rejects(writeSkill(skills, { name: "broken", frontmatter: {}, body: "" }, { backups, agent: "claude" }), {
    code: "CONFIG_UNREADABLE"
  });
  assert.equal(await readFile(join(skills, "broken", "SKILL.md"), "utf8"), "---\nname: [\n---\n", "left untouched");
});
