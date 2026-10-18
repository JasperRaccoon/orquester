/**
 * Filling an Agent Profile (spec §4.5) end to end at the service level, over temp homes: Import
 * from Global through the REAL Claude adapter (Global left byte for byte as it was), git / zip /
 * md scans through the real import store (a fake `git clone`), copy from another profile,
 * marketplace and Global plugins into the profile's own cache per agent, and export / import of a
 * whole profile. No secret value may appear in any answer or export.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentProfileSnapshot, ProfileItem, SessionProfileDetail } from "@orquester/api";
import { agentProfileBackupsDir, agentProfileStashDir } from "@orquester/config";
import { ClaudeProfileAdapter } from "../agent-profile/adapters/claude/index.ts";
import type { PluginSourceLocation, PortableItem } from "../agent-profile/adapters/types.ts";
import { createProfileConverter } from "../agent-profile/convert.ts";
import { ProfileImportStore } from "../agent-profile/import.ts";
import type { GitCloneFn } from "../agent-profile/import/git-clone.ts";
import { ProfileBackups, ProfileStash } from "../agent-profile/infra/index.ts";
import { AgentProfileService } from "../agent-profile/service.ts";
import { buildZip, type ZipEntry } from "./files.ts";
import { SessionProfileImports, type SessionProfileGlobalConfig } from "./imports.ts";
import { profileLayout } from "./layout.ts";
import { SessionProfileService } from "./service.ts";
import { SessionProfileStore } from "./store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SECRET = "ghp-THE-GLOBAL-SECRET-VALUE";
const HEADER_SECRET = "Bearer HEADER-SECRET-VALUE";

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every file under `dir` → its sha256 (a Global must come out of an import untouched). */
async function digestTree(dir: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(join(dir, rel))).sort()) {
    const path = join(dir, rel, name);
    const st = await lstat(path);
    const key = rel === "" ? name : `${rel}/${name}`;
    if (st.isDirectory()) Object.assign(out, await digestTree(dir, key));
    else if (st.isFile()) out[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    else if (st.isSymbolicLink()) out[key] = "symlink";
  }
  return out;
}

function noSecrets(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.ok(!text.includes(SECRET), "a secret value leaked");
  assert.ok(!text.includes(HEADER_SECRET), "a header secret leaked");
}

interface Harness {
  root: string;
  appdir: string;
  home: string;
  claudeDir: string;
  service: SessionProfileService;
  store: SessionProfileStore;
  clones: { url: string; ref: string | undefined }[];
  global: SessionProfileGlobalConfig;
}

/** A remote repository the fake clone copies: `url` → a directory. */
const remotes = new Map<string, string>();

