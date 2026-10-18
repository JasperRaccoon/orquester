/**
 * Agent Profiles — Grok isolation against the REAL CLI (spec 2026-10-18 §6.3, §8). OPT-IN: runs
 * only with `ORQUESTER_GROK_LIVE=1` (it spawns the installed `grok`; `ORQUESTER_GROK_BIN`
 * overrides it). Nothing else in the suite runs the real CLI. No prompt is ever sent.
 *
 * The daemon user's REAL `HOME` is read (never written) so its real Global setup is what must stay
 * out: `~/.claude/skills` with its symlinked entries, Claude-installed plugins, `~/.claude.json`
 * MCP servers, `~/.claude/CLAUDE.md`. `ORQUESTER_GROK_LIVE_HOME` points at another HOME. A temp
 * "Global" Grok home (the carry-over config, the shared `sessions/` the session files land in, the
 * folder trust), a temp repo with `AGENTS.md`, `CLAUDE.md` and `.claude/skills/repo-skill`, and a
 * profile (instructions, a skill, a command, a Grok plugin with a skill, a hook) prepared by the
 * real preparer; then the real adapter's spawn-time render.
 *
 * Part 1 (no sign-in): `grok inspect --json` in the repo under the profile home.
 * Part 2 (`ORQUESTER_GROK_LIVE_AUTH` = an account's `auth.json`, used in place through
 * `GROK_AUTH_PATH` exactly as a chat would — never copied): the real adapter starts a session
 * (`session/new`, no prompt); the last `available_commands_update` is the model's catalog, and the
 * CLI's debug log (`GROK_DEBUG_LOG`) shows which plugins and hooks loaded.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";

import { writePreparedManifest } from "../../../session-profiles/manifest.ts";
import { grokPreparer } from "../../../session-profiles/preparers/grok.ts";
import type { ResolvedAgentProfile } from "../../../session-profiles/resolve.ts";
import type { AgentHomes } from "../../../agent-profile/adapters/types.ts";
import type { AdapterContext } from "../../adapter.ts";
import type { HostThreadProfile } from "../../host-protocol.ts";
import { createGrokAdapter } from "./index.ts";
import { prepareGrokProfileSpawn } from "./profile-launch.ts";

function grokBin(): string | null {
  if (process.env.ORQUESTER_GROK_BIN) return process.env.ORQUESTER_GROK_BIN;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, "grok"), constants.X_OK);
      return join(dir, "grok");
    } catch {
      // next
    }
  }
  return null;
}

const LIVE = process.env.ORQUESTER_GROK_LIVE === "1";
const BIN = LIVE ? grokBin() : null;
const AUTH = process.env.ORQUESTER_GROK_LIVE_AUTH;
const HOME = process.env.ORQUESTER_GROK_LIVE_HOME ?? homedir();
const skip = !LIVE ? "set ORQUESTER_GROK_LIVE=1 to run against the real grok CLI" : BIN === null ? "no grok binary" : false;
const skipSession = skip !== false ? skip : AUTH === undefined ? "set ORQUESTER_GROK_LIVE_AUTH to an account's auth.json" : false;

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })));
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const md = (name: string): string => `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`;

/** Every entry of the Global user skill roots, and each symlinked entry's target (what must stay out). */
async function globalSkillPaths(): Promise<string[]> {
  const out: string[] = [];
  for (const root of [join(HOME, ".claude", "skills"), join(HOME, ".agents", "skills")]) {
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      out.push(join(root, name));
      try {
        out.push(await realpath(join(root, name)));
      } catch {
        // dangling
      }
    }
  }
  return out;
}

