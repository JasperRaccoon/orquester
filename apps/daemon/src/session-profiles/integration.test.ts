/**
 * Agent Profiles end to end across the daemon / agent-host seam (spec 2026-10-18 §8), with no
 * real CLI: the real profile store and service, the real preparation lifecycle with every real
 * preparer (Codex seeds through the fake `codex app-server`), the real launch resolver and
 * contributions, the real `AgentChatService` talking over its unix socket to a real agent-host
 * server on the real orchestrator, and the host's refresh before every session start going
 * through the daemon's real socket route. Only the provider adapters are scripted: each start's
 * `StartSessionInput` plus the thread's `launch.json` are then turned into what the provider
 * would be started with by each adapter's own profile code (`loadClaudeProfileLaunch` +
 * `buildClaudeQueryOptions`, `codexProfileLaunch`, `prepareGrokProfileSpawn`, the OpenCode keyed
 * server's env), against a temp HOME whose Global setup has real and SYMLINKED skills, MCP
 * servers, plugins and hooks for all four agents.
 *
 * What each test proves is in its name; per-agent output details are the per-agent unit tests'.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { parse as parseToml } from "@decimalturn/toml-patch";
import type { RegistryEntry, SessionProfileAgentId, SessionSummary } from "@orquester/api";
import type { DomainEvent } from "@orquester/api/agent-chat";
import { agentHostSocketPath, agentHostTokenPath, parseSessionsConfig } from "@orquester/config";

import type { StartSessionInput } from "../agent-host/adapter.ts";
import { buildClaudeQueryOptions } from "../agent-host/adapters/claude/launch.ts";
import { claudeProfileLaunchFiles, loadClaudeProfileLaunch } from "../agent-host/adapters/claude/profile-launch.ts";
import { codexProfileLaunch, codexProfileSkillDisables } from "../agent-host/adapters/codex/profile.ts";
import { prepareGrokProfileSpawn } from "../agent-host/adapters/grok/profile-launch.ts";
import { loadProfileManifest } from "../agent-host/adapters/profile-manifest.ts";
import { agentHostAuthValue } from "../agent-host/host-protocol.ts";
import { createDaemonLaunchProfileClient } from "../agent-host/orchestration/launch-profile.ts";
import type { ThreadLaunchConfig } from "../agent-host/orchestration/launch-config.ts";
import { createScriptedAdapter, createTestHost, type TestHost } from "../agent-host/orchestration/testing/index.ts";
import { createAgentHostServer, type AgentHostServer } from "../agent-host/server/http-server.ts";
import { registerThreadLaunchProfileRoute } from "../agent-chat/profile-launch-route.ts";
import { AgentChatService, type ChatLaunchEnv } from "../agent-chat/service.ts";
import type { AgentHomes } from "../agent-profile/adapters/types.ts";
import { createProfileLaunchResolver } from "./launch.ts";
import { SessionProfileLifecycle } from "./lifecycle.ts";
import { SessionProfileService } from "./service.ts";
import { SessionProfileStore } from "./store.ts";

const TOKEN = "integration-token";
const FAKE_CODEX = fileURLToPath(new URL("../agent-isolation/testing/fake-codex-seed.mjs", import.meta.url));
const AGENTS: readonly SessionProfileAgentId[] = ["claude", "codex", "grok", "opencode"];
/** A managed account per agent; OpenCode chats run on the System identity. */
const ACCOUNT: Record<SessionProfileAgentId, string> = { claude: "acc-claude", codex: "acc-codex", grok: "acc-grok", opencode: "" };
/** Every name the fake Global setup defines; none may reach a profile chat. */
const GLOBAL_NAMES = [
  "global-claude-skill",
  "global-linked-skill",
  "global-agents-skill",
  "global-codex-skill",
  "global-grok-skill",
  "global-oc-skill",
  "global-claude-mcp",
  "global-codex-mcp",
  "global-grok-mcp",
  "global-oc-mcp",
  "global-plugin",
  "GLOBAL-INSTRUCTIONS",
  "global-hook"
];

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} skill\n---\nUse ${name}.\n`;

// ---------------------------------------------------------------------------
// The fake machine: a HOME with every agent's Global setup, accounts, a project
// ---------------------------------------------------------------------------

interface World {
  root: string;
  appdir: string;
  homes: AgentHomes;
  project: string;
  accountHome: Record<SessionProfileAgentId, string | null>;
  /** What the registry answers as Codex's binary; `null` = not installed (its preparation fails). */
  codexBin: string | null;
}

async function makeWorld(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "orq-ap-e2e-"));
  roots.push(root);
  const home = join(root, "home");
  const homes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir: join(home, ".config", "opencode"),
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  // Dotfile-managed skills, linked into the agents' skill dirs (real setups do this; Grok follows links).
  await write(join(home, "dotfiles", "global-linked-skill", "SKILL.md"), skillMd("global-linked-skill"));
  await write(join(home, "dotfiles", "global-agents-skill", "SKILL.md"), skillMd("global-agents-skill"));

  // Claude Global: a real and a symlinked skill, an MCP server, a hook, an installed plugin, CLAUDE.md.
  await write(join(homes.claudeDir, "skills", "global-claude-skill", "SKILL.md"), skillMd("global-claude-skill"));
  await mkdir(join(homes.claudeDir, "skills"), { recursive: true });
  await symlink(join(home, "dotfiles", "global-linked-skill"), join(homes.claudeDir, "skills", "global-linked-skill"));
  await write(join(homes.claudeDir, "CLAUDE.md"), "GLOBAL-INSTRUCTIONS\n");
  await write(
    join(homes.claudeDir, "settings.json"),
    JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "global-hook" }] }] },
      enabledPlugins: { "global-plugin@mkt": true }
    })
  );
  await write(
    join(homes.claudeDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "global-plugin@mkt": [{ scope: "user", installPath: "/x", version: "1" }] } })
  );
  await write(homes.claudeJson, JSON.stringify({ mcpServers: { "global-claude-mcp": { command: "global-claude-mcp" } } }));
  // `~/.agents/skills`: Codex reads it whatever CODEX_HOME is; Grok ignores it by path.
  await mkdir(homes.agentsSkillsDir, { recursive: true });
  await symlink(join(home, "dotfiles", "global-agents-skill"), join(homes.agentsSkillsDir, "global-agents-skill"));

  // Codex Global.
  await write(
    join(homes.codexHome, "config.toml"),
    [
      'model = "gpt-5.5"',
      'approval_policy = "on-request"',
      "",
      "[mcp_servers.global-codex-mcp]",
      'command = "global-codex-mcp"',
      "",
      '[plugins."global-plugin@mkt"]',
      "enabled = true",
      ""
    ].join("\n")
  );
  await write(join(homes.codexHome, "AGENTS.md"), "GLOBAL-INSTRUCTIONS\n");
  await write(join(homes.codexHome, "skills", "global-codex-skill", "SKILL.md"), skillMd("global-codex-skill"));
  await write(join(homes.codexHome, "sessions", "rollout-old.jsonl"), "{}\n");
  await write(join(homes.codexHome, "auth.json"), '{"system":true}\n');

  // Grok Global.
  await write(
    join(homes.grokHome, "config.toml"),
    ['[ui]', 'theme = "dark"', "", "[mcp_servers.global-grok-mcp]", 'command = "global-grok-mcp"', ""].join("\n")
  );
  await write(join(homes.grokHome, "AGENTS.md"), "GLOBAL-INSTRUCTIONS\n");
  await write(join(homes.grokHome, "skills", "global-grok-skill", "SKILL.md"), skillMd("global-grok-skill"));
  await mkdir(join(homes.grokHome, "sessions"), { recursive: true });

  // OpenCode Global, beside another tool's config the shadow must keep.
  await write(
    join(homes.opencodeDir, "opencode.json"),
    JSON.stringify({ model: "anthropic/claude", mcp: { "global-oc-mcp": { type: "local", command: ["global-oc-mcp"] } } })
  );
  await write(join(homes.opencodeDir, "AGENTS.md"), "GLOBAL-INSTRUCTIONS\n");
  await write(join(homes.opencodeDir, "skills", "global-oc-skill", "SKILL.md"), skillMd("global-oc-skill"));
  await write(join(home, ".config", "gh", "hosts.yml"), "github.com: {}\n");

  // Managed accounts, linked to Global the way `syncAccountHome` does.
  const accounts = join(root, "accounts");
  const claudeAccount = join(accounts, "claude", ACCOUNT.claude);
  await mkdir(claudeAccount, { recursive: true });
  for (const entry of ["settings.json", "plugins", "skills", "CLAUDE.md"]) {
    await symlink(join(homes.claudeDir, entry), join(claudeAccount, entry));
  }
  const codexAccount = join(accounts, "codex", ACCOUNT.codex);
  await write(join(codexAccount, "auth.json"), '{"account":"acc-codex"}\n');
  await symlink(join(homes.codexHome, "sessions"), join(codexAccount, "sessions"));
  const grokAccount = join(accounts, "grok", ACCOUNT.grok);
  await write(join(grokAccount, "auth.json"), '{"account":"acc-grok"}\n');

  // The project (under HOME, so Claude's walk for project `.claude/` dirs stops there): its own
  // skill and MCP server stay, as in a Global chat.
  const project = join(home, "work", "project");
  await write(join(project, ".claude", "skills", "repo-skill", "SKILL.md"), skillMd("repo-skill"));
  await write(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "repo-mcp": { command: "repo-mcp" } } }));

  const codexBin = join(root, "bin", "codex");
  await write(codexBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX}' "$@"\n`);
  await chmod(codexBin, 0o755);

  return {
    root,
    appdir: join(root, "appdir"),
    homes,
    project,
    accountHome: { claude: claudeAccount, codex: codexAccount, grok: grokAccount, opencode: null },
    codexBin
  };
}

