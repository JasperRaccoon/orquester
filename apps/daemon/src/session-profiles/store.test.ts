import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { SessionProfileItemDraft } from "@orquester/api";
import { sessionProfileDeletedFile, sessionProfileDir, sessionProfileSourcesDir } from "@orquester/config";
import { SessionProfileError } from "./errors.ts";
import { profileLayout } from "./layout.ts";
import { SessionProfileService } from "./service.ts";
import { SessionProfileStore } from "./store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ appdir: string; store: SessionProfileStore; service: SessionProfileService }> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-session-profiles-"));
  roots.push(appdir);
  let n = 0;
  const store = new SessionProfileStore({
    appdir,
    now: () => new Date("2026-10-18T12:00:00.000Z"),
    newId: () => `id-${++n}`
  });
  await store.init();
  return { appdir, store, service: new SessionProfileService({ store }) };
}

const SKILL: SessionProfileItemDraft = {
  kind: "skill",
  document: { name: "review", frontmatter: { description: "Review the diff", custom: 1 }, body: "Do it.\n" }
};
const MCP: SessionProfileItemDraft = {
  kind: "mcp",
  agents: ["claude", "codex"],
  mcp: {
    name: "github",
    transport: "stdio",
    command: "gh-mcp",
    args: ["--stdio"],
    env: [
      { key: "GITHUB_TOKEN", value: "ghp_SECRET_VALUE" },
      { key: "OTHER", value: "other-secret" }
    ]
  }
};

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SessionProfileError || (error as { code?: string }).code === code, String(error));
    assert.equal((error as { code: string }).code, code);
    return true;
  });
}

describe("SessionProfileStore — profiles", () => {
  it("creates, lists, updates and deletes with optimistic revisions", async () => {
    const { appdir, store } = await setup();
    const created = await store.create({ name: "Developer", icon: "🛠", description: "Coding" });
    assert.equal(created.manifest.id, "id-1");
    assert.equal(created.manifest.revision, 1);
    assert.equal((await store.list()).profiles.length, 1);

    await rejects(store.create({ name: "developer" }), "PROFILE_NAME_TAKEN");
    await rejects(store.update("id-1", "7", { name: "X" }), "PROFILE_CONFLICT");

    const updated = await store.update("id-1", "1", {
      name: "Dev",
      icon: null,
      settings: { hideBuiltinSkills: { codex: false }, claudeWorkflowTool: false }
    });
    assert.equal(updated.manifest.revision, 2);
    assert.equal(updated.manifest.name, "Dev");
    assert.equal(updated.manifest.icon, undefined);
    assert.deepEqual(updated.manifest.settings, { hideBuiltinSkills: { codex: false }, claudeWorkflowTool: false });

    await rejects(store.delete("id-1", "1"), "PROFILE_CONFLICT");
    await store.delete("id-1", "2");
    await rejects(store.read("id-1"), "PROFILE_NOT_FOUND");
    assert.deepEqual(await readdir(sessionProfileSourcesDir(appdir)), []);
  });

  it("keeps a deleted profile's last name on disk, read by a later store (a daemon restart)", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "Developer" });
    await store.create({ name: "Video" });
    await store.update("id-1", "1", { name: "Dev" });
    assert.equal(await store.deletedName("id-1"), undefined, "a live profile is not deleted");
    await store.delete("id-1", "2");
    await store.delete("id-2", "1");
    const later = new SessionProfileStore({ appdir, newId: () => "id-3" });
    await later.init();
    assert.equal(await later.deletedName("id-1"), "Dev");
    assert.equal(await later.deletedName("id-2"), "Video");
    assert.equal(await later.deletedName("id-3"), undefined);
    // Unknown fields and entries of the file survive the next delete's rewrite.
    const file = sessionProfileDeletedFile(appdir);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const value = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...value, future: 1, profiles: { ...value.profiles, odd: { name: 5 } } }));
    await later.create({ name: "Third" });
    await later.delete("id-3", "1");
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.future, 1);
    assert.deepEqual(after.profiles.odd, { name: 5 });
    assert.equal(after.profiles["id-3"].name, "Third");
    assert.equal(after.profiles["id-1"].name, "Dev");
  });

  it("refuses ids that are not one safe path segment as not found", async () => {
    const { store } = await setup();
    await rejects(store.read("../../etc"), "PROFILE_NOT_FOUND");
    await rejects(store.read(".hidden"), "PROFILE_NOT_FOUND");
  });

  it("serializes concurrent mutations: two edits from the same revision → one conflict", async () => {
    const { store } = await setup();
    await store.create({ name: "P" });
    const results = await Promise.allSettled([
      store.update("id-1", "1", { description: "a" }),
      store.update("id-1", "1", { description: "b" })
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"]
    );
    assert.equal((results[1] as PromiseRejectedResult).reason.code, "PROFILE_CONFLICT");
  });

  it("lists an unreadable profile as an error and never rewrites it", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "Good" });
    const bad = sessionProfileDir(appdir, "broken");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "profile.json"), '{"version": 99}');
    const { profiles, errors } = await store.list();
    assert.deepEqual(
      profiles.map((profile) => profile.manifest.name),
      ["Good"]
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.profileId, "broken");
    await rejects(store.update("broken", "1", { name: "x" }), "PROFILE_UNREADABLE");
    assert.equal(await readFile(join(bad, "profile.json"), "utf8"), '{"version": 99}');
  });

  it("keeps the store private: 0700 dirs, 0600 manifest and secrets", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "P" });
    await store.createItem("id-1", "1", MCP);
    const layout = profileLayout(sessionProfileDir(appdir, "id-1"));
    assert.equal((await stat(sessionProfileSourcesDir(appdir))).mode & 0o777, 0o700);
    assert.equal((await stat(layout.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(layout.manifest)).mode & 0o777, 0o600);
    assert.equal((await stat(layout.secrets)).mode & 0o777, 0o600);
  });
});