async function world() {
  const root = await realpath(await mkdtemp("/tmp/orq-grok-live-"));
  roots.push(root);
  const globalGrok = join(root, "global-grok");
  const repo = join(root, "repo");
  await write(join(globalGrok, "config.toml"), "[marketplace]\nofficial_marketplace_auto_installed = true\ndefault_skills_installs_purged = true\n");
  await mkdir(join(globalGrok, "sessions"), { recursive: true });
  await write(join(globalGrok, "trusted_folders.toml"), `[folders.${JSON.stringify(repo)}]\ntrusted = true\ndecided_at = 1785966231\n`);
  await write(join(repo, "AGENTS.md"), "REPO-AGENTS-MARKER\n");
  await write(join(repo, "CLAUDE.md"), "REPO-CLAUDE-MARKER\n");
  await write(join(repo, ".claude", "skills", "repo-skill", "SKILL.md"), md("repo-skill"));

  const source = join(root, "profile-source");
  await write(join(source, "skills", "s1", "SKILL.md"), md("profile-skill"));
  await write(join(source, "commands", "c1.md"), "---\ndescription: profile command\n---\nrun it\n");
  const plugin = join(source, "plugins", "pl1");
  await write(join(plugin, ".grok-plugin", "plugin.json"), `${JSON.stringify({ name: "probe-plugin", version: "1.0.0" })}\n`);
  await write(join(plugin, "skills", "plugin-skill", "SKILL.md"), md("plugin-skill"));
  const hookMark = join(root, "profile-hook-fired");
  const resolved: ResolvedAgentProfile = {
    profileId: "live",
    revision: "1",
    name: "Live",
    agent: "grok",
    settings: { hideBuiltinSkills: true, claudeWorkflowTool: true },
    instructions: "PROFILE-INSTRUCTIONS-MARKER\n",
    skills: [{ id: "s1", name: "profile-skill", dir: join(source, "skills", "s1"), skillFile: join(source, "skills", "s1", "SKILL.md") }],
    commands: [{ id: "c1", name: "profile-cmd", file: join(source, "commands", "c1.md") }],
    mcpServers: [],
    hooks: [{ id: "h1", name: "mark", event: "SessionStart", command: `echo fired >> ${JSON.stringify(hookMark)}` }],
    plugins: [{ id: "pl1", name: "probe-plugin", cacheDir: plugin }],
    skipped: []
  };
  const systemHomes: AgentHomes = {
    home: HOME,
    claudeDir: join(HOME, ".claude"),
    claudeJson: join(HOME, ".claude.json"),
    codexHome: join(HOME, ".codex"),
    grokHome: globalGrok,
    opencodeDir: join(HOME, ".config", "opencode"),
    agentsSkillsDir: join(HOME, ".agents", "skills")
  };
  const preparedDir = join(root, "appdir", "prepared", "live", "grok", "shared", "v-1");
  await mkdir(preparedDir, { recursive: true, mode: 0o700 });
  const section = await grokPreparer.prepare({
    resolved,
    agent: "grok",
    accountKey: "shared",
    accountHome: null,
    systemHomes,
    stagingDir: preparedDir,
    preparedDir,
    previousPreparedDir: null,
    appdir: join(root, "appdir"),
    logger: { info: () => undefined, warn: () => undefined }
  });
  await writePreparedManifest(preparedDir, {
    schema: 1,
    profileId: "live",
    revision: "1",
    agent: "grok",
    accountKey: "shared",
    preparedAt: new Date().toISOString(),
    agentSection: section
  });
  const profile: HostThreadProfile = { profileId: "live", revision: "1", preparedDir };
  const env: Record<string, string> = {
    HOME,
    PATH: process.env.PATH ?? "",
    GROK_HOME: preparedDir,
    GROK_AUTH_PATH: AUTH ?? join(root, "no-sign-in", "auth.json")
  };
  return { root, repo, preparedDir, profile, env, hookMark, globalGrok };
}

function inspectIn(cwd: string, env: Record<string, string>): Record<string, any> {
  return JSON.parse(execFileSync(BIN!, ["inspect", "--json"], { cwd, env, encoding: "utf8", timeout: 60_000 }));
}