// ---------------------------------------------------------------------------
// The daemon (profiles + AgentChatService + its socket route) and the agent host
// ---------------------------------------------------------------------------

const entryFor = (agent: SessionProfileAgentId): RegistryEntry => ({
  id: agent,
  name: agent,
  kind: "agent",
  bin: [agent],
  resolvedBin: `/usr/bin/${agent}`,
  enabled: true,
  installState: "idle",
  version: "1.0.0",
  chat: { adapter: agent }
});

interface Daemon {
  store: SessionProfileStore;
  profiles: SessionProfileService;
  lifecycle: SessionProfileLifecycle;
  chat: AgentChatService;
  route: FastifyInstance;
  stop(): Promise<void>;
}

/** `records`: the chat tabs `sessions.json` held (a restart adopts them before `init`, as `index.ts`). */
async function startDaemon(world: World, records = "{}"): Promise<Daemon> {
  const store = new SessionProfileStore({ appdir: world.appdir });
  await store.init();
  const daemon = {} as Daemon;
  const lifecycle = new SessionProfileLifecycle({
    appdir: world.appdir,
    store,
    systemHomes: world.homes,
    accountHome: (agent, accountId) => (accountId === ACCOUNT[agent] ? world.accountHome[agent] : null),
    defaultAccountId: (agent) => ACCOUNT[agent] || null,
    cliVersion: () => "1.0.0",
    cliBin: (agent) => (agent === "codex" ? world.codexBin : `/usr/bin/${agent}`),
    leases: { inUse: () => daemon.chat.profileLeases() },
    logger: { info: () => undefined, warn: () => undefined }
  });
  const profiles = new SessionProfileService({ store, prepareStatus: lifecycle.prepareStatusSource });
  await profiles.init();
  lifecycle.attach(profiles.events);
  await lifecycle.start();

  const systemHome: Record<SessionProfileAgentId, string> = {
    claude: world.homes.claudeDir,
    codex: world.homes.codexHome,
    grok: world.homes.grokHome,
    opencode: world.homes.opencodeDir
  };
  const homeVar: Record<SessionProfileAgentId, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", grok: "GROK_HOME", opencode: "" };
  const chat = new AgentChatService({
    baseDir: world.appdir,
    daemonDir: join(world.appdir, "daemon"),
    platform: "linux",
    cwd: world.appdir,
    sessionPath: "/usr/bin",
    env: {},
    tmux: {
      hasServiceSession: async () => false,
      killServiceSession: async () => {
        throw new Error("the test never kills its host");
      },
      newServiceSession: async () => {
        throw new Error("the test adopts its in-process host");
      }
    },
    broadcaster: { publish: () => undefined },
    push: { notifyStructural: async () => undefined },
    registryEntry: (refId) => (AGENTS.includes(refId as SessionProfileAgentId) ? entryFor(refId as SessionProfileAgentId) : undefined),
    resolveLaunchEnv: async (entry, ctx): Promise<ChatLaunchEnv | null> => {
      const agent = entry.id as SessionProfileAgentId;
      const requested = ctx.accountId === "system" ? "" : (ctx.accountId ?? ACCOUNT[agent]);
      if (requested === "" || requested !== ACCOUNT[agent]) return { env: {} };
      return { env: { [homeVar[agent]]: world.accountHome[agent] as string }, accountId: requested };
    },
    listManagedAccounts: () => ({
      accounts: (["claude", "codex", "grok"] as const).map((agent) => ({ id: ACCOUNT[agent], agent, label: agent }) as never)
    }),
    systemClaudeConfigFile: () => world.homes.claudeJson,
    resolveTrustedProjectDir: async () => null,
    sendAttachment: async (reply) => reply,
    sessionProfiles: {
      resolve: createProfileLaunchResolver({ lifecycle, accountHome: (agent, accountId) => (accountId === null ? systemHome[agent] : world.accountHome[agent]) }),
      profileName: (profileId) => profiles.deletedName(profileId)
    }
  });
  daemon.chat = chat;
  chat.chat.adopt(parseSessionsConfig(JSON.parse(records)).sessions);

  // The daemon's socket-only route the host asks before every profile session start.
  const routeSocket = join(world.root, "daemon-route.sock");
  await rm(routeSocket, { force: true });
  const route = Fastify({ logger: false });
  registerThreadLaunchProfileRoute(route, {
    authorizeHost: (authorization) => authorization === agentHostAuthValue(TOKEN),
    resolve: (threadId, profileId) => chat.threadLaunchProfile(threadId, profileId)
  });
  await route.listen({ path: routeSocket });

  Object.assign(daemon, {
    store,
    profiles,
    lifecycle,
    route,
    stop: async () => {
      await lifecycle.gc();
      await chat.stop();
      await route.close();
      lifecycle.stop();
    }
  });
  return daemon;
}

