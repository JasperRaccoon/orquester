import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "@decimalturn/toml-patch";
import type { ProfileItem } from "@orquester/api";
import { agentProfileBackupsDir, agentProfileStashDir } from "@orquester/config";
import { AgentProfileError } from "../../errors.ts";
import { ProfileBackups, ProfileStash } from "../../infra/index.ts";
import type { ProfileAdapterContext } from "../types.ts";
import { CodexAppServerClient, type CodexConfigClient, type CodexConfigClientFactory } from "./codex-config-client.ts";
import { codexHookHash } from "./hooks.ts";
import { CodexProfileAdapter } from "./index.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-app-server.mjs", import.meta.url));

const SECRETS = ["hunter2-secret", "hdr-secret-value", "https://centur.invalid"];

interface Fixture {
  root: string;
  home: string;
  codexHome: string;
  appdir: string;
  accounts: string[];
  mkt: string;
  log: string;
  adapter: CodexProfileAdapter;
  ctx: ProfileAdapterContext;
  configText(): Promise<string>;
  config(): Promise<Record<string, any>>;
  hooksDoc(): Promise<{ hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> }>;
  item(id: string): Promise<ProfileItem>;
  requests(): Promise<Array<{ pid: number; method: string; params: any }>>;
}

const managedCommand = (appdir: string, event: string) => `'${appdir}/daemon/hooks/agent-hook.sh' codex ${event}`;

async function writeSkillFile(dir: string, name: string, description: string, body = "Body.\n"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}

/** A temp tree shaped like this host's real ~/.codex (secrets replaced) and two managed account homes. */
async function makeFixture(
  options: {
    wrap?: (client: CodexConfigClient) => CodexConfigClient;
    /** Runs whenever the adapter lists the account homes (a test's hook into a mutation). */
    onAccountHomes?: () => Promise<void>;
  } = {}
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codex-profile-"));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const appdir = join(root, "appdir");
  const mkt = join(root, "mkt");
  const log = join(root, "requests.ndjson");
  await mkdir(codexHome, { recursive: true });

  // Marketplace with one plugin that ships a skill.
  await mkdir(join(mkt, ".agents", "plugins"), { recursive: true });
  await writeFile(
    join(mkt, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "test-mkt",
      interface: { displayName: "Test marketplace" },
      plugins: [
        { name: "hello", source: { source: "local", path: "./plugins/hello" } },
        { name: "other", source: { source: "local", path: "./plugins/other" } }
      ]
    })
  );
  for (const plugin of ["hello", "other"]) {
    await mkdir(join(mkt, "plugins", plugin, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(mkt, "plugins", plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: plugin, version: "1.2.3", description: `The ${plugin} plugin.`, interface: { shortDescription: `Says ${plugin}` } })
    );
    await writeSkillFile(join(mkt, "plugins", plugin, "skills", `${plugin}-skill`), `${plugin}-skill`, `From ${plugin}.`);
  }
  await cp(join(mkt, "plugins", "hello"), join(codexHome, "plugins", "cache", "test-mkt", "hello", "1.2.3"), { recursive: true });

  // Account homes: config.toml and hooks.json symlinked to the system ones, as syncAccountHome does.
  const accounts = ["a1", "a2"].map((id) => join(appdir, "daemon", "agent-accounts", "codex", id, "home"));
  for (const account of accounts) {
    await mkdir(account, { recursive: true });
    await symlink(join(codexHome, "config.toml"), join(account, "config.toml"));
    await symlink(join(codexHome, "hooks.json"), join(account, "hooks.json"));
  }

  const userStop = { type: "command", command: "notify-send done", timeout: 30 };
  const hooksDoc = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: managedCommand(appdir, "SessionStart"), timeout: 10 }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: managedCommand(appdir, "PreToolUse"), timeout: 10 }] }],
      Stop: [{ hooks: [userStop] }, { hooks: [{ type: "command", command: managedCommand(appdir, "Stop"), timeout: 10 }] }]
    }
  };
  await writeFile(join(codexHome, "hooks.json"), `${JSON.stringify(hooksDoc, null, 2)}\n`);

  const hash = (snake: string, handler: Record<string, unknown>, matcher?: string) => codexHookHash(snake, handler, matcher)!;
  const stateLines: string[] = ["[hooks.state]", ""];
  for (const path of [join(codexHome, "hooks.json"), ...accounts.map((a) => join(a, "hooks.json"))]) {
    const add = (key: string, trusted: string) =>
      stateLines.push(`[hooks.state."${path}:${key}"]`, "enabled = true", `trusted_hash = "${trusted}"`, "");
    add("session_start:0:0", hash("session_start", hooksDoc.hooks.SessionStart[0].hooks[0]));
    add("pre_tool_use:0:0", hash("pre_tool_use", hooksDoc.hooks.PreToolUse[0].hooks[0], "*"));
    add("stop:0:0", hash("stop", userStop));
    add("stop:1:0", hash("stop", hooksDoc.hooks.Stop[1].hooks[0]));
  }
  const config = [
    "# Codex config (fixture shaped like the host's)",
    'model = "gpt-5.5"',
    'model_reasoning_effort = "xhigh" # keep me',
    "",
    '[projects."/w/p"]',
    'trust_level = "trusted"',
    "",
    "[mcp_servers.centur]",
    'command = "/usr/bin/node"',
    'args = ["/srv/centur/index.js"]',
    "",
    "[mcp_servers.centur.env]",
    'CENTUR_API_URL = "https://centur.invalid"',
    'CENTUR_PASSWORD = "hunter2-secret"',
    "",
    "[mcp_servers.web]",
    'url = "https://mcp.invalid/mcp"',
    'http_headers = { "X-Api-Key" = "hdr-secret-value" }',
    "startup_timeout_sec = 20",
    'custom_future_field = "kept"',
    "",
    "[marketplaces.test-mkt]",
    'source_type = "local"',
    `source = "${mkt}"`,
    "",
    '[plugins."hello@test-mkt"]',
    "enabled = true",
    "",
    '[plugins."ghost@test-mkt"]',
    "enabled = true",
    "",
    ...stateLines,
    "[notice]",
    "hide_rate_limit_model_nudge = true",
    ""
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), config, { mode: 0o600 });

  await writeFile(join(codexHome, "AGENTS.md"), "# Global\nBe brief.\n");
  await writeFile(join(codexHome, "AGENTS.override.md"), "Override!\n");
  await writeSkillFile(join(codexHome, "skills", ".system", "imagegen"), "imagegen", "Make images.");
  await writeSkillFile(join(codexHome, "skills", "handoff"), "handoff", "Write a handoff.");
  await writeSkillFile(join(root, "skill-sources", "chdb-sql"), "chdb-sql", "SQL on files.");
  await symlink(join(root, "skill-sources", "chdb-sql"), join(codexHome, "skills", "chdb-sql"));
  await writeSkillFile(join(home, ".agents", "skills", "shared-one"), "shared-one", "Shared.");
  await mkdir(join(codexHome, "prompts"), { recursive: true });
  await writeFile(join(codexHome, "prompts", "old.md"), "---\ndescription: An old prompt\n---\nDo it.\n");

  const factory: CodexConfigClientFactory = (opts) => {
    const client = new CodexAppServerClient({
      ...opts,
      bin: process.execPath,
      args: [FAKE, "app-server"],
      killGraceMs: 200,
      extraEnv: { FAKE_CODEX_LOG: log }
    });
    return options.wrap ? options.wrap(client) : client;
  };
  const ctx: ProfileAdapterContext = {
    homes: {
      home,
      claudeDir: join(home, ".claude"),
      claudeJson: join(home, ".claude.json"),
      codexHome,
      grokHome: join(home, ".grok"),
      opencodeDir: join(home, ".config", "opencode"),
      agentsSkillsDir: join(home, ".agents", "skills")
    },
    appdir,
    bin: "/usr/local/bin/codex",
    accountHomes: async () => {
      await options.onAccountHomes?.();
      return accounts;
    },
    logger: { info: () => undefined, warn: () => undefined },
    now: () => new Date()
  };
  const adapter = new CodexProfileAdapter(ctx, {
    backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }),
    stash: new ProfileStash({ dir: agentProfileStashDir(appdir) }),
    configClient: factory
  });
  const fixture: Fixture = {
    root,
    home,
    codexHome,
    appdir,
    accounts,
    mkt,
    log,
    adapter,
    ctx,
    configText: () => readFile(join(codexHome, "config.toml"), "utf8"),
    // Plain objects (the TOML parser answers null-prototype ones).
    config: async () => JSON.parse(JSON.stringify(parseToml(await readFile(join(codexHome, "config.toml"), "utf8")))),
    hooksDoc: async () => JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8")),
    item: async (id) => {
      const found = (await adapter.snapshot()).items.find((item) => item.id === id);
      assert.ok(found, `item ${id} is listed`);
      return found;
    },
    requests: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
  };
  return fixture;
}