describe("SessionProfileStore — items", () => {
  it("stores MCP secret values only in secrets.json and masks them in every view", async () => {
    const { appdir, store, service } = await setup();
    await store.create({ name: "P" });
    const { itemId } = await store.createItem("id-1", "1", MCP);
    const layout = profileLayout(sessionProfileDir(appdir, "id-1"));
    const manifest = await readFile(layout.manifest, "utf8");
    assert.ok(!manifest.includes("ghp_SECRET_VALUE"));
    assert.ok(manifest.includes("GITHUB_TOKEN"));
    assert.ok((await readFile(layout.secrets, "utf8")).includes("ghp_SECRET_VALUE"));

    const detail = await service.get("id-1");
    const views = JSON.stringify([detail, await service.readItem("id-1", itemId), await service.list()]);
    assert.ok(!views.includes("ghp_SECRET_VALUE") && !views.includes("other-secret"));
    const item = detail.items[0]!;
    assert.ok(item.kind === "mcp");
    assert.deepEqual(item.mcp.env, [
      { key: "GITHUB_TOKEN", set: true },
      { key: "OTHER", set: true }
    ]);

    // keep one, replace none, drop OTHER (absent = removed).
    await store.updateItem("id-1", itemId, "2", {
      kind: "mcp",
      mcp: { name: "github", transport: "stdio", command: "gh-mcp", env: [{ key: "GITHUB_TOKEN", keep: true }] }
    });
    const secrets = JSON.parse(await readFile(layout.secrets, "utf8"));
    assert.deepEqual(secrets.items[itemId], { env: { GITHUB_TOKEN: "ghp_SECRET_VALUE" } });
    await rejects(
      store.updateItem("id-1", itemId, "3", {
        kind: "mcp",
        mcp: { name: "github", transport: "stdio", command: "gh-mcp", env: [{ key: "NEW", keep: true }] }
      }),
      "INVALID_ITEM"
    );
    await store.deleteItem("id-1", itemId, "3");
    assert.deepEqual(JSON.parse(await readFile(layout.secrets, "utf8")).items, {});
  });

  it("rolls a failed mutation back whole: secrets, rewritten documents and instructions keep their previous text", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "P" });
    const { itemId: mcpId } = await store.createItem("id-1", "1", MCP);
    const { itemId: skillId } = await store.createItem("id-1", "2", SKILL);
    await store.writeInstructions("id-1", "3", "Old instructions\n");
    const layout = profileLayout(sessionProfileDir(appdir, "id-1"));
    const before = {
      secrets: await readFile(layout.secrets, "utf8"),
      skill: await readFile(layout.skillFile(skillId), "utf8"),
      instructions: await readFile(layout.instructions, "utf8"),
      manifest: await readFile(layout.manifest, "utf8")
    };
    // profile.json still reads, but its write (the commit) fails: it lives in a read-only dir.
    const locked = join(appdir, "locked");
    await mkdir(locked);
    await rename(layout.manifest, join(locked, "profile.json"));
    await symlink(join(locked, "profile.json"), layout.manifest);
    await chmod(locked, 0o500);
    try {
      await assert.rejects(
        store.updateItem("id-1", mcpId, "4", {
          kind: "mcp",
          mcp: { name: "github", transport: "stdio", command: "gh-mcp", env: [{ key: "GITHUB_TOKEN", value: "ghp_NEW_VALUE" }] }
        })
      );
      await assert.rejects(
        store.updateItem("id-1", skillId, "4", { kind: "skill", document: { name: "review", frontmatter: {}, body: "Rewritten.\n" } })
      );
      await assert.rejects(store.writeInstructions("id-1", "4", "New instructions\n"));
      await assert.rejects(store.writeInstructions("id-1", "4", ""));
    } finally {
      await chmod(locked, 0o700);
    }
    assert.equal(await readFile(layout.secrets, "utf8"), before.secrets, "secrets.json is the committed one");
    assert.equal(await readFile(layout.skillFile(skillId), "utf8"), before.skill, "the skill's SKILL.md is the committed one");
    assert.equal(await readFile(layout.instructions, "utf8"), before.instructions);
    assert.equal(await readFile(layout.manifest, "utf8"), before.manifest);
  });

  it("writes skills as directories and commands as markdown, by item id", async () => {
    const { appdir, store, service } = await setup();
    await store.create({ name: "P" });
    const { itemId: skillId } = await store.createItem("id-1", "1", SKILL);
    const { itemId: commandId } = await store.createItem("id-1", "2", {
      kind: "command",
      agents: ["claude", "grok"],
      document: { name: "git/pr", frontmatter: {}, body: "Open a PR" }
    });
    const layout = profileLayout(sessionProfileDir(appdir, "id-1"));
    const skillText = await readFile(layout.skillFile(skillId), "utf8");
    assert.match(skillText, /^---\nname: review\ndescription: Review the diff\ncustom: 1\n---\nDo it.\n$/);
    assert.equal(await readFile(layout.commandFile(commandId), "utf8"), "Open a PR");

    // An update merges the frontmatter (unknown keys survive, null removes) and keeps the id.
    await store.updateItem("id-1", skillId, "3", {
      kind: "skill",
      document: { name: "review-diff", frontmatter: { custom: null }, body: "New." }
    });
    const detail = await service.readItem("id-1", skillId);
    assert.ok(detail.kind === "skill");
    assert.deepEqual(detail.document.frontmatter, { name: "review-diff", description: "Review the diff" });
    assert.equal(detail.item.name, "review-diff");
    assert.equal(detail.item.description, "Review the diff");

    await rejects(
      store.createItem("id-1", "4", { kind: "skill", document: { name: "no-desc", frontmatter: {}, body: "" } }),
      "INVALID_ITEM"
    );
    await rejects(
      store.createItem("id-1", "4", { kind: "skill", document: { name: "Bad Name", frontmatter: { description: "d" }, body: "" } }),
      "INVALID_NAME"
    );
    // The refused creates left nothing behind.
    assert.deepEqual((await readdir(layout.skillsDir)).sort(), [skillId]);
  });

  it("refuses a name twice for overlapping agents, allows it for disjoint ones", async () => {
    const { store } = await setup();
    await store.create({ name: "P" });
    await store.createItem("id-1", "1", MCP); // claude + codex
    await rejects(store.createItem("id-1", "2", { ...MCP, agents: ["codex"] }), "ITEM_EXISTS");
    await rejects(store.createItem("id-1", "2", { ...MCP, agents: "all" }), "ITEM_EXISTS");
    const { profile } = await store.createItem("id-1", "2", { ...MCP, agents: ["grok"] });
    assert.equal(profile.items.length, 2);
  });

  it("requires exactly one agent for hooks and plugins, and a hook event that agent fires", async () => {
    const { store } = await setup();
    await store.create({ name: "P" });
    const hook = { kind: "hook" as const, hook: { event: "Stop", command: "notify" } };
    await rejects(store.createItem("id-1", "1", hook), "INVALID_ITEM");
    await rejects(store.createItem("id-1", "1", { ...hook, agents: ["claude", "codex"] }), "INVALID_ITEM");
    await rejects(store.createItem("id-1", "1", { ...hook, agents: ["opencode"] }), "INVALID_ITEM");
    await rejects(store.createItem("id-1", "1", { ...hook, agents: ["claude"], hook: { event: "Nope", command: "x" } }), "INVALID_ITEM");
    const { profile, itemId } = await store.createItem("id-1", "1", { ...hook, agents: ["claude"] });
    const entry = profile.items.find((candidate) => candidate.ok && candidate.record.id === itemId);
    assert.ok(entry?.ok && entry.record.kind === "hook" && entry.record.name === "Stop");

    const plugin = { kind: "plugin" as const, plugin: { name: "superpowers", marketplace: "official" } };
    await rejects(store.createItem("id-1", "2", plugin), "INVALID_ITEM");
    const created = await store.createItem("id-1", "2", { ...plugin, agents: ["claude"] });
    assert.equal(created.profile.cachedPlugins.size, 0);
    // The cache slot exists, empty, for the plugin flow to fill.
    assert.deepEqual(await readdir(store.pluginCacheDir("id-1", created.itemId)), []);
  });

  it("keeps unknown fields and unreadable items through rewrites; an unreadable item can be deleted", async () => {
    const { appdir, store, service } = await setup();
    await store.create({ name: "P" });
    const { itemId } = await store.createItem("id-1", "1", SKILL);
    const layout = profileLayout(sessionProfileDir(appdir, "id-1"));
    const raw = JSON.parse(await readFile(layout.manifest, "utf8"));
    raw.futureTop = { keep: true };
    raw.items[0].futureField = "kept";
    raw.items.push({ id: "future-1", kind: "workflow", name: "newer build" });
    await writeFile(layout.manifest, JSON.stringify(raw));

    const detail = await service.get("id-1");
    assert.equal(detail.items.length, 1);
    assert.deepEqual(detail.itemErrors.map((error) => error.itemId), ["future-1"]);

    await store.setItemEnabled("id-1", itemId, "2", false);
    const rewritten = JSON.parse(await readFile(layout.manifest, "utf8"));
    assert.deepEqual(rewritten.futureTop, { keep: true });
    assert.equal(rewritten.items[0].futureField, "kept");
    assert.equal(rewritten.items[0].enabled, false);
    assert.deepEqual(rewritten.items[1], { id: "future-1", kind: "workflow", name: "newer build" });

    await rejects(store.updateItem("id-1", "future-1", "3", SKILL), "INVALID_ITEM");
    await store.deleteItem("id-1", "future-1", "3");
    assert.equal(JSON.parse(await readFile(layout.manifest, "utf8")).items.length, 1);
  });

  it("keeps settings and a plugin source this build cannot read through a rewrite", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "P" });
    const layout = profileLayout(sessionProfileDir(appdir, "id-1"));
    const raw = JSON.parse(await readFile(layout.manifest, "utf8"));
    raw.settings = { hideBuiltinSkills: { claude: "auto", codex: false }, claudeWorkflowTool: "ask" };
    raw.items.push({ id: "pl-1", kind: "plugin", name: "fut", agents: ["claude"], plugin: { source: { type: "npm", copiedAt: "t" } } });
    await writeFile(layout.manifest, JSON.stringify(raw));

    await store.setItemEnabled("id-1", "pl-1", "1", false);
    let rewritten = JSON.parse(await readFile(layout.manifest, "utf8"));
    assert.deepEqual(rewritten.settings, raw.settings);
    assert.deepEqual(rewritten.items[0].plugin.source, { type: "npm", copiedAt: "t" });

    // Changing one setting keeps the others as they were.
    await store.update("id-1", "2", { settings: { hideBuiltinSkills: { grok: false } } });
    rewritten = JSON.parse(await readFile(layout.manifest, "utf8"));
    assert.deepEqual(rewritten.settings, { hideBuiltinSkills: { claude: "auto", codex: false, grok: false }, claudeWorkflowTool: "ask" });
  });

  it("writes and removes instructions under the profile's revision", async () => {
    const { store } = await setup();
    await store.create({ name: "P" });
    await rejects(store.writeInstructions("id-1", "0", "x"), "PROFILE_CONFLICT");
    const written = await store.writeInstructions("id-1", "1", "# Be brief\n");
    assert.equal(written.hasInstructions, true);
    assert.deepEqual(await store.readInstructions("id-1"), { text: "# Be brief\n", revision: "2" });
    const cleared = await store.writeInstructions("id-1", "2", "");
    assert.equal(cleared.hasInstructions, false);
    assert.deepEqual(await store.readInstructions("id-1"), { text: "", revision: "3" });
  });
});