describe("Grok profile isolation (live)", { skip }, () => {
  it("inspect in the repo under the profile home: profile + repo items only", async () => {
    const { repo, preparedDir, profile, env } = await world();
    const spawn = await prepareGrokProfileSpawn({ profile, env, command: BIN! });
    assert.ok(spawn);
    const childEnv = { ...env, ...spawn.env };
    const report = inspectIn(repo, childEnv);
    const config = await readFile(join(preparedDir, "config.toml"), "utf8");
    const discovered: string[] = (report.plugins ?? []).map((plugin: { name: string }) => plugin.name);
    console.log("discovered plugins:", discovered.join(", ") || "(none)");
    for (const name of discovered) {
      assert.ok(config.includes(JSON.stringify(name)), `plugin ${name} is denied in config.toml`);
    }

    const skills: Array<{ name: string; source: { type: string; path?: string; plugin_name?: string } }> = report.skills ?? [];
    console.log("inspect skills:", skills.map((skill) => `${skill.name}<${skill.source.type}${skill.source.plugin_name ? `:${skill.source.plugin_name}` : ""}>`).join(", "));
    const names = new Set(skills.map((skill) => skill.name));
    for (const expected of ["profile-skill", "repo-skill"]) assert.ok(names.has(expected), `${expected} is listed`);
    const global = await globalSkillPaths();
    for (const skill of skills) {
      const path = skill.source.path ?? "";
      assert.ok(!global.some((entry) => path === entry || path.startsWith(`${entry}/`)), `no Global skill: ${skill.name} (${path})`);
    }
    const hooks: Array<{ event: string; target: string; vendor?: string; disabled?: boolean; source?: { type: string; path?: string } }> = report.hooks ?? [];
    console.log("inspect hooks:", hooks.map((hook) => `${hook.event}:${hook.vendor ?? "-"}:${hook.source?.type}:${hook.source?.path ?? ""}:${hook.disabled ? "off" : "ON"}`).join("\n  "));
    // Claude-compat hooks are off. (Hooks of DISABLED plugins still show as on here: inspect lists a
    // disabled plugin as enabled — the session's debug log below is the authority on plugins.)
    for (const hook of hooks) {
      assert.ok(hook.disabled === true || hook.vendor !== "claude", `Claude hook not active: ${hook.target}`);
    }
    const servers: Array<{ name: string; disabled?: boolean; source?: { type: string } }> = report.mcpServers ?? [];
    console.log("inspect MCP:", servers.map((server) => `${server.name}:${server.source?.type}:${server.disabled ? "off" : "ON"}`).join(", "));
    for (const server of servers) assert.ok(server.disabled === true, `MCP server ${server.name} is not active`);
    // The profile's AGENTS.md and the repo's AGENTS.md / CLAUDE.md load; the user's CLAUDE.md does not.
    const instructions: Array<{ path: string; disabled?: boolean }> = report.projectInstructions ?? [];
    const active = instructions.filter((entry) => entry.disabled !== true).map((entry) => entry.path);
    assert.deepEqual(active.sort(), [join(preparedDir, "AGENTS.md"), join(repo, "AGENTS.md"), join(repo, "CLAUDE.md")].sort());
  });

  it("a real session (no prompt): the catalog holds the profile's and the repo's items only; Claude plugins stay off", { skip: skipSession }, async () => {
    const { root, repo, preparedDir, profile, env, hookMark, globalGrok } = await world();
    const debugLog = join(root, "grok-debug.log");
    const frames: unknown[] = [];
    let commandsSeen: (names: string[]) => void = () => undefined;
    const commandsReady = new Promise<string[]>((resolve) => (commandsSeen = resolve));
    const controller = new AbortController();
    let ids = 0;
    const log = (message: string, detail?: unknown): void => {
      if (process.env.ORQUESTER_GROK_LIVE_VERBOSE === "1") console.log("adapter:", message, detail ?? "");
    };
    const context: AdapterContext = {
      logger: { debug: log, info: log, warn: log, error: log },
      clock: { now: () => new Date(), nowIso: () => new Date().toISOString() },
      ids: { eventId: () => `e${(ids += 1)}`, messageId: (prefix) => `${prefix}-${(ids += 1)}`, uuid: () => `u${(ids += 1)}` },
      resolveAttachmentPath: async () => await Promise.resolve(root),
      attachmentsDir: () => root,
      logRawFrame: (_threadId, entry) => {
        frames.push(entry);
        const frame = (entry as { frame?: { method?: string; params?: { update?: { sessionUpdate?: string; availableCommands?: Array<{ name: string }> } } } }).frame;
        const update = frame?.params?.update;
        if (update?.sessionUpdate === "available_commands_update") {
          const names = (update.availableCommands ?? []).map((command) => command.name);
          if (names.some((name) => name.includes("plugin-skill"))) commandsSeen(names);
        }
      },
      buildEnv: () => ({ ...env, TMPDIR: root, GROK_DEBUG_LOG: debugLog }),
      resolveBin: async () => await Promise.resolve(BIN),
      sessionPath: () => process.env.PATH ?? "",
      tmpDir: () => root,
      signal: controller.signal
    };
    const adapter = await createGrokAdapter(context);
    const drain = (async () => {
      for await (const _event of adapter.events) {
        // consumed
      }
    })();
    try {
      await adapter.startSession({
        threadId: "live-1",
        cwd: repo,
        home: { kind: "account", accountId: "live", path: preparedDir },
        modelSelection: { model: "grok-build" },
        runtimeMode: "approval-required",
        profile
      });
      let timer: NodeJS.Timeout | undefined;
      const names = await Promise.race([
        commandsReady,
        new Promise<string[]>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("no available_commands_update with the profile plugin's skill")), 60_000);
        })
      ]).finally(() => clearTimeout(timer));
      console.log("catalog:", names.join(", "));
      for (const expected of ["profile-skill", "profile-cmd", "repo-skill"]) {
        assert.ok(names.includes(expected), `${expected} is in the catalog`);
      }
      assert.ok(names.some((name) => name.endsWith("plugin-skill")), "the profile plugin's skill is in the catalog");
      const globalNames = (await globalSkillPaths()).map((path) => path.split("/").at(-1) ?? "");
      for (const name of names) {
        assert.ok(!globalNames.includes(name), `no Global skill in the catalog: ${name}`);
      }
      // The debug log is the authority on plugins (inspect lists a disabled plugin as enabled):
      // every Claude-installed plugin is discovered and found in the deny list, and only the
      // profile's own hooks plugin loads hooks.
      const debug = await readFile(debugLog, "utf8");
      const discovered = new Set([...debug.matchAll(/plugin discovered name=(\S+) scope=user/g)].map((match) => match[1]));
      const denied = new Set([...debug.matchAll(/plugin already in enabled\/disabled list plugin=(\S+)/g)].map((match) => match[1]));
      console.log("user-scope plugins discovered:", [...discovered].join(", ") || "(none)", "| denied:", [...denied].join(", ") || "(none)");
      for (const name of discovered) assert.ok(denied.has(name), `plugin ${name} is in the deny list`);
      const hooksFrom = new Set([...debug.matchAll(/plugin hooks loaded from file plugin="([^"]+)"/g)].map((match) => match[1]));
      assert.deepEqual([...hooksFrom], ["orquester-profile-hooks"], "only the profile's hooks plugin loads hooks");
      for (const name of discovered) {
        assert.ok(!names.some((entry) => entry.startsWith(`${name}:`)), `nothing of plugin ${name} in the catalog`);
      }
      assert.match(await readFile(hookMark, "utf8"), /fired/, "the profile's SessionStart hook ran");
    } finally {
      controller.abort();
      await adapter.stopAll();
      await drain;
    }
  });
});
