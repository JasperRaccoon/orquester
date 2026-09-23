import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AgentAccount, RegistryEntry } from "@orquester/api";
import {
  agentHostSocketPath,
  agentHostTokenPath,
  createDefaultClientConfig,
  createDefaultDaemonConfig
} from "@orquester/config";
import { Broadcaster } from "../broadcaster.ts";
import { createServer as createDaemonApp } from "../index.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";
import type {
  CreateHostThreadRequest,
  SetThreadIdentityRequest
} from "../agent-host/host-protocol.ts";
import {
  AgentChatService,
  countingLimit,
  isUsableConversationId,
  proxyAccountFamily,
  PROVIDER_REFRESH_DEBOUNCE_MS,
  resolveHomeKind
} from "./service.ts";
import { ChatSessionError } from "./chat-sessions.ts";
import { HostUnavailableError } from "./host-client.ts";
import { UploadTooLargeError } from "../upload-stream.ts";

// §6.1 thread creation: the tab record first, then the host thread, and the
// launch environment a chat thread gets must be EXACTLY what a terminal launch
// of the same registry entry gets today (§3.1 "Launch environment").

interface Fixture {
  service: AgentChatService;
  created: CreateHostThreadRequest[];
  /** §3.4 account switches that reached the fake host, in order. */
  identities: Array<{ threadId: string; body: SetThreadIdentityRequest }>;
  /** Set to make the fake host refuse the thread. */
  refuse: { status: number; body: unknown } | null;
  /** Set to make the fake host refuse `POST /threads/:id/identity`. */
  refuseIdentity: { status: number; body: unknown } | null;
  appdir: string;
  /** Every path the service asked to confine before granting trust. */
  trustQueries: string[];
  /** Overridable per-account launch env, so a switch can be observed. */
  launchFor: (ctx: { accountId?: string; model?: string }) => {
    env: Record<string, string>;
    unset?: string[];
    accountId?: string;
  } | null;
  /** What `listManagedAccounts` answers — the family gate reads it. */
  accounts: AgentAccount[];
  /** What the injected seeded-account gate answers. */
  seededRefusal: { code: string; message: string } | null;
  /** Adapter ids the daemon asked the host to re-probe, in order. */
  refreshes: string[];
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
  launch: { env: Record<string, string>; unset?: string[]; accountId?: string } | null,
  options: { now?: () => number; adopt?: boolean; uploadLimitBytes?: number } = {}
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
    identities: [],
    refuse: null,
    refuseIdentity: null,
    appdir,
    trustQueries: [],
    launchFor: () => launch,
    accounts: [],
    seededRefusal: null,
    refreshes: [],
    service: null as unknown as AgentChatService,
    cleanup: async () => {
      // An upload a test left open would otherwise hold `close` forever.
      host.closeAllConnections();
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
      const refresh = /^\/providers\/([^/]+)\/refresh$/.exec(req.url ?? "");
      if (refresh && req.method === "POST") {
        state.refreshes.push(decodeURIComponent(refresh[1] ?? ""));
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ changed: true }));
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
      const identity = /^\/threads\/([^/]+)\/identity$/.exec(req.url ?? "");
      if (identity && req.method === "POST") {
        state.identities.push({
          threadId: identity[1]!,
          body: JSON.parse(body) as SetThreadIdentityRequest
        });
        if (state.refuseIdentity) {
          res
            .writeHead(state.refuseIdentity.status, { "content-type": "application/json" })
            .end(JSON.stringify(state.refuseIdentity.body));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seq: 42 }));
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
    resolveLaunchEnv: async (_entry, ctx) => state.launchFor(ctx),
    listManagedAccounts: () => ({ accounts: state.accounts }),
    seededAccountRefusal: () => state.seededRefusal,
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
    ...(options.now ? { now: options.now } : {}),
    ...(options.uploadLimitBytes !== undefined ? { uploadLimitBytes: options.uploadLimitBytes } : {}),
    sleep: async () => undefined,
    // A test must never start an agent host process.
    spawnDirect: () => {
      throw new Error("the fixture must adopt the fake host, never spawn one");
    }
  });
  // `adopt: false` is a daemon that has not found its host yet: no token, so
  // every host call is refused before anything is sent.
  if (options.adopt === false) return state;
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

// --- §3.4 switching an existing thread's account ---------------------------

const CLAUDE: RegistryEntry = { ...CLAUDEX, id: "claude", name: "Claude Code" };