const fakeClone: GitCloneFn = async (url, ref, dest) => {
  const source = remotes.get(url);
  if (source === undefined) throw new Error(`no such repository ${url}`);
  await cp(source, dest, { recursive: true, verbatimSymlinks: true });
  await mkdir(join(dest, ".git"), { recursive: true });
  await writeFile(join(dest, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  void ref;
};

async function harness(options: { global?: (claude: AgentProfileService) => SessionProfileGlobalConfig } = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-sp-imports-")));
  roots.push(root);
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const appdir = join(root, "appdir");

  // A small Claude Global: a skill with a reference file, commands, an MCP server with a secret,
  // a user hook, instructions, an installed plugin and a local marketplace.
  await write(join(claudeDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review the diff\nwhen_to_use: On PRs\nallowed-tools: Read\n---\nReview carefully.\n");
  await write(join(claudeDir, "skills", "review", "references", "checklist.md"), "- tests\n");
  await write(join(claudeDir, "commands", "git", "pr.md"), "---\ndescription: Open a PR\nargument-hint: <title>\n---\nOpen a PR titled $ARGUMENTS\n");
  await write(join(claudeDir, "CLAUDE.md"), "# Global rules\n\nBe brief.\n");
  await writeJson(join(home, ".claude.json"), {
    mcpServers: {
      github: { type: "stdio", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: SECRET } },
      remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: HEADER_SECRET } }
    }
  });
  await writeJson(join(claudeDir, "settings.json"), {
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "notify-send done", timeout: 5 }] }] }
  });
  const pluginsDir = join(claudeDir, "plugins");
  const installed = join(pluginsDir, "cache", "acme", "superpowers", "2.0.0");
  await writeJson(join(installed, ".claude-plugin", "plugin.json"), { name: "superpowers", version: "2.0.0", description: "Core skills" });
  await write(join(installed, "skills", "brainstorm", "SKILL.md"), "---\nname: brainstorm\ndescription: Think\n---\nBody\n");
  await write(join(installed, "hooks", "start.sh"), "#!/bin/sh\necho hi\n");
  await writeJson(join(pluginsDir, "installed_plugins.json"), {
    version: 2,
    plugins: { "superpowers@acme": [{ scope: "user", installPath: installed, version: "2.0.0" }] }
  });
  const market = join(pluginsDir, "marketplaces", "acme");
  await writeJson(join(market, ".claude-plugin", "marketplace.json"), {
    name: "acme",
    plugins: [
      { name: "local-plug", description: "Local", version: "1.1.0", source: "./plugins/local-plug" },
      { name: "loose-plug", source: "./plugins/loose-plug" },
      { name: "remote-plug", source: { source: "github", repo: "acme/remote-plug" } },
      { name: "npm-plug", source: { source: "npm", package: "x" } }
    ]
  });
  await writeJson(join(market, "plugins", "local-plug", ".claude-plugin", "plugin.json"), { name: "local-plug", version: "1.1.0" });
  await write(join(market, "plugins", "local-plug", "commands", "go.md"), "Go.\n");
  await write(join(market, "plugins", "loose-plug", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  await mkdir(join(market, ".git"), { recursive: true });
  await writeFile(join(market, ".git", "HEAD"), "fedcba9876543210fedcba9876543210fedcba98\n");
  await writeJson(join(pluginsDir, "known_marketplaces.json"), {
    acme: { source: { source: "github", repo: "acme/marketplace" }, installLocation: market }
  });

  const remotePlug = join(root, "remotes", "remote-plug");
  await writeJson(join(remotePlug, ".claude-plugin", "plugin.json"), { name: "remote-plug", version: "0.3.0" });
  await write(join(remotePlug, "skills", "r", "SKILL.md"), "---\nname: r\ndescription: remote\n---\n");
  remotes.set("https://github.com/acme/remote-plug.git", remotePlug);

  const claude = new ClaudeProfileAdapter(
    {
      homes: {
        home,
        claudeDir,
        claudeJson: join(home, ".claude.json"),
        codexHome: join(home, ".codex"),
        grokHome: join(home, ".grok"),
        opencodeDir: join(home, ".config", "opencode"),
        agentsSkillsDir: join(home, ".agents", "skills")
      },
      appdir,
      bin: null,
      accountHomes: async () => [],
      logger: { info: () => undefined, warn: () => undefined },
      now: () => new Date("2026-10-18T12:00:00.000Z")
    },
    { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }), stash: new ProfileStash({ dir: agentProfileStashDir(appdir) }) }
  );
  const workDir = join(appdir, "daemon", "agent-profile-imports");
  const agentProfile = new AgentProfileService({
    adapters: { claude },
    agentInfo: (agent) => ({ installed: agent === "claude" }),
    converter: createProfileConverter({ tempRoot: workDir }),
    logger: { warn: () => undefined, error: () => undefined }
  });
  const clones: { url: string; ref: string | undefined }[] = [];
  const clone: GitCloneFn = async (url, ref, dest, opts) => {
    clones.push({ url, ref });
    await fakeClone(url, ref, dest, opts);
  };
  const scanner = new ProfileImportStore({ dir: workDir, existing: async () => new Set(), clone, logger: { info: () => undefined, warn: () => undefined } });
  let n = 0;
  const store = new SessionProfileStore({ appdir, newId: () => `id-${++n}`, now: () => new Date("2026-10-18T12:00:00.000Z") });
  const global = options.global ? options.global(agentProfile) : agentProfile;
  const imports = new SessionProfileImports({ store, global, scanner, workDir, clone, now: () => new Date("2026-10-18T12:00:00.000Z") });
  const service = new SessionProfileService({ store, imports });
  await service.init();
  return { root, appdir, home, claudeDir, service, store, clones, global };
}

async function itemIdOf(h: Harness, kind: string, name: string): Promise<string> {
  const snapshot = await h.global.snapshot("claude");
  const item = snapshot.items.find((candidate) => candidate.kind === kind && (candidate.name === name || candidate.name.startsWith(`${name}@`)));
  assert.ok(item, `no Global ${kind} ${name}`);
  return item.id;
}

const byName = (profile: SessionProfileDetail, kind: string, name: string) =>
  profile.items.find((item) => item.kind === kind && item.name === name);