describe("SessionProfileStore — duplicate", () => {
  it("copies items, instructions and secrets under a new id and a unique name", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "Dev" });
    await store.createItem("id-1", "1", SKILL);
    await store.createItem("id-1", "2", MCP);
    await store.writeInstructions("id-1", "3", "hello");

    const copy = await store.duplicate("id-1");
    assert.equal(copy.manifest.id, "id-4");
    assert.equal(copy.manifest.name, "Dev copy");
    assert.equal(copy.manifest.revision, 1);
    assert.equal((await store.duplicate("id-1")).manifest.name, "Dev copy 2");
    await rejects(store.duplicate("id-1", "dev"), "PROFILE_NAME_TAKEN");

    const source = await store.readSource("id-4");
    assert.equal(source.instructions, "hello");
    assert.equal(source.items.length, 2);
    const mcp = source.items.find((entry) => entry.ok && entry.record.kind === "mcp");
    assert.ok(mcp?.ok);
    assert.equal(source.secrets[mcp.record.id]?.env?.GITHUB_TOKEN, "ghp_SECRET_VALUE");
    const layout = profileLayout(sessionProfileDir(appdir, "id-4"));
    assert.equal((await stat(layout.secrets)).mode & 0o777, 0o600);
    assert.equal((await stat(layout.dir)).mode & 0o777, 0o700);

    // Independent: editing the copy leaves the original alone.
    await store.writeInstructions("id-4", "1", "changed");
    assert.equal((await store.readInstructions("id-1")).text, "hello");
  });
});