function assertProfileError(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof AgentProfileError, `expected AgentProfileError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

describe("CodexProfileAdapter", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await makeFixture();
  });

  afterEach(async () => {
    await f.adapter.close();
    await rm(f.root, { recursive: true, force: true });
  });

  describe("snapshot", () => {
    it("lists every kind with its source, switches and warnings — and no secret", async () => {
      const snapshot = await f.adapter.snapshot();
      const byId = new Map(snapshot.items.map((item) => [item.id, item]));
      assert.deepEqual(snapshot.fileErrors, []);

      const centur = byId.get("mcp:centur")!;
      assert.equal(centur.enabled, true);
      assert.equal(centur.meta?.transport, "stdio");
      assert.equal(byId.get("mcp:web")!.meta?.transport, "http");

      const handoff = byId.get("skill:handoff")!;
      assert.deepEqual([handoff.editable, handoff.deletable, handoff.toggleable, handoff.source.type], [true, true, true, "user"]);
      assert.ok(byId.get("skill:chdb-sql"), "a symlinked user skill is listed");
      const bundled = byId.get("skill:system/imagegen")!;
      assert.deepEqual([bundled.editable, bundled.deletable, bundled.toggleable, bundled.source.type], [false, false, true, "bundled"]);
      const shared = byId.get("skill:agents/shared-one")!;
      assert.deepEqual([shared.editable, shared.deletable, shared.toggleable], [false, false, true]);
      assert.deepEqual(shared.source, { type: "inherited", label: "Shared · ~/.agents" });
      const pluginSkill = byId.get("skill:hello:hello-skill")!;
      assert.deepEqual(pluginSkill.source, { type: "plugin", label: "Plugin · hello", pluginId: "hello@test-mkt" });

      const hello = byId.get("plugin:hello@test-mkt")!;
      assert.equal(hello.enabled, true);
      assert.deepEqual(hello.warnings, []);
      assert.equal(hello.meta?.version, "1.2.3");
      const ghost = byId.get("plugin:ghost@test-mkt")!;
      assert.deepEqual(ghost.warnings.map((w) => w.code), ["plugin-cache-missing"]);

      const marketplace = byId.get("marketplace:test-mkt")!;
      assert.equal(marketplace.deletable, true);

      const hooks = snapshot.items.filter((item) => item.kind === "hook");
      assert.equal(hooks.length, 4);
      const locked = hooks.filter((item) => item.locked);
      assert.equal(locked.length, 3);
      for (const item of locked) {
        assert.deepEqual([item.toggleable, item.editable, item.deletable, item.source.type], [false, false, false, "orquester"]);
      }
      const userHook = hooks.find((item) => !item.locked)!;
      assert.equal(userHook.name, "notify-send done");
      assert.deepEqual(userHook.warnings, [], "the user hook is trusted");

      const prompt = byId.get("command:old")!;
      assert.deepEqual([prompt.enabled, prompt.toggleable, prompt.editable, prompt.deletable], [false, false, false, true]);
      assert.equal(prompt.warnings[0].code, "codex-prompts-deprecated");

      assert.equal(snapshot.instructions.exists, true);
      assert.equal(snapshot.instructions.lines, 2);
      assert.deepEqual(snapshot.instructions.warnings.map((w) => w.code), ["agents-override"]);

      const text = JSON.stringify(snapshot);
      for (const secret of SECRETS) assert.ok(!text.includes(secret), `snapshot leaks ${secret}`);
    });

    it("warns about an untrusted hook with a Trust action, and trust() fixes it on every path", async () => {
      const doc = await f.hooksDoc();
      doc.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: "echo hand-added" }] }];
      await writeFile(join(f.codexHome, "hooks.json"), JSON.stringify(doc));
      const item = (await f.adapter.snapshot()).items.find((i) => i.name === "echo hand-added")!;
      assert.deepEqual(item.warnings.map((w) => [w.code, w.action]), [["hook-untrusted", "trust"]]);
      await f.adapter.trust(item.id, item.revision);
      assert.deepEqual((await f.item(item.id)).warnings, []);
    });

    it("reports an unreadable config.toml and refuses to write it", async () => {
      await writeFile(join(f.codexHome, "config.toml"), "model = = 1\n");
      const snapshot = await f.adapter.snapshot();
      assert.equal(snapshot.fileErrors.length, 1);
      assert.equal(snapshot.fileErrors[0].path, join(f.codexHome, "config.toml"));
      assert.ok(snapshot.items.some((item) => item.id === "skill:handoff"), "disk items still listed");
      await assert.rejects(
        f.adapter.create({ kind: "mcp", mcp: { name: "x", transport: "stdio", command: "x" } }, { onConflict: "fail" }),
        assertProfileError("CONFIG_UNREADABLE", 409)
      );
    });

    it("reports an unparseable hooks.json", async () => {
      await writeFile(join(f.codexHome, "hooks.json"), "{nope");
      const snapshot = await f.adapter.snapshot();
      assert.deepEqual(snapshot.fileErrors.map((e) => e.path), [join(f.codexHome, "hooks.json")]);
      await assert.rejects(
        f.adapter.create({ kind: "hook", hook: { event: "Stop", command: "x" } }, { onConflict: "fail" }),
        assertProfileError("CONFIG_UNREADABLE")
      );
    });
  });

  describe("mcp", () => {
    it("masks secrets in readItem", async () => {
      const detail = await f.adapter.readItem("mcp:centur");
      assert.equal(detail.kind, "mcp");
      if (detail.kind !== "mcp") return;
      assert.deepEqual(detail.mcp.env, [
        { key: "CENTUR_API_URL", set: true },
        { key: "CENTUR_PASSWORD", set: true }
      ]);
      const web = await f.adapter.readItem("mcp:web");
      if (web.kind !== "mcp") return;
      assert.deepEqual(web.mcp.headers, [{ key: "X-Api-Key", set: true }]);
      assert.deepEqual(web.mcp.advanced, { startup_timeout_sec: 20 });
      for (const secret of SECRETS) assert.ok(!JSON.stringify([detail, web]).includes(secret));
    });

    it("creates, edits (keeping a secret and unknown fields), toggles and deletes through config/batchWrite", async () => {
      const created = await f.adapter.create(
        {
          kind: "mcp",
          mcp: {
            name: "jira",
            transport: "stdio",
            command: "node",
            args: ["jira.js"],
            env: [{ key: "JIRA_TOKEN", value: "tok-123" }],
            advanced: { tool_timeout_sec: 60, enabled_tools: ["search"] }
          }
        },
        { onConflict: "fail" }
      );
      assert.deepEqual(created.itemIds, ["mcp:jira"]);
      let config = await f.config();
      assert.deepEqual(config.mcp_servers.jira, {
        command: "node",
        args: ["jira.js"],
        env: { JIRA_TOKEN: "tok-123" },
        tool_timeout_sec: 60,
        enabled_tools: ["search"]
      });
      const text = await f.configText();
      assert.ok(text.startsWith("# Codex config (fixture shaped like the host's)\n"), "comments kept");
      assert.ok(text.includes("# keep me"));

      await assert.rejects(
        f.adapter.create({ kind: "mcp", mcp: { name: "jira", transport: "stdio", command: "x" } }, { onConflict: "fail" }),
        assertProfileError("ITEM_EXISTS", 409)
      );
      const both = await f.adapter.create(
        { kind: "mcp", mcp: { name: "jira", transport: "stdio", command: "x" } },
        { onConflict: "keep-both" }
      );
      assert.deepEqual(both.itemIds, ["mcp:jira-2"]);

      // Edit web: keep the header, change the URL; the unknown field survives.
      const web = await f.item("mcp:web");
      await f.adapter.update(web.id, web.revision, {
        kind: "mcp",
        mcp: {
          name: "web",
          transport: "http",
          url: "https://mcp2.invalid/mcp",
          headers: [{ key: "X-Api-Key", keep: true }],
          advanced: { startup_timeout_sec: 30, bearer_token_env_var: "WEB_TOKEN" }
        }
      });
      config = await f.config();
      assert.deepEqual(config.mcp_servers.web, {
        url: "https://mcp2.invalid/mcp",
        http_headers: { "X-Api-Key": "hdr-secret-value" },
        startup_timeout_sec: 30,
        bearer_token_env_var: "WEB_TOKEN",
        custom_future_field: "kept"
      });

      // Switch centur to http: stdio fields go, env with it.
      const centur = await f.item("mcp:centur");
      await f.adapter.update(centur.id, centur.revision, {
        kind: "mcp",
        mcp: { name: "centur", transport: "http", url: "https://centur.invalid/mcp" }
      });
      assert.deepEqual((await f.config()).mcp_servers.centur, { url: "https://centur.invalid/mcp" });

      // Off = enabled = false; on = the key removed.
      let jira = await f.item("mcp:jira");
      await f.adapter.setEnabled(jira.id, jira.revision, false);
      assert.equal((await f.config()).mcp_servers.jira.enabled, false);
      jira = await f.item("mcp:jira");
      assert.equal(jira.enabled, false);
      await f.adapter.setEnabled(jira.id, jira.revision, true);
      assert.equal("enabled" in (await f.config()).mcp_servers.jira, false);

      jira = await f.item("mcp:jira");
      await f.adapter.remove(jira.id, jira.revision);
      assert.equal((await f.config()).mcp_servers.jira, undefined);

      // Every write carried the version it read, and asked for a reload.
      const writes = (await f.requests()).filter((r) => r.method === "config/batchWrite");
      for (const write of writes) {
        assert.match(write.params.expectedVersion, /^sha256:/);
        assert.equal(write.params.reloadUserConfig, true);
      }
    });

    it("renames a server in one batch", async () => {
      const centur = await f.item("mcp:centur");
      const result = await f.adapter.update(centur.id, centur.revision, {
        kind: "mcp",
        mcp: {
          name: "centur2",
          transport: "stdio",
          command: "/usr/bin/node",
          env: [
            { key: "CENTUR_API_URL", keep: true },
            { key: "CENTUR_PASSWORD", keep: true }
          ]
        }
      });
      assert.deepEqual(result.itemIds, ["mcp:centur2"]);
      const servers = (await f.config()).mcp_servers;
      assert.equal(servers.centur, undefined);
      assert.deepEqual(servers.centur2.env, { CENTUR_API_URL: "https://centur.invalid", CENTUR_PASSWORD: "hunter2-secret" });
    });

    it("refuses bad drafts before writing", async () => {
      await assert.rejects(
        f.adapter.create({ kind: "mcp", mcp: { name: "x", transport: "sse", url: "https://x.invalid" } }, { onConflict: "fail" }),
        assertProfileError("INVALID_ITEM", 400)
      );
      await assert.rejects(
        f.adapter.create({ kind: "mcp", mcp: { name: "bad name", transport: "stdio", command: "x" } }, { onConflict: "fail" }),
        assertProfileError("INVALID_NAME", 400)
      );
      await assert.rejects(
        f.adapter.create(
          { kind: "mcp", mcp: { name: "x", transport: "stdio", command: "x", env: [{ key: "NEW", keep: true }] } },
          { onConflict: "fail" }
        ),
        assertProfileError("INVALID_ITEM")
      );
    });

    it("answers 409 on a stale item revision and on a config version conflict", async () => {
      const centur = await f.item("mcp:centur");
      await assert.rejects(f.adapter.setEnabled(centur.id, "stale", false), assertProfileError("PROFILE_CONFLICT", 409));

      await f.adapter.close();
      // Someone edits config.toml between our read and our write.
      const racy = await makeFixture({
        wrap: (client) => ({
          call: async (method, params, options) => {
            if (method === "config/batchWrite") {
              await writeFile(join(racy.codexHome, "config.toml"), `${await racy.configText()}# edited meanwhile\n`);
            }
            return client.call(method, params, options);
          },
          close: () => client.close()
        })
      });
      try {
        const item = await racy.item("mcp:centur");
        await assert.rejects(racy.adapter.setEnabled(item.id, item.revision, false), assertProfileError("PROFILE_CONFLICT", 409));
        assert.equal((await racy.config()).mcp_servers.centur.enabled, undefined, "nothing written");
      } finally {
        await racy.adapter.close();
        await rm(racy.root, { recursive: true, force: true });
      }
    });

    it("exports real values and imports a portable server", async () => {
      const portable = await f.adapter.exportItem("mcp:centur");
      assert.equal(portable.kind, "mcp");
      if (portable.kind !== "mcp") return;
      assert.equal(portable.server.env?.CENTUR_PASSWORD, "hunter2-secret");
      await f.adapter.importItem({ kind: "mcp", server: { ...portable.server, name: "copied" } }, { onConflict: "fail" });
      assert.deepEqual((await f.config()).mcp_servers.copied.env, portable.server.env);
    });
  });

  describe("skills", () => {
    it("creates, edits, toggles by path and deletes a user skill", async () => {
      await f.adapter.create(
        { kind: "skill", document: { name: "review", frontmatter: { description: "Review diffs." }, body: "Look.\n" } },
        { onConflict: "fail" }
      );
      const file = join(f.codexHome, "skills", "review", "SKILL.md");
      assert.match(await readFile(file, "utf8"), /^---\nname: review\ndescription: Review diffs\.\n---\nLook\.\n$/);

      let item = await f.item("skill:review");
      await f.adapter.update(item.id, item.revision, {
        kind: "skill",
        document: { name: "review", frontmatter: { description: "Review changes." }, body: "Look harder.\n" }
      });
      assert.match(await readFile(file, "utf8"), /Review changes\.[\s\S]*Look harder\./);

      item = await f.item("skill:review");
      await f.adapter.setEnabled(item.id, item.revision, false);
      assert.deepEqual((await f.config()).skills.config, [{ path: file, enabled: false }]);
      item = await f.item("skill:review");
      assert.equal(item.enabled, false);
      await f.adapter.setEnabled(item.id, item.revision, true);
      assert.equal((await f.config()).skills, undefined);

      item = await f.item("skill:review");
      await f.adapter.remove(item.id, item.revision);
      await assert.rejects(lstat(join(f.codexHome, "skills", "review")));
    });

    it("toggles a symlinked skill by its realpath, and deleting it removes only the link", async () => {
      let item = await f.item("skill:chdb-sql");
      await f.adapter.setEnabled(item.id, item.revision, false);
      const real = join(f.root, "skill-sources", "chdb-sql", "SKILL.md");
      assert.deepEqual((await f.config()).skills.config, [{ path: real, enabled: false }]);
      item = await f.item("skill:chdb-sql");
      await f.adapter.remove(item.id, item.revision);
      await assert.rejects(lstat(join(f.codexHome, "skills", "chdb-sql")));
      assert.ok((await stat(real)).isFile(), "the link's target is untouched");
      assert.equal((await f.config()).skills, undefined, "the switch of the removed skill is dropped");
    });

    it("toggles bundled and plugin skills by name and shared skills by path, and never edits them", async () => {
      const bundled = await f.item("skill:system/imagegen");
      await f.adapter.setEnabled(bundled.id, bundled.revision, false);
      const plugin = await f.item("skill:hello:hello-skill");
      await f.adapter.setEnabled(plugin.id, plugin.revision, false);
      const shared = await f.item("skill:agents/shared-one");
      await f.adapter.setEnabled(shared.id, shared.revision, false);
      assert.deepEqual((await f.config()).skills.config, [
        { name: "imagegen", enabled: false },
        { name: "hello:hello-skill", enabled: false },
        { path: join(f.home, ".agents", "skills", "shared-one", "SKILL.md"), enabled: false }
      ]);
      const offBundled = await f.item("skill:system/imagegen");
      assert.equal(offBundled.enabled, false);
      await assert.rejects(
        f.adapter.update(offBundled.id, offBundled.revision, {
          kind: "skill",
          document: { name: "imagegen", frontmatter: {}, body: "" }
        }),
        assertProfileError("NOT_EDITABLE", 403)
      );
      await assert.rejects(f.adapter.remove(offBundled.id, offBundled.revision), assertProfileError("NOT_DELETABLE", 403));
      const offShared = await f.item("skill:agents/shared-one");
      await assert.rejects(f.adapter.remove(offShared.id, offShared.revision), assertProfileError("NOT_DELETABLE", 403));
    });

    it("renames a skill, keeping its off switch", async () => {
      let item = await f.item("skill:handoff");
      await f.adapter.setEnabled(item.id, item.revision, false);
      item = await f.item("skill:handoff");
      const result = await f.adapter.update(item.id, item.revision, {
        kind: "skill",
        document: { name: "hand-off", frontmatter: {}, body: "Renamed.\n" }
      });
      assert.deepEqual(result.itemIds, ["skill:hand-off"]);
      await assert.rejects(lstat(join(f.codexHome, "skills", "handoff")));
      const renamed = await f.item("skill:hand-off");
      assert.equal(renamed.enabled, false);
      assert.deepEqual((await f.config()).skills.config, [
        { path: join(f.codexHome, "skills", "hand-off", "SKILL.md"), enabled: false }
      ]);
    });

    it("exports a skill as a copy and imports one", async () => {
      const portable = await f.adapter.exportItem("skill:handoff");
      assert.equal(portable.kind, "skill");
      if (portable.kind !== "skill") return;
      assert.notEqual(portable.dir, join(f.codexHome, "skills", "handoff"));
      await f.adapter.importItem({ kind: "skill", name: "handoff", dir: portable.dir }, { onConflict: "keep-both" });
      const text = await readFile(join(f.codexHome, "skills", "handoff-2", "SKILL.md"), "utf8");
      assert.match(text, /name: handoff-2/);
      await assert.rejects(
        f.adapter.importItem({ kind: "command", name: "x", frontmatter: {}, body: "" }, { onConflict: "fail" }),
        assertProfileError("INVALID_ITEM")
      );
    });
  });

  describe("hooks", () => {
    const keysOf = async (fixture: Fixture) => {
      const state = (await fixture.config()).hooks.state as Record<string, { enabled: boolean; trusted_hash: string }>;
      return state;
    };

    it("inserts a new hook before the managed group and re-keys every account path", async () => {
      const systemPath = join(f.codexHome, "hooks.json");
      const paths = [systemPath, ...f.accounts.map((a) => join(a, "hooks.json"))];
      const doc0 = await f.hooksDoc();
      const managedStop = doc0.hooks.Stop[1].hooks[0];
      const beforeState = await keysOf(f);
      const managedHash = beforeState[`${systemPath}:stop:1:0`].trusted_hash;

      const result = await f.adapter.create(
        { kind: "hook", hook: { event: "Stop", command: "say finished", timeoutSec: 20, matcher: "ignored" } },
        { onConflict: "fail" }
      );
      assert.equal(result.itemIds.length, 1);

      const doc = await f.hooksDoc();
      assert.deepEqual(
        doc.hooks.Stop.map((g) => g.hooks[0].command),
        ["notify-send done", "say finished", managedStop.command],
        "the new group sits before Orquester's, which stays last"
      );
      assert.deepEqual(doc.hooks.Stop[1], { hooks: [{ type: "command", command: "say finished", timeout: 20 }] }, "no matcher on Stop");

      const state = await keysOf(f);
      for (const path of paths) {
        assert.equal(state[`${path}:stop:1:0`].enabled, true);
        assert.deepEqual(state[`${path}:stop:2:0`], { enabled: true, trusted_hash: managedHash }, "managed trust moved");
        assert.deepEqual(state[`${path}:stop:0:0`], beforeState[`${path}:stop:0:0`]);
        assert.equal(state[`${path}:session_start:0:0`].enabled, true, "other events untouched");
      }

      // The new hook is listed trusted and on.
      const item = await f.item(result.itemIds[0]);
      assert.deepEqual(item.warnings, []);
      assert.equal(item.enabled, true);
    });

    it("toggles a hook on every path, edits it (re-trusted) and deletes it (shifting the rest back)", async () => {
      const paths = [join(f.codexHome, "hooks.json"), ...f.accounts.map((a) => join(a, "hooks.json"))];
      let item = (await f.adapter.snapshot()).items.find((i) => i.name === "notify-send done")!;
      await f.adapter.setEnabled(item.id, item.revision, false);
      let state = await keysOf(f);
      for (const path of paths) assert.equal(state[`${path}:stop:0:0`].enabled, false);
      item = await f.item(item.id);
      assert.equal(item.enabled, false);

      const edited = await f.adapter.update(item.id, item.revision, {
        kind: "hook",
        hook: { event: "Stop", command: "notify-send finished", timeoutSec: 5 }
      });
      const doc = await f.hooksDoc();
      assert.deepEqual(doc.hooks.Stop[0].hooks[0], { type: "command", command: "notify-send finished", timeout: 5 });
      state = await keysOf(f);
      for (const path of paths) {
        assert.equal(state[`${path}:stop:0:0`].enabled, false);
      }

      item = await f.item(edited.itemIds[0]);
      assert.deepEqual(item.warnings, [], "the edited hook is trusted anew");
      const managedHash = state[`${paths[0]}:stop:1:0`].trusted_hash;
      await f.adapter.remove(item.id, item.revision);
      assert.deepEqual((await f.hooksDoc()).hooks.Stop.length, 1);
      state = await keysOf(f);
      for (const path of paths) {
        assert.deepEqual(state[`${path}:stop:0:0`], { enabled: true, trusted_hash: managedHash }, "managed moved back to 0");
        assert.equal(state[`${path}:stop:1:0`], undefined);
      }
    });

    it("moves a hook to another event on edit", async () => {
      const item = (await f.adapter.snapshot()).items.find((i) => i.name === "notify-send done")!;
      const before = await keysOf(f);
      const updated = await f.adapter.update(item.id, item.revision, {
        kind: "hook",
        hook: { event: "PreToolUse", matcher: "Bash", command: "notify-send done" }
      });
      const doc = await f.hooksDoc();
      assert.equal(doc.hooks.Stop.length, 1);
      assert.deepEqual(doc.hooks.PreToolUse[0], { matcher: "Bash", hooks: [{ type: "command", command: "notify-send done" }] });
      const state = await keysOf(f);
      const sys = join(f.codexHome, "hooks.json");
      assert.deepEqual((await f.item(updated.itemIds[0])).warnings, []);
      assert.deepEqual(state[`${sys}:pre_tool_use:1:0`], before[`${sys}:pre_tool_use:0:0`], "managed PreToolUse moved to 1");
      assert.deepEqual(state[`${sys}:stop:0:0`], before[`${sys}:stop:1:0`]);
    });

    it("refuses to touch Orquester's managed hooks", async () => {
      const managed = (await f.adapter.snapshot()).items.filter((i) => i.kind === "hook" && i.locked);
      const before = await readFile(join(f.codexHome, "hooks.json"), "utf8");
      for (const item of managed) {
        await assert.rejects(f.adapter.setEnabled(item.id, item.revision, false), assertProfileError("ITEM_LOCKED", 403));
        await assert.rejects(f.adapter.remove(item.id, item.revision), assertProfileError("ITEM_LOCKED", 403));
        await assert.rejects(
          f.adapter.update(item.id, item.revision, { kind: "hook", hook: { event: "Stop", command: "x" } }),
          assertProfileError("ITEM_LOCKED", 403)
        );
      }
      assert.equal(await readFile(join(f.codexHome, "hooks.json"), "utf8"), before);
      await assert.rejects(
        f.adapter.create({ kind: "hook", hook: { event: "Nope", command: "x" } }, { onConflict: "fail" }),
        assertProfileError("INVALID_ITEM")
      );
    });

    it("keeps hooks.json and its links intact when writing through the account-home symlinks' target", async () => {
      await f.adapter.create({ kind: "hook", hook: { event: "SessionEnd", command: "bye" } }, { onConflict: "fail" });
      for (const account of f.accounts) {
        assert.equal(await readlink(join(account, "hooks.json")), join(f.codexHome, "hooks.json"));
        assert.equal(await readlink(join(account, "config.toml")), join(f.codexHome, "config.toml"));
      }
      assert.equal((await stat(join(f.codexHome, "config.toml"))).mode & 0o777, 0o600);
    });

    it("puts hooks.json back when the state write fails", async () => {
      await f.adapter.close();
      const racy = await makeFixture({
        wrap: (client) => ({
          call: async (method, params, options) => {
            if (method === "config/batchWrite") {
              await writeFile(join(racy.codexHome, "config.toml"), `${await racy.configText()}# edited meanwhile\n`);
            }
            return client.call(method, params, options);
          },
          close: () => client.close()
        })
      });
      try {
        const before = await readFile(join(racy.codexHome, "hooks.json"), "utf8");
        await assert.rejects(
          racy.adapter.create({ kind: "hook", hook: { event: "Stop", command: "x" } }, { onConflict: "fail" }),
          assertProfileError("PROFILE_CONFLICT", 409)
        );
        assert.equal(await readFile(join(racy.codexHome, "hooks.json"), "utf8"), before);
      } finally {
        await racy.adapter.close();
        await rm(racy.root, { recursive: true, force: true });
      }
    });

    it("warns about a hook an account home does not trust, and trust() writes it there", async () => {
      // An account added after the hook was trusted: its hooks.json link carries no trust entry yet.
      const late = join(f.appdir, "daemon", "agent-accounts", "codex", "a3", "home");
      await mkdir(late, { recursive: true });
      await symlink(join(f.codexHome, "config.toml"), join(late, "config.toml"));
      await symlink(join(f.codexHome, "hooks.json"), join(late, "hooks.json"));
      f.accounts.push(late);

      const item = (await f.adapter.snapshot()).items.find((i) => i.name === "notify-send done")!;
      assert.deepEqual(item.warnings.map((w) => [w.code, w.action]), [["hook-untrusted-elsewhere", "trust"]]);
      const managed = (await f.adapter.snapshot()).items.filter((i) => i.kind === "hook" && i.locked);
      assert.ok(managed.every((i) => i.warnings.length === 0), "Orquester's own hooks are trusted by its installer");

      await f.adapter.trust(item.id, item.revision);
      const state = (await f.config()).hooks.state;
      assert.equal(
        state[`${join(late, "hooks.json")}:stop:0:0`].trusted_hash,
        state[`${join(f.codexHome, "hooks.json")}:stop:0:0`].trusted_hash
      );
      assert.deepEqual((await f.item(item.id)).warnings, []);
    });

    it("keys an account home reached through a symlink by its realpath too, as Codex canonicalizes CODEX_HOME", async () => {
      const real = join(f.root, "elsewhere", "a4", "home");
      await mkdir(real, { recursive: true });
      await symlink(join(f.codexHome, "config.toml"), join(real, "config.toml"));
      await symlink(join(f.codexHome, "hooks.json"), join(real, "hooks.json"));
      const linked = join(f.appdir, "daemon", "agent-accounts", "codex", "a4");
      await mkdir(linked, { recursive: true });
      await symlink(real, join(linked, "home"));
      f.accounts.push(join(linked, "home"));
      // What a session of that account (CODEX_HOME=<linked>/home) keys its hooks by: the realpath.
      const canonical = join(await realpath(real), "hooks.json");
      const managedHash = (await keysOf(f))[`${join(f.codexHome, "hooks.json")}:stop:1:0`].trusted_hash;
      await writeFile(
        join(f.codexHome, "config.toml"),
        `${await f.configText()}\n[hooks.state."${canonical}:stop:1:0"]\nenabled = true\ntrusted_hash = "${managedHash}"\n`
      );

      const created = await f.adapter.create({ kind: "hook", hook: { event: "Stop", command: "say finished" } }, { onConflict: "fail" });
      const state = (await f.config()).hooks.state;
      assert.deepEqual(state[`${canonical}:stop:2:0`], { enabled: true, trusted_hash: managedHash }, "managed trust moved");
      assert.equal(state[`${canonical}:stop:1:0`].enabled, true);
      assert.deepEqual((await f.item(created.itemIds[0])).warnings, []);
    });

    it("refuses to overwrite a hooks.json rewritten while the mutation ran", async () => {
      await f.adapter.close();
      let armed = false;
      const racy = await makeFixture({
        onAccountHomes: async () => {
          if (!armed) return;
          const doc = JSON.parse(await readFile(join(racy.codexHome, "hooks.json"), "utf8"));
          doc.hooks.SessionEnd = [{ hooks: [{ type: "command", command: "added meanwhile" }] }];
          await writeFile(join(racy.codexHome, "hooks.json"), JSON.stringify(doc));
        }
      });
      try {
        const stateBefore = await racy.configText();
        armed = true;
        await assert.rejects(
          racy.adapter.create({ kind: "hook", hook: { event: "Stop", command: "x" } }, { onConflict: "fail" }),
          assertProfileError("PROFILE_CONFLICT", 409)
        );
        armed = false;
        const doc = await racy.hooksDoc();
        assert.equal(doc.hooks.SessionEnd[0].hooks[0].command, "added meanwhile", "the other writer's change survives");
        assert.equal(doc.hooks.Stop.length, 2);
        assert.equal(await racy.configText(), stateBefore);
      } finally {
        await racy.adapter.close();
        await rm(racy.root, { recursive: true, force: true });
      }
    });
  });

  it("replaces and terminates the app-server when the registry's codex binary moves", async () => {
    await f.adapter.close();
    let bin = "/old/bin/codex";
    const clients: CodexAppServerClient[] = [];
    const closing: Promise<void>[] = [];
    const adapter = new CodexProfileAdapter(
      {
        ...f.ctx,
        get bin() {
          return bin;
        }
      },
      {
        backups: new ProfileBackups({ dir: agentProfileBackupsDir(f.appdir) }),
        stash: new ProfileStash({ dir: agentProfileStashDir(f.appdir) }),
        configClient: (opts) => {
          const client = new CodexAppServerClient({
            ...opts,
            bin: process.execPath,
            args: [FAKE, "app-server"],
            killGraceMs: 200,
            extraEnv: { FAKE_CODEX_LOG: f.log }
          });
          clients.push(client);
          return {
            call: (method, params, options) => client.call(method, params, options),
            close: () => {
              const done = client.close();
              closing.push(done);
              return done;
            }
          };
        }
      }
    );
    try {
      await adapter.snapshot();
      const oldPid = (await f.requests()).at(-1)?.pid;
      assert.ok(oldPid !== undefined);
      bin = "/new/bin/codex";
      await adapter.snapshot();
      await Promise.all(closing);
      assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" }, "the previous app-server process exited");
      const newPid = (await f.requests()).at(-1)?.pid;
      assert.ok(newPid !== undefined);
      assert.doesNotThrow(() => process.kill(newPid, 0), "the replacement app-server is running");
    } finally {
      await adapter.close();
      await Promise.all(clients.map((client) => client.close()));
    }
  });

  describe("plugins and marketplaces", () => {
    it("toggles, uninstalls and installs a plugin through the app-server", async () => {
      let hello = await f.item("plugin:hello@test-mkt");
      await f.adapter.setEnabled(hello.id, hello.revision, false);
      assert.deepEqual((await f.config()).plugins["hello@test-mkt"], { enabled: false });
      hello = await f.item("plugin:hello@test-mkt");
      assert.equal(hello.enabled, false);

      const detail = await f.adapter.readItem(hello.id);
      assert.equal(detail.kind, "plugin");

      await f.adapter.remove(hello.id, hello.revision);
      assert.equal((await f.config()).plugins["hello@test-mkt"], undefined);
      await assert.rejects(stat(join(f.codexHome, "plugins", "cache", "test-mkt", "hello")));

      const installed = await f.adapter.create(
        { kind: "plugin", plugin: { plugin: "other", marketplace: "test-mkt" } },
        { onConflict: "fail" }
      );
      assert.deepEqual(installed.itemIds, ["plugin:other@test-mkt"]);
      const other = await f.item("plugin:other@test-mkt");
      assert.deepEqual(other.warnings, []);
      const install = (await f.requests()).find((r) => r.method === "plugin/install")!;
      assert.deepEqual(install.params, {
        pluginName: "other",
        marketplacePath: join(f.mkt, ".agents", "plugins", "marketplace.json")
      });
      await assert.rejects(
        f.adapter.create({ kind: "plugin", plugin: { spec: "npm-thing" } }, { onConflict: "fail" }),
        assertProfileError("INVALID_ITEM")
      );
    });

    it("lists a marketplace's plugins, removes and adds a marketplace", async () => {
      const plugins = await f.adapter.listMarketplacePlugins("test-mkt");
      assert.deepEqual(
        plugins.map((p) => [p.name, p.installed]),
        [["hello", true], ["other", false]]
      );
      const marketplace = await f.item("marketplace:test-mkt");
      const detail = await f.adapter.readItem(marketplace.id);
      assert.deepEqual(detail.kind === "marketplace" && detail.marketplace.source, { type: "path", path: f.mkt });
      await f.adapter.remove(marketplace.id, marketplace.revision);
      assert.equal((await f.config()).marketplaces?.["test-mkt"], undefined);
      const added = await f.adapter.create(
        { kind: "marketplace", marketplace: { source: { type: "path", path: f.mkt } } },
        { onConflict: "fail" }
      );
      assert.deepEqual(added.itemIds, ["marketplace:test-mkt"]);
      assert.deepEqual((await f.requests()).find((r) => r.method === "marketplace/add")!.params, { source: f.mkt });
    });
  });

  describe("commands and instructions", () => {
    it("deletes a legacy prompt and refuses to create one", async () => {
      const prompt = await f.item("command:old");
      await assert.rejects(
        f.adapter.update(prompt.id, prompt.revision, { kind: "command", document: { name: "old", frontmatter: {}, body: "" } }),
        assertProfileError("NOT_EDITABLE", 403)
      );
      await assert.rejects(f.adapter.setEnabled(prompt.id, prompt.revision, true), assertProfileError("NOT_TOGGLEABLE", 403));
      const detail = await f.adapter.readItem(prompt.id);
      assert.deepEqual(detail.kind === "command" && detail.document, { frontmatter: { description: "An old prompt" }, body: "Do it.\n" });
      const portable = await f.adapter.exportItem(prompt.id);
      assert.equal(portable.kind, "command");
      await f.adapter.remove(prompt.id, prompt.revision);
      await assert.rejects(stat(join(f.codexHome, "prompts", "old.md")));
      await assert.rejects(
        f.adapter.create({ kind: "command", document: { name: "x", frontmatter: {}, body: "" } }, { onConflict: "fail" }),
        assertProfileError("INVALID_ITEM")
      );
    });

    it("reads and writes AGENTS.md against its revision", async () => {
      const { text, info } = await f.adapter.readInstructions();
      assert.equal(text, "# Global\nBe brief.\n");
      await assert.rejects(f.adapter.writeInstructions("x", "stale"), assertProfileError("PROFILE_CONFLICT", 409));
      await f.adapter.writeInstructions("# Global\nBe briefer.\n", info.revision);
      assert.equal(await readFile(join(f.codexHome, "AGENTS.md"), "utf8"), "# Global\nBe briefer.\n");

      await rm(join(f.codexHome, "AGENTS.md"));
      await rm(join(f.codexHome, "AGENTS.override.md"));
      const empty = await f.adapter.readInstructions();
      assert.deepEqual([empty.info.exists, empty.info.revision, empty.info.warnings], [false, "", []]);
      await f.adapter.writeInstructions("new\n", "");
      assert.equal(await readFile(join(f.codexHome, "AGENTS.md"), "utf8"), "new\n");
    });
  });
});