describe("Import from Global", () => {
  it("copies skills, commands, MCP servers (secrets host-only), hooks, plugins and instructions; Global is untouched", async () => {
    const h = await harness();
    const before = await digestTree(h.home);
    const profile = await h.service.create({ name: "Dev" });

    const source = await h.service.globalSource(profile.id, "claude");
    noSecrets(source);
    assert.equal(source.installed, true);
    assert.equal(source.instructions.exists, true);
    const kinds = new Set(source.items.map((item) => item.kind));
    for (const kind of ["skill", "command", "mcp", "hook", "plugin"]) assert.ok(kinds.has(kind as never), kind);
    assert.ok(source.items.some((item) => item.kind === "plugin" && item.name === "superpowers"));

    const ids = [
      await itemIdOf(h, "skill", "review"),
      await itemIdOf(h, "command", "git/pr"),
      await itemIdOf(h, "mcp", "github"),
      await itemIdOf(h, "mcp", "remote"),
      source.items.find((item) => item.kind === "hook")!.id,
      await itemIdOf(h, "plugin", "superpowers")
    ];
    const result = await h.service.importFromGlobal(profile.id, {
      revision: profile.revision,
      agent: "claude",
      itemIds: ids,
      instructions: "replace"
    });
    noSecrets(result);
    assert.equal(result.itemIds.length, 6);
    assert.equal(result.profile.revision, "2");
    assert.equal(result.profile.hasInstructions, true);

    const skill = byName(result.profile, "skill", "review")!;
    assert.equal(skill.agents, "all");
    const command = byName(result.profile, "command", "git/pr")!;
    assert.equal(command.agents, "all");
    const mcp = byName(result.profile, "mcp", "github")!;
    assert.equal(mcp.kind === "mcp" && mcp.mcp.env?.[0]?.key, "GITHUB_TOKEN");
    const hook = result.profile.items.find((item) => item.kind === "hook")!;
    assert.deepEqual(hook.agents, ["claude"]);
    assert.equal(hook.kind === "hook" && hook.hook.command, "notify-send done");
    const plugin = byName(result.profile, "plugin", "superpowers")!;
    assert.deepEqual(plugin.agents, ["claude"]);
    assert.ok(plugin.kind === "plugin" && plugin.plugin.cached && plugin.plugin.marketplace === "acme" && plugin.plugin.version === "2.0.0");
    assert.equal(plugin.kind === "plugin" && plugin.plugin.source?.type, "global");

    // On disk: the skill's other file, the plugin root, the secrets file holding the values (0600).
    const layout = profileLayout(join(h.appdir, "daemon", "session-profiles", "profiles", profile.id));
    assert.equal(await readFile(join(layout.skillDir(skill.id), "references", "checklist.md"), "utf8"), "- tests\n");
    assert.match(await readFile(layout.skillFile(skill.id), "utf8"), /when_to_use: On PRs/);
    const cache = layout.pluginCacheDir(plugin.id);
    assert.ok((await stat(join(cache, ".claude-plugin", "plugin.json"))).isFile());
    assert.equal((await stat(join(cache, "hooks", "start.sh"))).mode & 0o777, 0o600);
    const secrets = await readFile(layout.secrets, "utf8");
    assert.ok(secrets.includes(SECRET) && secrets.includes(HEADER_SECRET));
    assert.equal((await stat(layout.secrets)).mode & 0o777, 0o600);
    assert.equal(await readFile(layout.instructions, "utf8"), "# Global rules\n\nBe brief.\n");
    const resolved = await h.service.resolveForAgent(profile.id, "claude");
    assert.equal(resolved.mcpServers.find((server) => server.name === "github")?.env.GITHUB_TOKEN, SECRET);
    assert.equal(resolved.plugins[0]?.cacheDir, cache);

    // Read back through every wire path: no value.
    noSecrets(await h.service.get(profile.id));
    noSecrets(await h.service.readItem(profile.id, mcp.id));

    // Global is byte for byte what it was.
    assert.deepEqual(await digestTree(h.home), before);
  });

  it("maps frontmatter for a single other agent, appends instructions, and follows the conflict policy", async () => {
    const h = await harness();
    const profile = await h.service.create({ name: "Codex only" });
    await h.service.writeInstructions(profile.id, profile.revision, "Profile rules.");
    const skillId = await itemIdOf(h, "skill", "review");
    const first = await h.service.importFromGlobal(profile.id, {
      revision: "2",
      agent: "claude",
      itemIds: [skillId, await itemIdOf(h, "mcp", "github")],
      agents: ["codex"],
      instructions: "append"
    });
    assert.deepEqual(byName(first.profile, "skill", "review")!.agents, ["codex"]);
    assert.ok(first.notes.some((note) => /review: Dropped frontmatter keys Codex does not use: when_to_use, allowed-tools/.test(note)), first.notes.join(" | "));
    const layout = profileLayout(join(h.appdir, "daemon", "session-profiles", "profiles", profile.id));
    const text = await readFile(layout.skillFile(byName(first.profile, "skill", "review")!.id), "utf8");
    assert.ok(!text.includes("when_to_use") && text.includes("description: Review the diff"));
    assert.equal(await readFile(layout.instructions, "utf8"), "Profile rules.\n\n# Global rules\n\nBe brief.\n");

    // fail → 409, nothing written; skip; keep-both → `-2`; replace keeps one.
    await assert.rejects(
      h.service.importFromGlobal(profile.id, { revision: first.profile.revision, agent: "claude", itemIds: [skillId], agents: ["codex"] }),
      (error: { code?: string }) => error.code === "ITEM_EXISTS"
    );
    const skipped = await h.service.importFromGlobal(profile.id, { revision: first.profile.revision, agent: "claude", itemIds: [skillId], agents: "all", onConflict: "skip" });
    assert.match(skipped.notes.join(" "), /Skipped the skill "review"/);
    assert.equal(skipped.itemIds.length, 0);
    const both = await h.service.importFromGlobal(profile.id, { revision: skipped.profile.revision, agent: "claude", itemIds: [skillId], onConflict: "keep-both" });
    assert.ok(byName(both.profile, "skill", "review-2"));
    const text2 = await readFile(layout.skillFile(byName(both.profile, "skill", "review-2")!.id), "utf8");
    assert.match(text2, /^---\nname: review-2\n/);
    // An identical hook is never kept twice: keep-both skips it.
    const hookId = (await h.service.globalSource(profile.id, "claude")).items.find((item) => item.kind === "hook")!.id;
    const hook1 = await h.service.importFromGlobal(profile.id, { revision: both.profile.revision, agent: "claude", itemIds: [hookId] });
    const hook2 = await h.service.importFromGlobal(profile.id, { revision: hook1.profile.revision, agent: "claude", itemIds: [hookId], onConflict: "keep-both" });
    assert.equal(hook2.profile.items.filter((item) => item.kind === "hook").length, 1);
    assert.match(hook2.notes.join(" "), /Skipped the hook/);
    const replaced = await h.service.importFromGlobal(profile.id, { revision: hook2.profile.revision, agent: "claude", itemIds: [skillId], agents: ["codex"], onConflict: "replace" });
    assert.equal(replaced.profile.items.filter((item) => item.name === "review").length, 1);
    assert.match(replaced.notes.join(" "), /Replaced the profile's skill "review"/);

    // A stale revision is a conflict.
    await assert.rejects(
      h.service.importFromGlobal(profile.id, { revision: "1", agent: "claude", itemIds: [skillId] }),
      (error: { code?: string }) => error.code === "PROFILE_CONFLICT"
    );
  });

  it("refuses an agent that is not installed and items that cannot be imported", async () => {
    const h = await harness();
    const profile = await h.service.create({ name: "P" });
    assert.deepEqual((await h.service.globalSource(profile.id, "grok")).installed, false);
    await assert.rejects(
      h.service.importFromGlobal(profile.id, { revision: "1", agent: "grok", itemIds: ["skill:x"] }),
      (error: { code?: string }) => error.code === "AGENT_NOT_INSTALLED"
    );
    await assert.rejects(
      h.service.importFromGlobal(profile.id, { revision: "1", agent: "claude", itemIds: ["skill:nope"] }),
      (error: { code?: string }) => error.code === "INVALID_ITEM"
    );
    const pluginSkill = (await h.service.globalSource(profile.id, "claude")).items.find((item) => item.unavailable !== undefined);
    if (pluginSkill) {
      await assert.rejects(
        h.service.importFromGlobal(profile.id, { revision: "1", agent: "claude", itemIds: [pluginSkill.id] }),
        (error: { code?: string }) => error.code === "INVALID_ITEM"
      );
    }
  });
});

describe("Git / .zip / .md imports", () => {
  it("scans a repository: commands stay commands, exists is the profile's, picks land with the chosen scope", async () => {
    const h = await harness();
    const repo = join(h.root, "remotes", "skills-repo");
    await write(join(repo, "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint it\n---\nLint.\n");
    await write(join(repo, "skills", "lint", "rules.md"), "rules\n");
    await write(join(repo, "commands", "git", "ship.md"), "---\ndescription: Ship\n---\nShip it.\n");
    remotes.set("https://github.com/acme/skills-repo", repo);
    const profile = await h.service.create({ name: "Git" });
    const added = await h.service.createItem(profile.id, "1", { kind: "skill", document: { name: "lint", frontmatter: { description: "Mine" }, body: "" } });

    const scan = await h.service.scanGit(profile.id, "https://github.com/acme/skills-repo");
    const lint = scan.candidates.find((candidate) => candidate.name === "lint")!;
    const ship = scan.candidates.find((candidate) => candidate.name === "git/ship")!;
    assert.equal(lint.exists, true);
    assert.equal(ship.kind, "command");
    assert.equal(ship.exists, false);

    // Another profile cannot take this scan.
    const other = await h.service.create({ name: "Other" });
    await assert.rejects(h.service.takeScan(other.id, scan.importId, { revision: "1", picks: [ship.ref] }), (error: { code?: string }) => error.code === "IMPORT_NOT_FOUND");

    // A stale revision is refused without using up the scan.
    await assert.rejects(h.service.takeScan(profile.id, scan.importId, { revision: "1", picks: [ship.ref] }), (error: { code?: string }) => error.code === "PROFILE_CONFLICT");
    const taken = await h.service.takeScan(profile.id, scan.importId, {
      revision: added.profile.revision,
      picks: [lint.ref, ship.ref],
      agents: ["claude", "codex"],
      onConflict: "keep-both"
    });
    assert.ok(byName(taken.profile, "command", "git/ship"));
    assert.deepEqual(byName(taken.profile, "command", "git/ship")!.agents, ["claude", "codex"]);
    const lint2 = byName(taken.profile, "skill", "lint-2")!;
    const layout = profileLayout(join(h.appdir, "daemon", "session-profiles", "profiles", profile.id));
    assert.equal(await readFile(join(layout.skillDir(lint2.id), "rules.md"), "utf8"), "rules\n");
    // Single use.
    await assert.rejects(h.service.takeScan(profile.id, scan.importId, { revision: taken.profile.revision, picks: [ship.ref] }), (error: { code?: string }) => error.code === "IMPORT_NOT_FOUND");
  });

  it("scans an uploaded .zip and .md; refuses an archive that escapes or carries a symlink", async () => {
    const h = await harness();
    const profile = await h.service.create({ name: "Zip" });
    const zip = join(h.root, "upload.zip");
    await writeFile(
      zip,
      buildZip([
        { path: "pack/SKILL.md", data: Buffer.from("---\nname: pack\ndescription: Packed\n---\nBody\n"), mode: 0o644 },
        { path: "commands/hello.md", data: Buffer.from("Hello\n"), mode: 0o644 }
      ])
    );
    const scan = await h.service.scanUpload(profile.id, "upload.zip", zip);
    assert.deepEqual(scan.candidates.map((candidate) => `${candidate.kind}:${candidate.name}`).sort(), ["command:hello", "skill:pack"]);
    const taken = await h.service.takeScan(profile.id, scan.importId, { revision: "1", picks: scan.candidates.map((candidate) => candidate.ref) });
    assert.equal(taken.itemIds.length, 2);

    const md = join(h.root, "deploy.md");
    await writeFile(md, "---\ndescription: Deploy\n---\nDeploy.\n");
    const mdScan = await h.service.scanUpload(profile.id, "deploy.md", md);
    assert.deepEqual(mdScan.candidates.map((candidate) => `${candidate.kind}:${candidate.name}`), ["command:deploy"]);

    const evil = join(h.root, "evil.zip");
    await writeFile(evil, buildZip([{ path: "../evil/SKILL.md", data: Buffer.from("x"), mode: 0o644 }]));
    await assert.rejects(h.service.scanUpload(profile.id, "evil.zip", evil), (error: { code?: string; message: string }) => error.code === "IMPORT_FAILED" && /leaves the archive|invalid relative path/.test(error.message));
    const link = buildZip([{ path: "s/SKILL.md", data: Buffer.from("/etc/passwd"), mode: 0o777 }]);
    // Mark the entry a symlink in its central-directory external attributes.
    const central = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    link.writeUInt32LE(((0o120000 | 0o777) << 16) >>> 0, central + 38);
    await writeFile(evil, link);
    await assert.rejects(h.service.scanUpload(profile.id, "evil.zip", evil), (error: { message: string }) => /symlink/.test(error.message));
  });
});

describe("Copy from profile", () => {
  it("copies items with their files, plugin cache, secret values and scope", async () => {
    const h = await harness();
    const from = await h.service.create({ name: "From" });
    const filled = await h.service.importFromGlobal(from.id, {
      revision: "1",
      agent: "claude",
      itemIds: [await itemIdOf(h, "skill", "review"), await itemIdOf(h, "mcp", "github"), await itemIdOf(h, "plugin", "superpowers")],
      agents: ["claude", "grok"]
    });
    const to = await h.service.create({ name: "To" });
    const copied = await h.service.copyFrom(to.id, {
      revision: "1",
      fromProfileId: from.id,
      itemIds: filled.itemIds
    });
    noSecrets(copied);
    assert.equal(copied.itemIds.length, 3);
    assert.deepEqual(byName(copied.profile, "skill", "review")!.agents, ["claude", "grok"]);
    const resolved = await h.service.resolveForAgent(to.id, "claude");
    assert.equal(resolved.mcpServers[0]?.env.GITHUB_TOKEN, SECRET);
    assert.ok((await stat(join(resolved.plugins[0]!.cacheDir, ".claude-plugin", "plugin.json"))).isFile());
    assert.ok((await stat(join(resolved.skills[0]!.dir, "references", "checklist.md"))).isFile());
    await assert.rejects(h.service.copyFrom(to.id, { revision: copied.profile.revision, fromProfileId: to.id, itemIds: [] , instructions: "append" }), (error: { code?: string }) => error.code === "INVALID_REQUEST");
  });
  it("copies one consistent snapshot of the source: an edit of the source during the copy does not tear it", async () => {
    const h = await harness();
    const from = await h.service.create({ name: "From" });
    const filled = await h.service.importFromGlobal(from.id, {
      revision: "1",
      agent: "claude",
      itemIds: [await itemIdOf(h, "skill", "review"), await itemIdOf(h, "plugin", "superpowers")]
    });
    const to = await h.service.create({ name: "To" });
    // The source's skill and plugin are deleted while the target's import runs: the copy must
    // still carry the files as they were when the copy read the source.
    const importItems = h.store.importItems.bind(h.store);
    h.store.importItems = async (...args) => {
      let revision = filled.profile.revision;
      for (const itemId of filled.itemIds) revision = (await h.store.deleteItem(from.id, itemId, revision)).manifest.revision.toString();
      return importItems(...args);
    };
    const copied = await h.service.copyFrom(to.id, { revision: "1", fromProfileId: from.id, itemIds: filled.itemIds });
    assert.equal(copied.itemIds.length, 2);
    const resolved = await h.service.resolveForAgent(to.id, "claude");
    assert.equal(await readFile(join(resolved.skills[0]!.dir, "references", "checklist.md"), "utf8"), "- tests\n");
    assert.match(await readFile(join(resolved.skills[0]!.dir, "SKILL.md"), "utf8"), /Review carefully/);
    assert.ok((await stat(join(resolved.plugins[0]!.cacheDir, ".claude-plugin", "plugin.json"))).isFile());
    // The snapshot is temporary: nothing of it is left in the work dir.
    assert.deepEqual((await readdir(join(h.appdir, "daemon", "agent-profile-imports")).catch(() => [])).filter((name) => name.startsWith("session-profile-copy")), []);
  });
});

describe("Plugins into the profile's own cache", () => {
  it("Claude: a marketplace folder, a catalogue-only plugin given a manifest, and a remote source cloned", async () => {
    const h = await harness();
    const profile = await h.service.create({ name: "Plugins" });
    const local = await h.service.addPlugin(profile.id, { revision: "1", agent: "claude", source: { type: "marketplace", marketplace: "acme", plugin: "local-plug" } });
    const item = byName(local.profile, "plugin", "local-plug")!;
    assert.ok(item.kind === "plugin");
    assert.deepEqual(item.agents, ["claude"]);
    assert.equal(item.plugin.version, "1.1.0");
    assert.equal(item.plugin.source?.commit, "fedcba9876543210fedcba9876543210fedcba98");
    const layout = profileLayout(join(h.appdir, "daemon", "session-profiles", "profiles", profile.id));
    assert.equal(await readFile(join(layout.pluginCacheDir(item.id), "commands", "go.md"), "utf8"), "Go.\n");

    const loose = await h.service.addPlugin(profile.id, { revision: local.profile.revision, agent: "claude", source: { type: "marketplace", marketplace: "acme", plugin: "loose-plug" } });
    const looseItem = byName(loose.profile, "plugin", "loose-plug")!;
    const manifest = JSON.parse(await readFile(join(layout.pluginCacheDir(looseItem.id), ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "loose-plug");

    const remote = await h.service.addPlugin(profile.id, { revision: loose.profile.revision, agent: "claude", source: { type: "marketplace", marketplace: "acme", plugin: "remote-plug" } });
    const remoteItem = byName(remote.profile, "plugin", "remote-plug")!;
    assert.ok(remoteItem.kind === "plugin");
    assert.equal(remoteItem.plugin.version, "0.3.0");
    assert.equal(remoteItem.plugin.source?.url, "https://github.com/acme/remote-plug.git");
    assert.deepEqual(h.clones.at(-1), { url: "https://github.com/acme/remote-plug.git", ref: undefined });
    const files = await readdir(layout.pluginCacheDir(remoteItem.id));
    assert.ok(!files.includes(".git"));

    await assert.rejects(
      h.service.addPlugin(profile.id, { revision: remote.profile.revision, agent: "claude", source: { type: "marketplace", marketplace: "acme", plugin: "npm-plug" } }),
      (error: { code?: string; message: string }) => error.code === "IMPORT_FAILED" && /Install it in Agent config/.test(error.message)
    );
    await assert.rejects(
      h.service.addPlugin(profile.id, { revision: remote.profile.revision, agent: "claude", source: { type: "marketplace", marketplace: "acme", plugin: "local-plug" } }),
      (error: { code?: string }) => error.code === "ITEM_EXISTS"
    );
    // Claude's account `plugins/` (the Global one) is untouched.
    assert.deepEqual((await readdir(join(h.claudeDir, "plugins", "cache"))).sort(), ["acme"]);
    assert.deepEqual(await readdir(join(h.claudeDir, "plugins", "cache", "acme")), ["superpowers"]);
  });

  it("Codex, Grok and OpenCode: version root, a remote marketplace's catalogue, a Global plugin file; symlinks refused", async () => {
    let fixtures!: { codexCache: string; grokRepo: string; opencodeFile: string; linkPlug: string };
    const h = await harness({
      global: (claude) => ({
        snapshot: async (agent): Promise<AgentProfileSnapshot> => {
          if (agent === "claude") return claude.snapshot(agent);
          const item = (patch: Partial<ProfileItem>): ProfileItem => ({
            id: "plugin:x",
            kind: "plugin",
            name: "x",
            enabled: true,
            toggleable: true,
            editable: false,
            deletable: true,
            locked: false,
            source: { type: "user", label: "User" },
            revision: "r",
            warnings: [],
            ...patch
          });
          const items =
            agent === "codex"
              ? [item({ id: "plugin:tools@openai", name: "tools", path: fixtures.codexCache, meta: { marketplace: "openai", version: "1.2.0" } })]
              : agent === "opencode"
                ? [
                    item({ id: "plugin:plugin/notify.js", name: "notify.js", path: fixtures.opencodeFile, meta: { source: "file" } }),
                    item({ id: "plugin:npm-thing", name: "npm-thing", meta: { source: "npm" } })
                  ]
                : [];
          return { agent, installed: true, revision: "r", instructions: { path: "", exists: false, bytes: 0, lines: 0, revision: "", warnings: [] }, items, fileErrors: [], readAt: "t" };
        },
        readItem: (agent, id) => claude.readItem(agent, id),
        readInstructions: (agent) => claude.readInstructions(agent),
        exportItem: (agent, id): Promise<PortableItem> => claude.exportItem(agent, id),
        pluginSource: async (agent, marketplace, plugin): Promise<PluginSourceLocation> => {
          if (agent === "grok") {
            return { marketplaceDir: null, source: { type: "remote", description: "marketplace", fetch: { url: "https://github.com/acme/grok-market.git", ref: "main", catalogPlugin: plugin } } };
          }
          if (agent === "codex" && plugin === "linked") return { marketplaceDir: null, source: { type: "local", dir: fixtures.linkPlug } };
          return claude.pluginSource(agent, marketplace, plugin);
        }
      })
    });
    const codexCache = join(h.root, "codex-home", "plugins", "cache", "openai", "tools");
    await writeJson(join(codexCache, "1.2.0", ".codex-plugin", "plugin.json"), { name: "tools", version: "1.2.0" });
    await write(join(codexCache, "1.2.0", "skills", "t", "SKILL.md"), "---\nname: t\ndescription: d\n---\n");
    await writeJson(join(codexCache, "0.9.0", ".codex-plugin", "plugin.json"), { name: "tools", version: "0.9.0" });
    const grokRepo = join(h.root, "remotes", "grok-market");
    await writeJson(join(grokRepo, ".claude-plugin", "marketplace.json"), { plugins: [{ name: "gp", source: "./plugins/gp" }] });
    await writeJson(join(grokRepo, "plugins", "gp", ".grok-plugin", "plugin.json"), { name: "gp", version: "4.0.0", description: "Grok plugin" });
    await write(join(grokRepo, "plugins", "gp", "skills", "g", "SKILL.md"), "---\nname: g\ndescription: d\n---\n");
    remotes.set("https://github.com/acme/grok-market.git", grokRepo);
    const opencodeFile = join(h.root, "oc", "plugin", "notify.js");
    await write(opencodeFile, "export const Notify = async () => ({});\n");
    const linkPlug = join(h.root, "linked");
    await write(join(linkPlug, "real.md"), "x");
    await symlink("/etc/passwd", join(linkPlug, "leak"));
    fixtures = { codexCache, grokRepo, opencodeFile, linkPlug };

    const profile = await h.service.create({ name: "Agents" });
    const layout = profileLayout(join(h.appdir, "daemon", "session-profiles", "profiles", profile.id));
    const codex = await h.service.addPlugin(profile.id, { revision: "1", agent: "codex", source: { type: "global", itemId: "plugin:tools@openai" } });
    const tools = byName(codex.profile, "plugin", "tools")!;
    assert.ok(tools.kind === "plugin" && tools.plugin.marketplace === "openai" && tools.plugin.version === "1.2.0");
    assert.deepEqual(tools.agents, ["codex"]);
    assert.ok((await stat(join(layout.pluginCacheDir(tools.id), ".codex-plugin", "plugin.json"))).isFile());
    assert.ok((await stat(join(layout.pluginCacheDir(tools.id), "skills", "t", "SKILL.md"))).isFile());

    const grok = await h.service.addPlugin(profile.id, { revision: codex.profile.revision, agent: "grok", source: { type: "marketplace", marketplace: "grok-market", plugin: "gp" } });
    const gp = byName(grok.profile, "plugin", "gp")!;
    assert.ok(gp.kind === "plugin" && gp.plugin.version === "4.0.0" && gp.plugin.source?.ref === "main");
    assert.ok((await stat(join(layout.pluginCacheDir(gp.id), ".grok-plugin", "plugin.json"))).isFile());
    assert.equal(gp.description, "Grok plugin");

    const oc = await h.service.addPlugin(profile.id, { revision: grok.profile.revision, agent: "opencode", source: { type: "global", itemId: "plugin:plugin/notify.js" } });
    const notify = byName(oc.profile, "plugin", "notify.js")!;
    assert.deepEqual(await readdir(layout.pluginCacheDir(notify.id)), ["notify.js"]);
    await assert.rejects(
      h.service.addPlugin(profile.id, { revision: oc.profile.revision, agent: "opencode", source: { type: "global", itemId: "plugin:npm-thing" } }),
      (error: { message: string }) => /npm plugin/.test(error.message)
    );
    await assert.rejects(
      h.service.addPlugin(profile.id, { revision: oc.profile.revision, agent: "opencode", source: { type: "marketplace", marketplace: "m", plugin: "p" } }),
      (error: { message: string }) => /no marketplaces/.test(error.message)
    );
    await assert.rejects(
      h.service.addPlugin(profile.id, { revision: oc.profile.revision, agent: "codex", source: { type: "marketplace", marketplace: "m", plugin: "linked" } }),
      (error: { message: string }) => /symlink/.test(error.message)
    );
    // A refused add leaves no cache slot behind.
    const slots = await readdir(layout.pluginsDir);
    assert.equal(slots.length, 3);
  });
});

describe("Export and import of a profile", () => {
  it("exports a zip without any secret value, and builds a new profile from it", async () => {
    const h = await harness();
    const profile = await h.service.create({ name: "Exported", icon: "🚀", description: "All of it" });
    const filled = await h.service.importFromGlobal(profile.id, {
      revision: "1",
      agent: "claude",
      itemIds: [
        await itemIdOf(h, "skill", "review"),
        await itemIdOf(h, "command", "git/pr"),
        await itemIdOf(h, "mcp", "github"),
        await itemIdOf(h, "mcp", "remote"),
        (await h.service.globalSource(profile.id, "claude")).items.find((item) => item.kind === "hook")!.id,
        await itemIdOf(h, "plugin", "superpowers")
      ],
      instructions: "replace"
    });
    const { fileName, data } = await h.service.exportProfile(profile.id);
    assert.equal(fileName, "exported.agent-profile.zip");
    noSecrets(data.toString("latin1"));
    const zipPath = join(h.root, fileName);
    await writeFile(zipPath, data);

    const imported = await h.service.importProfile(fileName, zipPath);
    noSecrets(imported);
    assert.notEqual(imported.profile.id, profile.id);
    assert.equal(imported.profile.name, "Exported copy");
    assert.equal(imported.profile.icon, "🚀");
    assert.equal(imported.profile.revision, "1");
    assert.equal(imported.profile.hasInstructions, true);
    const names = (detail: SessionProfileDetail) => detail.items.map((item) => `${item.kind}:${item.name}:${JSON.stringify(item.agents)}`).sort();
    assert.deepEqual(names(imported.profile), names(filled.profile));
    assert.match(imported.notes.join(" "), /enter them again for "github", "remote"/);
    const resolved = await h.service.resolveForAgent(imported.profile.id, "claude");
    assert.equal(resolved.skills[0]?.name, "review");
    assert.ok((await stat(join(resolved.skills[0]!.dir, "references", "checklist.md"))).isFile());
    assert.ok((await stat(join(resolved.plugins[0]!.cacheDir, ".claude-plugin", "plugin.json"))).isFile());
    assert.deepEqual(resolved.mcpServers, []);
    assert.ok(resolved.skipped.some((skip) => /GITHUB_TOKEN is missing/.test(skip.reason)));
    const layout = profileLayout(join(h.appdir, "daemon", "session-profiles", "profiles", imported.profile.id));
    await assert.rejects(stat(layout.secrets));
  });

  it("redacts credential-looking URL parts, args and hook command values in an export, and says which", async () => {
    const h = await harness();
    const profile = await h.service.create({ name: "Leaky" });
    let revision = profile.revision;
    for (const draft of [
      {
        kind: "mcp",
        agents: "all",
        mcp: {
          name: "local",
          transport: "stdio",
          command: "mcp-server",
          args: ["--token", "tok_ARG_SECRET", "--api-key=key_SECRET", "-e", "GITHUB_TOKEN=ghp_ENV_SECRET", "--verbose", "plain", "--port", "8080"]
        }
      },
      {
        kind: "mcp",
        agents: "all",
        mcp: { name: "web", transport: "http", url: "https://user:pw_SECRET@mcp.example.com/sse?api_key=q_SECRET&team=eng" }
      },
      {
        kind: "hook",
        agents: ["claude"],
        name: "notify",
        hook: { event: "Stop", command: 'curl -H "Authorization: Bearer bearer_SECRET" "https://hooks.example.com/x?token=hook_SECRET" --password=pw2_SECRET --retry 2' }
      }
    ] as const) {
      revision = (await h.service.createItem(profile.id, revision, draft as never)).profile.revision;
    }
    const { fileName, data } = await h.service.exportProfile(profile.id);
    const zipPath = join(h.root, fileName);
    await writeFile(zipPath, data);
    const entries = await readZipEntries(zipPath);
    const text = entries.map((entry) => entry.data.toString("utf8")).join("\n");
    for (const secret of ["tok_ARG_SECRET", "key_SECRET", "ghp_ENV_SECRET", "pw_SECRET", "q_SECRET", "bearer_SECRET", "hook_SECRET", "pw2_SECRET"]) {
      assert.ok(!text.includes(secret), secret);
    }
    const manifest = JSON.parse(entries.find((entry) => entry.path === "profile.json")!.data.toString("utf8"));
    const record = (name: string) => manifest.items.find((item: { name: string }) => item.name === name);
    assert.deepEqual(record("local").mcp.args, ["--token", "REDACTED", "--api-key=REDACTED", "-e", "GITHUB_TOKEN=REDACTED", "--verbose", "plain", "--port", "8080"]);
    assert.equal(record("web").mcp.url, "https://REDACTED@mcp.example.com/sse?api_key=REDACTED&team=eng");
    assert.equal(
      record("notify").hook.command,
      'curl -H "Authorization: Bearer REDACTED" "https://hooks.example.com/x?token=REDACTED" --password=REDACTED --retry 2'
    );
    const marker = JSON.parse(entries.find((entry) => entry.path === "orquester-export.json")!.data.toString("utf8"));
    assert.deepEqual(marker.redacted, [
      'MCP server "local": its arguments',
      'MCP server "web": its URL',
      'hook "notify": its command'
    ]);
    // The profile itself is untouched.
    const kept = await h.service.readItem(profile.id, (await h.service.get(profile.id)).items.find((item) => item.name === "web")!.id);
    assert.ok(kept.kind === "mcp" && kept.item.kind === "mcp" && kept.item.mcp.url?.includes("q_SECRET"));

    const imported = await h.service.importProfile(fileName, zipPath);
    assert.match(imported.notes.join(" "), /replaced with REDACTED.*MCP server "local": its arguments.*hook "notify": its command/);
  });

  it("refuses an export that is not exactly one", async () => {
    const h = await harness();
    const profile = await h.service.create({ name: "Strict" });
    const { data } = await h.service.exportProfile(profile.id);
    const good = join(h.root, "good.zip");
    await writeFile(good, data);
    const entries = async (extra: ZipEntry[], drop: string[] = []): Promise<string> => {
      const read = await readZipEntries(good);
      const path = join(h.root, `bad-${Math.random().toString(36).slice(2)}.zip`);
      await writeFile(path, buildZip([...read.filter((entry) => !drop.includes(entry.path)), ...extra]));
      return path;
    };
    const refusals: [string, RegExp][] = [
      [await entries([{ path: "secrets.json", data: Buffer.from("{}"), mode: 0o600 }]), /secrets.json" is not part/],
      [await entries([], ["orquester-export.json"]), /orquester-export.json is missing/],
      [await entries([{ path: "skills/ghost/SKILL.md", data: Buffer.from("x"), mode: 0o644 }]), /belongs to no skill/],
      [
        await entries(
          [{ path: "profile.json", data: Buffer.from(JSON.stringify({ version: 1, id: "x", name: "N", revision: 1, createdAt: "t", updatedAt: "t", items: [{ id: "s", kind: "skill", name: "s" }] })), mode: 0o644 }],
          ["profile.json"]
        ),
        /skills\/s\/SKILL.md is missing/
      ],
      [
        await entries(
          [{ path: "profile.json", data: Buffer.from(JSON.stringify({ version: 1, id: "x", name: "N", revision: 1, createdAt: "t", updatedAt: "t", items: [{ id: "p", kind: "plugin", name: "p", agents: "all" }] })), mode: 0o644 }],
          ["profile.json"]
        ),
        /invalid agent scope/
      ]
    ];
    for (const [path, pattern] of refusals) {
      await assert.rejects(h.service.importProfile("bad.zip", path), (error: { code?: string; message: string }) => {
        assert.equal(error.code, "IMPORT_FAILED");
        assert.match(error.message, pattern);
        return true;
      });
    }
    assert.equal((await h.service.list()).profiles.length, 1);
  });
});

/** The entries of a zip `buildZip` wrote (stored or deflated), for re-packing in tests. */
async function readZipEntries(path: string): Promise<ZipEntry[]> {
  const buffer = await readFile(path);
  const out: ZipEntry[] = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const body = buffer.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    out.push({ path: name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body), mode: 0o644 });
    offset += 30 + nameLength + size;
  }
  return out;
}