describe("SessionProfileStore — readSource", () => {
  it("refuses to resolve a profile whose secrets do not read, without quoting them", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "P" });
    await store.createItem("id-1", "1", MCP);
    const layout = profileLayout(sessionProfileDir(appdir, "id-1"));
    await writeFile(layout.secrets, '{"version": 1, "items": "ghp_SECRET_VALUE"');
    await assert.rejects(store.readSource("id-1"), (error: Error) => {
      assert.equal((error as SessionProfileError).code, "PROFILE_UNREADABLE");
      assert.ok(!error.message.includes("ghp_SECRET_VALUE"));
      return true;
    });
  });

  it("marks items whose content is missing", async () => {
    const { appdir, store } = await setup();
    await store.create({ name: "P" });
    const { itemId } = await store.createItem("id-1", "1", SKILL);
    const plugin = await store.createItem("id-1", "2", { kind: "plugin", agents: ["claude"], plugin: { name: "p" } });
    await rm(profileLayout(sessionProfileDir(appdir, "id-1")).skillDir(itemId), { recursive: true });
    const source = await store.readSource("id-1");
    assert.deepEqual([...source.missingContent].sort(), [itemId, plugin.itemId].sort());
  });
});

describe("SessionProfileService — the composer's fallback catalog", () => {
  it("is the profile's own enabled, in-scope skills and commands (Codex: commands as skills) plus /compact — never anything else", async () => {
    const { store, service } = await setup();
    await store.create({ name: "P" });
    await store.createItem("id-1", "1", SKILL);
    await store.createItem("id-1", "2", {
      kind: "command",
      document: { name: "ship", frontmatter: { description: "Ship it", "argument-hint": "<version>" }, body: "Ship $ARGUMENTS\n" }
    });
    await store.createItem("id-1", "3", { kind: "skill", agents: ["grok"], document: { name: "grok-only", frontmatter: { description: "G" }, body: "" } });
    await store.createItem("id-1", "4", { kind: "skill", enabled: false, document: { name: "off", frontmatter: { description: "Off" }, body: "" } });

    const claude = await service.composerCatalog("id-1", "claude");
    assert.deepEqual(claude.slashCommands, [
      { name: "compact", description: "Compact this conversation's context." },
      { name: "ship", description: "Ship it", input: { hint: "<version>" } }
    ]);
    assert.deepEqual(
      claude.skills.map((skill) => [skill.name, skill.scope, skill.enabled, skill.description]),
      [["review", "profile", true, "Review the diff"]]
    );
    assert.ok(claude.skills[0]!.path.endsWith("/SKILL.md"));

    const codex = await service.composerCatalog("id-1", "codex");
    assert.deepEqual(codex.slashCommands.map((command) => command.name), ["compact"]);
    assert.deepEqual(codex.skills.map((skill) => skill.name), ["review", "ship"], "Codex runs a command as a skill");

    const grok = await service.composerCatalog("id-1", "grok");
    assert.deepEqual(grok.skills.map((skill) => skill.name).sort(), ["grok-only", "review"]);
    await rejects(service.composerCatalog("nope", "claude"), "PROFILE_NOT_FOUND");
  });
});
