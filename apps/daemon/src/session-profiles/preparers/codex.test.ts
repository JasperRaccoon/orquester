import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { daemonConfigDir } from "@orquester/config";
import { codexHookHash } from "../../agent-profile/adapters/codex/hooks.ts";
import { parseToml } from "../../agent-profile/adapters/grok/toml-patch.ts";
import { parseMarkdownDocument } from "../../agent-profile/infra/index.ts";
import { agentHookScriptPath } from "../../agent-hooks.ts";
import { CODEX_STATE_DB_FILE } from "../../agent-isolation/index.ts";
import type { AgentHomes } from "../../agent-profile/adapters/types.ts";
import { codexProfileLaunchContribution } from "../contributions/codex.ts";
import { codexPreparedSectionSchema } from "../manifest/codex.ts";
import type { SessionProfilePrepareContext } from "../preparer.ts";
import type { ResolvedAgentProfile } from "../resolve.ts";
import { codexPreparer } from "./codex.ts";

const FAKE = fileURLToPath(new URL("../../agent-isolation/testing/fake-codex-seed.mjs", import.meta.url));
const SECRET = "ghp_PROFILE_SECRET_VALUE";

const GLOBAL_CONFIG = `model = "gpt-5.5"
approval_policy = "on-request"
sqlite_home = "/somewhere/else"
notify = ["notify-send"]

[features]
apps = true
codex_hooks = true

[projects."/work/repo"]
trust_level = "trusted"

[mcp_servers.global-db]
command = "db-mcp"

[plugins."superpowers@openai-curated"]
enabled = true

[[skills.config]]
path = "/home/u/.agents/skills/pdf/SKILL.md"
enabled = false

[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]
enabled = true
trusted_hash = "sha256:global"
`;

interface Fixture {
  root: string;
  appdir: string;
  homes: AgentHomes;
  accountHome: string;
  profileDir: string;
  fakeBin: string;
  seedLog: string;
}

