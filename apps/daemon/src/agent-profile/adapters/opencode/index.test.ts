import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentProfileErrorCode, ProfileItem } from "@orquester/api";
import { agentProfileBackupsDir, agentProfileImportsDir, agentProfileStashDir } from "@orquester/config";
import { AgentProfileError } from "../../errors.ts";
import { ProfileBackups, ProfileStash, pathKind } from "../../infra/index.ts";
import type { AgentHomes } from "../types.ts";
import { OPENCODE_RECYCLE_NOTE, OpenCodeProfileAdapter } from "./index.ts";
import { parseJsoncObject } from "./jsonc.ts";

/** Shaped like this host's `~/.config/opencode/opencode.jsonc` (secrets replaced), plus comments and trailing commas. */
const HOST_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  // MCP servers every session gets
  "mcp": {
    "agent-browser": {
      "type": "local",
      "command": [
        "agent-browser",
        "mcp"
      ],
      "environment": {
        "AGENT_BROWSER_ARGS": "--fake-browser-args"
      },
      "enabled": true,
      "timeout": 60000
    },
    "centur": {
      "type": "local",
      "command": ["/usr/bin/node", "/srv/centur-mcp/dist/index.js"],
      "environment": {
        "CENTUR_API_URL": "https://centur.invalid/api",
        "CENTUR_PASSWORD": "fake-centur-password" // rotated monthly
      },
      "enabled": true,
      "timeout": 60000,
    },
    "jira-cloud": {
      "type": "local",
      "command": [
        "/usr/bin/node",
        "/srv/jira/build/index.js",
      ],
      "environment": {
        "JIRA_API_TOKEN": "fake-jira-token",
        "JIRA_EMAIL": "owner@example.invalid",
      },
      "enabled": true,
      "timeout": 60000,
    },
  },
  /* language servers */
  "lsp": {
    "rust": {
      "disabled": true,
    },
  },
}
`;

const SECRETS = ["--fake-browser-args", "fake-centur-password", "fake-jira-token", "owner@example.invalid", "https://centur.invalid/api"];

const STATUS_PLUGIN = "// orquester-managed status plugin v2 — do not edit (rewritten by the daemon)\nexport default {};\n";

interface Env {
  root: string;
  home: string;
  dir: string;
  appdir: string;
  adapter: OpenCodeProfileAdapter;
  config: string;
  read(path: string): Promise<string>;
  item(id: string): Promise<ProfileItem>;
  items(): Promise<ProfileItem[]>;
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function setup(t: test.TestContext, options: { config?: string | null } = {}): Promise<Env> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-opencode-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dir = join(home, ".config", "opencode");
  const appdir = join(root, "appdir");
  const config = join(dir, "opencode.jsonc");
  await mkdir(dir, { recursive: true });
  if (options.config !== null) {
    await put(config, options.config ?? HOST_CONFIG);
    await chmod(config, 0o600);
  }
  await put(join(dir, "AGENTS.md"), "# Global rules\n\nBe brief.\n");
  await put(join(dir, "plugin", "orquester-status.js"), STATUS_PLUGIN);
  await mkdir(join(dir, "commands"), { recursive: true });
  await put(join(home, ".claude", "skills", "handoff", "SKILL.md"), "---\nname: handoff\ndescription: Write a handoff\n---\nBody\n");
  await put(
    join(home, ".claude", "skills", "synced", "abc", "pdf", "SKILL.md"),
    "---\nname: pdf\ndescription: Work with PDFs\n---\nBody\n"
  );
  await put(join(home, ".agents", "skills", "shared-one", "SKILL.md"), "---\nname: shared-one\ndescription: Shared\n---\n");
  const homes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir: dir,
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 8, 28, 12, 0, tick++));
  const adapter = new OpenCodeProfileAdapter(
    {
      homes,
      appdir,
      bin: "/usr/bin/opencode",
      accountHomes: async () => [],
      logger: { info: () => undefined, warn: () => undefined },
      now
    },
    {
      backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir), now }),
      stash: new ProfileStash({ dir: agentProfileStashDir(appdir), now })
    }
  );
  const items = async (): Promise<ProfileItem[]> => (await adapter.snapshot()).items;
  return {
    root,
    home,
    dir,
    appdir,
    adapter,
    config,
    read: (path) => readFile(path, "utf8"),
    items,
    item: async (id) => {
      const found = (await items()).find((item) => item.id === id);
      assert.ok(found, `no item ${id}`);
      return found;
    }
  };
}

async function rejectsWith(promise: Promise<unknown>, code: AgentProfileErrorCode, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentProfileError, `expected an AgentProfileError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function jsonc(text: string): Record<string, unknown> {
  const parsed = parseJsoncObject(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.value;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

test("the snapshot lists the host's MCP servers, inherited skills and the locked status plugin", async (t) => {
  const env = await setup(t);
  const snapshot = await env.adapter.snapshot();
  assert.deepEqual(snapshot.fileErrors, []);
  const ids = snapshot.items.map((item) => item.id).sort();
  assert.deepEqual(ids, [
    "mcp:agent-browser",
    "mcp:centur",
    "mcp:jira-cloud",
    "plugin:plugin/orquester-status.js",
    "skill:handoff",
    "skill:pdf",
    "skill:shared-one"
  ]);
  const centur = snapshot.items.find((item) => item.id === "mcp:centur")!;
  assert.equal(centur.enabled, true);
  assert.equal(centur.editable, true);
  assert.deepEqual(centur.meta, { transport: "stdio", command: "/usr/bin/node" });
  assert.equal(centur.path, env.config);

  const handoff = snapshot.items.find((item) => item.id === "skill:handoff")!;
  assert.deepEqual(handoff.source, { type: "inherited", label: "From Claude", ownerAgent: "claude" });
  assert.equal(handoff.toggleable, true);
  assert.equal(handoff.editable, false);
  assert.equal(handoff.deletable, false);
  assert.equal(snapshot.items.find((item) => item.id === "skill:shared-one")!.source.label, "Shared · ~/.agents");

  const status = snapshot.items.find((item) => item.id === "plugin:plugin/orquester-status.js")!;
  assert.equal(status.locked, true);
  assert.equal(status.toggleable, false);
  assert.equal(status.deletable, false);
  assert.equal(status.source.type, "orquester");

  assert.equal(snapshot.instructions.path, join(env.dir, "AGENTS.md"));
  assert.equal(snapshot.instructions.exists, true);
  assert.equal(snapshot.instructions.lines, 3);
  assert.deepEqual(snapshot.instructions.warnings, []);

  const text = JSON.stringify(snapshot);
  for (const secret of SECRETS.filter((s) => !s.startsWith("https"))) {
    assert.ok(!text.includes(secret), `snapshot leaks ${secret}`);
  }
});

test("watchPaths names the config files, the item folders, the inherited skill roots and the stash", async (t) => {
  const env = await setup(t);
  const paths = env.adapter.watchPaths();
  for (const expected of [
    join(env.dir, "config.json"),
    join(env.dir, "opencode.json"),
    join(env.dir, "opencode.jsonc"),
    join(env.dir, "AGENTS.md"),
    join(env.dir, "skills"),
    join(env.dir, "skill"),
    join(env.dir, "commands"),
    join(env.dir, "command"),
    join(env.dir, "plugin"),
    join(env.dir, "plugins"),
    join(env.home, ".claude", "skills"),
    join(env.home, ".agents", "skills"),
    join(agentProfileStashDir(env.appdir), "opencode")
  ]) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test("an MCP server's detail masks environment values", async (t) => {
  const env = await setup(t);
  const detail = await env.adapter.readItem("mcp:centur");
  assert.equal(detail.kind, "mcp");
  assert.deepEqual(detail.kind === "mcp" ? detail.mcp : null, {
    name: "centur",
    transport: "stdio",
    command: "/usr/bin/node",
    args: ["/srv/centur-mcp/dist/index.js"],
    env: [
      { key: "CENTUR_API_URL", set: true },
      { key: "CENTUR_PASSWORD", set: true }
    ],
    advanced: { timeout: 60000 }
  });
  const text = JSON.stringify(detail);
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `detail leaks ${secret}`);
  }
});

test("turning an MCP server off and on edits only its enabled flag, byte for byte", async (t) => {
  const env = await setup(t);
  const item = await env.item("mcp:centur");
  const off = await env.adapter.setEnabled(item.id, item.revision, false);
  assert.deepEqual(off, { itemIds: ["mcp:centur"], notes: [OPENCODE_RECYCLE_NOTE] });
  const expectedOff = HOST_CONFIG.replace(
    '"CENTUR_PASSWORD": "fake-centur-password" // rotated monthly\n      },\n      "enabled": true,',
    '"CENTUR_PASSWORD": "fake-centur-password" // rotated monthly\n      },\n      "enabled": false,'
  );
  assert.notEqual(expectedOff, HOST_CONFIG);
  assert.equal(await env.read(env.config), expectedOff);
  const turnedOff = await env.item("mcp:centur");
  assert.equal(turnedOff.enabled, false);
  assert.notEqual(turnedOff.revision, item.revision);

  await env.adapter.setEnabled(turnedOff.id, turnedOff.revision, true);
  assert.equal(await env.read(env.config), HOST_CONFIG);
  assert.equal((await stat(env.config)).mode & 0o777, 0o600, "the file keeps its mode");
});

test("a stale revision is a conflict and changes nothing", async (t) => {
  const env = await setup(t);
  await rejectsWith(env.adapter.setEnabled("mcp:centur", "0000000000000000", false), "PROFILE_CONFLICT");
  await rejectsWith(env.adapter.remove("mcp:nope", "x"), "ITEM_NOT_FOUND");
  assert.equal(await env.read(env.config), HOST_CONFIG);
});

test("creating, editing (secrets kept, renamed, removed) and deleting an MCP server keeps the rest of the file", async (t) => {
  const env = await setup(t);
  const created = await env.adapter.create(
    {
      kind: "mcp",
      mcp: {
        name: "docs",
        transport: "http",
        url: "https://docs.invalid/mcp",
        headers: [{ key: "Authorization", value: "Bearer fake-docs-token" }],
        advanced: { timeout: 30000 }
      }
    },
    { onConflict: "fail" }
  );
  assert.deepEqual(created.itemIds, ["mcp:docs"]);
  let text = await env.read(env.config);
  assert.ok(text.startsWith(HOST_CONFIG.slice(0, HOST_CONFIG.indexOf('    "jira-cloud"'))), "earlier entries untouched");
  assert.ok(text.includes("// rotated monthly") && text.includes("/* language servers */"));
  assert.deepEqual((jsonc(text).mcp as Record<string, unknown>).docs, {
    type: "remote",
    url: "https://docs.invalid/mcp",
    headers: { Authorization: "Bearer fake-docs-token" },
    timeout: 30000
  });
  const docsDetail = await env.adapter.readItem("mcp:docs");
  assert.ok(!JSON.stringify(docsDetail).includes("fake-docs-token"));

  await rejectsWith(
    env.adapter.create({ kind: "mcp", mcp: { name: "docs", transport: "http", url: "https://x.invalid" } }, { onConflict: "fail" }),
    "ITEM_EXISTS"
  );
  const both = await env.adapter.create(
    { kind: "mcp", mcp: { name: "docs", transport: "stdio", command: "docs-mcp" } },
    { onConflict: "keep-both" }
  );
  assert.deepEqual(both.itemIds, ["mcp:docs-2"]);

  // Edit centur: keep one secret, replace nothing else, drop the other, rename.
  const centur = await env.item("mcp:centur");
  await env.adapter.update(centur.id, centur.revision, {
    kind: "mcp",
    mcp: {
      name: "centur",
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["/srv/centur-mcp/dist/index.js", "--verbose"],
      env: [{ key: "CENTUR_PASSWORD", keep: true }, { key: "NEW_KEY", value: "fake-new" }],
      advanced: { timeout: 60000 }
    }
  });
  text = await env.read(env.config);
  const mcp = jsonc(text).mcp as Record<string, Record<string, unknown>>;
  assert.deepEqual(mcp.centur, {
    type: "local",
    command: ["/usr/bin/node", "/srv/centur-mcp/dist/index.js", "--verbose"],
    environment: { CENTUR_PASSWORD: "fake-centur-password", NEW_KEY: "fake-new" },
    enabled: true,
    timeout: 60000
  });
  assert.ok(
    text.includes('"CENTUR_PASSWORD": "fake-centur-password", // rotated monthly\n        "NEW_KEY": "fake-new"\n'),
    `a kept key keeps its comment, the new key goes after it:\n${text}`
  );
  assert.ok(!text.includes("CENTUR_API_URL"));
  assert.ok(text.includes('"agent-browser": {\n      "type": "local",\n      "command": [\n        "agent-browser",'));

  const jira = await env.item("mcp:jira-cloud");
  await rejectsWith(
    env.adapter.update(jira.id, jira.revision, {
      kind: "mcp",
      mcp: { name: "jira-cloud", transport: "stdio", command: "x", env: [{ key: "NOT_THERE", keep: true }] }
    }),
    "INVALID_ITEM",
    /no current value/
  );
  await rejectsWith(
    env.adapter.update(jira.id, jira.revision, { kind: "mcp", mcp: { name: "jira-cloud", transport: "sse", url: "https://x.invalid" } }),
    "INVALID_ITEM",
    /SSE/
  );
  await rejectsWith(
    env.adapter.update(jira.id, jira.revision, {
      kind: "mcp",
      mcp: { name: "jira-cloud", transport: "stdio", command: "x", advanced: { startup_timeout_sec: 5 } }
    }),
    "INVALID_ITEM"
  );
  await rejectsWith(
    env.adapter.create({ kind: "mcp", mcp: { name: "bad name", transport: "stdio", command: "x" } }, { onConflict: "fail" }),
    "INVALID_NAME"
  );

  await env.adapter.update(jira.id, jira.revision, {
    kind: "mcp",
    mcp: {
      name: "jira",
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["/srv/jira/build/index.js"],
      env: [
        { key: "JIRA_API_TOKEN", keep: true },
        { key: "JIRA_EMAIL", keep: true }
      ],
      advanced: { timeout: 60000 }
    }
  });
  const renamed = jsonc(await env.read(env.config)).mcp as Record<string, Record<string, unknown>>;
  assert.equal(renamed["jira-cloud"], undefined);
  assert.deepEqual(renamed.jira?.environment, { JIRA_API_TOKEN: "fake-jira-token", JIRA_EMAIL: "owner@example.invalid" });
  assert.equal(renamed.jira?.enabled, true);

  const docs = await env.item("mcp:docs");
  await env.adapter.remove(docs.id, docs.revision);
  assert.equal((jsonc(await env.read(env.config)).mcp as Record<string, unknown>).docs, undefined);
  assert.ok((await env.read(env.config)).includes("/* language servers */"));
});

test("a missing config is created as opencode.jsonc with $schema, 0600", async (t) => {
  const env = await setup(t, { config: null });
  assert.deepEqual((await env.adapter.snapshot()).fileErrors, []);
  await env.adapter.create({ kind: "mcp", mcp: { name: "local", transport: "stdio", command: "run-it", args: ["--mcp"] } }, { onConflict: "fail" });
  const value = jsonc(await env.read(env.config));
  assert.deepEqual(value, {
    $schema: "https://opencode.ai/config.json",
    mcp: { local: { type: "local", command: ["run-it", "--mcp"] } }
  });
  assert.equal((await stat(env.config)).mode & 0o777, 0o600);
});

test("several config files: the edit goes to opencode.jsonc, overrides are honoured, a warning names them", async (t) => {
  const env = await setup(t, {
    config: `{
  "mcp": {
    // only an override for a server defined in opencode.json
    "shared": { "enabled": false },
  },
}
`
  });
  const json = join(env.dir, "opencode.json");
  await put(
    json,
    JSON.stringify({ mcp: { shared: { type: "remote", url: "https://shared.invalid/mcp" }, orphan: { enabled: false } } }, null, 2)
  );
  const snapshot = await env.adapter.snapshot();
  assert.equal(snapshot.instructions.warnings[0]?.code, "opencode-several-config-files");
  assert.match(snapshot.instructions.warnings[0]!.message, /written to opencode\.jsonc/);
  const shared = snapshot.items.find((item) => item.id === "mcp:shared")!;
  assert.equal(shared.enabled, false);
  assert.equal(shared.editable, false, "its definition lives in another file");
  assert.equal(shared.deletable, false);
  assert.equal(shared.toggleable, true);
  assert.ok(shared.warnings.some((w) => w.code === "opencode-defined-in-other-file"));
  const orphan = snapshot.items.find((item) => item.id === "mcp:orphan")!;
  assert.ok(orphan.warnings.some((w) => w.code === "opencode-mcp-override-only"));

  // On: the override-only entry in the target goes away, opencode.json is untouched.
  const jsonBefore = await env.read(json);
  await env.adapter.setEnabled(shared.id, shared.revision, true);
  assert.equal((jsonc(await env.read(env.config)).mcp as Record<string, unknown>).shared, undefined);
  assert.equal(await env.read(json), jsonBefore);
  assert.equal((await env.item("mcp:shared")).enabled, true);

  // Orphan is off in opencode.json: turning it on needs an explicit override in the target.
  const orphanNow = await env.item("mcp:orphan");
  await env.adapter.setEnabled(orphanNow.id, orphanNow.revision, true);
  assert.deepEqual((jsonc(await env.read(env.config)).mcp as Record<string, unknown>).orphan, { enabled: true });
  assert.equal((await env.item("mcp:orphan")).enabled, true);
});

test("a config file that does not parse is reported and no config write is attempted", async (t) => {
  const env = await setup(t, { config: '{ "mcp": { "x": } }' });
  const snapshot = await env.adapter.snapshot();
  assert.equal(snapshot.fileErrors.length, 1);
  assert.equal(snapshot.fileErrors[0]!.path, env.config);
  await rejectsWith(
    env.adapter.create({ kind: "mcp", mcp: { name: "a", transport: "stdio", command: "a" } }, { onConflict: "fail" }),
    "CONFIG_UNREADABLE"
  );
  const handoff = snapshot.items.find((item) => item.id === "skill:handoff")!;
  assert.equal(handoff.toggleable, false, "skill switches write the config");
  await rejectsWith(env.adapter.setEnabled(handoff.id, handoff.revision, false), "NOT_TOGGLEABLE");
  assert.equal(await env.read(env.config), '{ "mcp": { "x": } }');
  // File-backed items still work.
  await env.adapter.create(
    { kind: "command", document: { name: "hello", frontmatter: { description: "Say hello" }, body: "Say hello.\n" } },
    { onConflict: "fail" }
  );
  assert.equal((await env.item("command:hello")).enabled, true);
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

test("own skills: create, edit, rename, delete", async (t) => {
  const env = await setup(t);
  await rejectsWith(
    env.adapter.create({ kind: "skill", document: { name: "review", frontmatter: {}, body: "x" } }, { onConflict: "fail" }),
    "INVALID_ITEM",
    /description/
  );
  await rejectsWith(
    env.adapter.create({ kind: "skill", document: { name: "Review", frontmatter: { description: "d" }, body: "x" } }, { onConflict: "fail" }),
    "INVALID_NAME"
  );
  const created = await env.adapter.create(
    { kind: "skill", document: { name: "review", frontmatter: { description: "Review a diff", license: "MIT" }, body: "Steps\n" } },
    { onConflict: "fail" }
  );
  assert.deepEqual(created.itemIds, ["skill:review"]);
  const file = join(env.dir, "skills", "review", "SKILL.md");
  assert.equal(await env.read(file), "---\nname: review\ndescription: Review a diff\nlicense: MIT\n---\nSteps\n");
  await put(join(env.dir, "skills", "review", "notes.md"), "extra");
  const item = await env.item("skill:review");
  assert.equal(item.editable, true);
  assert.equal(item.enabled, true);
  assert.deepEqual(item.source, { type: "user", label: "User" });
  const detail = await env.adapter.readItem(item.id);
  assert.deepEqual(detail.kind === "skill" ? detail.files : null, ["notes.md"]);

  await env.adapter.update(item.id, item.revision, {
    kind: "skill",
    document: { name: "review", frontmatter: { description: "Review the current diff", license: null }, body: "New steps\n" }
  });
  assert.equal(await env.read(file), "---\nname: review\ndescription: Review the current diff\n---\nNew steps\n");

  const edited = await env.item("skill:review");
  await env.adapter.update(edited.id, edited.revision, {
    kind: "skill",
    document: { name: "code-review", frontmatter: {}, body: "New steps\n" }
  });
  assert.equal(await pathKind(join(env.dir, "skills", "review")), null);
  assert.equal(
    await env.read(join(env.dir, "skills", "code-review", "SKILL.md")),
    "---\nname: code-review\ndescription: Review the current diff\n---\nNew steps\n"
  );
  assert.equal(await env.read(join(env.dir, "skills", "code-review", "notes.md")), "extra");

  // An inherited skill cannot be edited or deleted here.
  const handoff = await env.item("skill:handoff");
  await rejectsWith(
    env.adapter.update(handoff.id, handoff.revision, { kind: "skill", document: { name: "handoff", frontmatter: {}, body: "" } }),
    "NOT_EDITABLE"
  );
  await rejectsWith(env.adapter.remove(handoff.id, handoff.revision), "NOT_DELETABLE");

  const renamed = await env.item("skill:code-review");
  await env.adapter.remove(renamed.id, renamed.revision);
  assert.equal(await pathKind(join(env.dir, "skills", "code-review")), null);
});

test("skill switches write permission.skill (absent permission)", async (t) => {
  const env = await setup(t);
  const handoff = await env.item("skill:handoff");
  await env.adapter.setEnabled(handoff.id, handoff.revision, false);
  const text = await env.read(env.config);
  assert.deepEqual(jsonc(text).permission, { skill: { handoff: "deny" } });
  assert.ok(text.startsWith(HOST_CONFIG.trimEnd().slice(0, -2)), "everything before the new key is untouched");
  const off = await env.item("skill:handoff");
  assert.equal(off.enabled, false);
  await env.adapter.setEnabled(off.id, off.revision, true);
  assert.equal(await env.read(env.config), HOST_CONFIG, "the emptied rules go away again, byte for byte");
  assert.equal((await env.item("skill:handoff")).enabled, true);
});

test("a permission action string is rewritten to the object it means before a skill is turned off", async (t) => {
  const env = await setup(t, { config: '{\n  // ask for everything\n  "permission": "ask"\n}\n' });
  const pdf = await env.item("skill:pdf");
  assert.equal(pdf.enabled, true, "ask is not deny");
  await env.adapter.setEnabled(pdf.id, pdf.revision, false);
  const text = await env.read(env.config);
  assert.ok(text.includes("// ask for everything"));
  assert.deepEqual(jsonc(text).permission, { "*": "ask", skill: { pdf: "deny" } });
  assert.equal((await env.item("skill:pdf")).enabled, false);
  assert.equal((await env.item("skill:handoff")).enabled, true);
});

test("a permission.skill action string keeps its meaning as the wildcard rule", async (t) => {
  const env = await setup(t, { config: '{ "permission": { "bash": "ask", "skill": "allow" } }' });
  const pdf = await env.item("skill:pdf");
  await env.adapter.setEnabled(pdf.id, pdf.revision, false);
  assert.deepEqual(jsonc(await env.read(env.config)).permission, { bash: "ask", skill: { "*": "allow", pdf: "deny" } });
});

test("turning a skill on past a wildcard deny adds an allow rule; a later catch-all is refused", async (t) => {
  const env = await setup(t, { config: '{ "permission": { "skill": { "*": "allow", "shared-*": "deny" } } }' });
  const shared = await env.item("skill:shared-one");
  assert.equal(shared.enabled, false);
  await env.adapter.setEnabled(shared.id, shared.revision, true);
  assert.deepEqual(jsonc(await env.read(env.config)).permission, {
    skill: { "*": "allow", "shared-*": "deny", "shared-one": "allow" }
  });
  assert.equal((await env.item("skill:shared-one")).enabled, true);

  // A catch-all after the skill rules wins in OpenCode: refuse rather than write a no-op.
  const trap = '{ "permission": { "skill": { "pdf": "allow" }, "*": "allow" } }';
  await writeFile(env.config, trap);
  const pdf = await env.item("skill:pdf");
  await rejectsWith(env.adapter.setEnabled(pdf.id, pdf.revision, false), "INVALID_ITEM", /last matching rule/);
  assert.equal(await env.read(env.config), trap);
});

test("an own skill shadows an inherited one; other copies make one warning; skill/ and bad skills are listed", async (t) => {
  const env = await setup(t);
  await put(join(env.dir, "skill", "handoff", "SKILL.md"), "---\nname: handoff\ndescription: Mine\n---\n");
  await put(join(env.home, ".claude", "skills", "synced", "def", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Again\n---\n");
  await put(join(env.home, ".agents", "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Third\n---\n");
  await put(join(env.dir, "skills", "nameless", "SKILL.md"), "---\ndescription: No name\n---\n");
  await put(join(env.dir, "skills", "quiet", "SKILL.md"), "---\nname: quiet\n---\n");
  const items = await env.items();
  const handoff = items.find((item) => item.id === "skill:handoff")!;
  assert.equal(handoff.description, "Mine");
  assert.equal(handoff.source.type, "user");
  assert.equal(handoff.editable, true);
  assert.equal(handoff.warnings.length, 1);
  assert.match(handoff.warnings[0]!.message, /Another skill named "handoff" is at .*\.claude\/skills\/handoff/);
  const pdf = items.find((item) => item.id === "skill:pdf")!;
  assert.equal(pdf.warnings.filter((w) => w.code === "opencode-skill-duplicate").length, 1);
  assert.match(pdf.warnings[0]!.message, /^2 other skills/);
  const nameless = items.find((item) => item.id === "skill:nameless")!;
  assert.equal(nameless.toggleable, false);
  assert.equal(nameless.editable, true, "saving it writes the missing name");
  assert.equal(nameless.deletable, true);
  assert.ok(nameless.warnings.some((w) => w.code === "opencode-skill-no-name"));
  assert.ok(items.find((item) => item.id === "skill:quiet")!.warnings.some((w) => w.code === "opencode-skill-no-description"));
});

test("a [spec, options] plugin entry is stashed and restored as it was", async (t) => {
  const env = await setup(t, {
    config: '{\n  "plugin": [\n    "first",\n    ["with-options@2", { "level": "debug" }],\n  ],\n}\n'
  });
  const item = await env.item("plugin:with-options@2");
  assert.deepEqual(item.meta, { source: "npm", version: "2", options: "yes" });
  await env.adapter.setEnabled(item.id, item.revision, false);
  assert.equal(await env.read(env.config), '{\n  "plugin": [\n    "first",\n  ],\n}\n');
  const off = await env.item(item.id);
  await env.adapter.setEnabled(off.id, off.revision, true);
  assert.deepEqual(jsonc(await env.read(env.config)).plugin, ["first", ["with-options@2", { level: "debug" }]]);
});

test("deleting an own skill drops its permission rule", async (t) => {
  const env = await setup(t);
  await env.adapter.create({ kind: "skill", document: { name: "temp", frontmatter: { description: "Temp" }, body: "" } }, { onConflict: "fail" });
  const temp = await env.item("skill:temp");
  await env.adapter.setEnabled(temp.id, temp.revision, false);
  const off = await env.item("skill:temp");
  await env.adapter.remove(off.id, off.revision);
  assert.equal(await env.read(env.config), HOST_CONFIG);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

test("command frontmatter is validated strictly before anything is written", async (t) => {
  const env = await setup(t);
  const create = (frontmatter: Record<string, unknown>): Promise<unknown> =>
    env.adapter.create({ kind: "command", document: { name: "c", frontmatter, body: "b" } }, { onConflict: "fail" });
  await rejectsWith(create({ "argument-hint": "[x]" }), "INVALID_ITEM", /no "argument-hint" setting/);
  await rejectsWith(create({ subtask: "yes" }), "INVALID_ITEM", /subtask/);
  await rejectsWith(create({ description: 3 }), "INVALID_ITEM", /description/);
  await rejectsWith(create({ model: "sonnet" }), "INVALID_ITEM", /provider\/model/);
  await rejectsWith(
    env.adapter.create({ kind: "command", document: { name: "a/b/c", frontmatter: {}, body: "" } }, { onConflict: "fail" }),
    "INVALID_NAME"
  );
  assert.deepEqual(await readdir(join(env.dir, "commands")), []);

  // A file already on disk that OpenCode would choke on is flagged.
  await put(join(env.dir, "commands", "broken.md"), "---\nsubtask: maybe\n---\nx\n");
  const broken = await env.item("command:broken");
  assert.ok(broken.warnings.some((w) => w.code === "opencode-command-invalid"));
});

test("command files: create nested, edit, stash off and restore byte for byte, delete", async (t) => {
  const env = await setup(t);
  await env.adapter.create(
    {
      kind: "command",
      document: {
        name: "git/pr",
        frontmatter: { description: "Open a PR", agent: "build", model: "anthropic/claude-sonnet-4", subtask: true },
        body: "Open a pull request for $ARGUMENTS\n"
      }
    },
    { onConflict: "fail" }
  );
  const file = join(env.dir, "commands", "git", "pr.md");
  const original = await env.read(file);
  assert.equal(
    original,
    "---\ndescription: Open a PR\nagent: build\nmodel: anthropic/claude-sonnet-4\nsubtask: true\n---\nOpen a pull request for $ARGUMENTS\n"
  );
  const pr = await env.item("command:git/pr");
  assert.equal(pr.description, "Open a PR");
  assert.equal(pr.editable, true);

  await env.adapter.setEnabled(pr.id, pr.revision, false);
  assert.equal(await pathKind(file), null, "moved aside");
  const off = await env.item("command:git/pr");
  assert.equal(off.enabled, false);
  assert.equal(off.stashed, true);
  assert.equal(off.description, "Open a PR");
  const offDetail = await env.adapter.readItem(off.id);
  assert.equal(offDetail.kind === "command" ? offDetail.document.body : null, "Open a pull request for $ARGUMENTS\n");

  await env.adapter.setEnabled(off.id, off.revision, true);
  assert.equal(await env.read(file), original);

  // A restore onto a path taken again is refused.
  const on = await env.item("command:git/pr");
  await env.adapter.setEnabled(on.id, on.revision, false);
  await put(file, "someone else\n");
  const again = (await env.items()).find((item) => item.id === "command:git/pr")!;
  assert.equal(again.stashed, undefined, "the live file wins the listing");
  assert.ok(again.warnings.some((w) => w.code === "opencode-stashed-copy"));
  await rm(file);
  const stashed = await env.item("command:git/pr");
  await put(file, "raced in\n");
  await rejectsWith(env.adapter.setEnabled(stashed.id, stashed.revision, true), "PROFILE_CONFLICT");
  await rm(file);
  const stashedNow = await env.item("command:git/pr");
  await env.adapter.setEnabled(stashedNow.id, stashedNow.revision, true);

  const live = await env.item("command:git/pr");
  await env.adapter.update(live.id, live.revision, {
    kind: "command",
    document: { name: "git/pr", frontmatter: { subtask: null, variant: "high" }, body: "Changed\n" }
  });
  assert.equal(
    await env.read(file),
    "---\ndescription: Open a PR\nagent: build\nmodel: anthropic/claude-sonnet-4\nvariant: high\n---\nChanged\n"
  );

  const edited = await env.item("command:git/pr");
  await env.adapter.setEnabled(edited.id, edited.revision, false);
  const stashedAgain = await env.item("command:git/pr");
  await env.adapter.remove(stashedAgain.id, stashedAgain.revision);
  assert.equal((await env.items()).some((item) => item.id === "command:git/pr"), false);
});

test("config commands: listed, edited in place, stashed off and restored, deleted", async (t) => {
  const env = await setup(t, {
    config: `{
  "$schema": "https://opencode.ai/config.json",
  "command": {
    // quick review
    "review": {
      "template": "Review $ARGUMENTS",
      "description": "Review something",
    },
  },
  "lsp": { "rust": { "disabled": true } },
}
`
  });
  const review = await env.item("command:review");
  assert.equal(review.description, "Review something");
  assert.equal(review.editable, true);
  const detail = await env.adapter.readItem(review.id);
  assert.deepEqual(detail.kind === "command" ? detail.document : null, {
    frontmatter: { description: "Review something" },
    body: "Review $ARGUMENTS"
  });

  await env.adapter.update(review.id, review.revision, {
    kind: "command",
    document: { name: "review", frontmatter: { agent: "plan" }, body: "Review $ARGUMENTS" }
  });
  let text = await env.read(env.config);
  assert.ok(text.includes("// quick review"));
  assert.deepEqual((jsonc(text).command as Record<string, unknown>).review, {
    template: "Review $ARGUMENTS",
    description: "Review something",
    agent: "plan"
  });

  const edited = await env.item("command:review");
  await env.adapter.setEnabled(edited.id, edited.revision, false);
  text = await env.read(env.config);
  assert.equal((jsonc(text).command as Record<string, unknown>).review, undefined);
  const off = await env.item("command:review");
  assert.equal(off.enabled, false);
  assert.equal(off.stashed, true);

  await env.adapter.setEnabled(off.id, off.revision, true);
  assert.deepEqual((jsonc(await env.read(env.config)).command as Record<string, unknown>).review, {
    template: "Review $ARGUMENTS",
    description: "Review something",
    agent: "plan"
  });
  assert.deepEqual(jsonc(await env.read(env.config)).lsp, { rust: { disabled: true } });

  const on = await env.item("command:review");
  await env.adapter.remove(on.id, on.revision);
  assert.equal((await env.items()).some((item) => item.id === "command:review"), false);
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

test("plugins: install npm and file specs, stash off and restore in place, delete; the status plugin is locked", async (t) => {
  const env = await setup(t);
  await env.adapter.create({ kind: "plugin", plugin: { spec: "opencode-wakatime@1.2.3" } }, { onConflict: "fail" });
  const localPlugin = join(env.home, "plugins", "mine.js");
  await put(localPlugin, "export default {};\n");
  await env.adapter.create({ kind: "plugin", plugin: { spec: localPlugin } }, { onConflict: "fail" });
  assert.deepEqual(jsonc(await env.read(env.config)).plugin, ["opencode-wakatime@1.2.3", localPlugin]);

  const outside = join(env.root, "elsewhere.js");
  await put(outside, "export default {};\n");
  await rejectsWith(env.adapter.create({ kind: "plugin", plugin: { spec: outside } }, { onConflict: "fail" }), "INVALID_REQUEST");
  await rejectsWith(env.adapter.create({ kind: "plugin", plugin: { spec: "./rel.js" } }, { onConflict: "fail" }), "INVALID_ITEM");
  await rejectsWith(env.adapter.create({ kind: "plugin", plugin: { spec: "Not A Package" } }, { onConflict: "fail" }), "INVALID_ITEM");
  await rejectsWith(
    env.adapter.create({ kind: "plugin", plugin: { spec: "opencode-wakatime@2.0.0" } }, { onConflict: "fail" }),
    "ITEM_EXISTS"
  );
  await rejectsWith(
    env.adapter.create({ kind: "plugin", plugin: { plugin: "x", marketplace: "y" } }, { onConflict: "fail" }),
    "INVALID_ITEM"
  );

  const waka = await env.item("plugin:opencode-wakatime@1.2.3");
  assert.deepEqual(waka.meta, { source: "npm", version: "1.2.3" });
  await env.adapter.setEnabled(waka.id, waka.revision, false);
  assert.deepEqual(jsonc(await env.read(env.config)).plugin, [localPlugin]);
  const off = await env.item(waka.id);
  assert.equal(off.enabled, false);
  await env.adapter.setEnabled(off.id, off.revision, true);
  assert.deepEqual(jsonc(await env.read(env.config)).plugin, ["opencode-wakatime@1.2.3", localPlugin], "back at its index");

  const mine = await env.item(`plugin:${localPlugin}`);
  await env.adapter.remove(mine.id, mine.revision);
  assert.deepEqual(jsonc(await env.read(env.config)).plugin, ["opencode-wakatime@1.2.3"]);

  const status = await env.item("plugin:plugin/orquester-status.js");
  await rejectsWith(env.adapter.setEnabled(status.id, status.revision, false), "ITEM_LOCKED");
  await rejectsWith(env.adapter.remove(status.id, status.revision), "ITEM_LOCKED");
  assert.equal(await env.read(join(env.dir, "plugin", "orquester-status.js")), STATUS_PLUGIN);
});

test("plugin files are stashed off and restored", async (t) => {
  const env = await setup(t);
  const file = join(env.dir, "plugins", "notify.ts");
  await put(file, "export default async () => ({});\n");
  const item = await env.item("plugin:plugins/notify.ts");
  assert.equal(item.toggleable, true);
  await env.adapter.setEnabled(item.id, item.revision, false);
  assert.equal(await pathKind(file), null);
  const off = await env.item(item.id);
  assert.equal(off.stashed, true);
  await env.adapter.setEnabled(off.id, off.revision, true);
  assert.equal(await env.read(file), "export default async () => ({});\n");
  const on = await env.item(item.id);
  await env.adapter.remove(on.id, on.revision);
  assert.equal(await pathKind(file), null);
});

test("hooks and marketplaces are not OpenCode kinds", async (t) => {
  const env = await setup(t);
  await rejectsWith(
    env.adapter.create({ kind: "hook", hook: { event: "Stop", command: "x" } }, { onConflict: "fail" }),
    "KIND_NOT_SUPPORTED"
  );
  await rejectsWith(
    env.adapter.create({ kind: "marketplace", marketplace: { source: { type: "github", repo: "a/b" } } }, { onConflict: "fail" }),
    "KIND_NOT_SUPPORTED"
  );
});

// ---------------------------------------------------------------------------
// Instructions, copy
// ---------------------------------------------------------------------------

test("instructions read and write against their revision", async (t) => {
  const env = await setup(t);
  const { text, info } = await env.adapter.readInstructions();
  assert.equal(text, "# Global rules\n\nBe brief.\n");
  await rejectsWith(env.adapter.writeInstructions("x", "stale"), "PROFILE_CONFLICT");
  const result = await env.adapter.writeInstructions("# Rules\n", info.revision);
  assert.deepEqual(result.notes, [OPENCODE_RECYCLE_NOTE]);
  assert.equal(await env.read(join(env.dir, "AGENTS.md")), "# Rules\n");

  await rm(join(env.dir, "AGENTS.md"));
  const missing = await env.adapter.readInstructions();
  assert.equal(missing.info.exists, false);
  assert.equal(missing.info.revision, "");
  await env.adapter.writeInstructions("new\n", "");
  assert.equal(await env.read(join(env.dir, "AGENTS.md")), "new\n");
});

test("export carries real MCP values and a skill copy; import honours the conflict policy", async (t) => {
  const env = await setup(t);
  const exported = await env.adapter.exportItem("mcp:centur");
  assert.deepEqual(exported, {
    kind: "mcp",
    server: {
      name: "centur",
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["/srv/centur-mcp/dist/index.js"],
      env: { CENTUR_API_URL: "https://centur.invalid/api", CENTUR_PASSWORD: "fake-centur-password" },
      advanced: { timeout: 60000 }
    }
  });
  const imported = await env.adapter.importItem(exported, { onConflict: "keep-both" });
  assert.deepEqual(imported.itemIds, ["mcp:centur-2"]);
  assert.deepEqual((jsonc(await env.read(env.config)).mcp as Record<string, Record<string, unknown>>)["centur-2"], {
    type: "local",
    command: ["/usr/bin/node", "/srv/centur-mcp/dist/index.js"],
    environment: { CENTUR_API_URL: "https://centur.invalid/api", CENTUR_PASSWORD: "fake-centur-password" },
    timeout: 60000
  });

  const skill = await env.adapter.exportItem("skill:handoff");
  assert.equal(skill.kind, "skill");
  if (skill.kind !== "skill") return;
  assert.notEqual(skill.dir, join(env.home, ".claude", "skills", "handoff"), "a copy the caller owns");
  const result = await env.adapter.importItem(skill, { onConflict: "keep-both" });
  assert.deepEqual(result.itemIds, ["skill:handoff-2"]);
  assert.equal(
    await env.read(join(env.dir, "skills", "handoff-2", "SKILL.md")),
    "---\nname: handoff-2\ndescription: Write a handoff\n---\nBody\n"
  );
  await rm(skill.dir, { recursive: true, force: true });
  assert.deepEqual(await readdir(agentProfileImportsDir(env.appdir)), [], "nothing left behind");

  await env.adapter.importItem({ kind: "command", name: "hi", frontmatter: { description: "Hi" }, body: "Hi\n" }, { onConflict: "fail" });
  assert.equal(await env.read(join(env.dir, "commands", "hi.md")), "---\ndescription: Hi\n---\nHi\n");
  await rejectsWith(
    env.adapter.importItem({ kind: "command", name: "hi2", frontmatter: { "allowed-tools": "Bash" }, body: "" }, { onConflict: "fail" }),
    "INVALID_ITEM"
  );
});
