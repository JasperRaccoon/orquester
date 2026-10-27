import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { claudePreparedSectionSchema } from "../manifest/claude.ts";
import { claudePreparer } from "./claude.ts";
import { FIXTURE_SECRETS, makeClaudeProfileFixture } from "./claude.testing.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      out.push(relative(dir, full) + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return out;
}

async function prepare(settings: Parameters<typeof makeClaudeProfileFixture>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "orq-claude-preparer-"));
  roots.push(root);
  const fixture = await makeClaudeProfileFixture(root, settings);
  const stagingDir = join(root, "staging");
  await mkdir(stagingDir, { mode: 0o700 });
  const preparedDir = "/appdir/prepared/p1/claude/shared/v-1";
  const section = await claudePreparer.prepare(fixture.context({ stagingDir, preparedDir }));
  return { root, fixture, stagingDir, preparedDir, section };
}

describe("Claude preparer", () => {
  it("shares preparations across accounts without copying Global files", () => {
    assert.equal(claudePreparer.perAccount, false);
    const homes = { claudeDir: "/h/.claude" } as Parameters<NonNullable<typeof claudePreparer.inputs>>[0]["systemHomes"];
    assert.deepEqual(claudePreparer.inputs?.({ agent: "claude", accountKey: "shared", accountHome: null, systemHomes: homes, appdir: "/a" }) ?? [], []);
  });

  it("names a copied plugin as the CLI loads it: its manifest name, else its directory (the item id)", async () => {
    for (const [manifest, name, allowed, profileName, localName] of [
      [{ version: "1" }, "pl1", ["pl1:fmt", "pl1:lint"], "Dev Kit", "dev-kit"],
      [{ name: "tool.box" }, "tool.box", ["tool.box:fmt", "tool.box:lint"], "Tool.Box", null],
      [{ name: "bad name" }, "pl1", [], "🎬", "profile"]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "orq-claude-preparer-"));
      roots.push(root);
      const fixture = await makeClaudeProfileFixture(root);
      fixture.resolved.name = profileName;
      await writeFile(join(root, "profile", "plugins", "pl1", ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
      const stagingDir = join(root, "staging");
      await mkdir(stagingDir, { mode: 0o700 });
      const section = await claudePreparer.prepare(fixture.context({ stagingDir, preparedDir: "/appdir/prepared/v-1" }));
      assert.deepEqual(section.plugins, [{ itemId: "pl1", name, path: "plugins/pl1" }]);
      assert.ok(section.localPlugin);
      if (localName !== null) assert.equal(section.localPlugin.name, localName);
      assert.notEqual(section.localPlugin.name, name, "generated and copied plugins have distinct namespaces");
      assert.deepEqual(section.skills?.filter((id) => !id.startsWith(`${section.localPlugin!.name}:`) && id !== "workflow-authoring").sort(), [...allowed]);
    }
  });

  it("writes an immutable plugin copy and private MCP and instruction files (golden)", async () => {
    const { stagingDir, preparedDir, section, fixture } = await prepare();
    assert.deepEqual(section, {
      localPlugin: { path: "plugin", name: "dev-kit" },
      plugins: [{ itemId: "pl1", name: "toolbox", path: "plugins/pl1" }],
      mcpConfig: "mcp-servers.json",
      mcpServerNames: ["search", "docs", "plugin:toolbox:db"],
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "echo pre", timeout: 5 },
              { type: "command", command: "echo two" }
            ]
          }
        ],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }]
      },
      instructionsFile: "instructions.md",
      skills: ["dev-kit:review", "dev-kit:git:pr", "toolbox:fmt", "toolbox:lint", "workflow-authoring"],
      disableWorkflows: false
    });
    assert.deepEqual(claudePreparedSectionSchema.parse(section), section, "the section reads back as written");
    assert.deepEqual(await tree(stagingDir), [
      "instructions.md",
      "mcp-servers.json",
      "plugin/",
      "plugin/.claude-plugin/",
      "plugin/.claude-plugin/plugin.json",
      "plugin/commands/",
      "plugin/commands/git/",
      "plugin/commands/git/pr.md",
      "plugin/skills/",
      "plugin/skills/review/",
      "plugin/skills/review/notes.md",
      "plugin/skills/review/SKILL.md",
      "plugin-data/",
      "plugin-data/pl1/",
      "plugins/",
      "plugins/pl1/",
      "plugins/pl1/.claude-plugin/",
      "plugins/pl1/.claude-plugin/plugin.json",
      "plugins/pl1/.mcp.json",
      "plugins/pl1/bin/",
      "plugins/pl1/bin/db",
      "plugins/pl1/commands/",
      "plugins/pl1/commands/fmt.md",
      "plugins/pl1/skills/",
      "plugins/pl1/skills/lint/",
      "plugins/pl1/skills/lint/SKILL.md"
    ]);
    assert.equal(await readFile(join(stagingDir, "instructions.md"), "utf8"), "Be brief.\n");
    const mcp = JSON.parse(await readFile(join(stagingDir, "mcp-servers.json"), "utf8"));
    assert.deepEqual(mcp, {
      mcpServers: {
        search: { type: "stdio", command: "search-mcp", args: ["--fast"], env: { API_KEY: FIXTURE_SECRETS.env } },
        docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: FIXTURE_SECRETS.header }, timeout: 5000 },
        // Lifted from the copied plugin (strictMcpConfig ignores plugin MCP): its root and data
        // dir resolved against the FINAL version dir, other variables left for the CLI.
        "plugin:toolbox:db": {
          command: `${preparedDir}/plugins/pl1/bin/db`,
          args: ["--data", `${preparedDir}/plugin-data/pl1`, "${HOME}"]
        }
      }
    });
    assert.ok(fixture.warnings.some((line) => line.includes('"orquester"')), "Orquester's own server name is refused, with a warning");
    assert.ok(fixture.warnings.every((line) => !line.includes(FIXTURE_SECRETS.env)));
    assert.equal((await stat(join(stagingDir, "mcp-servers.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(stagingDir, "instructions.md"))).mode & 0o777, 0o600);
    await writeFile(join(fixture.pluginCacheDir, "commands", "fmt.md"), "changed\n");
    assert.equal(await readFile(join(stagingDir, "plugins", "pl1", "commands", "fmt.md"), "utf8"), "---\ndescription: Format\n---\nFormat.\n");
  });

  it("with the Workflow tool off: disableWorkflows and no workflow-authoring", async () => {
    const { section } = await prepare({ claudeWorkflowTool: false });
    assert.equal(section.disableWorkflows, true);
    assert.deepEqual(section.skills, ["dev-kit:review", "dev-kit:git:pr", "toolbox:fmt", "toolbox:lint"]);
  });

  it("a managed profile without built-in tools says so in its section; others never carry the key", async () => {
    const { section } = await prepare({ claudeBuiltinTools: false });
    assert.equal(section.disableBuiltinTools, true);
    assert.deepEqual(claudePreparedSectionSchema.parse(section), section);
    const { section: plain } = await prepare();
    assert.equal("disableBuiltinTools" in plain, false);
  });

  it("showing built-in skills omits the allow-list entirely", async () => {
    const { section } = await prepare({ hideBuiltinSkills: false });
    assert.equal("skills" in section, false);
    assert.equal(section.disableWorkflows, false);
  });

  it("an empty profile writes no plugin, MCP or instructions file", async () => {
    const root = await mkdtemp(join(tmpdir(), "orq-claude-preparer-"));
    roots.push(root);
    const fixture = await makeClaudeProfileFixture(root);
    Object.assign(fixture.resolved, { skills: [], commands: [], mcpServers: [], hooks: [], plugins: [], instructions: "  " });
    const stagingDir = join(root, "staging");
    await mkdir(stagingDir);
    const section = await claudePreparer.prepare(fixture.context({ stagingDir, preparedDir: "/x/v-2" }));
    assert.deepEqual(section, { plugins: [], mcpServerNames: [], hooks: {}, skills: ["workflow-authoring"], disableWorkflows: false });
    assert.deepEqual(await tree(stagingDir), []);
  });
});
