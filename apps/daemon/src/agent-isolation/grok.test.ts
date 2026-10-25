import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseToml } from "../agent-profile/adapters/grok/toml-patch.ts";
import {
  GROK_PROFILE_ENV,
  grokDiscoveredPluginNames,
  grokSkillIgnoreList,
  parsePluginNames,
  renderGrokProfileConfigToml
} from "./grok.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-grok-inspect.mjs", import.meta.url));

describe("grokSkillIgnoreList", () => {
  let root: string;
  let home: string;
  let shared: string;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "grok-ignore-")));
    home = join(root, "home");
    shared = join(root, "shared-skills");
    await mkdir(join(shared, "linked-a"), { recursive: true });
    await mkdir(join(shared, "linked-b"), { recursive: true });
    // ~/.claude/skills: a real dir, a symlinked dir, a dangling link.
    await mkdir(join(home, ".claude", "skills", "real-one"), { recursive: true });
    await symlink(join(shared, "linked-a"), join(home, ".claude", "skills", "linked-a"));
    await symlink(join(root, "gone"), join(home, ".claude", "skills", "dangling"));
    // ~/.agents/skills is itself a symlink to a directory with one linked entry.
    await mkdir(join(root, "agents-skills-real"), { recursive: true });
    await symlink(join(shared, "linked-b"), join(root, "agents-skills-real", "linked-b"));
    await writeFile(join(root, "agents-skills-real", "README.md"), "x");
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(join(root, "agents-skills-real"), join(home, ".agents", "skills"));
    // ~/.claude/commands: a real command file and a symlinked one; ~/.agents/commands: a symlinked one.
    await mkdir(join(shared, "cmds"), { recursive: true });
    await writeFile(join(shared, "cmds", "linked-cmd.md"), "x");
    await writeFile(join(shared, "cmds", "agents-cmd.md"), "x");
    await mkdir(join(home, ".claude", "commands"), { recursive: true });
    await writeFile(join(home, ".claude", "commands", "plain.md"), "x");
    await symlink(join(shared, "cmds", "linked-cmd.md"), join(home, ".claude", "commands", "linked-cmd.md"));
    await mkdir(join(home, ".agents", "commands"), { recursive: true });
    await symlink(join(shared, "cmds", "agents-cmd.md"), join(home, ".agents", "commands", "agents-cmd.md"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists the user skill and command roots, every entry by absolute path, and each symlinked entry's target", async () => {
    const list = await grokSkillIgnoreList({ home, grokHome: join(root, "grok-home"), hideBundled: false });
    assert.deepEqual(list, [
      "~/.claude/skills",
      "~/.agents/skills",
      "~/.agents/commands",
      "~/.claude/commands",
      join(home, ".claude", "skills", "dangling"),
      join(home, ".claude", "skills", "linked-a"),
      join(shared, "linked-a"),
      join(home, ".claude", "skills", "real-one"),
      join(root, "agents-skills-real"),
      join(home, ".agents", "skills", "README.md"),
      join(home, ".agents", "skills", "linked-b"),
      join(shared, "linked-b"),
      join(home, ".claude", "commands", "linked-cmd.md"),
      join(shared, "cmds", "linked-cmd.md"),
      join(home, ".claude", "commands", "plain.md"),
      join(home, ".agents", "commands", "agents-cmd.md"),
      join(shared, "cmds", "agents-cmd.md")
    ]);
  });

  it("adds <grokHome>/bundled/skills when hiding built-ins", async () => {
    const list = await grokSkillIgnoreList({ home, grokHome: "/g", hideBundled: true });
    assert.equal(list.at(-1), "/g/bundled/skills");
  });

  it("tolerates a home without either directory", async () => {
    assert.deepEqual(await grokSkillIgnoreList({ home: join(root, "empty-home"), grokHome: "/g", hideBundled: false }), [
      "~/.claude/skills",
      "~/.agents/skills",
      "~/.agents/commands",
      "~/.claude/commands"
    ]);
  });
});

