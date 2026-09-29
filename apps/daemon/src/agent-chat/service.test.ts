import { strict as assert } from "node:assert";
import { EventEmitter, once } from "node:events";
import { createWriteStream } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
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
  createDefaultDaemonConfig,
  parseSessionsConfig
} from "@orquester/config";
import { Broadcaster } from "../broadcaster.ts";
import { createServer as createDaemonApp } from "../index.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  type CreateHostThreadRequest,
  type SetThreadIdentityRequest
} from "../agent-host/host-protocol.ts";
import { AgentChatService } from "./service.ts";
import { ChatSessionError, ChatSessionManager } from "./chat-sessions.ts";
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
  /**
   * Set to make the fake host refuse an attachment upload on sight, before it
   * reads a byte of the body, as the real host refuses a missing `name` or a
   * declared length over its 50 MiB cap.
   */
  refuseUpload: { status: number; body: unknown } | null;
  /**
   * Set to make the fake host refuse an attachment upload only once it has
   * read every byte of the body, as the real host does when its store refuses
   * the file it stat'd (an image over the image cap).
   */
  refuseUploadAfterBody: { status: number; body: unknown } | null;
  /**
   * Called with every attachment upload the fake host receives, the moment it
   * arrives and before it is answered, so a test can watch the host's end of
   * the daemon→host request.
   */
  onUpload: ((req: IncomingMessage) => void) | null;
  appdir: string;
  /** Overridable per-account launch env, so a switch can be observed. */
  launchFor: (ctx: { accountId?: string }) => {
    env: Record<string, string>;
    unset?: string[];
    accountId?: string;
  } | null;
  /** What `listManagedAccounts` answers — the family gate reads it. */
  accounts: AgentAccount[];
  /** Adapter ids the daemon asked the host to re-probe, in order. */
  refreshes: string[];
  /** Merged into the fake host's `/health` answer (`makeFixture`'s `health` option). */
  health: Record<string, unknown>;
  /** Agent goals §5.7: every `POST /goals/hold` the fake host received. */
  holdRequests: Array<{ body: string; headers: IncomingMessage["headers"] }>;
  /** What the fake host answers `POST /goals/hold`. */
  holdAnswer: { status: number; body: unknown };
  /** Agent goals §5.7 legacy handover: the snapshot the fake host answers per thread (`GET /threads/:id/thread`). */
  snapshots: Record<string, { status: number; body: unknown }>;
  /** Every `POST /threads/:id/session/stop` the fake host received. */
  sessionStops: Array<{ threadId: string; body: string }>;
  /** Every `POST /goals/resume-sessions` the fake host received, and its answer. */
  resumeRequests: string[];
  resumeAnswer: { status: number; body: unknown };
  /** Agent profile §4.8: how many `POST /opencode/recycle-idle` reached the fake host. */
  recycleRequests: number;
  /** Its answer; `"drop"` tears the connection down unanswered. */
  recycleAnswer: { status: number; body: unknown } | "drop";
  requests: EventEmitter;
  broadcasts: EventEmitter;
  cleanup(): Promise<void>;
}