interface Host {
  test: TestHost;
  server: AgentHostServer;
  stop(): Promise<void>;
}

/** The agent host: the real orchestrator and socket server, scripted provider adapters. */
async function startHost(world: World, previous?: Host): Promise<Host> {
  await mkdir(join(world.appdir, "daemon"), { recursive: true });
  await writeFile(agentHostTokenPath(world.appdir), `${TOKEN}\n`, { mode: 0o600 });
  const routeSocket = join(world.root, "daemon-route.sock");
  const test = createTestHost({
    adapters: Object.fromEntries(AGENTS.map((agent) => [agent, createScriptedAdapter({ id: agent })])),
    ...(previous ? { store: previous.test.store, launchConfigs: previous.test.launchConfigs } : {}),
    launchProfile: createDaemonLaunchProfileClient({ socketPath: () => routeSocket, token: TOKEN })
  });
  for (const adapter of test.adapters.values()) void test.orchestrator.consume(adapter);
  const socketPath = agentHostSocketPath(world.appdir, "linux");
  await rm(socketPath, { force: true });
  const server = createAgentHostServer({
    orchestrator: test.orchestrator,
    store: test.store,
    logger: test.logger,
    hostInstanceId: "host-e2e",
    token: TOKEN,
    socketPath,
    tmpDir: join(world.appdir, "tmp"),
    startedAt: "2026-10-18T00:00:00.000Z",
    pid: process.pid,
    onStop: async () => ({ ok: true, markedThreadIds: [] })
  });
  await server.listen();
  return {
    test,
    server,
    stop: async () => {
      await server.close();
      await test.stop();
    }
  };
}