let fx: Fixture;
const roots: string[] = [];

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-preparer-"));
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
  await mkdir(join(homes.codexHome, "sessions"), { recursive: true });
  await writeFile(join(homes.codexHome, "sessions", "rollout-old.jsonl"), "{}\n");
  await writeFile(join(homes.codexHome, "config.toml"), GLOBAL_CONFIG);
  await writeFile(join(homes.codexHome, "auth.json"), '{"system":true}\n');
  await writeFile(join(homes.codexHome, ".personality_migration"), "v1\n");
  // A managed account home: its own login, `sessions` linked to the shared one (agent-accounts.ts).
  const accountHome = join(root, "appdir", "daemon", "agent-accounts", "codex", "acc1", "home");
  await mkdir(accountHome, { recursive: true });
  await writeFile(join(accountHome, "auth.json"), '{"account":"acc1"}\n');
  await symlink(join(homes.codexHome, "sessions"), join(accountHome, "sessions"));

  // The profile's source items.
  const profileDir = join(root, "profile");
  await mkdir(join(profileDir, "skills", "s1", "scripts"), { recursive: true });
  await writeFile(join(profileDir, "skills", "s1", "SKILL.md"), "---\nname: video-cut\ndescription: Cut video\n---\nCut it.\n");
  await writeFile(join(profileDir, "skills", "s1", "scripts", "run.sh"), "echo cut\n");
  await mkdir(join(profileDir, "commands"), { recursive: true });
  await writeFile(join(profileDir, "commands", "c1.md"), "---\ndescription: Open a PR\nargument-hint: '[title]'\n---\nOpen a pull request for $ARGUMENTS.\n");
  await mkdir(join(profileDir, "plugins", "p1", ".codex-plugin"), { recursive: true });
  await writeFile(join(profileDir, "plugins", "p1", ".codex-plugin", "plugin.json"), '{"name":"render"}\n');

  const seedLog = join(root, "seed.log");
  const fakeBin = join(root, "codex");
  await writeFile(fakeBin, `#!/bin/sh\nFAKE_SEED_LOG='${seedLog}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  await chmod(fakeBin, 0o755);
  fx = { root, appdir: join(root, "appdir"), homes, accountHome, profileDir, fakeBin, seedLog };
});

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function resolved(overrides: Partial<ResolvedAgentProfile> = {}): ResolvedAgentProfile {
  return {
    profileId: "editor",
    revision: "3",
    name: "Editor",
    agent: "codex",
    settings: { hideBuiltinSkills: true, claudeWorkflowTool: true },
    instructions: "# Editor\nYou edit videos.\n",
    skills: [{ id: "s1", name: "video-cut", dir: join(fx.profileDir, "skills", "s1"), skillFile: join(fx.profileDir, "skills", "s1", "SKILL.md") }],
    commands: [{ id: "c1", name: "git/pr", file: join(fx.profileDir, "commands", "c1.md") }],
    mcpServers: [
      { id: "m1", name: "github", transport: "stdio", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: SECRET }, headers: {}, advanced: {} },
      { id: "m2", name: "docs", transport: "http", url: "https://docs.example/mcp", env: {}, headers: { Authorization: `Bearer ${SECRET}` }, advanced: { tool_timeout_sec: 30 } }
    ],
    hooks: [{ id: "h1", name: "lint", event: "PostToolUse", matcher: "apply_patch", command: "lint.sh", timeoutSec: 20 }],
    plugins: [{ id: "p1", name: "render", marketplace: "studio", version: "1.2.0", cacheDir: join(fx.profileDir, "plugins", "p1") }],
    skipped: [],
    ...overrides
  };
}

let seq = 0;
async function context(
  overrides: { resolved?: ResolvedAgentProfile; accountHome?: string; cliBin?: string | null } = {}
): Promise<SessionProfilePrepareContext<"codex">> {
  seq += 1;
  const stagingDir = join(fx.appdir, "daemon", "session-profiles", "staging", `editor.codex.${seq}`);
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  return {
    resolved: overrides.resolved ?? resolved(),
    agent: "codex",
    accountKey: "acc1",
    accountHome: overrides.accountHome ?? fx.accountHome,
    systemHomes: fx.homes,
    stagingDir,
    preparedDir: join(fx.appdir, "daemon", "session-profiles", "prepared", "editor", "codex", "acc1", `v-${seq}`),
    previousPreparedDir: null,
    appdir: fx.appdir,
    cliBin: overrides.cliBin === undefined ? fx.fakeBin : overrides.cliBin,
    logger: { info: () => undefined, warn: () => undefined }
  };
}

async function seedEvents(): Promise<Array<{ event: string; sessions?: string; auth?: boolean }>> {
  const text = await readFile(fx.seedLog, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string });
}

describe("codexPreparer", () => {
  it("prepares per account and tracks the Global config.toml", () => {
    assert.equal(codexPreparer.perAccount, true);
    const inputs = codexPreparer.inputs?.({ agent: "codex", accountKey: "acc1", accountHome: fx.accountHome, systemHomes: fx.homes, appdir: fx.appdir });
    assert.deepEqual(inputs, [join(fx.homes.codexHome, "config.toml")]);
  });

  it("builds the isolated home: config, instructions, skills, commands as skills, hooks with trust, plugins, links, seeded DB", async () => {
    const globalBefore = await readFile(join(fx.homes.codexHome, "config.toml"), "utf8");
    const ctx = await context();
    const section = await codexPreparer.prepare(ctx);
    await codexPreparer.validate?.(ctx);
    const home = ctx.stagingDir;

    // The manifest section.
    assert.deepEqual(codexPreparedSectionSchema.parse(section), {
      stateDbFile: CODEX_STATE_DB_FILE,
      hideBuiltinSkills: true,
      skills: ["video-cut", "git-pr"],
      mcpServers: ["github", "docs"],
      plugins: ["render@studio"],
      hooks: 1,
      userSkillRoots: [join(fx.homes.home, ".agents", "skills"), join(fx.homes.home, ".agents", "plugins")]
    });

    // config.toml: Global's runtime settings, none of its items, the recipe and the profile's items.
    const configText = await readFile(join(home, "config.toml"), "utf8");
    assert.equal((await stat(join(home, "config.toml"))).mode & 0o777, 0o600);
    const hooksPath = join(ctx.preparedDir, "hooks.json");
    const scriptPath = agentHookScriptPath(daemonConfigDir(fx.appdir));
    const managed = (event: string, label: string, matcher?: string) => {
      const handler = { type: "command", command: `'${scriptPath}' codex ${event}`, timeout: 10 };
      return [`${hooksPath}:${label}:${label === "post_tool_use" ? 1 : 0}:0`, { enabled: true, trusted_hash: codexHookHash(label, handler, matcher) }] as const;
    };
    assert.deepEqual(parseToml(configText), {
      model: "gpt-5.5",
      approval_policy: "on-request",
      notify: ["notify-send"],
      features: { apps: false, codex_hooks: true, remote_plugin: false },
      projects: { "/work/repo": { trust_level: "trusted" } },
      skills: { bundled: { enabled: false } },
      mcp_servers: {
        github: { command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: SECRET } },
        docs: { url: "https://docs.example/mcp", http_headers: { Authorization: `Bearer ${SECRET}` }, tool_timeout_sec: 30 }
      },
      plugins: { "render@studio": { enabled: true } },
      hooks: {
        state: Object.fromEntries([
          [
            `${hooksPath}:post_tool_use:0:0`,
            { enabled: true, trusted_hash: codexHookHash("post_tool_use", { type: "command", command: "lint.sh", timeout: 20 }, "apply_patch") }
          ],
          managed("PostToolUse", "post_tool_use", "*"),
          managed("SessionStart", "session_start"),
          managed("UserPromptSubmit", "user_prompt_submit"),
          managed("PreToolUse", "pre_tool_use", "*"),
          managed("PermissionRequest", "permission_request", "*"),
          managed("Stop", "stop")
        ])
      }
    });
    assert.ok(!configText.includes("sqlite_home"), "never the account's DBs");
    assert.ok(!configText.includes("global-db") && !configText.includes("superpowers"), "no Global items");

    // hooks.json: the profile's hook, then Orquester's managed group.
    const hooks = JSON.parse(await readFile(join(home, "hooks.json"), "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PermissionRequest", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    assert.deepEqual(hooks.hooks.PostToolUse?.map((group) => group.hooks[0]?.command), ["lint.sh", `'${scriptPath}' codex PostToolUse`]);
    assert.ok((await stat(scriptPath)).isFile(), "the managed hook script exists");

    // Instructions, skills, commands as skills.
    assert.equal(await readFile(join(home, "AGENTS.md"), "utf8"), "# Editor\nYou edit videos.\n");
    assert.deepEqual((await readdir(join(home, "skills"))).sort(), ["git-pr", "video-cut"]);
    assert.equal(await readFile(join(home, "skills", "video-cut", "scripts", "run.sh"), "utf8"), "echo cut\n");
    const pr = parseMarkdownDocument(await readFile(join(home, "skills", "git-pr", "SKILL.md"), "utf8"));
    assert.deepEqual(pr.frontmatter, { name: "git-pr", description: "Open a PR" });
    assert.equal(pr.body.trim(), "Open a pull request for $ARGUMENTS.");

    // The plugin, copied into the cache layout Codex reads.
    assert.equal(
      await readFile(join(home, "plugins", "cache", "studio", "render", "1.2.0", ".codex-plugin", "plugin.json"), "utf8"),
      '{"name":"render"}\n'
    );

    // Links: the account's login and its sessions; the DB seeded against an EMPTY real sessions/
    // with no login in the home yet.
    assert.equal(await readlink(join(home, "auth.json")), join(fx.accountHome, "auth.json"));
    assert.equal(await readlink(join(home, "sessions")), join(fx.accountHome, "sessions"));
    assert.ok((await lstat(join(home, CODEX_STATE_DB_FILE))).isFile());
    const init = (await seedEvents()).filter((line) => line.event === "initialize").at(-1);
    assert.deepEqual({ sessions: init?.sessions, auth: init?.auth }, { sessions: "empty-dir", auth: false });
    assert.equal(await readFile(join(home, ".personality_migration"), "utf8"), "v1\n");

    // Global untouched.
    assert.equal(await readFile(join(fx.homes.codexHome, "config.toml"), "utf8"), globalBefore);
    assert.equal(await readFile(join(fx.accountHome, "auth.json"), "utf8"), '{"account":"acc1"}\n');
    assert.deepEqual(await readdir(join(fx.homes.codexHome, "sessions")), ["rollout-old.jsonl"]);

    // Usable while seeded; not once the DB is gone.
    assert.equal(await codexPreparer.unusableReason?.(home), null);
    assert.deepEqual(await codexProfileLaunchContribution({ profile: { profileId: "editor", revision: "3", preparedDir: home } }), { env: { CODEX_HOME: home }, homePath: home });
    await unlink(join(home, CODEX_STATE_DB_FILE));
    assert.match((await codexPreparer.unusableReason?.(home)) ?? "", /state DB/);
    await assert.rejects(codexProfileLaunchContribution({ profile: { profileId: "editor", revision: "3", preparedDir: home } }), /not seeded/);
  });

  it("without Codex plugins: plugins feature off; built-ins shown when the profile says so; no instructions file", async () => {
    const ctx = await context({ resolved: resolved({ plugins: [], instructions: "", settings: { hideBuiltinSkills: false, claudeWorkflowTool: true }, hooks: [], mcpServers: [] }) });
    await codexPreparer.prepare(ctx);
    const config = parseToml(await readFile(join(ctx.stagingDir, "config.toml"), "utf8"));
    assert.deepEqual(config.features, { apps: false, codex_hooks: true, remote_plugin: false, plugins: false });
    assert.equal(config.skills, undefined);
    assert.equal(config.mcp_servers, undefined);
    assert.equal(config.plugins, undefined);
    await assert.rejects(lstat(join(ctx.stagingDir, "AGENTS.md")));
  });

  it("the System account links the system home's login and history", async () => {
    const ctx = await context({ accountHome: fx.homes.codexHome });
    await codexPreparer.prepare(ctx);
    await codexPreparer.validate?.(ctx);
    assert.equal(await readlink(join(ctx.stagingDir, "auth.json")), join(fx.homes.codexHome, "auth.json"));
    assert.equal(await readlink(join(ctx.stagingDir, "sessions")), join(fx.homes.codexHome, "sessions"));
  });

  it("an account home without sessions/ yet links the shared one every account home links to", async () => {
    const fresh = join(fx.root, "fresh-account", "home");
    await mkdir(fresh, { recursive: true });
    const ctx = await context({ accountHome: fresh });
    await codexPreparer.prepare(ctx);
    assert.equal(await readlink(join(ctx.stagingDir, "sessions")), join(fx.homes.codexHome, "sessions"));
    assert.equal(await readlink(join(ctx.stagingDir, "auth.json")), join(fresh, "auth.json"));
  });

  it("fails without a codex binary, and when the seed cannot create the state DB", async () => {
    await assert.rejects(codexPreparer.prepare(await context({ cliBin: null })), /not installed/);
    const noDb = join(fx.root, "codex-nodb");
    await writeFile(noDb, `#!/bin/sh\nFAKE_SEED_DB= exec '${process.execPath}' '${FAKE}' "$@"\n`);
    await chmod(noDb, 0o755);
    const ctx = await context({ cliBin: noDb });
    await assert.rejects(codexPreparer.prepare(ctx), /state DB name may have changed/);
    await assert.rejects(lstat(join(ctx.stagingDir, "auth.json")), "no login linked into a failed home");
  });

  it("never leaves a secret value in a failure reason or a log line", async () => {
    const lines: string[] = [];
    const bad = resolved({ mcpServers: [{ id: "m3", name: "bad", transport: "stdio", command: "", env: { TOKEN: SECRET }, headers: {}, advanced: {} }] });
    const ctx = { ...(await context({ resolved: bad })), logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } };
    await codexPreparer.prepare(ctx);
    assert.ok(lines.some((line) => line.includes('"bad"')));
    assert.ok(!lines.join("\n").includes(SECRET));
    assert.equal(parseToml(await readFile(join(ctx.stagingDir, "config.toml"), "utf8")).mcp_servers, undefined);
  });
});