const CLAUDE: RegistryEntry = {
  id: "claude",
  name: "Claude Code",
  kind: "agent",
  bin: ["claude"],
  resolvedBin: "/usr/bin/claude",
  enabled: true,
  installState: "idle",
  // What RegistryService materialises: the static entry env merged with
  // `<appdir>/daemon/env/claude.env`.
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
  options: {
    adopt?: boolean;
    /** Set before boot adoption, which is the first thing to read `/health`. */
    health?: Record<string, unknown>;
    holdAnswer?: { status: number; body: unknown };
  } = {}
): Promise<Fixture> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-chat-service-"));
  // The REAL paths, so boot adoption probes the fake host rather than deciding
  // nothing is listening and spawning one. No host process is ever started
  // here: the tmux boundary below refuses any attempt to start one.
  const socketPath = agentHostSocketPath(appdir, "linux");
  await mkdir(join(appdir, "daemon"), { recursive: true });
  await writeFile(agentHostTokenPath(appdir), "test-token\n", { mode: 0o600 });
  const state: Fixture = {
    created: [],
    identities: [],
    refuse: null,
    refuseIdentity: null,
    refuseUpload: null,
    refuseUploadAfterBody: null,
    onUpload: null,
    appdir,
    launchFor: () => launch,
    accounts: [],
    refreshes: [],
    health: options.health ?? {},
    holdRequests: [],
    holdAnswer: options.holdAnswer ?? { status: 200, body: { heldThreadIds: [] } },
    snapshots: {},
    sessionStops: [],
    resumeRequests: [],
    resumeAnswer: { status: 200, body: { threadIds: [] } },
    recycleRequests: 0,
    recycleAnswer: { status: 200, body: { recycled: 0, deferred: 0 } },
    requests: new EventEmitter(),
    broadcasts: new EventEmitter(),
    service: null as unknown as AgentChatService,
    cleanup: async () => {
      await state.service.stop();
      // An upload a test left open would otherwise hold `close` forever.
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await rm(appdir, { recursive: true, force: true });
    }
  };
  const host = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.on("finish", () => state.requests.emit(req.url ?? "/"));
    const upload = req.method === "POST" && /^\/threads\/[^/]+\/attachments(?:\?|$)/.test(req.url ?? "");
    if (upload) state.onUpload?.(req);
    if (upload && state.refuseUpload) {
      res
        .writeHead(state.refuseUpload.status, { "content-type": "application/json" })
        .end(JSON.stringify(state.refuseUpload.body));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { if (!upload) chunks.push(chunk); });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (upload && state.refuseUploadAfterBody) {
        res
          .writeHead(state.refuseUploadAfterBody.status, { "content-type": "application/json" })
          .end(JSON.stringify(state.refuseUploadAfterBody.body));
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            protocolVersion: 1,
            hostInstanceId: "host-1",
            liveThreadIds: [],
            activeTurnThreadIds: [],
            pid: 111,
            startedAt: "2026-09-21T00:00:00.000Z",
            ...state.health
          })
        );
        return;
      }
      if (req.url === "/goals/hold" && req.method === "POST") {
        state.holdRequests.push({ body, headers: req.headers });
        res
          .writeHead(state.holdAnswer.status, { "content-type": "application/json" })
          .end(JSON.stringify(state.holdAnswer.body));
        return;
      }
      const snapshot = /^\/threads\/([^/]+)\/thread$/.exec(req.url ?? "");
      if (snapshot && req.method === "GET" && state.snapshots[decodeURIComponent(snapshot[1]!)]) {
        const answer = state.snapshots[decodeURIComponent(snapshot[1]!)]!;
        res
          .writeHead(answer.status, { "content-type": "application/json" })
          .end(JSON.stringify(answer.body));
        return;
      }
      const sessionStop = /^\/threads\/([^/]+)\/session\/stop$/.exec(req.url ?? "");
      if (sessionStop && req.method === "POST") {
        state.sessionStops.push({ threadId: decodeURIComponent(sessionStop[1]!), body });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seq: 7 }));
        return;
      }
      if (req.url === "/opencode/recycle-idle" && req.method === "POST") {
        state.recycleRequests += 1;
        const answer = state.recycleAnswer;
        if (answer === "drop") {
          req.socket.destroy();
          return;
        }
        res
          .writeHead(answer.status, { "content-type": "application/json" })
          .end(JSON.stringify(answer.body));
        return;
      }
      if (req.url === "/goals/resume-sessions" && req.method === "POST") {
        state.resumeRequests.push(body);
        res
          .writeHead(state.resumeAnswer.status, { "content-type": "application/json" })
          .end(JSON.stringify(state.resumeAnswer.body));
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
  // The real host's timeouts (`agent-host/server/http-server.ts`): none. A
  // connection closes only when one end tears it down. With Node's defaults
  // the fake host closed an idle connection itself after 5 s, so a test that
  // waited on that close passed whether or not the daemon tore anything down.
  host.keepAliveTimeout = 0;
  host.headersTimeout = 0;
  host.requestTimeout = 0;
  await new Promise<void>((resolve) => host.listen(socketPath, resolve));

  state.service = new AgentChatService({
    baseDir: appdir,
    daemonDir: join(appdir, "daemon"),
    platform: "linux",
    cwd: appdir,
    sessionPath: "/usr/bin",
    env: {},
    tmux: {
      hasServiceSession: async () => false,
      killServiceSession: async () => { throw new Error("the fixture must never kill a host"); },
      newServiceSession: async () => { throw new Error("the fixture must adopt the fake host"); }
    },
    broadcaster: { publish: (_topic, kind) => { state.broadcasts.emit(kind); } },
    push: { notifyStructural: async () => undefined },
    registryEntry: (refId) => (refId === entry.id ? entry : undefined),
    resolveLaunchEnv: async (_entry, ctx) => state.launchFor(ctx),
    listManagedAccounts: () => ({ accounts: state.accounts }),
    systemClaudeConfigFile: () => join(appdir, ".claude.json"),
    // The real confinement lives in `index.ts` (realpath + assertInsideFsRoot);
    // here the sandbox is `<appdir>/ws`, so a path outside it answers null.
    resolveTrustedProjectDir: async (projectPath) => {
      const root = join(appdir, "ws");
      const resolvedPath = resolve(projectPath);
      return resolvedPath === root || resolvedPath.startsWith(root + sep) ? resolvedPath : null;
    },
    sendAttachment: async (reply) => reply
  });
  // `adopt: false` is a daemon that has not found its host yet: no token, so
  // every host call is refused before anything is sent.
  if (options.adopt === false) return state;
  await state.service.init();
  return state;
}