describe("grokDiscoveredPluginNames", () => {
  const base = { grokBin: process.execPath, args: [FAKE, "inspect", "--json"], cwd: tmpdir(), timeoutMs: 60_000 };

  it("runs inspect with the given env and cwd and returns the exact plugin names", async () => {
    const result = await grokDiscoveredPluginNames({ ...base, env: { PATH: process.env.PATH ?? "", GROK_HOME: "/profile/grok home" } });
    assert.deepEqual(result, { ok: true, names: ["/profile/grok home", tmpdir()] });
  });

  it("parses a real-shaped report", () => {
    const report = JSON.stringify({ plugins: [{ name: "hookify", enabled: true }, { name: " spaced " }, { name: "hookify" }, { nope: 1 }] });
    const result = parsePluginNames(report);
    assert.deepEqual(result, { ok: true, names: ["hookify", " spaced "] });
  });

  it("answers an error result on a non-zero exit, with the stderr tail", async () => {
    const result = await grokDiscoveredPluginNames({ ...base, env: { FAKE_GROK_EXIT: "3" } });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /exited with code 3: boom/);
  });

  it("answers an error result on a deadline and kills the child", async () => {
    const result = await grokDiscoveredPluginNames({ ...base, timeoutMs: 300, env: { FAKE_GROK_HANG: "1" } });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /timed out/);
  });

  it("answers an error result for a binary that cannot start", async () => {
    const result = await grokDiscoveredPluginNames({ ...base, grokBin: "/nonexistent/grok", args: undefined, env: {} });
    assert.equal(result.ok, false);
  });

  it("answers an error result for output that is not a report", () => {
    assert.equal(parsePluginNames("not json").ok, false);
    assert.equal(parsePluginNames("[]").ok, false);
    assert.equal(parsePluginNames('{"plugins": {}}').ok, false);
    assert.deepEqual(parsePluginNames('{"skills": []}'), { ok: true, names: [] });
  });
});

describe("renderGrokProfileConfigToml", () => {
  const carriedOver = parseToml(`
disabled_mcp_servers = ["x"]

[cli]
auto_update = true
installer = "npm"

[ui]
yolo = false

[mcp_servers.global]
command = "global"

[plugins]
enabled = ["hookify"]

[compat.claude]
hooks = true
`);
  const input = {
    carriedOver,
    mcpServers: { "jira-mcp": { command: "jira", args: ["--stdio"], env: { TOKEN_FILE: "/t" } } },
    skillsIgnore: ["~/.claude/skills", "/home/u/.claude/skills/pdf"],
    pluginsDisabled: ["hookify", "feature-dev"]
  };

  it("renders isolated native settings while carrying runtime policy", () => {
    assert.deepEqual(parseToml(renderGrokProfileConfigToml(input)), {
      cli: { auto_update: false, installer: "npm", use_leader: false },
      ui: { yolo: false },
      compat: {
        claude: { skills: true, rules: false, agents: false, mcps: false, hooks: false },
        cursor: { skills: false, rules: false, agents: false, mcps: false, hooks: false }
      },
      skills: { ignore: ["~/.claude/skills", "/home/u/.claude/skills/pdf"] },
      plugins: { disabled: ["hookify", "feature-dev"] },
      mcp_servers: { "jira-mcp": { command: "jira", args: ["--stdio"], env: { TOKEN_FILE: "/t" } } }
    });
  });

  it("writes empty lists and no mcp_servers table for an empty profile", () => {
    const doc = parseToml(renderGrokProfileConfigToml({ carriedOver: {}, mcpServers: {}, skillsIgnore: [], pluginsDisabled: [] }));
    assert.deepEqual(doc.skills, { ignore: [] });
    assert.deepEqual(doc.plugins, { disabled: [] });
    assert.equal("mcp_servers" in doc, false);
    assert.deepEqual(doc.cli, { auto_update: false, use_leader: false });
  });
});

describe("GROK_PROFILE_ENV", () => {
  it("turns every Claude/Cursor compat cell off except Claude skills", () => {
    for (const vendor of ["CLAUDE", "CURSOR"]) {
      for (const cell of ["RULES", "AGENTS", "MCPS", "HOOKS"]) {
        assert.equal(GROK_PROFILE_ENV[`GROK_${vendor}_${cell}_ENABLED`], "false");
      }
    }
    assert.equal(GROK_PROFILE_ENV.GROK_CURSOR_SKILLS_ENABLED, "false");
    assert.equal("GROK_CLAUDE_SKILLS_ENABLED" in GROK_PROFILE_ENV, false);
  });
});