interface Machine {
  world: World;
  daemon: Daemon;
  host: Host;
  /** Both processes stop and start again on the same appdir, store and launch configs. */
  restart(): Promise<void>;
  /** Only the agent host restarts (an upgrade, a crash): every thread's next turn starts anew. */
  restartHost(): Promise<void>;
  stop(): Promise<void>;
}

async function boot(): Promise<Machine> {
  const world = await makeWorld();
  const host = await startHost(world);
  const daemon = await startDaemon(world);
  await daemon.chat.init();
  const machine: Machine = {
    world,
    daemon,
    host,
    restart: async () => {
      const records = JSON.stringify({ version: 1, sessions: machine.daemon.chat.chat.records() });
      await machine.daemon.stop();
      await machine.host.stop();
      machine.host = await startHost(world, machine.host);
      machine.daemon = await startDaemon(world, records);
      await machine.daemon.chat.init();
    },
    restartHost: async () => {
      await machine.host.stop();
      machine.host = await startHost(world, machine.host);
    },
    stop: async () => {
      await machine.daemon.stop();
      await machine.host.stop();
    }
  };
  return machine;
}

// ---------------------------------------------------------------------------
// Profiles, chats, turns
// ---------------------------------------------------------------------------

/** A profile with one skill, one MCP server (a secret env value) and instructions, all agents. */
async function makeProfile(daemon: Daemon, name: string, skill: string, mcp: string): Promise<string> {
  const created = await daemon.profiles.create({ name });
  let revision = created.revision;
  ({ revision } = (
    await daemon.profiles.createItem(created.id, revision, {
      kind: "skill",
      document: { name: skill, frontmatter: { name: skill, description: `${skill} skill` }, body: `Use ${skill}.\n` }
    })
  ).profile);
  ({ revision } = (
    await daemon.profiles.createItem(created.id, revision, {
      kind: "mcp",
      mcp: { name: mcp, transport: "stdio", command: mcp, env: [{ key: "TOKEN", value: `secret-${mcp}` }] }
    })
  ).profile);
  await daemon.profiles.writeInstructions(created.id, revision, `${name.toUpperCase()}-INSTRUCTIONS\n`);
  await Promise.all((Object.keys(ACCOUNT) as SessionProfileAgentId[]).map((agent) => daemon.lifecycle.ensureReady(created.id, agent, ACCOUNT[agent] || null)));
  await daemon.lifecycle.gc();
  return created.id;
}

async function addSkill(daemon: Daemon, profileId: string, skill: string): Promise<void> {
  const { revision } = await daemon.profiles.get(profileId);
  await daemon.profiles.createItem(profileId, revision, {
    kind: "skill",
    document: { name: skill, frontmatter: { name: skill, description: `${skill} skill` }, body: `Use ${skill}.\n` }
  });
}

function createChat(
  m: Machine,
  agent: SessionProfileAgentId,
  extra: { profileId?: string; unattended?: boolean } = {}
): Promise<SessionSummary> {
  return m.daemon.chat.createSession(
    {
      kind: "agent-chat",
      refId: agent,
      projectPath: m.world.project,
      cwd: m.world.project,
      ...(ACCOUNT[agent] ? { accountId: ACCOUNT[agent] } : { accountId: "system" }),
      ...(extra.profileId ? { profileId: extra.profileId } : {}),
      chat: { modelSelection: { model: "test-model" }, ...(extra.unattended ? { unattended: true } : {}) }
    } as never,
    0
  );
}

let commandSeq = 0;

async function turn(m: Machine, threadId: string): Promise<void> {
  const host = m.host.test;
  await host.orchestrator.command(threadId, "turn", { commandId: `e2e-${(commandSeq += 1)}`, input: "go" });
  await host.settle();
}

async function completeTurn(m: Machine, threadId: string): Promise<void> {
  const host = m.host.test;
  await host.orchestrator.ingestionSink(threadId, [
    {
      eventId: `turn-end-${(commandSeq += 1)}`,
      threadId,
      type: "thread.session-set",
      payload: { session: { status: "ready", activeTurnId: null } },
      occurredAt: host.clock.nowIso(),
      commandId: null,
      causationEventId: null,
      metadata: {}
    } as DomainEvent
  ]);
  await host.settle();
}

function starts(m: Machine, threadId: string): StartSessionInput[] {
  return [...m.host.test.adapters.values()].flatMap((adapter) =>
    adapter.calls.filter((call) => call.kind === "startSession" && call.threadId === threadId).map((call) => call.detail as StartSessionInput)
  );
}

