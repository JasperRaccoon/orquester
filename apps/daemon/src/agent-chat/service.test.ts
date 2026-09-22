import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import type { RegistryEntry } from "@orquester/api";
import { agentHostSocketPath, agentHostTokenPath } from "@orquester/config";
import type { CreateHostThreadRequest } from "../agent-host/host-protocol.ts";
import { AgentChatService, isUsableConversationId, resolveHomeKind } from "./service.ts";
import { ChatSessionError } from "./chat-sessions.ts";

// §6.1 thread creation: the tab record first, then the host thread, and the
// launch environment a chat thread gets must be EXACTLY what a terminal launch
// of the same registry entry gets today (§3.1 "Launch environment").

interface Fixture {
  service: AgentChatService;
  created: CreateHostThreadRequest[];
  /** Set to make the fake host refuse the thread. */
  refuse: { status: number; body: unknown } | null;
  appdir: string;
  /** Every path the service asked to confine before granting trust. */
  trustQueries: string[];
  cleanup(): Promise<void>;
}

const CLAUDEX: RegistryEntry = {
  id: "claudex",
  name: "Claude (proxy)",
  kind: "agent",
  bin: ["claude"],
  resolvedBin: "/usr/bin/claude",
  enabled: true,
  installState: "idle",
  // What RegistryService materialises: the static entry env merged with
  // `<appdir>/daemon/env/claudex.env`.
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ORQ_FROM_ENV_FILE: "1" },
  chat: { adapter: "claude" }
};

const OPENCODE: RegistryEntry = {
  id: "opencode",
  name: "OpenCode",
  kind: "agent",
  bin: ["opencode"],
  resolvedBin: "/usr/bin/opencode",
  enabled: true,
  installState: "idle",
  // The per-launcher env file `<appdir>/daemon/env/opencode.env`, already
  // merged by RegistryService — it must reach the host or
  // `OPENCODE_CONFIG_CONTENT` silently falls back to "{}".
  env: { OPENCODE_CONFIG_CONTENT: '{"provider":{}}' },
  chat: { adapter: "opencode" }
};

async function makeFixture(
  entry: RegistryEntry,
  launch: { env: Record<string, string>; unset?: string[]; accountId?: string } | null
): Promise<Fixture> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-chat-service-"));
  // The REAL paths, so boot adoption probes the fake host rather than deciding
  // nothing is listening and spawning one. No host process is ever started
  // here: `spawnDirect` is stubbed below as a second guard.
  const socketPath = agentHostSocketPath(appdir, "linux");
  await mkdir(join(appdir, "daemon"), { recursive: true });
  await writeFile(agentHostTokenPath(appdir), "test-token\n", { mode: 0o600 });
  const state: Fixture = {
    created: [],
    refuse: null,
    appdir,
    trustQueries: [],
    service: null as unknown as AgentChatService,
    cleanup: async () => {
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await rm(appdir, { recursive: true, force: true });
    }
  };
  const host = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            protocolVersion: 1,
            hostInstanceId: "host-1",
            liveThreadIds: [],
            activeTurnThreadIds: [],
            pid: 111,
            startedAt: "2026-09-21T00:00:00.000Z"
          })
        );
        return;
      }
      if (req.url === "/threads" && req.method === "POST") {
        state.created.push(JSON.parse(body) as CreateHostThreadRequest);
        if (state.refuse) {
          res
            .writeHead(state.refuse.status, { "content-type": "application/json" })
            .end(JSON.stringify(state.refuse.body));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => host.listen(socketPath, resolve));

  state.service = new AgentChatService({
    baseDir: appdir,
    daemonDir: join(appdir, "daemon"),
    platform: "linux",
    cwd: appdir,
    sessionPath: "/usr/bin",
    env: {},
    tmux: null,
    broadcaster: { publish: () => undefined },
    push: { notifyStructural: async () => undefined },
    registryEntry: (refId) => (refId === entry.id ? entry : undefined),
    resolveLaunchEnv: async () => launch,
    systemClaudeConfigFile: () => join(appdir, ".claude.json"),
    // The real confinement lives in `index.ts` (realpath + assertInsideFsRoot);
    // here the sandbox is `<appdir>/ws`, so a path outside it answers null.
    resolveTrustedProjectDir: async (projectPath) => {
      state.trustQueries.push(projectPath);
      const root = join(appdir, "ws");
      const resolvedPath = resolve(projectPath);
      return resolvedPath === root || resolvedPath.startsWith(root + sep) ? resolvedPath : null;
    },
    sendAttachment: async (reply) => reply,
    nodeBin: "/usr/bin/node",
    sleep: async () => undefined,
    // A test must never start an agent host process.
    spawnDirect: () => {
      throw new Error("the fixture must adopt the fake host, never spawn one");
    }
  });
  await state.service.supervisor.init();
  assert.equal(state.service.supervisor.isHealthy(), true, "the fake host was adopted");
  return state;
}

