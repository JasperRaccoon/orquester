import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  claudeCommandNamesIn,
  claudeInstalledPluginIds,
  claudePluginEntryIds,
  claudePluginNameOf,
  claudePluginSkillName,
  claudeProjectEntryNames,
  claudeProjectMcpServers,
  claudeSkillNamesIn,
  isValidClaudePluginName
} from "./claude-names.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-claude-names-"));
  roots.push(dir);
  return dir;
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const skill = (name?: string): string => `---\n${name !== undefined ? `name: ${name}\n` : ""}description: d\n---\nbody\n`;

describe("Claude names (as observed on Claude Code 2.1.285)", () => {
  it("a skill is its directory — the frontmatter name is display only; symlinked skill dirs count", async () => {
    const dir = await root();
    await write(join(dir, "skills", "a", "SKILL.md"), skill());
    await write(join(dir, "skills", "dir-name", "SKILL.md"), skill("front-name"));
    await write(join(dir, "skills", "no-skill", "README.md"), "x");
    await write(join(dir, "elsewhere", "linked", "SKILL.md"), skill("linked"));
    await symlink(join(dir, "elsewhere", "linked"), join(dir, "skills", "link"));
    // Probed on 2.1.307: `skills: ["dir-name"]` keeps that skill, `skills: ["front-name"]` hides it.
    assert.deepEqual(await claudeSkillNamesIn(join(dir, "skills")), ["a", "dir-name", "link"]);
    assert.deepEqual(await claudeSkillNamesIn(join(dir, "missing")), []);
  });

  it("a command is its path below the root, joined by `:`", async () => {
    const dir = await root();
    await write(join(dir, "commands", "review.md"), "x");
    await write(join(dir, "commands", "git", "pr.md"), "x");
    await write(join(dir, "commands", "git", "deep", "x.md"), "x");
    await write(join(dir, "commands", "notes.txt"), "x");
    assert.deepEqual(await claudeCommandNamesIn(join(dir, "commands")), ["git:deep:x", "git:pr", "review"]);
  });

  it("plugin ids: commands then skills; manifest skills add to skills/, manifest commands replace commands/", async () => {
    const dir = join(await root(), "plugin");
    await write(join(dir, "skills", "s1", "SKILL.md"), skill());
    await write(join(dir, "commands", "c1.md"), "x");
    assert.deepEqual(await claudePluginEntryIds(dir, "pl"), ["pl:c1", "pl:s1"]);

    await write(join(dir, "extra-skills", "s2", "SKILL.md"), skill("s2"));
    await write(join(dir, "one-skill", "SKILL.md"), skill("solo"));
    await write(join(dir, "custom", "sub", "c2.md"), "x");
    await write(join(dir, "single.md"), "x");
    await write(join(dir, "..", "outside.md"), "outside");
    const absolute = join(dir, "absolute.md");
    await write(absolute, "absolute");
    assert.deepEqual(
      await claudePluginEntryIds(dir, "pl", {
        skills: ["./extra-skills/", "./one-skill"],
        commands: ["./custom/", "./single.md", "../outside.md", absolute]
      }),
      ["pl:sub:c2", "pl:single", "pl:s1", "pl:s2", "pl:solo"]
    );
  });

  it("plugin skill ids are the loader's: folder names sanitised, a single SKILL.md by its frontmatter name", async () => {
    const dir = await root();
    await write(join(dir, "skills", "my.folder", "SKILL.md"), skill("front-name"));
    await write(join(dir, "skills", "with space", "SKILL.md"), skill());
    await write(join(dir, "one", "SKILL.md"), skill("dot.plug:So Lo"));
    assert.deepEqual(await claudePluginEntryIds(dir, "dot.plug", { skills: ["./one"] }), [
      "dot.plug:my-folder",
      "dot.plug:with-space",
      "dot.plug:So-Lo"
    ]);
    // A plugin that is itself one skill, declaring none, is named by its directory.
    const solo = join(dir, "solo-plugin");
    await write(join(solo, "SKILL.md"), skill());
    assert.deepEqual(await claudePluginEntryIds(solo, "item-1", {}), ["item-1:solo-plugin"]);
  });

  it("one naming for a plugin and its skills, dotted plugin names included", () => {
    assert.equal(claudePluginSkillName("dot.plug", "my.folder"), "dot.plug:my-folder");
    assert.equal(claudePluginSkillName("p", "dir", "p:Named"), "p:Named");
    assert.equal(claudePluginSkillName("p", "dir", "  "), "p:dir");
    assert.equal(claudePluginNameOf({ name: "dot.plug" }, "item-1"), "dot.plug");
    assert.equal(claudePluginNameOf({}, "item-1"), "item-1", "no manifest name: the directory's");
    assert.equal(claudePluginNameOf(null, "item-1"), "item-1");
    assert.equal(claudePluginNameOf({ name: 3 }, "item-1"), "item-1");
    assert.equal(claudePluginNameOf({ name: "bad name" }, "item-1"), null, "the CLI refuses it");
    for (const bad of ["", "a@b", "a:b", "a/b", "a\\b", "a\u200bb"]) assert.equal(isValidClaudePluginName(bad), false, bad);
    for (const good of ["toolbox", "my.plugin", "A_b-1", "plüg"]) assert.equal(isValidClaudePluginName(good), true, good);
  });

  it("project entries: `.claude/` of the cwd and its ancestors, stopping below the home", async () => {
    const dir = await root();
    const home = join(dir, "home");
    const project = join(home, "work", "proj");
    await write(join(home, ".claude", "skills", "user-skill", "SKILL.md"), skill());
    await write(join(home, "work", ".claude", "commands", "above.md"), "x");
    await write(join(project, ".claude", "skills", "proj-skill", "SKILL.md"), skill());
    await write(join(project, ".claude", "commands", "git", "x.md"), "x");
    await mkdir(join(project, "sub"), { recursive: true });
    assert.deepEqual(await claudeProjectEntryNames(join(project, "sub"), home), ["git:x", "proj-skill", "above"]);
  });

  it("project MCP: every `.mcp.json` from the cwd up, the nearest definition winning", async () => {
    const dir = await root();
    await write(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "far" }, top: { command: "t" } } }));
    await write(join(dir, "proj", ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "near" } } }));
    await write(join(dir, "proj", "sub", ".mcp.json"), "{not json");
    const servers = await claudeProjectMcpServers(join(dir, "proj", "sub"));
    assert.deepEqual(servers.shared, { command: "near" });
    assert.deepEqual(servers.top, { command: "t" });
  });

  it("installed plugin ids from installed_plugins.json (v2), none when it is missing", async () => {
    const dir = await root();
    assert.deepEqual(await claudeInstalledPluginIds(dir), []);
    await write(
      join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "a@mkt": [{ scope: "user" }], "b@other": [] } })
    );
    assert.deepEqual(await claudeInstalledPluginIds(dir), ["a@mkt", "b@other"]);
  });
});