function lastStart(m: Machine, threadId: string): StartSessionInput {
  const all = starts(m, threadId);
  assert.ok(all.length > 0, `thread ${threadId} never started`);
  return all[all.length - 1]!;
}

function launchConfig(m: Machine, threadId: string): ThreadLaunchConfig {
  const config = m.host.test.launchConfigs.entries.get(threadId);
  assert.ok(config, `thread ${threadId} has no launch.json`);
  return config;
}

// ---------------------------------------------------------------------------
// What the provider would be started with, per agent (each adapter's own code)
// ---------------------------------------------------------------------------

interface Effective {
  /** The skills the model would list (names), project ones included. */
  skills: string[];
  /** The MCP servers the CLI would connect. */
  mcp: string[];
  /** Everything else the launch carries, serialized: no Global name may appear in it. */
  text: string;
}

async function dirNames(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

async function effective(m: Machine, agent: SessionProfileAgentId, threadId: string): Promise<Effective> {
  const start = lastStart(m, threadId);
  const config = launchConfig(m, threadId);
  const env = config.launchEnv ?? {};
  const profile = start.profile;
  assert.ok(profile, "a profile chat starts with its profile");
  assert.deepEqual(config.profile, profile, "launch.json holds the profile the start got");
  assert.ok(profile.preparedDir.startsWith(join(m.world.appdir, "daemon", "session-profiles", "prepared", profile.profileId)));
  // MCP secret values live in the prepared 0600 files only: never in launch.json or the start input.
  assert.ok(!JSON.stringify(config).includes("secret-") && !JSON.stringify(start).includes("secret-"), "no secret on the wire");

  if (agent === "claude") {
    const configDir = env.CLAUDE_CONFIG_DIR;
    assert.equal(configDir, m.world.accountHome.claude, "Claude keeps the account's config dir");
    const launch = await loadClaudeProfileLaunch(
      { profile, cwd: start.cwd },
      { configDir: configDir!, claudeJson: join(configDir!, ".claude.json"), home: m.world.homes.home }
    );
    assert.ok(launch);
    const built = buildClaudeQueryOptions({
      cwd: start.cwd,
      executablePath: "/usr/bin/claude",
      env,
      runtimeMode: start.runtimeMode,
      models: [],
      attachmentsDir: join(m.world.root, "attachments"),
      canUseTool: (async () => ({ behavior: "allow", updatedInput: {} })) as never,
      profile: { launch, files: claudeProfileLaunchFiles(join(m.world.appdir, "tmp"), threadId) }
    });
    const { options, profileFiles } = built;
    assert.deepEqual(options.settingSources, ["project", "local"], "no user setting source");
    assert.equal(options.strictMcpConfig, true);
    assert.equal(typeof options.settings, "string", "settings ride a 0600 file, not argv");
    assert.ok(!JSON.stringify(options).includes("secret-"), "MCP secrets ride the --mcp-config file, not the options");
    const settings = profileFiles?.settings ?? {};
    assert.equal(settings.model, "opus", "runtime settings carry over");
    assert.deepEqual(settings.enabledPlugins, { "global-plugin@mkt": false }, "the installed Global plugin is switched off");
    const pluginSkills = (
      await Promise.all((options.plugins ?? []).map((plugin) => dirNames(join((plugin as { path: string }).path, "skills"))))
    ).flat();
    for (const plugin of options.plugins ?? []) assert.ok((plugin as { path: string }).path.startsWith(profile.preparedDir));
    return {
      skills: [
        ...pluginSkills,
        ...(Array.isArray(options.skills) ? options.skills : []).filter((name) => !name.includes(":") && name !== "workflow-authoring")
      ].sort(),
      mcp: Object.keys(profileFiles?.mcpConfig?.mcpServers ?? {}).sort(),
      // `enabledPlugins` names the Global plugin only to switch it off (asserted above).
      text: JSON.stringify({ settings: { ...settings, enabledPlugins: undefined }, append: options.systemPrompt, skills: options.skills })
    };
  }

  if (agent === "codex") {
    assert.equal(env.CODEX_HOME, profile.preparedDir, "CODEX_HOME is the prepared home");
    assert.equal(start.home.path, profile.preparedDir, "and so is the resume identity's home");
    const section = await loadProfileManifest(start, "codex");
    assert.ok(section);
    const launch = await codexProfileLaunch(profile.preparedDir, section, m.world.homes.home);
    // What `skills/list` reports in that home and cwd (Codex canonicalizes skill paths): the
    // profile's, the project's, and the `$HOME/.agents/skills` one Codex reads regardless.
    const linked = await realpath(join(m.world.homes.agentsSkillsDir, "global-agents-skill"));
    const listed = [
      ...(await dirNames(join(profile.preparedDir, "skills"))).map((name) => ({ name, path: join(profile.preparedDir, "skills", name, "SKILL.md"), scope: "user" })),
      { name: "global-agents-skill", path: join(linked, "SKILL.md"), scope: "user" },
      { name: "repo-skill", path: join(m.world.project, ".agents", "skills", "repo-skill", "SKILL.md"), scope: "repo" }
    ];
    const disabled = codexProfileSkillDisables([{ cwd: start.cwd, skills: listed, errors: [] }] as never, launch);
    const toml = await readFile(join(profile.preparedDir, "config.toml"), "utf8");
    const parsed = parseToml(toml) as Record<string, unknown>;
    assert.equal(parsed.model, "gpt-5.5", "runtime settings carry over");
    return {
      skills: listed.filter((skill) => !disabled.includes(skill.path)).map((skill) => skill.name).sort(),
      mcp: Object.keys((parsed.mcp_servers as Record<string, unknown>) ?? {}).sort(),
      text: [toml, await readFile(join(profile.preparedDir, "AGENTS.md"), "utf8")].join("\n")
    };
  }

  if (agent === "grok") {
    assert.equal(env.GROK_HOME, profile.preparedDir, "GROK_HOME is the prepared home");
    assert.equal(env.GROK_AUTH_PATH, join(m.world.accountHome.grok!, "auth.json"), "the account's own login");
    const spawn = await prepareGrokProfileSpawn({
      profile,
      env: { ...env, HOME: m.world.homes.home },
      command: "/usr/bin/grok",
      // `grok inspect --json` under the profile home: Grok discovers the Claude-installed plugin.
      inspect: async () => ({ ok: true, names: ["global-plugin"] })
    });
    assert.ok(spawn);
    assert.ok(spawn.agentArgs.includes("--no-leader"));
    const toml = await readFile(join(profile.preparedDir, "config.toml"), "utf8");
    const parsed = parseToml(toml) as Record<string, Record<string, unknown>>;
    const ignore = (parsed.skills?.ignore as string[]) ?? [];
    const linkedEntry = join(m.world.homes.claudeDir, "skills", "global-linked-skill");
    assert.ok(ignore.includes(linkedEntry) && ignore.includes(await realpath(linkedEntry)), "a symlinked Global skill is ignored by path AND target");
    assert.deepEqual(parsed.plugins?.disabled, ["global-plugin"]);
    assert.equal(parsed.ui?.theme, "dark", "runtime settings carry over");
    const { skills: _skills, plugins: _plugins, ...rest } = parsed;
    return {
      skills: await dirNames(join(profile.preparedDir, "skills")),
      mcp: Object.keys(parsed.mcp_servers ?? {}).sort(),
      text: [JSON.stringify(rest), await readFile(join(profile.preparedDir, "AGENTS.md"), "utf8"), JSON.stringify(spawn)].join("\n")
    };
  }

  // OpenCode: the keyed server for (project, profile version), with its own config dirs.
  const pool = start.serverPool;
  assert.ok(pool, "an OpenCode profile chat runs on a keyed server");
  assert.ok(pool.key.startsWith(`profile:${profile.profileId}:`));
  const configDir = pool.env?.OPENCODE_CONFIG_DIR;
  const shadow = pool.env?.XDG_CONFIG_HOME;
  assert.ok(configDir?.startsWith(profile.preparedDir) && shadow?.startsWith(profile.preparedDir));
  const shadowEntries = await dirNames(shadow!);
  assert.ok(shadowEntries.includes("gh") && !shadowEntries.includes("opencode"), "other tools keep ~/.config; OpenCode's own is hidden");
  const json = await readFile(join(configDir!, "opencode.json"), "utf8");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed.model, "anthropic/claude", "runtime settings carry over");
  return {
    skills: await dirNames(join(configDir!, "skills")),
    mcp: Object.keys((parsed.mcp as Record<string, unknown>) ?? {}).sort(),
    text: [json, await readFile(join(configDir!, "AGENTS.md"), "utf8"), JSON.stringify(pool)].join("\n")
  };
}