test("the launch env is the registry entry's env UNDER the resolveExtraEnv contributors", async () => {
  const f = await makeFixture(CLAUDEX, {
    // The cliproxy contributor, exactly as it runs for a terminal today.
    env: {
      CLAUDE_CONFIG_DIR: "/var/lib/orquester/daemon/cliproxy/claude-home-claudex",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_MODEL: "claude-sonnet",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "150000"
    },
    unset: ["ANTHROPIC_API_KEY"]
  });
  await f.service.createSession(
    { kind: "agent-chat", refId: "claudex", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  assert.equal(f.created.length, 1);
  const body = f.created[0];
  assert.equal(body.launchEnv?.ORQ_FROM_ENV_FILE, "1", "the per-launcher env file reaches the host");
  assert.equal(body.launchEnv?.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(body.launchEnv?.ANTHROPIC_MODEL, "claude-sonnet");
  assert.equal(body.launchEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "150000");
  assert.equal(
    body.launchEnv?.ANTHROPIC_BASE_URL,
    "http://127.0.0.1:9999",
    "the contributor wins a collision with the entry env, as the terminal wrapper does"
  );
  assert.deepEqual(body.unsetEnv, ["ANTHROPIC_API_KEY"]);
  assert.equal(body.home, "cliproxy");
  assert.equal(body.proxyRefId, "claudex");
  assert.equal(body.homePath, "/var/lib/orquester/daemon/cliproxy/claude-home-claudex");
  await f.cleanup();
});

test("an OpenCode thread carries its per-launcher env file and the PROJECT ROOT", async () => {
  const f = await makeFixture(OPENCODE, null);
  await f.service.createSession(
    { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  const body = f.created[0];
  assert.equal(body.launchEnv?.OPENCODE_CONFIG_CONTENT, '{"provider":{}}');
  assert.equal(body.projectPath, "/w/p", "the server pool keys on the project root");
  assert.equal(body.cwd, "/w/p");
  assert.equal(body.home, "system");
  assert.equal(body.homePath, undefined);
  await f.cleanup();
});

test("a managed account binds its home through the adapter's own variable", async () => {
  const f = await makeFixture(
    { ...CLAUDEX, id: "claude", name: "Claude Code" },
    { env: { CLAUDE_CONFIG_DIR: "/appdir/agent-accounts/claude/acc-1/home" }, accountId: "acc-1" }
  );
  await f.service.createSession(
    { kind: "agent-chat", refId: "claude", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  const body = f.created[0];
  assert.equal(body.home, "account");
  assert.equal(body.accountId, "acc-1");
  assert.equal(body.homePath, "/appdir/agent-accounts/claude/acc-1/home");
  await f.cleanup();
});

test("the project is marked trusted for the home the thread will run under", async () => {
  // A never-seen directory starts untrusted and the project's settings, hooks
  // and skills are then silently ignored, with nothing on the wire to say so.
  const dir = await mkdtemp(join(tmpdir(), "orq-claude-home-"));
  const f = await makeFixture(
    { ...CLAUDEX, id: "claude", name: "Claude Code" },
    { env: { CLAUDE_CONFIG_DIR: dir }, accountId: "acc-1" }
  );
  const projectPath = join(f.appdir, "ws", "proj");
  await f.service.createSession(
    { kind: "agent-chat", refId: "claude", projectPath, cwd: projectPath },
    0
  );
  const config = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
  assert.equal(
    (config.projects as Record<string, Record<string, unknown>>)[projectPath].hasTrustDialogAccepted,
    true
  );
  await rm(dir, { recursive: true, force: true });
  await f.cleanup();
});

test("trust is granted for the validated projectPath, NEVER the request's cwd", async () => {
  // Claude's trust dialog is a security control: an untrusted directory's hooks
  // (arbitrary shell as the daemon user, which holds scoped passwordless sudo)
  // are ignored until it is accepted. A client naming any `cwd` on the box must
  // not be able to enable them — host-wide and permanently, since a system-home
  // grant also applies to every future terminal `claude` tab on that path.
  const dir = await mkdtemp(join(tmpdir(), "orq-claude-home-"));
  const f = await makeFixture(
    { ...CLAUDEX, id: "claude", name: "Claude Code" },
    { env: { CLAUDE_CONFIG_DIR: dir }, accountId: "acc-1" }
  );
  const projectPath = join(f.appdir, "ws", "proj");
  await f.service.createSession(
    { kind: "agent-chat", refId: "claude", projectPath, cwd: "/some/other/repo" },
    0
  );
  const config = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
  const projects = config.projects as Record<string, unknown>;
  assert.deepEqual(Object.keys(projects), [projectPath]);
  assert.equal(projects["/some/other/repo"], undefined, "an arbitrary cwd is never trusted");
  assert.deepEqual(f.trustQueries, [projectPath], "only the project path is ever confined");
  await rm(dir, { recursive: true, force: true });
  await f.cleanup();
});

test("a projectPath outside the sandbox grants NO trust, and the launch still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-claude-home-"));
  const f = await makeFixture(
    { ...CLAUDEX, id: "claude", name: "Claude Code" },
    { env: { CLAUDE_CONFIG_DIR: dir }, accountId: "acc-1" }
  );
  await f.service.createSession(
    { kind: "agent-chat", refId: "claude", projectPath: "/etc", cwd: "/etc" },
    0
  );
  await assert.rejects(() => readFile(join(dir, ".claude.json"), "utf8"), /ENOENT/);
  assert.equal(f.created.length, 1, "home prep never blocks a launch");
  await rm(dir, { recursive: true, force: true });
  await f.cleanup();
});

test("a Grok thread no longer touches any home config file", async () => {
  // Regression: the daemon used to write `[features] support_permission` and
  // `auto_update` into `<grokHome>/config.toml`, which on a managed account
  // home is a SYMLINK to the daemon user's own `~/.grok/config.toml`.
  const grokHome = await mkdtemp(join(tmpdir(), "orq-grok-home-"));
  const shared = join(grokHome, "shared.toml");
  const link = join(grokHome, "config.toml");
  await writeFile(shared, "[compat.claude]\nhooks = false\n", "utf8");
  await symlink(shared, link);
  const f = await makeFixture(
    { ...OPENCODE, id: "grok", name: "Grok", env: {}, chat: { adapter: "grok" } },
    { env: { GROK_HOME: grokHome }, accountId: "acc-1" }
  );
  const projectPath = join(f.appdir, "ws", "proj");
  await f.service.createSession(
    { kind: "agent-chat", refId: "grok", projectPath, cwd: projectPath },
    0
  );
  assert.equal(
    await readFile(shared, "utf8"),
    "[compat.claude]\nhooks = false\n",
    "the user's shared grok config is byte-identical"
  );
  assert.deepEqual(f.trustQueries, [], "no trust confinement is even attempted for grok");
  assert.equal(f.created.length, 1);
  await rm(grokHome, { recursive: true, force: true });
  await f.cleanup();
});

test("the tab record is written FIRST and rolled back when the host refuses", async () => {
  const f = await makeFixture(OPENCODE, null);
  f.refuse = {
    status: 400,
    body: { error: { code: "RESUME_UNAVAILABLE", message: "no resume path for that home" } }
  };
  await assert.rejects(
    () =>
      f.service.createSession(
        { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p" },
        0
      ),
    (error: unknown) => error instanceof ChatSessionError && error.code === "RESUME_UNAVAILABLE"
  );
  assert.equal(f.created.length, 1, "the host was asked");
  assert.deepEqual(f.service.chat.list(), [], "a tab pointing at no thread is worse than none");
  await f.cleanup();
});

test("an agent row with no chat adapter cannot open a chat tab", async () => {
  const f = await makeFixture({ ...OPENCODE, chat: undefined }, null);
  await assert.rejects(
    () =>
      f.service.createSession(
        { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p" },
        0
      ),
    /no chat adapter/
  );
  assert.equal(f.created.length, 0);
  await f.cleanup();
});

test("a resume id the adapter cannot use is refused at creation, never degraded", async () => {
  const f = await makeFixture(OPENCODE, null);
  for (const conversationId of ["../escape", "-rf", "", "a/../b"]) {
    await assert.rejects(
      () =>
        f.service.createSession(
          {
            kind: "agent-chat",
            refId: "opencode",
            projectPath: "/w/p",
            cwd: "/w/p",
            resume: { home: "system", conversationId }
          },
          0
        ),
      (error: unknown) => error instanceof ChatSessionError && error.code === "RESUME_UNAVAILABLE",
      conversationId
    );
  }
  assert.equal(f.created.length, 0, "an unusable resume never reaches the host");
  await f.cleanup();
});

test("§6.1's fields ride the nested `chat` block the client sends", async () => {
  const f = await makeFixture(OPENCODE, null);
  await f.service.createSession(
    {
      kind: "agent-chat",
      refId: "opencode",
      projectPath: "/w/p",
      cwd: "/w/p",
      chat: {
        // An empty `model` means "the provider's own default" — the launcher
        // had no catalog to pick from. It is never a refusal.
        modelSelection: { model: "" },
        runtimeMode: "auto-accept-edits",
        resume: { home: "cliproxy", conversationId: "0199-abc" }
      }
    },
    0
  );
  const body = f.created[0];
  assert.deepEqual(body.modelSelection, { model: "" });
  assert.equal(body.runtimeMode, "auto-accept-edits");
  assert.deepEqual(body.resume, { home: "cliproxy", conversationId: "0199-abc" });
  await f.cleanup();
});

test("a bad resume in the nested block is refused just as the flat one is", async () => {
  const f = await makeFixture(OPENCODE, null);
  await assert.rejects(
    () =>
      f.service.createSession(
        {
          kind: "agent-chat",
          refId: "opencode",
          projectPath: "/w/p",
          cwd: "/w/p",
          chat: { modelSelection: { model: "" }, resume: { home: "system", conversationId: "../x" } }
        },
        0
      ),
    (error: unknown) => error instanceof ChatSessionError && error.code === "RESUME_UNAVAILABLE"
  );
  assert.equal(f.created.length, 0);
  await f.cleanup();
});

test("resolveHomeKind and the conversation-id shape check", () => {
  assert.equal(resolveHomeKind("claudex", ""), "cliproxy");
  assert.equal(resolveHomeKind("claudemix", "acc-1"), "cliproxy");
  assert.equal(resolveHomeKind("claude", "acc-1"), "account");
  assert.equal(resolveHomeKind("claude", ""), "system");
  assert.equal(isUsableConversationId("0199-abc.def"), true);
  assert.equal(isUsableConversationId("a/b/c"), true);
  assert.equal(isUsableConversationId("-flag"), false, "an id must never arrive as a flag");
  assert.equal(isUsableConversationId("a/../b"), false);
  assert.equal(isUsableConversationId(42), false);
  assert.equal(isUsableConversationId(""), false);
});
