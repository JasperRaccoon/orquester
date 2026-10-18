/**
 * Agent Profiles — OpenCode isolation against the REAL CLI, with no model call and no login
 * (spec 2026-10-18 §6.4, §8). OPT-IN: runs only with `ORQUESTER_OPENCODE_LIVE=1` (it spawns the
 * installed `opencode`; `ORQUESTER_OPENCODE_BIN` overrides the binary, else `opencode` on PATH).
 * Each `opencode debug …` takes a minute or more (OpenCode installs its plugin dependency into
 * every config dir first; the registry is pointed at a closed port so it fails fast and offline).
 *
 * A fake HOME under the OS temp dir — a global `~/.config/opencode` with an MCP server, a plugin
 * file, a skill, a command, an agent and AGENTS.md; `~/.claude/skills` with a real and a
 * SYMLINKED skill; `~/.agents/skills`; `~/.claude/CLAUDE.md`; `~/.config/gh` — and a git repo
 * with AGENTS.md, `.claude/skills`, `.agents/skills` and `.opencode/{skills,commands}`. Temp
 * `XDG_DATA_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME`, so nothing real is read or written.
 *
 * The profile run uses exactly the env the launch contribution gives the keyed server; a Global
 * run of the same fixture is checked too, so every "absent" below is a real absence.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { after, describe, it } from "node:test";

import { OPENCODE_STATUS_PLUGIN_FILE } from "../../agent-hooks.ts";
import type { AgentHomes } from "../../agent-profile/adapters/types.ts";
import { opencodePreparedSectionSchema } from "../manifest/opencode.ts";
import type { ResolvedAgentProfile } from "../resolve.ts";
import { opencodeLaunchContribution, opencodePreparer } from "./opencode.ts";

function opencodeBin(): string | null {
  if (process.env.ORQUESTER_OPENCODE_BIN) return process.env.ORQUESTER_OPENCODE_BIN;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, "opencode"), constants.X_OK);
      return join(dir, "opencode");
    } catch {
      // next
    }
  }
  return null;
}

const LIVE = process.env.ORQUESTER_OPENCODE_LIVE === "1";
const BIN = LIVE ? opencodeBin() : null;
const skip = !LIVE ? "set ORQUESTER_OPENCODE_LIVE=1 to run against the real opencode CLI" : BIN === null ? "no opencode binary" : false;
const TMP = process.env.ORQUESTER_OPENCODE_LIVE_TMP ?? "/tmp";
const CLI_TIMEOUT_MS = 8 * 60_000;

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })));
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const skill = (name: string): string => `---\nname: ${name}\ndescription: ${name} description\n---\nbody\n`;

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      out.push(relative(dir, full));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return out.sort();
}

async function world(root: string) {
  const home = join(root, "home");
  const xdg = join(home, ".config");
  const globalDir = join(xdg, "opencode");
  await write(
    join(globalDir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { "global-mcp": { type: "local", command: ["true"], enabled: false } },
      share: "disabled"
    })
  );
  await write(join(globalDir, "AGENTS.md"), "GLOBAL INSTRUCTIONS\n");
  await write(join(globalDir, "skills", "global-oc-skill", "SKILL.md"), skill("global-oc-skill"));
  await write(join(globalDir, "plugin", "global-plugin.js"), "export const G = async () => ({});\n");
  await write(join(globalDir, "commands", "global-cmd.md"), "---\ndescription: global\n---\nx\n");
  await write(join(globalDir, "agents", "global-agent.md"), "---\ndescription: a global agent\nmode: subagent\n---\nYou are.\n");
  await write(join(home, ".claude", "CLAUDE.md"), "USER CLAUDE MEMORY\n");
  await write(join(home, ".claude", "skills", "claude-user-skill", "SKILL.md"), skill("claude-user-skill"));
  await write(join(root, "shared-skills", "linked-skill", "SKILL.md"), skill("linked-skill"));
  await symlink(join(root, "shared-skills", "linked-skill"), join(home, ".claude", "skills", "linked-skill"));
  await write(join(home, ".agents", "skills", "agents-user-skill", "SKILL.md"), skill("agents-user-skill"));
  await write(join(xdg, "gh", "hosts.yml"), "github.com: {}\n");

  const repo = join(root, "work", "repo");
  await write(join(repo, "AGENTS.md"), "REPO INSTRUCTIONS\n");
  await write(join(repo, ".claude", "skills", "repo-skill", "SKILL.md"), skill("repo-skill"));
  await write(join(repo, ".agents", "skills", "repo-agents-skill", "SKILL.md"), skill("repo-agents-skill"));
  await write(join(repo, ".opencode", "skills", "repo-oc-skill", "SKILL.md"), skill("repo-oc-skill"));
  await write(join(repo, ".opencode", "commands", "repo-cmd.md"), "---\ndescription: repo\n---\nx\n");
  await mkdir(join(repo, ".git"), { recursive: true });

  const profileDir = join(root, "profile");
  await write(join(profileDir, "skills", "s1", "SKILL.md"), skill("profile-skill"));
  await write(join(profileDir, "commands", "c1.md"), "---\ndescription: profile cmd\n---\nDo it.\n");
  await write(join(profileDir, "plugins", "pl1", "profile-plugin.js"), "export const P = async () => ({});\n");
  const resolved: ResolvedAgentProfile = {
    profileId: "live",
    revision: "1",
    name: "Live",
    agent: "opencode",
    settings: { hideBuiltinSkills: true, claudeWorkflowTool: true },
    instructions: "PROFILE INSTRUCTIONS",
    skills: [
      {
        id: "s1",
        name: "profile-skill",
        dir: join(profileDir, "skills", "s1"),
        skillFile: join(profileDir, "skills", "s1", "SKILL.md")
      }
    ],
    commands: [{ id: "c1", name: "profile-cmd", file: join(profileDir, "commands", "c1.md") }],
    mcpServers: [{ id: "m1", name: "profile-mcp", transport: "stdio", command: "true", env: { TOKEN: "x" }, headers: {}, advanced: {} }],
    hooks: [],
    plugins: [{ id: "pl1", name: "profile-plugin.js", cacheDir: join(profileDir, "plugins", "pl1") }],
    skipped: []
  };
  const systemHomes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir: globalDir,
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  const preparedDir = join(root, "appdir", "prepared", "live", "opencode", "shared", "v-live-1");
  await mkdir(preparedDir, { recursive: true, mode: 0o700 });
  const section = await opencodePreparer.prepare({
    resolved,
    agent: "opencode",
    accountKey: "shared",
    accountHome: null,
    systemHomes,
    stagingDir: preparedDir,
    preparedDir,
    previousPreparedDir: null,
    appdir: join(root, "appdir"),
    logger: { info: () => {}, warn: () => {} }
  });
  const contribution = await opencodeLaunchContribution({
    agent: "opencode",
    profile: { profileId: "live", revision: "1", preparedDir },
    manifestSection: opencodePreparedSectionSchema.parse(section),
    accountId: null,
    accountHome: globalDir,
    projectPath: repo,
    launchEnv: {}
  });
  assert.ok(contribution.serverPool?.env !== undefined);
  return { home, xdg, globalDir, repo, preparedDir, serverPool: contribution.serverPool };
}

type World = Awaited<ReturnType<typeof world>>;

function run(w: World, mode: string, args: string[], extra: Record<string, string>, unset: readonly string[] = []): Promise<string> {
  const state = join(w.home, "..", `state-${mode}`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: w.home,
    TMPDIR: join(w.home, ".."),
    XDG_CONFIG_HOME: w.xdg,
    XDG_DATA_HOME: join(state, "data"),
    XDG_CACHE_HOME: join(state, "cache"),
    XDG_STATE_HOME: join(state, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    // The dependency install OpenCode runs in every config dir: offline, failing fast.
    BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
    npm_config_registry: "http://127.0.0.1:9/",
    ...extra
  };
  for (const name of unset) delete env[name];
  return new Promise((resolve, reject) => {
    execFile(BIN!, args, { cwd: w.repo, env, timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`opencode ${args.join(" ")} failed: ${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

interface Observed {
  skills: string[];
  config: Record<string, unknown>;
  build: { permission?: Array<{ permission: string; pattern: string; action: string }> };
}

async function observe(w: World, mode: string, extra: Record<string, string>, unset: readonly string[] = []): Promise<Observed> {
  const skills = (JSON.parse(await run(w, mode, ["debug", "skill"], extra, unset)) as Array<{ name: string }>).map((entry) => entry.name).sort();
  const config = JSON.parse(await run(w, mode, ["debug", "config"], extra, unset)) as Record<string, unknown>;
  const build = JSON.parse(await run(w, mode, ["debug", "agent", "build"], extra, unset)) as Observed["build"];
  return { skills, config, build };
}

const keys = (value: unknown): string[] => (value !== null && typeof value === "object" ? Object.keys(value).sort() : []);
const pluginFiles = (config: Record<string, unknown>): string[] =>
  (Array.isArray(config.plugin) ? config.plugin : []).map((spec) => String(Array.isArray(spec) ? spec[0] : spec));

describe("OpenCode profile isolation (real CLI)", { skip, timeout: 4 * CLI_TIMEOUT_MS }, () => {
  it("a profile server loads only the profile's items and the repo's own; Global loads the user's", async () => {
    const root = await mkdtemp(join(TMP, "orq-opencode-live-"));
    roots.push(root);
    const w = await world(root);
    const realBefore = await snapshot(w.globalDir);

    const [profile, global] = await Promise.all([
      observe(w, "profile", w.serverPool.env!, w.serverPool.unsetEnv),
      observe(w, "global", {})
    ]);

    // Global baseline: the user's items are there (so their absence below means something).
    for (const name of ["global-oc-skill", "claude-user-skill", "linked-skill", "agents-user-skill", "repo-skill", "repo-agents-skill", "repo-oc-skill"]) {
      assert.ok(global.skills.includes(name), `Global loads ${name}: ${global.skills.join(", ")}`);
    }
    assert.ok(keys(global.config.mcp).includes("global-mcp"));
    assert.ok(keys(global.config.command).includes("global-cmd"));
    assert.ok(keys(global.config.agent).includes("global-agent"));
    assert.ok(pluginFiles(global.config).some((spec) => spec.endsWith("/global-plugin.js")));

    // The profile: its own items plus the repo's, nothing of the user's.
    assert.deepEqual(profile.skills, ["customize-opencode", "profile-skill", "repo-agents-skill", "repo-oc-skill", "repo-skill"]);
    assert.deepEqual(keys(profile.config.mcp), ["profile-mcp"]);
    assert.ok(keys(profile.config.command).includes("profile-cmd"));
    assert.ok(keys(profile.config.command).includes("repo-cmd"));
    assert.ok(!keys(profile.config.command).includes("global-cmd"));
    assert.ok(!keys(profile.config.agent).includes("global-agent"));
    const plugins = pluginFiles(profile.config);
    assert.ok(plugins.some((spec) => spec === `file://${join(w.preparedDir, "opencode", "plugin", "profile-plugin.js")}`), plugins.join(", "));
    assert.equal(plugins.filter((spec) => spec.endsWith(`/${OPENCODE_STATUS_PLUGIN_FILE}`)).length, 1, "the status plugin loads once");
    assert.ok(!plugins.some((spec) => spec.includes(w.globalDir)), "no plugin of the global dir");
    assert.deepEqual(profile.config.skills, { paths: [".claude/skills", ".agents/skills"] });
    // Built-ins hidden: the build agent denies customize-opencode (the model's skill listing filters on it).
    const skillRules = (profile.build.permission ?? []).filter((rule) => rule.permission === "skill");
    assert.deepEqual(skillRules.at(-1), { permission: "skill", pattern: "customize-opencode", action: "deny" });

    // The shadow keeps other tools' config; the real global dir was never written by the profile run.
    assert.equal(await readlink(join(w.preparedDir, "xdg", "gh")), join(w.xdg, "gh"));
    assert.equal(await readFile(join(w.preparedDir, "xdg", "gh", "hosts.yml"), "utf8"), "github.com: {}\n");
    const realAfter = await snapshot(w.globalDir);
    // The Global run itself writes OpenCode's own dependency files there; nothing else appears.
    const added = realAfter.filter((path) => !realBefore.includes(path));
    assert.ok(
      added.every((path) => /^(node_modules|package\.json|package-lock\.json|bun\.lock|\.gitignore)(\/|$)/.test(path)),
      added.join(", ")
    );
  });
});