function assertNoGlobal(found: Effective, label: string): void {
  const all = [...found.skills, ...found.mcp, found.text].join("\n");
  for (const name of GLOBAL_NAMES) assert.ok(!all.includes(name), `${label}: the Global "${name}" leaked`);
}

/** The project's own skill and server stay where the agent loads them in Global too (spec §6). */
const projectExtras = (agent: SessionProfileAgentId): { skills: string[]; mcp: string[] } =>
  agent === "claude" ? { skills: ["repo-skill"], mcp: ["repo-mcp"] } : agent === "codex" ? { skills: ["repo-skill"], mcp: [] } : { skills: [], mcp: [] };

function assertKit(found: Effective, agent: SessionProfileAgentId, kit: { skills: string[]; mcp: string; instructions: string }, label: string): void {
  const extras = projectExtras(agent);
  assert.deepEqual(found.skills, [...kit.skills, ...extras.skills].sort(), `${label}: skills`);
  assert.deepEqual(found.mcp, [kit.mcp, ...extras.mcp].sort(), `${label}: MCP servers`);
  assert.ok(found.text.includes(kit.instructions), `${label}: instructions`);
  assertNoGlobal(found, label);
}

function eventsOf(m: Machine, threadId: string): DomainEvent[] {
  return m.host.test.store.logs.get(threadId) ?? [];
}

const EDITOR = { skills: ["video-cut"], mcp: "ffmpeg", instructions: "EDITOR-INSTRUCTIONS" };
const DEVELOPER = { skills: ["code-review"], mcp: "github", instructions: "DEVELOPER-INSTRUCTIONS" };

