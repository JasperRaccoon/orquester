import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  claudeCommandNamesIn,
  claudeInstalledPluginIds,
  claudePluginEntryIds,
  claudeProjectEntryNames,
  claudeProjectMcpServers,
  claudeSkillNamesIn,
  MAX_CLAUDE_FILE_BYTES,
  readJsonObject,
  type ClaudeNamesFs
} from "./claude-names.ts";
import { HostProjectFs } from "../boxes/remote/fs/project-fs.ts";

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
  it("a skill is its frontmatter name, else its directory; symlinked skill dirs count", async () => {
    const dir = await root();
    await write(join(dir, "skills", "a", "SKILL.md"), skill());
    await write(join(dir, "skills", "dir-name", "SKILL.md"), skill("front-name"));
    await write(join(dir, "skills", "no-skill", "README.md"), "x");
    await write(join(dir, "elsewhere", "linked", "SKILL.md"), skill("linked"));
    await symlink(join(dir, "elsewhere", "linked"), join(dir, "skills", "link"));
    assert.deepEqual(await claudeSkillNamesIn(join(dir, "skills")), ["a", "front-name", "linked"]);
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
    const dir = await root();
    await write(join(dir, "skills", "s1", "SKILL.md"), skill());
    await write(join(dir, "commands", "c1.md"), "x");
    assert.deepEqual(await claudePluginEntryIds(dir, "pl"), ["pl:c1", "pl:s1"]);

    await write(join(dir, "extra-skills", "s2", "SKILL.md"), skill("s2"));
    await write(join(dir, "one-skill", "SKILL.md"), skill("solo"));
    await write(join(dir, "custom", "sub", "c2.md"), "x");
    await write(join(dir, "single.md"), "x");
    assert.deepEqual(
      await claudePluginEntryIds(dir, "pl", {
        skills: ["./extra-skills/", "./one-skill"],
        commands: ["./custom/", "./single.md", "../outside.md", "/abs"]
      }),
      ["pl:sub:c2", "pl:single", "pl:s1", "pl:s2", "pl:solo"]
    );
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

  it("file reads are bounded: one byte past the cap is asked for, and a file past it reads as unreadable", async () => {
    const dir = await root();
    const file = join(dir, ".mcp.json");
    await write(file, JSON.stringify({ mcpServers: {} }));
    const host = new HostProjectFs();
    const asked: (number | undefined)[] = [];
    let pad = 0;
    // Once padded, the file is past the cap: trailing spaces, still valid JSON were it parsed.
    const fs: ClaudeNamesFs = {
      stat: (path, options) => host.stat(path, options),
      readdir: (path) => host.readdir(path),
      read: async (path, options) => {
        asked.push(options.length);
        const bytes = await host.read(path, options);
        return pad > 0 ? Buffer.concat([bytes, Buffer.alloc(Math.min(pad, options.length - bytes.length), 0x20)]) : bytes;
      }
    };
    assert.deepEqual(await readJsonObject(file, fs), { mcpServers: {} });
    pad = MAX_CLAUDE_FILE_BYTES;
    assert.equal(await readJsonObject(file, fs), null, "a file past the cap is not parsed");
    assert.deepEqual(asked, [MAX_CLAUDE_FILE_BYTES + 1, MAX_CLAUDE_FILE_BYTES + 1]);
  });
});
