import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CodexRpcError } from "../../../agent-host/adapters/codex/protocol.ts";
import { AgentProfileError } from "../../errors.ts";
import { CodexAppServerClient, configWriteErrorCode, keyPath, toProfileError } from "./codex-config-client.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-app-server.mjs", import.meta.url));

describe("CodexAppServerClient", () => {
  let dir: string;
  let codexHome: string;
  let log: string;
  const clients: CodexAppServerClient[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-config-client-"));
    codexHome = join(dir, "codex");
    log = join(dir, "requests.ndjson");
    await import("node:fs/promises").then((fs) => fs.mkdir(codexHome, { recursive: true }));
    await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  });

  after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await rm(dir, { recursive: true, force: true });
  });

  function client(extra: Partial<ConstructorParameters<typeof CodexAppServerClient>[0]> = {}) {
    const created = new CodexAppServerClient({
      bin: process.execPath,
      args: [FAKE, "app-server"],
      codexHome,
      home: dir,
      idleMs: 30_000,
      callTimeoutMs: 10_000,
      killGraceMs: 200,
      extraEnv: { FAKE_CODEX_LOG: log },
      ...extra
    });
    clients.push(created);
    return created;
  }

  async function requests(): Promise<Array<{ method: string; params: unknown }>> {
    const text = await readFile(log, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: unknown });
  }

  it("spawns on demand with CODEX_HOME, handshakes once and reuses the child", async () => {
    const c = client();
    assert.equal(c.isRunning, false);
    const read = await c.call("config/read", { includeLayers: true });
    assert.equal(read.layers?.[0].name.type, "user");
    assert.equal(read.layers?.[0].name.file, join(codexHome, "config.toml"));
    const pid = c.pid;
    await c.call("config/read", {});
    assert.equal(c.pid, pid, "the same app-server serves both calls");
    const methods = (await requests()).map((r) => r.method);
    assert.equal(methods.filter((m) => m === "initialize").length, 1);
    await c.close();
    assert.equal(c.isRunning, false);
  });

  it("closes after the idle window and respawns on the next call", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const c = client();
    await c.call("config/read", {});
    const pid = c.pid;
    t.mock.timers.tick(29_999);
    assert.equal(c.isRunning, true, "still inside the idle window");
    t.mock.timers.tick(1);
    assert.equal(c.isRunning, false, "closed once idle for the whole window");
    await c.call("config/read", {});
    assert.equal(c.isRunning, true);
    assert.notEqual(c.pid, pid);
    await c.close();
  });

  it("does not close for idleness while a call is pending", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const c = client({ extraEnv: { FAKE_CODEX_LOG: log, FAKE_CODEX_HANG: "hooks/list" } });
    const pending = c.call("hooks/list", { cwds: [dir] }, { timeoutMs: 60_000 }).catch((error: unknown) => error);
    await c.call("config/read", {});
    t.mock.timers.tick(30_000);
    assert.equal(c.isRunning, true, "hooks/list is still pending, so the idle window never opened");
    t.mock.timers.tick(30_000);
    assert.ok((await pending) instanceof AgentProfileError);
    await c.close();
  });

  it("fails a call that misses its deadline with AGENT_CLI_FAILED and kills the child", async (t) => {
    {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const c = client({ extraEnv: { FAKE_CODEX_LOG: log, FAKE_CODEX_HANG: "hooks/list" } });
      await c.call("config/read", {});
      const hung = c.call("hooks/list", {});
      t.mock.timers.tick(9_999);
      assert.equal(c.isRunning, true, "inside the call's deadline");
      t.mock.timers.tick(1);
      await assert.rejects(hung, (error: unknown) => {
        assert.ok(error instanceof AgentProfileError);
        assert.equal(error.code, "AGENT_CLI_FAILED");
        assert.match(error.message, /hooks\/list.*timed out after 10 s/);
        return true;
      });
      assert.equal(c.isRunning, false, "the wedged child is gone");
      assert.deepEqual((await c.call("config/read", {})).layers?.[0].name.type, "user", "the next call starts afresh");
      await c.close();
    }
  });

  it("hands an answered error back as CodexRpcError, mapped by toProfileError", async () => {
    const c = client();
    const error = await c
      .call("config/batchWrite", {
        edits: [{ keyPath: "model", value: "x", mergeStrategy: "replace" }],
        expectedVersion: "sha256:stale"
      })
      .catch((e: unknown) => e);
    assert.ok(error instanceof CodexRpcError);
    assert.equal(configWriteErrorCode(error), "configVersionConflict");
    const mapped = toProfileError("config/batchWrite", error);
    assert.ok(mapped instanceof AgentProfileError);
    assert.equal(mapped.status, 409);
    assert.equal(mapped.code, "PROFILE_CONFLICT");

    const invalid = await c
      .call("config/batchWrite", {
        edits: [{ keyPath: "mcp_servers.x", value: { url: "https://x.invalid", command: "y" }, mergeStrategy: "replace" }]
      })
      .catch((e: unknown) => toProfileError("config/batchWrite", e));
    assert.ok(invalid instanceof AgentProfileError);
    assert.equal(invalid.code, "INVALID_ITEM");
  });

  it("reports a binary that does not start as AGENT_CLI_FAILED", async () => {
    const c = client({ bin: join(dir, "no-such-codex"), args: ["app-server"] });
    await assert.rejects(c.call("config/read", {}), (error: unknown) => {
      assert.ok(error instanceof AgentProfileError);
      assert.equal(error.code, "AGENT_CLI_FAILED");
      return true;
    });
    assert.equal(c.isRunning, false);
  });

  it("quotes key path segments the way the config API reads them", () => {
    assert.equal(keyPath("mcp_servers", "jira-cloud"), "mcp_servers.jira-cloud");
    assert.equal(keyPath("plugins", "superpowers@openai-curated", "enabled"), 'plugins."superpowers@openai-curated".enabled');
    assert.equal(
      keyPath("hooks", "state", "/h/.codex/hooks.json:stop:0:0"),
      'hooks.state."/h/.codex/hooks.json:stop:0:0"'
    );
    assert.equal(keyPath("a", 'q"b\\'), 'a."q\\"b\\\\"');
  });
});