// ---------------------------------------------------------------------------

describe("Agent Profiles end to end (daemon → host → adapter launch inputs)", () => {
  for (const agent of AGENTS) {
    it(`${agent}: two concurrent chats on one account with different profiles get distinct kits and no Global item; a Global chat beside them is unchanged`, async () => {
      const m = await boot();
      try {
        const editor = await makeProfile(m.daemon, "Editor", "video-cut", "ffmpeg");
        const developer = await makeProfile(m.daemon, "Developer", "code-review", "github");
        const [a, b, global] = await Promise.all([
          createChat(m, agent, { profileId: editor }),
          createChat(m, agent, { profileId: developer }),
          createChat(m, agent)
        ]);
        assert.equal(a.profileId, editor);
        assert.equal(b.profileId, developer);
        assert.equal(global.profileId ?? null, null);
        await Promise.all([turn(m, a.id), turn(m, b.id), turn(m, global.id)]);

        const [ea, eb] = await Promise.all([effective(m, agent, a.id), effective(m, agent, b.id)]);
        assertKit(ea, agent, EDITOR, `${agent} Editor`);
        assertKit(eb, agent, DEVELOPER, `${agent} Developer`);
        assert.notEqual(lastStart(m, a.id).profile!.preparedDir, lastStart(m, b.id).profile!.preparedDir);
        if (agent === "opencode") assert.notEqual(lastStart(m, a.id).serverPool!.key, lastStart(m, b.id).serverPool!.key);

        // Global: no profile anywhere, the account's own launch, as before profiles existed.
        const g = lastStart(m, global.id);
        assert.equal(g.profile, undefined);
        const gConfig = launchConfig(m, global.id);
        assert.equal(gConfig.profile, undefined);
        if (agent === "opencode") {
          assert.equal(g.serverPool, undefined, "the project's global server");
        } else {
          const homeVar = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", grok: "GROK_HOME" }[agent];
          assert.deepEqual(gConfig.launchEnv, { [homeVar]: m.world.accountHome[agent] });
          assert.equal(g.home.path, m.world.accountHome[agent]);
        }
        if (agent === "claude") {
          const options = buildClaudeQueryOptions({
            cwd: g.cwd,
            executablePath: "/usr/bin/claude",
            env: gConfig.launchEnv ?? {},
            runtimeMode: g.runtimeMode,
            models: [],
            attachmentsDir: join(m.world.root, "attachments"),
            canUseTool: (async () => ({ behavior: "allow", updatedInput: {} })) as never
          }).options;
          assert.deepEqual(options.settingSources, ["user", "project", "local"]);
          assert.equal(options.strictMcpConfig, undefined);
          assert.equal(options.skills, undefined);
        }
        if (agent === "grok") {
          assert.equal(await prepareGrokProfileSpawn({ env: gConfig.launchEnv ?? {}, command: "/usr/bin/grok" }), null);
        }
      } finally {
        await m.stop();
      }
    });
  }

  it("a daemon and host restart keeps the chat's profile, and its next start picks up the edited profile's new version", async () => {
    const m = await boot();
    try {
      for (const agent of ["codex", "grok"] as const) {
        const editor = await makeProfile(m.daemon, `Editor ${agent}`, "video-cut", "ffmpeg");
        const chat = await createChat(m, agent, { profileId: editor });
        await turn(m, chat.id);
        await completeTurn(m, chat.id);
        const before = lastStart(m, chat.id).profile!;
        const cursor = m.host.test.store.bindings.get(chat.id)?.resumeCursor;
        assert.ok(cursor, "the first turn learned a resume cursor");

        // Edited while the chat runs: the running session keeps its version until its next start.
        await addSkill(m.daemon, editor, `subtitles-${agent}`);
        await Promise.all((Object.keys(ACCOUNT) as SessionProfileAgentId[]).map((target) => m.daemon.lifecycle.ensureReady(editor, target, ACCOUNT[target] || null)));
        await m.daemon.lifecycle.gc();
        await m.restart();
        assert.equal(m.daemon.chat.chat.get(chat.id)?.profileId, editor, "the tab record survived the daemon restart");

        await turn(m, chat.id);
        const after = lastStart(m, chat.id);
        assert.equal(after.profile?.profileId, editor, "same profile after the restart");
        assert.notEqual(after.profile?.revision, before.revision);
        assert.notEqual(after.profile?.preparedDir, before.preparedDir, "a new immutable version");
        assert.deepEqual(after.resumeCursor, cursor, "the conversation resumes");
        const kit = { ...EDITOR, skills: ["video-cut", `subtitles-${agent}`], instructions: `EDITOR ${agent.toUpperCase()}-INSTRUCTIONS` };
        assertKit(await effective(m, agent, chat.id), agent, kit, `${agent} after restart`);
        assert.equal(m.host.test.store.heads.get(chat.id)?.profileId, editor);
        await completeTurn(m, chat.id);
      }
    } finally {
      await m.stop();
    }
  });

  it("a profile switch mid-chat relaunches with the new kit on the same conversation; a switch to Global drops it", async () => {
    const m = await boot();
    try {
      const editor = await makeProfile(m.daemon, "Editor", "video-cut", "ffmpeg");
      const developer = await makeProfile(m.daemon, "Developer", "code-review", "github");
      for (const agent of ["claude", "opencode"] as const) {
        const chat = await createChat(m, agent, { profileId: editor });
        await turn(m, chat.id);
        await completeTurn(m, chat.id);
        assertKit(await effective(m, agent, chat.id), agent, EDITOR, `${agent} before the switch`);
        const cursor = m.host.test.store.bindings.get(chat.id)?.resumeCursor;
        assert.ok(cursor, "the first turn learned a resume cursor");

        await m.daemon.chat.switchProfile(chat.id, { commandId: `switch-${agent}`, profileId: developer });
        assert.equal(m.daemon.chat.chat.get(chat.id)?.profileId, developer);
        await turn(m, chat.id);
        assertKit(await effective(m, agent, chat.id), agent, DEVELOPER, `${agent} after the switch`);
        assert.deepEqual(lastStart(m, chat.id).resumeCursor, cursor, "the same conversation, resumed");
        await completeTurn(m, chat.id);

        await m.daemon.chat.switchProfile(chat.id, { commandId: `global-${agent}`, profileId: null });
        await turn(m, chat.id);
        assert.equal(lastStart(m, chat.id).profile, undefined, "Global again");
        assert.equal(launchConfig(m, chat.id).profile, undefined);
        await completeTurn(m, chat.id);
      }
    } finally {
      await m.stop();
    }
  });

  it("a deleted profile: an interactive chat falls back to Global with a notice naming it; an unattended one fails to start", async () => {
    const m = await boot();
    try {
      const editor = await makeProfile(m.daemon, "Editor", "video-cut", "ffmpeg");
      const interactive = await createChat(m, "grok", { profileId: editor });
      const unattended = await createChat(m, "grok", { profileId: editor, unattended: true });
      await Promise.all([turn(m, interactive.id), turn(m, unattended.id)]);
      await Promise.all([completeTurn(m, interactive.id), completeTurn(m, unattended.id)]);

      const { revision } = await m.daemon.profiles.get(editor);
      await m.daemon.profiles.remove(editor, revision);
      await m.daemon.lifecycle.gc();
      // Their next agent start (here: the host restarting, as after a crash or an upgrade).
      await m.restartHost();
      await Promise.all([turn(m, interactive.id), turn(m, unattended.id)]);

      const fallback = lastStart(m, interactive.id);
      assert.equal(fallback.profile, undefined, "the interactive chat runs Global");
      assert.deepEqual(launchConfig(m, interactive.id).launchEnv, { GROK_HOME: m.world.accountHome.grok });
      assert.equal(m.daemon.chat.chat.get(interactive.id)?.profileId, null, "the tab mirrors Global");
      const notice = eventsOf(m, interactive.id)
        .filter((event) => event.type === "thread.activity-appended")
        .map((event) => (event.payload as { activity: { activityKind: string; summary: string; payload?: Record<string, unknown> } }).activity)
        .find((activity) => activity.activityKind === "runtime.warning" && activity.payload?.reason === "profile-deleted");
      assert.ok(notice, "a deleted-profile fallback is announced");
      assert.deepEqual(notice.payload, { profileId: null, previousProfileId: editor, reason: "profile-deleted" });
      assert.match(notice.summary, /Editor/);
      assert.match(notice.summary, /Global/);

      assert.equal(starts(m, unattended.id).length, 0, "the unattended chat never starts Global");
      assert.match(m.host.test.store.heads.get(unattended.id)?.session.lastError ?? "", /unattended chat never falls back to Global/);
      assert.equal(m.daemon.chat.chat.get(unattended.id)?.profileId, editor);
    } finally {
      await m.stop();
    }
  });

  it("a failed preparation fails the launch with its reason, never Global: at create, and at a later start", async () => {
    const m = await boot();
    try {
      const editor = await makeProfile(m.daemon, "Editor", "video-cut", "ffmpeg");
      const chat = await createChat(m, "codex", { profileId: editor });
      await turn(m, chat.id);
      await completeTurn(m, chat.id);
      // Codex disappears; the profile is edited, so its Codex home must be prepared again.
      m.world.codexBin = null;
      await addSkill(m.daemon, editor, "subtitles");
      await m.daemon.lifecycle.gc();

      await assert.rejects(createChat(m, "codex", { profileId: editor }), (error: unknown) => {
        const { code, message } = error as { code?: string; message?: string };
        return code === "PROFILE_NOT_READY" && /Codex is not installed/.test(message ?? "");
      });
      assert.equal(m.daemon.chat.chat.records().filter((record) => record.refId === "codex").length, 1, "no tab for the refused create");

      await m.restart();
      await turn(m, chat.id);
      assert.equal(starts(m, chat.id).length, 0, "the running chat's next start is refused, not run Global");
      assert.match(m.host.test.store.heads.get(chat.id)?.session.lastError ?? "", /Codex is not installed/);
      assert.equal(launchConfig(m, chat.id).profile?.profileId, editor, "launch.json keeps the profile");
    } finally {
      await m.stop();
    }
  });
});
