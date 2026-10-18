import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { AgentHooks, OPENCODE_STATUS_PLUGIN_FILE, openCodeStatusPluginSource } from "../../agent-hooks.ts";
import type { AgentHomes } from "../../agent-profile/adapters/types.ts";
import { OPENCODE_GLOBAL_POOL_KEY, OpenCodeServerPool, type OpenCodeServerHandle } from "../../agent-host/adapters/opencode/server.ts";
import { makePeer } from "../../agent-host/adapters/opencode/testing/peer.ts";
import { createProfileLaunchResolver, profileLaunchContribution, type ProfileLaunchContext } from "../launch.ts";
import { writePreparedManifest } from "../manifest.ts";
import { opencodePreparedSectionSchema } from "../manifest/opencode.ts";
import { preparerFor } from "../preparer.ts";
import type { ResolvedAgentProfile } from "../resolve.ts";
import {
  OPENCODE_PREPARER_VERSION,
  opencodeLaunchContribution,
  opencodePreparer,
  opencodeProfilePoolKey,
  withSkillsDenied
} from "./opencode.ts";

const FAKE_OPENCODE = fileURLToPath(new URL("../../agent-isolation/testing/fake-opencode-debug-config.mjs", import.meta.url));

/** An executable `opencode` (the fake `debug config`, with `flags`) for a preparer's `cliBin`. */
async function fakeOpencodeBin(dir: string, flags: string[] = []): Promise<string> {
  const bin = join(dir, `opencode-${flags.join("").replace(/[^a-z]/g, "") || "honours"}`);
  await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OPENCODE)} ${flags.join(" ")} "$@"\n`);
  await chmod(bin, 0o755);
  return bin;
}

interface FixtureOptions {
  /** `(root) => cliBin` for the preparer; none by default (the probe does not run). */
  cliBin?: (root: string) => Promise<string>;
  /** Files written under the fake user's `~/.opencode` before preparing. */
  opencodeHome?: Record<string, string>;
  /** The profile's instructions ("Be brief.\n" by default). */
  instructions?: string;
}

const SECRETS = { env: "sekret-env-value-1", header: "Bearer sekret-header-value-2" };

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

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

/** A fake daemon user (Global OpenCode config with items, other XDG config) and a profile on disk. */
async function fixture(settings: Partial<ResolvedAgentProfile["settings"]> = {}, globalJsonc?: string, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "orq-opencode-preparer-"));
  roots.push(root);
  const home = join(root, "home");
  const xdg = join(home, ".config");
  const globalDir = join(xdg, "opencode");
  await write(
    join(globalDir, "config.json"),
    JSON.stringify({ model: "anthropic/old", plugin: ["npm-plugin"], mcp: { globalmcp: { type: "local", command: ["g"] } } })
  );
  await write(
    join(globalDir, "opencode.jsonc"),
    globalJsonc ??
      `// the user's config\n${JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4",
        permission: "ask",
        instructions: ["~/rules.md"],
        agent: { mine: { description: "x" } },
        default_agent: "mine",
        skills: { paths: ["/global/skills"] },
        provider: { acme: { options: { apiKey: "{file:./acme.key}", other: "{file:~/k}" } } },
        theme: "dark"
      })}\n`
  );
  await write(join(globalDir, "plugin", "user.js"), "export const U = async () => ({});\n");
  await write(join(globalDir, "plugin", OPENCODE_STATUS_PLUGIN_FILE), "// an older copy\n");
  await write(join(globalDir, "skills", "user-skill", "SKILL.md"), "---\nname: user-skill\ndescription: u\n---\nu\n");
  await write(join(xdg, "gh", "hosts.yml"), "github.com: {}\n");
  await write(join(xdg, "git", "config"), "[user]\n");
  await write(join(xdg, "mimeapps.list"), "\n");
  for (const [path, text] of Object.entries(options.opencodeHome ?? {})) {
    await write(join(home, ".opencode", path), text);
  }

  const profileDir = join(root, "profile");
  const skillDir = join(profileDir, "skills", "sk1");
  await write(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview it.\n");
  await write(join(skillDir, "notes.md"), "notes\n");
  const prFile = join(profileDir, "commands", "c1.md");
  await write(prFile, "---\ndescription: Open a PR\nargument-hint: '[title]'\n---\nOpen a PR.\n");
  const badFile = join(profileDir, "commands", "c2.md");
  await write(badFile, "---\nsubtask: sometimes\n---\nBad.\n");
  const pluginCache = join(profileDir, "plugins", "pl1");
  await write(join(pluginCache, "notify.js"), "export const Notify = async () => ({});\n");
  await write(join(pluginCache, "helper.mjs"), "export const h = 1;\n");
  await write(join(pluginCache, "README.md"), "docs\n");
  await write(join(pluginCache, OPENCODE_STATUS_PLUGIN_FILE), "// a copy imported from Global\n");
  const pluginCache2 = join(profileDir, "plugins", "pl2");
  await write(join(pluginCache2, "notify.js"), "export const Other = async () => ({});\n");

  const resolved: ResolvedAgentProfile = {
    profileId: "p1",
    revision: "4",
    name: "Dev Kit",
    agent: "opencode",
    settings: { hideBuiltinSkills: true, claudeWorkflowTool: true, ...settings },
    instructions: options.instructions ?? "Be brief.\n",
    skills: [{ id: "sk1", name: "review", description: "Review code", dir: skillDir, skillFile: join(skillDir, "SKILL.md") }],
    commands: [
      { id: "c1", name: "git/pr", description: "Open a PR", file: prFile },
      { id: "c2", name: "bad", file: badFile }
    ],
    mcpServers: [
      { id: "m1", name: "search", transport: "stdio", command: "search-mcp", args: ["--fast"], env: { API_KEY: SECRETS.env }, headers: {}, advanced: {} },
      {
        id: "m2",
        name: "docs",
        transport: "http",
        url: "https://docs.example/mcp",
        env: {},
        headers: { Authorization: SECRETS.header },
        advanced: { timeout: 5000 }
      },
      { id: "m3", name: "orquester", transport: "stdio", command: "fake", env: {}, headers: {}, advanced: {} },
      { id: "m4", name: "orquester-0123456789abcdef", transport: "stdio", command: "fake", env: {}, headers: {}, advanced: {} }
    ],
    hooks: [],
    plugins: [
      { id: "pl1", name: "notify.js", cacheDir: pluginCache },
      { id: "pl2", name: "notify-2.js", cacheDir: pluginCache2 }
    ],
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
  // Prepared in place: the staging dir IS the version dir here, so the launch side can read it.
  const preparedDir = join(root, "prepared", "p1", "opencode", "shared", "v-abc-1");
  await mkdir(preparedDir, { recursive: true, mode: 0o700 });
  const warnings: string[] = [];
  const globalBefore = await snapshot(xdg);
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
    cliBin: options.cliBin ? await options.cliBin(root) : null,
    logger: { info: () => {}, warn: (message) => warnings.push(message) }
  });
  await writePreparedManifest(preparedDir, {
    schema: 1,
    profileId: "p1",
    revision: "4",
    agent: "opencode",
    accountKey: "shared",
    preparedAt: "2026-10-18T00:00:00.000Z",
    fingerprint: "f",
    agentSection: section
  } as never);
  return { root, home, xdg, globalDir, preparedDir, section, warnings, systemHomes, globalBefore };
}

/** Every file under `dir` with its bytes (links as their target), to prove nothing was written there. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[relative(dir, full)] = entry.isSymbolicLink() ? `-> ${await readlink(full)}` : await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return out;
}

function contributionContext(f: Awaited<ReturnType<typeof fixture>>, launchEnv: Record<string, string> = {}): ProfileLaunchContext<"opencode"> {
  return {
    agent: "opencode",
    profile: { profileId: "p1", revision: "4", preparedDir: f.preparedDir },
    manifestSection: opencodePreparedSectionSchema.parse(f.section),
    accountId: null,
    accountHome: f.globalDir,
    projectPath: "/w/p",
    launchEnv
  };
}

describe("OpenCode preparer", () => {
  it("is registered, shared by every account, versioned, and reads the Global config files", () => {
    assert.equal(preparerFor("opencode"), opencodePreparer);
    assert.equal(opencodePreparer.perAccount, false);
    assert.equal(opencodePreparer.version, OPENCODE_PREPARER_VERSION);
    assert.match(OPENCODE_PREPARER_VERSION, /^3\.[0-9a-f]{8}$/);
    const homes = { opencodeDir: "/h/.config/opencode" } as AgentHomes;
    assert.deepEqual(opencodePreparer.inputs?.({ agent: "opencode", accountKey: "shared", accountHome: null, systemHomes: homes, appdir: "/a" }), [
      "/h/.config/opencode/config.json",
      "/h/.config/opencode/opencode.json",
      "/h/.config/opencode/opencode.jsonc"
    ]);
  });

  it("writes the config dir, the plugin copies, the status plugin and the XDG shadow (golden)", async () => {
    const f = await fixture();
    assert.deepEqual(f.section, {
      configDir: "opencode",
      xdgConfigHome: "xdg",
      realConfigHome: f.xdg,
      skills: ["review"],
      commands: ["git/pr"],
      mcpServerNames: ["search", "docs"],
      plugins: [
        { itemId: "pl1", name: "notify.js", files: ["helper.mjs", "notify.js"] },
        { itemId: "pl2", name: "notify-2.js", files: [] }
      ],
      hiddenSkills: ["customize-opencode"],
      userHome: f.home,
      testHome: { dir: "home", verified: false, reason: "no OpenCode binary was found to check it" }
    });
    assert.deepEqual(opencodePreparedSectionSchema.parse(f.section), f.section, "the section reads back as written");
    assert.deepEqual(await tree(f.preparedDir), [
      "home/",
      "manifest.json",
      "opencode/",
      "opencode/AGENTS.md",
      "opencode/commands/",
      "opencode/commands/git/",
      "opencode/commands/git/pr.md",
      "opencode/opencode.json",
      "opencode/plugin/",
      "opencode/plugin/helper.mjs",
      "opencode/plugin/notify.js",
      `opencode/plugin/${OPENCODE_STATUS_PLUGIN_FILE}`,
      "opencode/skills/",
      "opencode/skills/review/",
      "opencode/skills/review/notes.md",
      "opencode/skills/review/SKILL.md",
      "xdg/",
      "xdg/gh ->",
      "xdg/git ->",
      "xdg/mimeapps.list ->"
    ]);
    const config = JSON.parse(await readFile(join(f.preparedDir, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(config, {
      $schema: "https://opencode.ai/config.json",
      // §6.0: the runtime settings of every Global file, merged as OpenCode merges them…
      model: "anthropic/claude-sonnet-4",
      provider: { acme: { options: { apiKey: `{file:${join(f.globalDir, "acme.key")}}`, other: "{file:~/k}" } } },
      theme: "dark",
      // …without the items (mcp, plugin, instructions, agent, default_agent, skills), plus the recipe.
      mcp: {
        search: { type: "local", command: ["search-mcp", "--fast"], environment: { API_KEY: SECRETS.env } },
        docs: { type: "remote", url: "https://docs.example/mcp", headers: { Authorization: SECRETS.header }, timeout: 5000 }
      },
      skills: { paths: [".claude/skills", ".agents/skills"] },
      permission: { "*": "ask", skill: { "customize-opencode": "deny" } }
    });
    assert.equal((await stat(join(f.preparedDir, "opencode", "opencode.json"))).mode & 0o777, 0o600, "it holds secrets");
    assert.equal(await readFile(join(f.preparedDir, "opencode", "AGENTS.md"), "utf8"), "Be brief.\n");
    assert.equal(
      await readFile(join(f.preparedDir, "opencode", "commands", "git", "pr.md"), "utf8"),
      "---\ndescription: Open a PR\nargument-hint: '[title]'\n---\nOpen a PR.\n"
    );
    assert.equal(
      await readFile(join(f.preparedDir, "opencode", "plugin", OPENCODE_STATUS_PLUGIN_FILE), "utf8"),
      openCodeStatusPluginSource(),
      "Orquester's status plugin, not the profile's copy of it"
    );
    assert.equal(await readFile(join(f.preparedDir, "opencode", "plugin", "notify.js"), "utf8"), "export const Notify = async () => ({});\n");
    for (const name of ["gh", "git", "mimeapps.list"]) {
      assert.equal(await readlink(join(f.preparedDir, "xdg", name)), join(f.xdg, name));
    }
    assert.equal((await stat(join(f.preparedDir, "opencode"))).mode & 0o777, 0o700);
    assert.equal(f.warnings.length, 5);
    assert.ok(f.warnings.some((warning) => warning.includes(`"${OPENCODE_STATUS_PLUGIN_FILE}" of "notify.js"`)));
    assert.ok(f.warnings.some((warning) => warning.includes('"orquester"')));
    assert.ok(f.warnings.some((warning) => warning.includes('"orquester-0123456789abcdef"')));
    assert.ok(f.warnings.some((warning) => warning.includes('command "bad"')));
    assert.ok(f.warnings.some((warning) => warning.includes('"notify.js" of "notify-2.js"')));
    for (const warning of f.warnings) {
      assert.ok(!warning.includes(SECRETS.env) && !warning.includes(SECRETS.header));
    }
    assert.deepEqual(await snapshot(f.xdg), f.globalBefore, "nothing under the real ~/.config was written");
  });

  it("keeps the Global permission as is when built-in skills are shown, and merges the deny last otherwise", async () => {
    const f = await fixture({ hideBuiltinSkills: false });
    const config = JSON.parse(await readFile(join(f.preparedDir, "opencode", "opencode.json"), "utf8")) as Record<string, unknown>;
    // OpenCode's own decode of a permission string, as it reads the Global file.
    assert.deepEqual(config.permission, { "*": "ask" });
    assert.deepEqual(f.section.hiddenSkills, []);

    assert.deepEqual(withSkillsDenied(undefined, ["customize-opencode"]), { skill: { "customize-opencode": "deny" } });
    assert.deepEqual(withSkillsDenied({ skill: "ask", bash: "allow" }, ["customize-opencode"]), {
      bash: "allow",
      skill: { "*": "ask", "customize-opencode": "deny" }
    });
    // `skill` moves after a later `*` key, and the deny after a later `*` pattern: the last match wins.
    assert.deepEqual(
      Object.keys(withSkillsDenied({ skill: { "customize-opencode": "allow", "*": "allow" }, "*": "ask" }, ["customize-opencode"])),
      ["*", "skill"]
    );
    assert.deepEqual(
      withSkillsDenied({ skill: { "customize-opencode": "allow", "*": "allow" } }, ["customize-opencode"]).skill,
      { "*": "allow", "customize-opencode": "deny" }
    );
  });

  it("verifies OPENCODE_TEST_HOME against the CLI binary; the probe leaves nothing behind", async () => {
    const f = await fixture({}, undefined, { cliBin: (root) => fakeOpencodeBin(root) });
    assert.deepEqual(f.section.testHome, { dir: "home", verified: true });
    assert.deepEqual(await readdir(join(f.preparedDir, "home")), [], "the override home is empty");
    assert.ok(!(await tree(f.preparedDir)).some((path) => path.includes("probe")), "no probe scratch is published");
  });

  it("refuses when ~/.opencode holds config and the override is not verified (no binary, or one that ignores it)", async () => {
    const opencodeHome = { "opencode.json": "{}", "command/leak.md": "leak" };
    await assert.rejects(fixture({}, undefined, { opencodeHome }), /~\/\.opencode would leak into profile chats: .*command\/, opencode\.json/);
    await assert.rejects(
      fixture({}, undefined, { opencodeHome, cliBin: (root) => fakeOpencodeBin(root, ["--ignore-test-home"]) }),
      /~\/\.opencode would leak into profile chats: .*still loads ~\/\.opencode/
    );
    // Verified: the same home prepares.
    const f = await fixture({}, undefined, { opencodeHome, cliBin: (root) => fakeOpencodeBin(root) });
    assert.equal(f.section.testHome?.verified, true);
    // Only OpenCode's own files in ~/.opencode (an installer's bin/, its package.json): nothing to leak.
    const g = await fixture({}, undefined, { opencodeHome: { "bin/opencode": "x", "package.json": "{}" } });
    assert.equal(g.section.testHome?.verified, false);
  });

  it("always writes AGENTS.md — empty without instructions — so OpenCode never falls back to ~/.claude/CLAUDE.md", async () => {
    const f = await fixture({}, undefined, { instructions: "  \n" });
    assert.equal(await readFile(join(f.preparedDir, "opencode", "AGENTS.md"), "utf8"), "");
    assert.equal((await stat(join(f.preparedDir, "opencode", "AGENTS.md"))).mode & 0o777, 0o600);
  });

  it("fails with the reason when a Global config file does not parse", async () => {
    await assert.rejects(fixture({}, "{ not json"), /The Global OpenCode config .*opencode\.jsonc could not be read/);
  });
});

describe("OpenCode launch contribution", () => {
  it("is the registered contribution and names the version's keyed server with the profile env", async () => {
    const f = await fixture();
    assert.equal(profileLaunchContribution("opencode"), opencodeLaunchContribution);
    const contribution = await opencodeLaunchContribution(contributionContext(f));
    assert.equal(contribution.env, undefined, "nothing goes into the thread's own launch env");
    assert.equal(contribution.homePath, undefined);
    assert.deepEqual(contribution, {
      serverPool: {
        key: "profile:p1:v-abc-1",
        env: {
          XDG_CONFIG_HOME: join(f.preparedDir, "xdg"),
          OPENCODE_CONFIG_DIR: join(f.preparedDir, "opencode"),
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
          OPENCODE_TEST_HOME: join(f.preparedDir, "home")
        },
        unsetEnv: ["OPENCODE_CONFIG"]
      }
    });
    assert.equal(opencodeProfilePoolKey("p1", f.preparedDir), "profile:p1:v-abc-1");
    assert.notEqual(contribution.serverPool?.key, OPENCODE_GLOBAL_POOL_KEY);
    const env = contribution.serverPool?.env ?? {};
    for (const reserved of ["PATH", "HOME", "TMPDIR", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG_CONTENT", "XDG_DATA_HOME"]) {
      assert.ok(!(reserved in env), `${reserved} is left to the host / Global`);
    }
  });

  it("refuses at every launch while ~/.opencode holds config and the override is not verified", async () => {
    const f = await fixture();
    await opencodeLaunchContribution(contributionContext(f));
    await write(join(f.home, ".opencode", "agents", "a.md"), "a");
    await assert.rejects(opencodeLaunchContribution(contributionContext(f)), /~\/\.opencode would leak into profile chats: .*agents\//);
    // Through the resolver it is PROFILE_NOT_READY with that reason.
    const resolve = createProfileLaunchResolver({
      lifecycle: {
        ensureReady: async () => ({ profileId: "p1", agent: "opencode", accountKey: "shared", revision: "4", preparedDir: f.preparedDir })
      }
    });
    await assert.rejects(
      resolve({ profileId: "p1", agent: "opencode", accountId: "", projectPath: "/w/p", base: { launchEnv: {}, unsetEnv: [] } }),
      (error: unknown) => (error as { code?: string }).code === "PROFILE_NOT_READY" && /~\/\.opencode would leak/.test(String((error as Error).message))
    );
    await rm(join(f.home, ".opencode"), { recursive: true });
    await opencodeLaunchContribution(contributionContext(f));

    const verified = await fixture({}, undefined, { cliBin: (root) => fakeOpencodeBin(root) });
    await write(join(verified.home, ".opencode", "agents", "a.md"), "a");
    const contribution = await opencodeLaunchContribution(contributionContext(verified));
    assert.equal(contribution.serverPool?.env?.OPENCODE_TEST_HOME, join(verified.preparedDir, "home"));
  });

  it("refuses a version without AGENTS.md (an older preparation) instead of letting ~/.claude/CLAUDE.md in", async () => {
    const f = await fixture();
    await rm(join(f.preparedDir, "opencode", "AGENTS.md"));
    await assert.rejects(opencodeLaunchContribution(contributionContext(f)), /AGENTS\.md is missing/);
  });

  it("refreshes the shadow at every launch: new entries linked, gone ones and a stray `opencode` link removed", async () => {
    const f = await fixture();
    await write(join(f.xdg, "rclone", "rclone.conf"), "\n");
    await rm(join(f.xdg, "mimeapps.list"));
    // A stray link that would read the real global OpenCode dir (e.g. left by an older build).
    await symlink(f.globalDir, join(f.preparedDir, "xdg", "opencode"));
    // A real directory a tool created inside the shadow is left alone.
    await write(join(f.preparedDir, "xdg", "newtool", "state"), "x\n");
    await opencodeLaunchContribution(contributionContext(f));
    assert.deepEqual(await tree(join(f.preparedDir, "xdg")), ["gh ->", "git ->", "newtool/", "newtool/state", "rclone ->"]);
    assert.equal(await readlink(join(f.preparedDir, "xdg", "rclone")), join(f.xdg, "rclone"));

    // The launcher env's XDG_CONFIG_HOME, when it names one, is the config home mirrored.
    const other = join(f.root, "other-config");
    await write(join(other, "gh", "hosts.yml"), "\n");
    await write(join(other, "opencode", "opencode.json"), "{}\n");
    await opencodeLaunchContribution(contributionContext(f, { XDG_CONFIG_HOME: other }));
    assert.deepEqual(await tree(join(f.preparedDir, "xdg")), ["gh ->", "newtool/", "newtool/state"]);
    assert.equal(await readlink(join(f.preparedDir, "xdg", "gh")), join(other, "gh"));
  });

  it("loads Orquester's status plugin once and never writes it through to the real ~/.config/opencode", async () => {
    const f = await fixture();
    await opencodeLaunchContribution(contributionContext(f));
    const shadow = join(f.preparedDir, "xdg");
    // The only status plugin a profile server sees is the config dir's.
    assert.equal(await lstat(join(shadow, "opencode")).catch(() => null), null, "the shadow has no `opencode` of the real home");
    // Even an install aimed at the shadow (a launch whose XDG_CONFIG_HOME is it) lands in the
    // shadow's own real `opencode/`, never through a link into the real global dir.
    const daemonDir = join(f.root, "daemon");
    await new AgentHooks(daemonDir, f.home, { error: () => undefined }).ensureForEntry("opencode", { XDG_CONFIG_HOME: shadow });
    const installed = join(shadow, "opencode");
    assert.equal((await lstat(installed)).isDirectory(), true);
    assert.equal(await readFile(join(installed, "plugin", OPENCODE_STATUS_PLUGIN_FILE), "utf8"), openCodeStatusPluginSource());
    assert.deepEqual(await snapshot(f.xdg), f.globalBefore, "the real ~/.config is byte for byte as before");
    // A later refresh keeps that real dir (it is not a link) and links nothing named `opencode`.
    await opencodeLaunchContribution(contributionContext(f));
    assert.equal((await lstat(installed)).isDirectory(), true);
  });

  it("goes through the resolver: the account's launch stays as is, the keyed server is the profile's", async () => {
    const f = await fixture();
    const resolve = createProfileLaunchResolver({
      lifecycle: {
        ensureReady: async () => ({ profileId: "p1", agent: "opencode", accountKey: "shared", revision: "4", preparedDir: f.preparedDir })
      }
    });
    const base = { launchEnv: { OPENCODE_CONFIG: "/user/extra.json", KEEP: "1" }, unsetEnv: ["OPENCODE_API_KEY"] };
    const launch = await resolve({ profileId: "p1", agent: "opencode", accountId: "", projectPath: "/w/p", base });
    assert.deepEqual(launch.profile, { profileId: "p1", revision: "4", preparedDir: f.preparedDir });
    assert.equal(launch.fields.serverPool?.key, "profile:p1:v-abc-1");
    // OpenCode's servers read the project's launcher env; the profile's unsets ride the keyed server.
    assert.deepEqual(launch.fields.launchEnv, base.launchEnv);
    assert.deepEqual(launch.fields.unsetEnv, ["OPENCODE_API_KEY"]);
    assert.deepEqual(launch.fields.serverPool?.unsetEnv, ["OPENCODE_CONFIG"]);
  });
});

describe("a profile's keyed OpenCode server", () => {
  const REPORTED = [
    "XDG_CONFIG_HOME",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
    "OPENCODE_TEST_HOME",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "XDG_DATA_HOME"
  ];

  async function envOf(handle: OpenCodeServerHandle, directory: string): Promise<Record<string, string | null>> {
    return await handle.client(directory).get<Record<string, string | null>>("/__peer/env", { timeoutMs: 2_000 });
  }

  it("starts with the contribution's env over the launcher env; the project's Global server is unchanged", async () => {
    const f = await fixture();
    const { serverPool } = await opencodeLaunchContribution(contributionContext(f));
    assert.ok(serverPool !== undefined);
    const peer = makePeer();
    const controller = new AbortController();
    const pool = new OpenCodeServerPool({
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      resolveBin: async () => peer.bin,
      buildEnv: () => ({
        PATH: process.env.PATH ?? "",
        HOME: peer.dir,
        TMPDIR: peer.dir,
        MOCK_MODE: "ok",
        MOCK_REPORT_ENV: REPORTED.join(","),
        OPENCODE_CONFIG: "/user/extra.json",
        OPENCODE_CONFIG_CONTENT: '{"orquester":true}',
        XDG_DATA_HOME: "/shared/data"
      }),
      signal: controller.signal
    });
    try {
      const global = await pool.acquire(peer.dir);
      const profile = await pool.acquire(peer.dir, serverPool);
      assert.notEqual(global.pid, profile.pid);
      assert.equal(profile.poolKey, "profile:p1:v-abc-1");
      assert.deepEqual(await envOf(global, peer.dir), {
        XDG_CONFIG_HOME: null,
        OPENCODE_CONFIG_DIR: null,
        OPENCODE_DISABLE_EXTERNAL_SKILLS: null,
        OPENCODE_DISABLE_CLAUDE_CODE: null,
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: null,
        OPENCODE_TEST_HOME: null,
        OPENCODE_CONFIG: "/user/extra.json",
        OPENCODE_CONFIG_CONTENT: '{"orquester":true}',
        XDG_DATA_HOME: "/shared/data"
      });
      assert.deepEqual(await envOf(profile, peer.dir), {
        XDG_CONFIG_HOME: join(f.preparedDir, "xdg"),
        OPENCODE_CONFIG_DIR: join(f.preparedDir, "opencode"),
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        // Not the broad flag: it would drop a repo's own CLAUDE.md too.
        OPENCODE_DISABLE_CLAUDE_CODE: null,
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_TEST_HOME: join(f.preparedDir, "home"),
        OPENCODE_CONFIG: null,
        // Orquester's injected settings still reach it (OpenCode merges them last), and the data dir is shared.
        OPENCODE_CONFIG_CONTENT: '{"orquester":true}',
        XDG_DATA_HOME: "/shared/data"
      });
      global.release();
      profile.release();
    } finally {
      await pool.stopAll();
      controller.abort();
      peer.cleanup();
    }
  });
});