test("the launch env is the registry entry's env UNDER the resolveExtraEnv contributors", async () => {
  const f = await makeFixture(CLAUDE, {
    // The account + timeout contributors, exactly as they run for a terminal.
    env: {
      CLAUDE_CONFIG_DIR: "/var/lib/orquester/daemon/agent-accounts/claude/acc-1/home",
      API_TIMEOUT_MS: "600000",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999"
    },
    unset: ["ANTHROPIC_API_KEY"],
    accountId: "acc-1"
  });
  await f.service.createSession(
    { kind: "agent-chat", refId: "claude", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  assert.equal(f.created.length, 1);
  const body = f.created[0];
  assert.equal(body.launchEnv?.ORQ_FROM_ENV_FILE, "1", "the per-launcher env file reaches the host");
  assert.equal(body.launchEnv?.API_TIMEOUT_MS, "600000");
  assert.equal(
    body.launchEnv?.ANTHROPIC_BASE_URL,
    "http://127.0.0.1:9999",
    "the contributor wins a collision with the entry env, as the terminal wrapper does"
  );
  assert.deepEqual(body.unsetEnv, ["ANTHROPIC_API_KEY"]);
  assert.equal(body.home, "account");
  assert.equal(body.accountId, "acc-1");
  assert.equal(body.homePath, "/var/lib/orquester/daemon/agent-accounts/claude/acc-1/home");
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

test("trust is granted for the validated projectPath, NEVER the request's cwd", async () => {
  // Claude's trust dialog is a security control: an untrusted directory's hooks
  // (arbitrary shell as the daemon user, which holds scoped passwordless sudo)
  // are ignored until it is accepted. A client naming any `cwd` on the box must
  // not be able to enable them — host-wide and permanently, since a system-home
  // grant also applies to every future terminal `claude` tab on that path.
  const dir = await mkdtemp(join(tmpdir(), "orq-claude-home-"));
  const f = await makeFixture(
    CLAUDE,
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
  await rm(dir, { recursive: true, force: true });
  await f.cleanup();
});

test("a projectPath outside the sandbox grants NO trust, and the launch still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-claude-home-"));
  const f = await makeFixture(
    CLAUDE,
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
    (error: unknown) => error instanceof ChatSessionError && error.code === "SESSION_UNAVAILABLE"
  );
  assert.equal(f.created.length, 0);
  await f.cleanup();
});

test("a resume id the adapter cannot use is refused at creation, never degraded", async () => {
  const f = await makeFixture(OPENCODE, null);
  for (const conversationId of ["../escape", "-rf", "", "a/../b", 42 as unknown as string]) {
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
      String(conversationId)
    );
  }
  assert.equal(f.created.length, 0, "an unusable resume never reaches the host");
  await f.cleanup();
});

test("§6.1's fields ride the nested `chat` block the client sends", async () => {
  const f = await makeFixture(CLAUDE, {
    env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" },
    accountId: "acc-1"
  });
  await f.service.createSession(
    {
      kind: "agent-chat",
      refId: "claude",
      projectPath: "/w/p",
      cwd: "/w/p",
      chat: {
        // An empty `model` means "the provider's own default" — the launcher
        // had no catalog to pick from. It is never a refusal.
        modelSelection: { model: "" },
        runtimeMode: "auto-accept-edits",
        resume: { home: "account", conversationId: "0199-abc.def/history" }
      }
    },
    0
  );
  const body = f.created[0];
  assert.deepEqual(body.modelSelection, { model: "" });
  assert.equal(body.runtimeMode, "auto-accept-edits");
  assert.deepEqual(body.resume, { home: "account", conversationId: "0199-abc.def/history" });
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

// --- workflows §5.10: the session owner ----------------------------------

test("a workflow owner rides create → summary → sessions.json → re-adoption after a restart", async () => {
  const f = await makeFixture(OPENCODE, null);
  const owner = { kind: "workflow" as const, workflowId: "wf-1", runId: "run-1", nodeId: "node-1" };
  const summary = await f.service.createSession(
    { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p", owner },
    0
  );
  assert.deepEqual(summary.owner, owner);
  // A §6.4 field update replaces the derived fields, never the owner.
  const updated = f.service.chat.applyFields(summary.id, {
    hasPendingApprovals: true,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    latestTurn: null,
    chatSessionStatus: "ready",
    goal: null
  });
  assert.deepEqual(updated?.owner, owner);
  assert.equal("owner" in (f.created[0] ?? {}), false, "the host thread knows nothing of workflows");

  // What the index writes, read back through the tolerant parse a restart uses.
  const onDisk = JSON.parse(JSON.stringify({ version: 1, sessions: f.service.chat.records() }));
  assert.deepEqual(onDisk.sessions[0].owner, owner);
  const reloaded = new ChatSessionManager();
  reloaded.adopt(parseSessionsConfig(onDisk).sessions);
  assert.deepEqual(reloaded.get(summary.id)?.owner, owner);
  assert.deepEqual(reloaded.records()[0]?.owner, owner, "a re-write keeps it");
  await f.cleanup();
});

test("a tab with no owner writes no owner key", async () => {
  const f = await makeFixture(OPENCODE, null);
  const summary = await f.service.createSession(
    { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  assert.equal("owner" in summary, false);
  const record = f.service.chat.records()[0]!;
  assert.equal("owner" in record, false);
  await f.cleanup();
});

test("the service refuses a malformed owner before the tab or the thread exists", async () => {
  const f = await makeFixture(OPENCODE, null);
  await assert.rejects(
    () =>
      f.service.createSession(
        {
          kind: "agent-chat",
          refId: "opencode",
          projectPath: "/w/p",
          cwd: "/w/p",
          owner: { kind: "workflow", workflowId: "", runId: "r", nodeId: "n" }
        },
        0
      ),
    (error: unknown) => error instanceof ChatSessionError && error.code === "INVALID_OWNER"
  );
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.service.chat.list(), []);
  await f.cleanup();
});

// --- §3.4 switching an existing thread's account ---------------------------

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

// §3.2 — the daemon is the one process that knows an install just happened.
//
// The incident: `claude` was updated from Settings → Agents (2.1.278 → 2.1.280,
// which resolves the `opus` alias to a different model) and a chat opened
// afterwards still offered the old alias, because the host's snapshot was the
// one probed under the old binary and nothing told it the CLI had changed.

test("an install/update asks the host to re-probe the provider that entry maps to", async (t) => {
  const f = await makeFixture(CLAUDE, null);
  t.after(() => f.cleanup());
  const changed = once(f.broadcasts, "agent.providers.changed");
  f.service.onRegistryEntryChanged({ ...CLAUDE, installState: "installing" });
  f.service.onRegistryEntryChanged({ ...CLAUDE, installState: "idle" });
  await changed;
  assert.deepEqual(f.refreshes, ["claude"]);
});

test("a CLI version change asks the host to refresh its provider catalog", async (t) => {
  const f = await makeFixture(CLAUDE, null);
  t.after(() => f.cleanup());
  f.service.onRegistryEntryChanged({ ...CLAUDE, version: "2.1.278" });
  const changed = once(f.broadcasts, "agent.providers.changed");
  f.service.onRegistryEntryChanged({ ...CLAUDE, version: "2.1.280" });
  await changed;
  assert.deepEqual(f.refreshes, ["claude"]);
});

// Agent goals §5.7: a deploy's drain blocked by a continuing goal asks the host
// to hold it between two turns. The supervisor decides WHEN — every blocked
// evaluation; the service owns the hop: route, body, deadline, and reading
// another process's answer field-wise.

/** A host a deploy has made stale (another protocol version), busy with one turn. */
const STALE_BUSY_HOST = {
  protocolVersion: AGENT_HOST_PROTOCOL_VERSION + 1,
  activeTurnThreadIds: ["thread-G"],
  backgroundWorkThreadIds: []
};

test("agent goals §5.7: a blocked deploy drain posts the goal hold, with authentication", async (t) => {
  const f = await makeFixture(CLAUDE, null, { health: STALE_BUSY_HOST });
  t.after(() => f.cleanup());
  if (f.holdRequests.length === 0) await once(f.requests, "/goals/hold");
  assert.equal(f.holdRequests[0]!.body, "{}");
  assert.equal(f.holdRequests[0]!.headers["content-type"], "application/json");
  assert.equal(f.holdRequests[0]!.headers.authorization, "Bearer test-token");
});

test("agent goals §5.7, a host from before the hold: the snapshot read, the session stop and the hand-over reach the host as sent", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await makeFixture(CLAUDE, null, {
    health: STALE_BUSY_HOST,
    holdAnswer: { status: 404, body: { error: { code: "THREAD_NOT_FOUND" } } }
  });
  try {
    if (f.holdRequests.length === 0) await once(f.requests, "/goals/hold");
    // Drain the response's I/O turn before advancing the native health interval.
    await turnOfTheLoop();
    await turnOfTheLoop();
    // A Codex goal loop whose next turn has just begun, as the host answers
    // `GET /threads/:id/thread` — another version's snapshot, read field-wise.
    const at = (ms: number): string => new Date(Date.now() - ms).toISOString();
    f.snapshots["thread-G"] = {
      status: 200,
      body: {
        kind: "snapshot",
        thread: {
          head: { adapter: "codex", session: { status: "running", activeTurnId: "t2" } },
          turns: [
            { turnId: "t1", state: "completed", startedAt: at(60_000), completedAt: at(1_050) },
            { turnId: "t2", state: "running", startedAt: at(1_000) }
          ],
          pending: { approvals: [], userInputs: [] }
        }
      }
    };
    const stopped = once(f.requests, "/threads/thread-G/session/stop");
    t.mock.timers.tick(15_000);
    await stopped;
    assert.equal(f.sessionStops.length, 1, "the goal's session was stopped");
    assert.equal(f.sessionStops[0]!.threadId, "thread-G");
    const commandId = (JSON.parse(f.sessionStops[0]!.body) as { commandId: string }).commandId;
    assert.equal(typeof commandId, "string");
    assert.ok(commandId.length > 0);
    // The replacement answers on the socket (the same fake, now current):
    // adopted, it is handed the stopped session.
    f.health = { protocolVersion: AGENT_HOST_PROTOCOL_VERSION, hostInstanceId: "host-2", activeTurnThreadIds: [], backgroundWorkThreadIds: [] };
    f.resumeAnswer = { status: 200, body: { threadIds: ["thread-G", 7] } };
    await turnOfTheLoop();
    await turnOfTheLoop();
    const resumed = once(f.requests, "/goals/resume-sessions");
    t.mock.timers.tick(15_000);
    await resumed;
    assert.deepEqual(f.resumeRequests.map((body) => JSON.parse(body) as unknown), [{ threadIds: ["thread-G"] }]);
  } finally {
    await f.cleanup();
  }
});

// Agent profile §4.8: after an OpenCode config write the daemon asks the host to
// recycle OpenCode's idle servers. Fire-and-forget: whatever the host answers —
// counts, the route-miss 404 of a host from before the route, a refusal, a torn
// connection — the call settles without throwing, and a daemon with no host
// sends nothing.

test("agent profile §4.8: the OpenCode recycle reaches the host, and no answer makes it throw", async () => {
  const f = await makeFixture(OPENCODE, null);
  try {
    const answers: Array<Fixture["recycleAnswer"]> = [
      { status: 200, body: { recycled: 2, deferred: 1 } },
      // The generic route-miss 404 of a host that predates the route.
      { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No route for POST /opencode/recycle-idle." } } },
      { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "stopping" } } },
      { status: 200, body: "not an object" },
      "drop"
    ];
    for (const [index, answer] of answers.entries()) {
      f.recycleAnswer = answer;
      await f.service.recycleIdleOpenCodeServers();
      assert.equal(f.recycleRequests, index + 1);
    }
  } finally {
    await f.cleanup();
  }

  // No host adopted: nothing is sent, and nothing throws.
  const down = await makeFixture(OPENCODE, null, { adopt: false });
  try {
    await down.service.recycleIdleOpenCodeServers();
    assert.equal(down.recycleRequests, 0);
  } finally {
    await down.cleanup();
  }
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
  const f = await makeFixture(CLAUDE, { env: {} });
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
  const f = await makeFixture(CLAUDE, { env: {} }, { adopt: false });
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

// The daemon's cap is the one upload failure that is the CALLER's, not the
// host's. The host client reports it as HOST_UNAVAILABLE like everything else,
// so `uploadAttachment` hands it on typed, and both of its callers — the
// daemon's upload route and the MCP seam — answer 413 UPLOAD_TOO_LARGE rather
// than telling the client to retry a host that is fine. The fixture host
// answers only once the body is in, as the real one does, so a body one byte
// over the public 500 MiB cap trips while the host client still waits for headers.

function oversizedUpload(): Readable {
  return Readable.from((function* () {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 500; i++) yield chunk;
    yield Buffer.from([0]);
  })());
}

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
        const res = await app.inject({ ...CHAT_UPLOAD, headers: { ...CHAT_UPLOAD.headers } });
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

// The route relays the host's own answer to a chat upload. The host may refuse
// before it has read the whole body, and then the rest of it is still on the
// wire: AGENTS.md ("Uploads are raw binary streams") wants every refusal that
// leaves the body unread to close the socket, so Node does not drain it.

/** A small chat upload for `thread-1`, well under every cap. */
const CHAT_UPLOAD = {
  method: "POST",
  url: "/api/sessions/thread-1/upload?name=notes.txt",
  headers: { "content-type": "application/octet-stream" },
  payload: Buffer.from("bytes")
} as const;

test("a host that refuses an upload before reading it is relayed as is, and the connection closes", async () => {
  const f = await makeFixture(CLAUDE, { env: {} });
  const refusal = { error: { code: "INVALID_COMMAND", message: "`name` is required." } };
  f.refuseUpload = { status: 400, body: refusal };
  const app = chatUploadRoute(f.appdir, f.service);
  try {
    const res = await app.inject({ ...CHAT_UPLOAD, headers: { ...CHAT_UPLOAD.headers } });
    assert.equal(res.statusCode, 400);
    // The host's own `{error}` envelope, which the chat transport reads. It is
    // relayed as is, never reshaped into `refuseUpload`'s `{code, message}`.
    assert.deepEqual(res.json(), refusal);
    assert.equal(res.headers.connection, "close", "a refusal that may leave the body on the wire closes the socket");
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("an upload the host takes is relayed without closing the connection", async () => {
  const f = await makeFixture(CLAUDE, { env: {} });
  const app = chatUploadRoute(f.appdir, f.service);
  try {
    const res = await app.inject({ ...CHAT_UPLOAD, headers: { ...CHAT_UPLOAD.headers } });
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.headers.connection, "close", "the host read the whole body before answering 2xx");
  } finally {
    await app.close();
    await f.cleanup();
  }
});

// `inject` cannot leave a body on the wire: light-my-request's request carries
// no `complete` at all, so the route test above only proves the wiring. The
// real route below proves the complete-wire boundary.

test("a host refusal keeps the client connection open once all upload bytes are off the wire", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-upload-complete-"));
  const socketPath = join(dir, "upload.sock");
  let headersIn!: () => void;
  const arrived = new Promise<void>((resolve) => { headersIn = resolve; });
  const app = chatUploadRoute(dir, {
    routeDeps: () => undefined,
    uploadAttachment: async (_id: string, _query: unknown, body: IncomingMessage) => {
      headersIn();
      // The upstream can refuse after the body arrived but before the daemon
      // consumes it. Complete wire input alone makes keep-alive safe.
      await new Promise<void>((resolve) => {
        const complete = () => {
          if (!body.complete) return;
          body.off("readable", complete);
          resolve();
        };
        body.on("readable", complete);
        complete();
      });
      assert.equal(body.readableEnded, false);
      return { status: 400, value: { error: { code: "INVALID_COMMAND" } } };
    }
  });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  await app.listen({ path: socketPath });
  const client = httpRequest({
    socketPath, method: "POST", path: CHAT_UPLOAD.url,
    headers: { "content-type": "application/octet-stream", "content-length": "10", connection: "keep-alive" }
  });
  const answered = once(client, "response");
  client.write("12345");
  await arrived;
  client.end("67890");
  const [response] = (await answered) as [IncomingMessage];
  assert.equal(response.statusCode, 400);
  assert.notEqual(response.headers.connection, "close");
  response.resume();
  await once(response, "end");
  client.destroy();
});

// The daemon's own request to the host, once a refusal has been relayed. If
// the host answers ≥ 400 while the body is still arriving, nothing else ever
// ends that request: `countingLimit` forwards only an error, the route's
// request is no longer aborted once its reply has gone out, and the host runs
// with no keep-alive or request timeout. Left open, it holds one daemon↔host
// socket pair until the host restarts.

// The timeout is a deadline for a failure, never a wait. A real teardown
// closes the host's end of the connection within milliseconds, and nothing
// else ever closes it. So a teardown that never reaches the socket fails here
// instead of hanging the suite.
test("a host that refuses while the upload is still arriving has the daemon's request to it torn down", { timeout: 10_000 }, async (t) => {
  const f = await makeFixture(CLAUDE, { env: {} });
  t.after(() => f.cleanup());
  // The real host's answer to an upload with no `name`, before it reads a byte.
  const refusal = { error: { code: "INVALID_COMMAND", message: "`name` is required." } };
  f.refuseUpload = { status: 400, body: refusal };
  // Watched from the moment the upload reaches the host, so the close cannot
  // slip by. Only the daemon can close this connection: the fake host never
  // times it out. It is the connection that closes: the host's request object
  // never does, because once its answer has gone out the server no longer
  // tracks it. A listener rather than `events.once()`, which would reject on
  // the parse error the host's socket reports for the cut body on its way out.
  const closed = new Promise<void>((resolve) => {
    f.onUpload = (req) => req.socket.once("close", () => resolve());
  });
  // The first bytes are sent, and the rest never comes: the client has gone.
  const source = new Readable({ read() {} });
  source.push(Buffer.from("the first bytes"));
  const answer = await f.service.uploadAttachment("thread-1", {}, source);
  assert.deepEqual(answer, { status: 400, value: refusal }, "the refusal is relayed as is");
  await closed;
  assert.equal(source.readableFlowing, false, "nothing reads the source any more");
  assert.equal(source.destroyed, false, "the source is still its owner's to end");
});

test("a fully consumed upload preserves the host answer and all body bytes", async (t) => {
  // The real host's answer when its store refuses the file it stat'd.
  const refusal = {
    error: { code: "COMMAND_REJECTED", message: "agent-chat: attachment is 10 bytes, over the 4-byte limit" }
  };
  for (const expected of [
    { status: 200, value: {} },
    { status: 500, value: refusal }
  ]) {
    const f = await makeFixture(CLAUDE, { env: {} });
    t.after(() => f.cleanup());
    if (expected.status >= 400) {
      f.refuseUploadAfterBody = { status: expected.status, body: expected.value };
    }
    const received = new Promise<string>((resolve) => {
      f.onUpload = (req) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      };
    });
    const answer = await f.service.uploadAttachment(
      "thread-1",
      { name: "notes.txt" },
      Readable.from([Buffer.from("every byte")])
    );
    assert.deepEqual(answer, expected, `${expected.status}: the host's answer is relayed`);
    assert.equal(await received, "every byte", `${expected.status}: the host read the whole body before answering`);
  }
});

test("an over-cap chat upload answers 413 UPLOAD_TOO_LARGE through the MCP seam too, and ends its owned stream", async (t) => {
  const f = await makeFixture(CLAUDE, { env: {} });
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
    const bytes = oversizedUpload();
    const response = await seam.uploadAttachment("thread-1", { name: "big.bin" }, bytes);
    assert.equal(response.status, 413);
    assert.equal((response.value as { code: string }).code, "UPLOAD_TOO_LARGE");
    assert.equal(bytes.destroyed, true, "the seam still ends the stream it owns");
  } finally {
    await app.close();
    await f.cleanup();
  }
});