/** A `claude` chat tab on `acc-1`, plus a second account it can move to. */
async function switchableFixture(): Promise<Fixture & { sessionId: string }> {
  const f = await makeFixture(CLAUDE, {
    env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" },
    accountId: "acc-1"
  });
  f.launchFor = (ctx) =>
    ctx.accountId === undefined || ctx.accountId === "system"
      ? null
      : { env: { CLAUDE_CONFIG_DIR: `/homes/${ctx.accountId}` }, accountId: ctx.accountId };
  f.accounts = [
    { id: "acc-1", agent: "claude", label: "one" } as AgentAccount,
    { id: "acc-2", agent: "claude", label: "two" } as AgentAccount,
    { id: "cod-1", agent: "codex", label: "codex one" } as AgentAccount
  ];
  const summary = await f.service.createSession(
    { kind: "agent-chat", refId: "claude", accountId: "acc-1", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  assert.equal(summary.accountId, "acc-1");
  return Object.assign(f, { sessionId: summary.id });
}

test("a switch recomputes the launch env, calls the host, THEN moves the tab record", async () => {
  const f = await switchableFixture();
  const before = f.service.chat.get(f.sessionId)?.accountId;
  assert.equal(before, "acc-1");

  const receipt = await f.service.switchAccount(f.sessionId, {
    commandId: "c1",
    accountId: "acc-2"
  });
  assert.deepEqual(receipt, { seq: 42 });
  assert.equal(f.identities.length, 1);
  const body = f.identities[0]!.body;
  assert.equal(f.identities[0]!.threadId, f.sessionId);
  assert.equal(body.commandId, "c1");
  assert.equal(body.accountId, "acc-2");
  assert.equal(body.home, "account");
  assert.equal(body.homePath, "/homes/acc-2", "the adapter's own home variable decides");
  assert.equal(
    body.launchEnv?.ORQ_FROM_ENV_FILE,
    "1",
    "the per-launcher env file is recomposed too, exactly as at create"
  );
  assert.equal(f.service.chat.get(f.sessionId)?.accountId, "acc-2");
  await f.cleanup();
});

test("switching to System clears the account and never falls back to the family default", async () => {
  const f = await switchableFixture();
  await f.service.switchAccount(f.sessionId, { commandId: "c1", accountId: "system" });
  const body = f.identities[0]!.body;
  assert.equal(body.accountId, "");
  assert.equal(body.home, "system");
  assert.equal(body.homePath, undefined);
  assert.equal(f.service.chat.get(f.sessionId)?.accountId, undefined);
  await f.cleanup();
});

test("an account of another family is refused rather than silently degraded to System", async () => {
  // `AgentAccountsService.resolveLaunchEnv` answers null for a wrong-family id,
  // which would launch the SYSTEM identity while the tab claimed the account.
  const f = await switchableFixture();
  await assert.rejects(
    () => f.service.switchAccount(f.sessionId, { commandId: "c1", accountId: "cod-1" }),
    (error: unknown) => error instanceof ChatSessionError && error.code === "INVALID_COMMAND"
  );
  assert.equal(f.identities.length, 0, "nothing reached the host");
  assert.equal(f.service.chat.get(f.sessionId)?.accountId, "acc-1");
  await f.cleanup();
});

test("the seeded-account gate applies to a switch exactly as it does to a create", async () => {
  const f = await switchableFixture();
  f.seededRefusal = { code: "SESSION_UNAVAILABLE", message: "This account is not seeded." };
  await assert.rejects(
    () => f.service.switchAccount(f.sessionId, { commandId: "c1", accountId: "acc-2" }),
    (error: unknown) =>
      error instanceof ChatSessionError && /not seeded/.test(error.message)
  );
  assert.equal(f.identities.length, 0);
  await f.cleanup();
});

test("an OpenCode thread cannot switch accounts", async () => {
  const f = await makeFixture(OPENCODE, null);
  const summary = await f.service.createSession(
    { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  await assert.rejects(
    () => f.service.switchAccount(summary.id, { commandId: "c1", accountId: "acc-2" }),
    (error: unknown) => error instanceof ChatSessionError && error.code === "INVALID_COMMAND"
  );
  assert.equal(f.identities.length, 0);
  await f.cleanup();
});

test("a host refusal leaves the tab record exactly as it was", async () => {
  const f = await switchableFixture();
  f.refuseIdentity = {
    status: 409,
    body: { error: { code: "COMMAND_REJECTED", message: "Wait for the turn to finish." } }
  };
  await assert.rejects(
    () => f.service.switchAccount(f.sessionId, { commandId: "c1", accountId: "acc-2" }),
    (error: unknown) => error instanceof ChatSessionError && error.code === "COMMAND_REJECTED"
  );
  assert.equal(f.service.chat.get(f.sessionId)?.accountId, "acc-1");
  await f.cleanup();
});

test("an older host with no identity route reads as HOST_UNAVAILABLE, not a refusal", async () => {
  // A host that survived a deploy runs the code it started from (§8): it 404s
  // this route until the drain-restart replaces it, and that is a retry.
  const f = await switchableFixture();
  f.refuseIdentity = { status: 404, body: {} };
  await assert.rejects(
    () => f.service.switchAccount(f.sessionId, { commandId: "c1", accountId: "acc-2" }),
    (error: unknown) => error instanceof ChatSessionError && error.code === "HOST_UNAVAILABLE"
  );
  assert.equal(f.service.chat.get(f.sessionId)?.accountId, "acc-1");
  await f.cleanup();
});

test("a switch on an unknown tab is THREAD_NOT_FOUND and a blank commandId is invalid", async () => {
  const f = await switchableFixture();
  await assert.rejects(
    () => f.service.switchAccount("nope", { commandId: "c1", accountId: "acc-2" }),
    (error: unknown) => error instanceof ChatSessionError && error.code === "THREAD_NOT_FOUND"
  );
  await assert.rejects(
    () => f.service.switchAccount(f.sessionId, { commandId: "  ", accountId: "acc-2" }),
    (error: unknown) => error instanceof ChatSessionError && error.code === "INVALID_COMMAND"
  );
  await assert.rejects(
    () => f.service.switchAccount(f.sessionId, { commandId: "c1", accountId: "" }),
    (error: unknown) => error instanceof ChatSessionError && error.code === "INVALID_COMMAND"
  );
  assert.equal(f.identities.length, 0);
  await f.cleanup();
});

test("the proxy launchers draw their accounts from the mapped family", () => {
  assert.equal(proxyAccountFamily("claudex"), "codex");
  assert.equal(proxyAccountFamily("claudemix"), "claude");
  assert.equal(proxyAccountFamily("claude"), null);
});

// §3.2 — the daemon is the one process that knows an install just happened.
//
// The incident: `claude` was updated from Settings → Agents (2.1.278 → 2.1.280,
// which resolves the `opus` alias to a different model) and a chat opened
// afterwards still offered the old alias, because the host's snapshot was the
// one probed under the old binary and nothing told it the CLI had changed.

test("an install/update asks the host to re-probe the provider that entry maps to", async () => {
  let nowMs = 1_000_000;
  const f = await makeFixture(CLAUDEX, null, { now: () => nowMs });

  // A first sighting is not a change: the host probes every provider at boot.
  f.service.onRegistryEntryChanged({ ...CLAUDEX, version: "2.1.278" });
  await f.service.drainProviderRefreshes();
  assert.deepEqual(f.refreshes, [], "boot state is not an update");

  // `RegistryService.runManaged`: installing → idle (bin re-resolved, version
  // cleared and re-detection kicked).
  f.service.onRegistryEntryChanged({
    ...CLAUDEX,
    version: "2.1.278",
    installState: "installing"
  });
  f.service.onRegistryEntryChanged({ ...CLAUDEX, version: undefined, installState: "idle" });
  await f.service.drainProviderRefreshes();
  assert.deepEqual(
    f.refreshes,
    ["claude"],
    "claudex nudges the claude adapter its launcher runs"
  );

  // The version detection that follows is the same event twice: debounced.
  f.service.onRegistryEntryChanged({ ...CLAUDEX, version: "2.1.280" });
  await f.service.drainProviderRefreshes();
  assert.deepEqual(f.refreshes, ["claude"]);
  await f.cleanup();
});

test("a version that moved refreshes once, and a flapping detector cannot loop", async () => {
  let nowMs = 1_000_000;
  const f = await makeFixture(CLAUDEX, null, { now: () => nowMs });

  f.service.onRegistryEntryChanged({ ...CLAUDEX, version: "2.1.278" });
  await f.service.drainProviderRefreshes();
  assert.deepEqual(f.refreshes, []);

  // A CLI updated outside the registry — the detector reads a new version.
  f.service.onRegistryEntryChanged({ ...CLAUDEX, version: "2.1.280" });
  await f.service.drainProviderRefreshes();
  assert.deepEqual(f.refreshes, ["claude"]);

  // Flapping inside the window costs nothing.
  for (const version of ["2.1.278", "2.1.280", "2.1.278"]) {
    f.service.onRegistryEntryChanged({ ...CLAUDEX, version });
  }
  await f.service.drainProviderRefreshes();
  assert.deepEqual(f.refreshes, ["claude"], "the window holds the next nudge off");

  // Past the window a real change is heard again.
  nowMs += PROVIDER_REFRESH_DEBOUNCE_MS;
  f.service.onRegistryEntryChanged({ ...CLAUDEX, version: "2.1.281" });
  await f.service.drainProviderRefreshes();
  assert.deepEqual(f.refreshes, ["claude", "claude"]);
  await f.cleanup();
});

test("an entry with no chat adapter never nudges a provider", async () => {
  const f = await makeFixture(CLAUDEX, null);
  const detectOnly: RegistryEntry = { ...CLAUDEX, id: "deepseek", chat: undefined };
  f.service.onRegistryEntryChanged({ ...detectOnly, version: "1.0.0" });
  f.service.onRegistryEntryChanged({ ...detectOnly, version: "1.1.0", installState: "idle" });
  await f.service.drainProviderRefreshes();
  assert.deepEqual(f.refreshes, []);
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

// §6.3 chat attachment uploads. An `'error'` event nobody listens for is thrown
// on the event loop, and in the daemon that ends the process — so "this is not
// a crash" is asserted by watching for one, never by hoping.

/**
 * Run `body` with an `uncaughtException` listener installed. `crashed` settles
 * on the first one, so a test can race it and fail instead of hanging.
 */
async function watchingForCrashes<T>(
  body: (crashed: Promise<"crashed">) => Promise<T>
): Promise<{ result: T; uncaught: unknown[] }> {
  const uncaught: unknown[] = [];
  let report: () => void = () => undefined;
  const crashed = new Promise<"crashed">((resolve) => {
    report = () => resolve("crashed");
  });
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
    report();
  };
  process.on("uncaughtException", onUncaught);
  try {
    return { result: await body(crashed), uncaught };
  } finally {
    process.off("uncaughtException", onUncaught);
  }
}

/** One full turn of the loop: every tick a `destroy` scheduled has been emitted. */
const turnOfTheLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a body that fails mid-upload fails the upload, never the daemon", async () => {
  const f = await makeFixture(CLAUDEX, { env: {} });
  try {
    // What the MCP hands over for a `{path}` attachment is a file stream, and a
    // file read can fail partway: EIO, a file truncated or unlinked under it.
    const source = new Readable({ read() {} });
    source.push(Buffer.from("the first bytes are on their way"));
    const { result, uncaught } = await watchingForCrashes(async (crashed) => {
      const upload = f.service.uploadAttachment("thread-1", { name: "notes.txt", type: "text/plain" }, source);
      source.once("data", () =>
        source.destroy(Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" }))
      );
      return Promise.race([upload.then(() => "resolved", (error: unknown) => error), crashed]);
    });
    assert.deepEqual(uncaught, [], "the read error never reaches the event loop");
    assert.ok(result instanceof HostUnavailableError, `the upload is refused, got ${String(result)}`);
    assert.match(result.message, /EIO/);
  } finally {
    await f.cleanup();
  }
});

test("an upload refused before it was sent leaves a failing body nothing to crash on", async () => {
  // No host adopted yet: the host client refuses without ever reading the body.
  const f = await makeFixture(CLAUDEX, { env: {} }, { adopt: false });
  try {
    const source = new Readable({ read() {} });
    source.push(Buffer.from("bytes"));
    const { uncaught } = await watchingForCrashes(async (crashed) => {
      await assert.rejects(
        f.service.uploadAttachment("thread-1", { name: "notes.txt" }, source),
        HostUnavailableError
      );
      // The route has answered 503 and the client goes away: the request it
      // streamed from fails after the fact.
      source.destroy(new Error("aborted"));
      await Promise.race([turnOfTheLoop(), crashed]);
    });
    assert.deepEqual(uncaught, []);
  } finally {
    await f.cleanup();
  }
});

test("past its cap the counted body still fails with UploadTooLargeError, and leaves its source to its owner", async () => {
  const source = new Readable({ read() {} });
  const counted = countingLimit(source, 4);
  const failed = once(counted, "error");
  counted.resume();
  source.push(Buffer.from("12345"));
  const [error] = await failed;
  assert.ok(error instanceof UploadTooLargeError);
  // `countingLimit` never destroys its source: the request is the route's,
  // and the route ends it with its own refusal (`refuseUpload`).
  assert.equal(source.destroyed, false);
});

// The daemon's cap is the one upload failure that is the CALLER's, not the
// host's. The host client reports it as HOST_UNAVAILABLE like everything else,
// so `uploadAttachment` hands it on typed, and both of its callers — the
// daemon's upload route and the MCP seam — answer 413 UPLOAD_TOO_LARGE rather
// than telling the client to retry a host that is fine. The fixture host
// answers only once the body is in, as the real one does, so a 5-byte body
// against a 4-byte cap trips while the host client still waits for headers.

/** A 5-byte octet-stream body for `thread-1`, one byte over the fixtures' cap. */
const OVER_CAP_UPLOAD = {
  method: "POST",
  url: "/api/sessions/thread-1/upload?name=big.bin",
  headers: { "content-type": "application/octet-stream" },
  payload: Buffer.from("12345")
} as const;

/**
 * The daemon's own upload route over a partial `services`, with the inject-only
 * harness of `project-create-routes.test.ts`: nothing listens. `thread-1` is
 * the one chat tab it knows.
 */
function chatUploadRoute(appdir: string, agentChat: unknown): FastifyInstance {
  type Args = Parameters<typeof createDaemonApp>;
  const workspacesDir = join(appdir, "ws");
  return createDaemonApp(
    createDefaultDaemonConfig({ env: {} }),
    {
      daemonDir: join(appdir, "daemon"),
      workspacesDir,
      workspacesMetaFile: join(appdir, "daemon", "workspaces.json"),
      fsRoot: workspacesDir
    } as unknown as Args[1],
    createDefaultClientConfig(join(appdir, "daemon.sock")),
    createWriteStream("/dev/null"),
    {
      sessions: { get: (id: string) => (id === "thread-1" ? { id, kind: "agent-chat" } : undefined) },
      agentChat
    } as unknown as Args[4],
    { authRequired: false, mode: "local" }
  );
}

test("past the daemon's cap an upload rejects with the typed UploadTooLargeError, never as HOST_UNAVAILABLE", async () => {
  const f = await makeFixture(CLAUDEX, { env: {} }, { uploadLimitBytes: 4 });
  try {
    await assert.rejects(
      f.service.uploadAttachment("thread-1", { name: "big.bin" }, Readable.from([Buffer.from("12345")])),
      UploadTooLargeError
    );
  } finally {
    await f.cleanup();
  }
});

test("an over-cap chat upload answers 413 UPLOAD_TOO_LARGE through the daemon's upload route, not 503", async () => {
  const f = await makeFixture(CLAUDEX, { env: {} }, { uploadLimitBytes: 4 });
  const app = chatUploadRoute(f.appdir, f.service);
  try {
    const res = await app.inject({ ...OVER_CAP_UPLOAD, headers: { ...OVER_CAP_UPLOAD.headers } });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.json(), { code: "UPLOAD_TOO_LARGE", message: new UploadTooLargeError().message });
    assert.equal(res.headers.connection, "close", "a refusal that leaves the body unread closes the socket");
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("the upload route answers a cap refusal the host client wrapped 413 too, and any other host failure 503", async () => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-chat-upload-route-"));
  const answers: Array<{ status: number; code: unknown }> = [];
  try {
    for (const failure of [
      new HostUnavailableError(new UploadTooLargeError().message, new UploadTooLargeError()),
      new HostUnavailableError("connect ENOENT agent-host.sock")
    ]) {
      const app = chatUploadRoute(appdir, {
        // No chat proxy routes: only the upload route is under test.
        routeDeps: () => undefined,
        uploadAttachment: async () => {
          throw failure;
        }
      });
      try {
        const res = await app.inject({ ...OVER_CAP_UPLOAD, headers: { ...OVER_CAP_UPLOAD.headers } });
        answers.push({ status: res.statusCode, code: (res.json() as { code?: unknown }).code });
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(appdir, { recursive: true, force: true });
  }
  assert.deepEqual(answers, [
    { status: 413, code: "UPLOAD_TOO_LARGE" },
    { status: 503, code: "HOST_UNAVAILABLE" }
  ]);
});

test("an over-cap chat upload answers 413 UPLOAD_TOO_LARGE through the MCP seam too, and logs nothing", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  const f = await makeFixture(CLAUDEX, { env: {} }, { uploadLimitBytes: 4 });
  const app = Fastify();
  try {
    const seam = new InjectDaemonApi({
      app,
      authorization: undefined,
      agentChat: f.service,
      broadcaster: new Broadcaster(),
      fsRoot: f.appdir,
      workspacesDir: f.appdir
    });
    const bytes = Readable.from([Buffer.from("12345")]);
    assert.deepEqual(await seam.uploadAttachment("thread-1", { name: "big.bin" }, bytes), {
      status: 413,
      value: { code: "UPLOAD_TOO_LARGE", message: new UploadTooLargeError().message }
    });
    assert.equal(logged.mock.callCount(), 0, "a size refusal is an answer, not a failure to log");
    assert.equal(bytes.destroyed, true, "the seam still ends the stream it owns");
  } finally {
    await app.close();
    await f.cleanup();
  }
});
