import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseToml } from "@decimalturn/toml-patch";
import { grokPreparedSectionSchema } from "../manifest/grok.ts";
import { grokPreparer } from "./grok.ts";
import { GROK_FIXTURE_SECRETS, makeGrokProfileFixture } from "./grok.testing.ts";

const roots: string[] = [];
/** TOML read back as plain objects (the parser answers null-prototype ones). */
const readToml = async (path: string): Promise<Record<string, any>> => JSON.parse(JSON.stringify(parseToml(await readFile(path, "utf8"))));
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      out.push(relative(dir, full) + (entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " ->" : ""));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return out;
}

async function prepare(settings: Parameters<typeof makeGrokProfileFixture>[1] = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-grok-preparer-")));
  roots.push(root);
  const fixture = await makeGrokProfileFixture(root, settings);
  const stagingDir = join(root, "staging");
  await mkdir(stagingDir, { mode: 0o700 });
  const preparedDir = "/appdir/prepared/p1/grok/shared/v-1";
  const section = await grokPreparer.prepare(fixture.context({ stagingDir, preparedDir }));
  return { root, fixture, stagingDir, preparedDir, section };
}

describe("Grok preparer", () => {
  it("shares preparations across accounts and tracks the Global config.toml", () => {
    assert.equal(grokPreparer.perAccount, false);
    const homes = { grokHome: "/h/.grok" } as Parameters<NonNullable<typeof grokPreparer.inputs>>[0]["systemHomes"];
    assert.deepEqual(grokPreparer.inputs?.({ agent: "grok", accountKey: "shared", accountHome: null, systemHomes: homes, appdir: "/a" }), [
      "/h/.grok/config.toml"
    ]);
  });

  it("builds a private Grok home with an immutable copy of the profile's kit (golden)", async () => {
    const { stagingDir, section, fixture } = await prepare();
    assert.deepEqual(section, {
      configBase: "profile/config.base.toml",
      hideBundledSkills: true,
      plugins: [{ itemId: "pl1", name: "toolbox", path: "profile/plugins/pl1/toolbox" }],
      hooksPlugin: { name: "orquester-profile-hooks", path: "profile/hooks-plugin/orquester-profile-hooks" },
      mcpServerNames: ["search", "docs"]
    });
    assert.deepEqual(grokPreparedSectionSchema.parse(section), section, "the section reads back as written");
    assert.deepEqual(await tree(stagingDir), [
      "AGENTS.md",
      "commands/",
      "commands/git/",
      "commands/git/pr.md",
      "config.toml",
      "hooks/",
      "hooks/orquester.json",
      "profile/",
      "profile/config.base.toml",
      "profile/hooks-plugin/",
      "profile/hooks-plugin/orquester-profile-hooks/",
      "profile/hooks-plugin/orquester-profile-hooks/hooks/",
      "profile/hooks-plugin/orquester-profile-hooks/hooks/hooks.json",
      "profile/hooks-plugin/orquester-profile-hooks/plugin.json",
      "profile/plugins/",
      "profile/plugins/pl1/",
      "profile/plugins/pl1/toolbox/",
      "profile/plugins/pl1/toolbox/.grok-plugin/",
      "profile/plugins/pl1/toolbox/.grok-plugin/plugin.json",
      "profile/plugins/pl1/toolbox/skills/",
      "profile/plugins/pl1/toolbox/skills/lint/",
      "profile/plugins/pl1/toolbox/skills/lint/SKILL.md",
      "sessions ->",
      "skills/",
      "skills/review/",
      "skills/review/notes.md",
      "skills/review/SKILL.md",
      "trusted_folders.toml ->"
    ]);
    assert.equal(await readFile(join(stagingDir, "AGENTS.md"), "utf8"), "Be brief.\n");
    assert.equal(await readFile(join(stagingDir, "commands", "git", "pr.md"), "utf8"), "---\ndescription: Open a PR\n---\nOpen a PR.\n");
    // History and folder trust are the Global ones; there is no credential in the home.
    assert.equal(await readlink(join(stagingDir, "sessions")), join(fixture.globalHome, "sessions"));
    assert.equal(await readlink(join(stagingDir, "trusted_folders.toml")), join(fixture.globalHome, "trusted_folders.toml"));
    await assert.rejects(lstat(join(stagingDir, "auth.json")));
    // The profile's hooks ship as a plugin; Orquester's own status hooks as in a Global home.
    assert.deepEqual(JSON.parse(await readFile(join(stagingDir, "profile/hooks-plugin/orquester-profile-hooks/hooks/hooks.json"), "utf8")), {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre", timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }]
      }
    });
    assert.equal(JSON.parse(await readFile(join(stagingDir, "profile/hooks-plugin/orquester-profile-hooks/plugin.json"), "utf8")).name, "orquester-profile-hooks");
    const managed = JSON.parse(await readFile(join(stagingDir, "hooks", "orquester.json"), "utf8"));
    const script = join(fixture.appdir, "daemon", "hooks", "agent-hook.sh");
    assert.equal(managed.hooks.Stop[0].hooks[0].command, `'${script}' grok Stop`);
    assert.equal((await stat(script)).mode & 0o777, 0o755, "the managed hook script exists");
    assert.ok(fixture.warnings.some((line) => line.includes('"orquester"')), "Orquester's own server name is refused, with a warning");
    assert.ok(fixture.warnings.every((line) => !line.includes(GROK_FIXTURE_SECRETS.env)));
    for (const file of ["profile/config.base.toml", "config.toml", "AGENTS.md"]) {
      assert.equal((await stat(join(stagingDir, file))).mode & 0o777, 0o600, file);
    }
    assert.equal((await stat(join(stagingDir, "profile"))).mode & 0o777, 0o700);
    await writeFile(join(fixture.pluginCacheDir, "skills", "lint", "SKILL.md"), "changed\n");
    assert.equal(
      await readFile(join(stagingDir, "profile/plugins/pl1/toolbox/skills/lint/SKILL.md"), "utf8"),
      "---\nname: lint\ndescription: Lint\n---\nLint.\n"
    );
  });

  it("carries the Global runtime settings over, minus the item sections, plus the profile's MCP servers", async () => {
    const { stagingDir } = await prepare();
    const base = await readToml(join(stagingDir, "profile/config.base.toml"));
    assert.deepEqual(base, {
      cli: { installer: "npm", auto_update: true },
      ui: { permission_mode: "always-approve" },
      marketplace: {
        official_marketplace_auto_installed: true,
        sources: [{ name: "xAI Official", git: "https://github.com/xai-org/plugin-marketplace.git" }]
      },
      future_section: { keep: "me" },
      mcp_servers: {
        search: { command: "search-mcp", args: ["--fast"], env: { API_KEY: GROK_FIXTURE_SECRETS.env }, startup_timeout_sec: 20 },
        docs: { url: "https://docs.example/sse", type: "sse", headers: { Authorization: GROK_FIXTURE_SECRETS.header } }
      }
    });
  });

  it("writes a first config.toml with the recipe, the exclusion lists as of now and no plugin deny list yet", async () => {
    const { stagingDir, preparedDir, fixture } = await prepare();
    const config = await readToml(join(stagingDir, "config.toml"));
    assert.deepEqual(config.cli, { installer: "npm", auto_update: false, use_leader: false });
    assert.deepEqual(config.compat, {
      claude: { skills: true, rules: false, agents: false, mcps: false, hooks: false },
      cursor: { skills: false, rules: false, agents: false, mcps: false, hooks: false }
    });
    const skills = join(fixture.home, ".claude", "skills");
    assert.deepEqual(config.skills.ignore, [
      "~/.claude/skills",
      "~/.agents/skills",
      "~/.agents/commands",
      "~/.claude/commands",
      join(skills, "dangling"),
      join(skills, "linked-one"),
      join(fixture.root, "shared-skills", "linked-one"),
      join(skills, "real-one"),
      join(preparedDir, "bundled", "skills")
    ]);
    assert.deepEqual(config.plugins, { disabled: [] });
    assert.deepEqual(Object.keys(config.mcp_servers), ["search", "docs"]);
  });

  it("showing built-in skills leaves bundled skills out of the ignore list", async () => {
    const { section, stagingDir, preparedDir } = await prepare({ hideBuiltinSkills: false });
    assert.equal(section.hideBundledSkills, false);
    const config = await readToml(join(stagingDir, "config.toml"));
    assert.equal(config.skills.ignore.includes(join(preparedDir, "bundled", "skills")), false);
  });

  it("an empty profile still gets the recipe, the managed hooks and the shared links — nothing else", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "orq-grok-preparer-")));
    roots.push(root);
    const fixture = await makeGrokProfileFixture(root);
    Object.assign(fixture.resolved, { skills: [], commands: [], mcpServers: [], hooks: [], plugins: [], instructions: "  " });
    await rm(join(fixture.globalHome, "trusted_folders.toml"));
    const stagingDir = join(root, "staging");
    await mkdir(stagingDir);
    const section = await grokPreparer.prepare(fixture.context({ stagingDir, preparedDir: "/x/v-2" }));
    assert.deepEqual(section, { configBase: "profile/config.base.toml", hideBundledSkills: true, plugins: [], mcpServerNames: [] });
    assert.deepEqual(await tree(stagingDir), [
      "config.toml",
      "hooks/",
      "hooks/orquester.json",
      "profile/",
      "profile/config.base.toml",
      "sessions ->"
    ]);
  });

  it("fails with the reason when the Global config does not parse", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "orq-grok-preparer-")));
    roots.push(root);
    const fixture = await makeGrokProfileFixture(root);
    await writeFile(join(fixture.globalHome, "config.toml"), "[cli\n");
    const stagingDir = join(root, "staging");
    await mkdir(stagingDir);
    await assert.rejects(grokPreparer.prepare(fixture.context({ stagingDir, preparedDir: "/x/v-3" })), /Global Grok config .* does not parse/);
  });
});
