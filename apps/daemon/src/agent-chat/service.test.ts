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
  type ForkHostThreadRequest,
  type SetThreadIdentityRequest
} from "../agent-host/host-protocol.ts";
import { AgentChatService, FORK_CONFIRM_MAX_BACKOFF_MS, FORK_CONFIRM_MAX_REFUSALS, type ChatLaunchEnv } from "./service.ts";
import { ChatSessionError, ChatSessionManager } from "./chat-sessions.ts";
import { HostUnavailableError } from "./host-client.ts";
import { UploadTooLargeError } from "../upload-stream.ts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  htmlRenderStockTheme,
  htmlRenderThemeFragment
} from "@orquester/api/agent-chat";
import { HtmlPreviewError, type HtmlPageRenderer } from "../html-preview/index.ts";

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
  /** Set to make the fake host drop the thread create's connection without answering. */
  dropCreate: boolean;
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
  /** Their bodies, parsed. */
  recycleBodies: unknown[];
  /** Its answer; `"drop"` tears the connection down unanswered. */
  recycleAnswer: { status: number; body: unknown } | "drop";
  /** Thread lineage: every `POST /threads/:parentId/fork` the fake host received. */
  forks: Array<{ parentId: string; body: ForkHostThreadRequest }>;
  /** What the fake host answers a fork; built from the request when null. */
  forkAnswer: { status: number; body: unknown } | null;
  /** Drop the next fork's connection after the host took it (a lost answer), once. */
  dropForkAnswer: boolean;
  /** Drop the next fork's connection before the host created anything, once. */
  dropForkUncreated: boolean;
  /** The fork children the fake host holds, by id, with the lineage it resolved. */
  forkChildren: Map<string, unknown>;
  /** What the fake host answers a `confirmOnly` fork instead of the truth, when set. */
  confirmAnswer: { status: number; body: unknown } | null;
  restart(): Promise<void>;
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
  launch: ChatLaunchEnv | null,
  options: {
    adopt?: boolean;
    /** Set before boot adoption, which is the first thing to read `/health`. */
    health?: Record<string, unknown>;
    holdAnswer?: { status: number; body: unknown };
    /** The agent pages' browser (design 2026-10-14 §2.1); none by default. */
    htmlPreview?: HtmlPageRenderer;
    /** More registry entries beside `entry` (a continuation in another agent). */
    extraEntries?: RegistryEntry[];
    /** The working tree a continuation hands over (`AgentChatServiceOptions.gitStatusShort`). */
    gitStatusShort?: (projectPath: string) => Promise<string>;
    /** The service's clock (a fork reconcile's backoff). */
    now?: () => number;
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
    dropCreate: false,
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
    recycleBodies: [],
    recycleAnswer: { status: 200, body: { recycled: 0, deferred: 0 } },
    forks: [],
    forkAnswer: null,
    dropForkAnswer: false,
    dropForkUncreated: false,
    forkChildren: new Map(),
    confirmAnswer: null,
    restart: async () => undefined,
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
        state.recycleBodies.push(body.length > 0 ? (JSON.parse(body) as unknown) : null);
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
        if (state.dropCreate) {
          req.socket.destroy();
          return;
        }
        if (state.refuse) {
          res
            .writeHead(state.refuse.status, { "content-type": "application/json" })
            .end(JSON.stringify(state.refuse.body));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const fork = /^\/threads\/([^/]+)\/fork$/.exec(req.url ?? "");
      if (fork && req.method === "POST") {
        const request = JSON.parse(body) as ForkHostThreadRequest;
        state.forks.push({ parentId: decodeURIComponent(fork[1]!), body: request });
        if (state.dropForkUncreated) {
          state.dropForkUncreated = false;
          req.socket.destroy();
          return;
        }
        const held = state.forkChildren.get(request.threadId);
        if (request.confirmOnly) {
          const confirmed = state.confirmAnswer ?? (held
            ? { status: 200, body: { head: { id: request.threadId, lineage: held }, strategy: "native", lineage: held } }
            : { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: `Thread '${request.threadId}' was not found.` } } });
          res.writeHead(confirmed.status, { "content-type": "application/json" }).end(JSON.stringify(confirmed.body));
          return;
        }
        const lineage = held ?? {
          parentThreadId: decodeURIComponent(fork[1]!),
          relation: "fork",
          forkedFrom: { messageId: request.fork.messageId ?? "m", turnId: "t1" },
          createdAt: "2026-10-14T00:00:00.000Z"
        };
        const answer = state.forkAnswer ?? {
          status: 200,
          body: { head: { id: request.threadId, lineage }, strategy: "native", lineage }
        };
        if (answer.status < 400 && (answer.body as { head?: unknown } | null)?.head !== undefined || state.dropForkAnswer) {
          state.forkChildren.set(request.threadId, lineage);
        }
        if (state.dropForkAnswer) {
          state.dropForkAnswer = false;
          req.socket.destroy();
          return;
        }
        res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
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

  const createService = () => new AgentChatService({
    ...(options.now !== undefined ? { now: options.now } : {}),
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
    registryEntry: (refId) => (refId === entry.id ? entry : options.extraEntries?.find((extra) => extra.id === refId)),
    ...(options.gitStatusShort ? { gitStatusShort: options.gitStatusShort } : {}),
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
    sendAttachment: async (reply) => reply,
    ...(options.htmlPreview ? { htmlPreview: options.htmlPreview } : {})
  });
  state.service = createService();
  state.restart = async () => {
    const records = parseSessionsConfig(JSON.parse(JSON.stringify({ version: 1, sessions: state.service.chat.records() }))).sessions;
    const deletes = state.service.chat.pendingThreadDeletes();
    await state.service.stop();
    state.service = createService();
    state.service.chat.adopt(records);
    state.service.chat.adoptPendingDeletes(deletes);
    await state.service.init();
  };
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
  assert.equal("serverPool" in body, false, "no keyed server named: the project's global one");
  await f.cleanup();
});

test("a keyed OpenCode server named by the launch env reaches the host on create, fork and a fork's reconcile", async () => {
  const serverPool = { key: "profile-a", env: { XDG_CONFIG_HOME: "/profiles/a/xdg" }, unsetEnv: ["X"] };
  const f = await makeFixture(OPENCODE, { env: {}, serverPool });
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "opencode", projectPath: "/w/p" }, 0);
  assert.deepEqual(f.created[0]?.serverPool, serverPool);
  assert.equal(f.created[0]?.launchEnv?.XDG_CONFIG_HOME, undefined, "the server's env, never the launcher env");

  f.dropForkAnswer = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", turnId: "t3", role: "user" }, 1));
  assert.deepEqual(f.forks.at(-1)?.body.serverPool, serverPool);
  await f.service.reconcileForks();
  const confirm = f.forks.at(-1)!.body;
  assert.equal(confirm.confirmOnly, true);
  assert.deepEqual(confirm.serverPool, serverPool);
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
  assert.equal(projects["/some/other/repo"], undefined, "an arbitrary cwd is never trusted");
  assert.deepEqual(Object.keys(projects), [projectPath]);
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

test("a host that stops answering a create reads as not responding, not as not running", async () => {
  const f = await makeFixture(OPENCODE, null);
  // Adopted and still healthy to the supervisor, but the request gets no answer.
  f.dropCreate = true;
  await assert.rejects(
    () =>
      f.service.createSession(
        { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p" },
        0
      ),
    (error: unknown) =>
      error instanceof ChatSessionError &&
      error.code === "HOST_UNAVAILABLE" &&
      error.message === "The agent host is not responding. Try again in a moment."
  );
  assert.deepEqual(f.service.chat.list(), [], "the tab is rolled back");
  await f.cleanup();
});

test("a conversation already open elsewhere is refused with the owning tab's id", async () => {
  const f = await makeFixture(OPENCODE, null);
  f.refuse = {
    status: 409,
    body: {
      error: {
        code: "COMMAND_REJECTED",
        message: 'That conversation is already open in "old tab".',
        detail: { code: "RESUME_UNAVAILABLE", ownerThreadId: "owner-tab" }
      }
    }
  };
  await assert.rejects(
    () =>
      f.service.createSession(
        {
          kind: "agent-chat",
          refId: "opencode",
          projectPath: "/w/p",
          cwd: "/w/p",
          chat: { modelSelection: { model: "" }, resume: { home: "system", conversationId: "ses_1" } }
        },
        0
      ),
    (error: unknown) =>
      error instanceof ChatSessionError &&
      error.code === "CONVERSATION_ALREADY_OPEN" &&
      error.ownerSessionId === "owner-tab"
  );
  assert.deepEqual(f.service.chat.list(), [], "the refused tab is rolled back");
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

test("a switch carries the recomposed serverPool: the host replaces launch.json's with it", async () => {
  const f = await switchableFixture();
  f.launchFor = (ctx) => ({
    env: { CLAUDE_CONFIG_DIR: `/homes/${ctx.accountId}` },
    accountId: ctx.accountId!,
    serverPool: { key: "keyed", env: { A: "1" } }
  });
  await f.service.switchAccount(f.sessionId, { commandId: "c1", accountId: "acc-2" });
  assert.deepEqual(f.identities[0]!.body.serverPool, { key: "keyed", env: { A: "1" } });
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
    () => f.service.switchAccount(summary.id, { commandId: "c1", accountId: "system" }),
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

test("agent goals §5.7, a host from before the hold: the snapshot read, the session stop and the hand-over reach the host as sent", async (t) => {
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
    // Narrowed to one keyed pool, or not: the body says which.
    f.recycleAnswer = { status: 200, body: { recycled: 1, deferred: 0 } };
    await f.service.recycleIdleOpenCodeServers("profile-a");
    assert.deepEqual(f.recycleBodies.at(-1), { poolKey: "profile-a" });
    assert.deepEqual(f.recycleBodies[0], {});
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

test("a host that refuses while the upload is still arriving has the daemon's request to it torn down", async (t) => {
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

test("an over-cap chat upload answers 413 UPLOAD_TOO_LARGE through the MCP seam too, and ends its owned stream", async () => {
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

test("publishHtmlRender stores the prepared page through the host's upload and answers its reference", async (t) => {
  const f = await makeFixture(CLAUDE, { env: {} });
  t.after(() => f.cleanup());
  const id = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
  // The real host answers an upload with the stored `AttachmentRef`.
  f.refuseUploadAfterBody = { status: 200, body: { type: "file", id, name: "Chart.html", sizeBytes: 1 } };
  const uploads: Array<{ url: string; body: Promise<string> }> = [];
  f.onUpload = (req) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    uploads.push({
      url: req.url ?? "",
      body: new Promise((resolve) => req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))))
    });
  };
  const reference = await f.service.publishHtmlRender({
    threadId: "thread-1",
    html: "<p>chart</p>",
    title: "Chart",
    height: 300
  });
  assert.deepEqual(reference, { attachmentId: id, title: "Chart", height: 300 });
  assert.equal(uploads.length, 1);
  const query = new URL(uploads[0]!.url, "http://host").searchParams;
  assert.equal(query.get("name"), "Chart.html");
  assert.equal(query.get("type"), "text/html");
  const stored = await uploads[0]!.body;
  assert.ok(stored.includes('<style id="orq-theme">') && stored.endsWith("<p>chart</p>"));

  // A host refusal is a store failure the tool can report.
  f.refuseUploadAfterBody = { status: 500, body: { error: { code: "COMMAND_REJECTED", message: "disk full" } } };
  await assert.rejects(
    f.service.publishHtmlRender({ threadId: "thread-1", html: "<p>x</p>", title: "T", height: 300 }),
    /disk full/
  );
});

// --- Thread lineage (spec 2026-10-14 §6) -----------------------------------

test("a fork opens in the parent's project under the parent's account, pinned", async () => {
  const seen: Array<{ accountId?: string }> = [];
  const f = await makeFixture(CLAUDE, {
    env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" },
    unset: ["ANTHROPIC_API_KEY"],
    accountId: "acc-1"
  });
  const parent = await f.service.createSession(
    { kind: "agent-chat", refId: "claude", projectPath: "/w/p", cwd: "/w/p/sub", title: "Plan" },
    0
  );
  f.launchFor = (ctx) => {
    seen.push(ctx);
    return { env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" }, unset: ["ANTHROPIC_API_KEY"], accountId: "acc-1" };
  };
  const result = await f.service.forkSession(parent.id, { messageId: "msg-7" }, 3);
  assert.deepEqual(seen, [{ accountId: "acc-1" }], "the parent's account, never the family default");
  assert.equal(f.forks.length, 1);
  const { parentId, body } = f.forks[0]!;
  assert.equal(parentId, parent.id);
  assert.equal(body.threadId, result.session.id);
  assert.deepEqual(body.fork, { messageId: "msg-7" });
  assert.equal(body.projectPath, "/w/p");
  assert.equal(body.cwd, "/w/p/sub");
  assert.equal(body.homePath, "/homes/acc-1");
  assert.equal(body.modelSelection, undefined, "the host takes the parent's model");
  assert.equal(result.session.title, "Plan (fork)");
  assert.equal(result.session.order, 3);
  assert.equal(result.strategy, "native");
  assert.deepEqual(result.session.lineage?.forkedFrom, { messageId: "msg-7", turnId: "t1" });
  assert.deepEqual(f.service.chat.get(result.session.id)?.lineage, result.lineage);
  await f.cleanup();
});

test("a system-identity parent's fork stays on the system identity", async () => {
  const seen: Array<{ accountId?: string }> = [];
  const f = await makeFixture(CLAUDE, null);
  f.launchFor = (ctx) => {
    seen.push(ctx);
    return null;
  };
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  seen.length = 0;
  await f.service.forkSession(parent.id, {}, 1);
  assert.deepEqual(seen, [{ accountId: "system" }]);
  assert.equal(f.forks[0]!.body.home, "system");
  await f.cleanup();
});

test("a fork refuses a parent whose account is gone, and rolls its tab back on a host refusal", async () => {
  const f = await makeFixture(CLAUDE, { env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" }, accountId: "acc-1" });
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.launchFor = () => null;
  await assert.rejects(f.service.forkSession(parent.id, {}, 1), /no longer available/);
  assert.equal(f.forks.length, 0, "refused before the host is asked");

  f.launchFor = () => ({ env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" }, accountId: "acc-1" });
  f.forkAnswer = {
    status: 409,
    body: { error: { code: "COMMAND_REJECTED", message: "That reply is still being written." } }
  };
  await assert.rejects(
    f.service.forkSession(parent.id, { messageId: "m" }, 1),
    (error: unknown) => error instanceof ChatSessionError && error.code === "COMMAND_REJECTED"
  );
  assert.equal(f.service.chat.list("/w/p").length, 1, "the fork's tab is rolled back");

  f.forkAnswer = { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No route for POST /threads/x/fork." } } };
  await assert.rejects(f.service.forkSession(parent.id, {}, 1), /updated agent host/);
  await assert.rejects(f.service.forkSession(parent.id, { role: "system" } as never, 1), /role must be/);
  await assert.rejects(f.service.forkSession("nope", {}, 1), /No chat session/);
  await f.cleanup();
});

// --- "Continue in another agent" ----------------------------------------------

const CODEX: RegistryEntry = {
  id: "codex",
  name: "Codex",
  kind: "agent",
  bin: ["codex"],
  resolvedBin: "/usr/bin/codex",
  enabled: true,
  installState: "idle",
  env: {},
  chat: { adapter: "codex" }
};

const CROSS_AGENT_HOST = { capabilities: { sessionProfiles: 1, crossAgentFork: 1 } };

async function continuationFixture(health: Record<string, unknown> = CROSS_AGENT_HOST) {
  const gitReads: string[] = [];
  const f = await makeFixture(
    CLAUDE,
    { env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" }, accountId: "acc-1" },
    {
      health,
      extraEntries: [CODEX, { ...CODEX, id: "off", name: "Off", enabled: false }],
      gitStatusShort: async (path) => {
        gitReads.push(path);
        return " M src/app.ts";
      }
    }
  );
  f.launchFor = (ctx): ChatLaunchEnv | null =>
    ctx.accountId === undefined
      ? { env: { CODEX_HOME: "/homes/cod-default" }, accountId: "cod-default" }
      : ctx.accountId === "system"
        ? null
        : { env: { CLAUDE_CONFIG_DIR: `/homes/${ctx.accountId}` }, accountId: ctx.accountId };
  f.accounts = [
    { id: "acc-1", agent: "claude", label: "one" } as AgentAccount,
    { id: "acc-2", agent: "claude", label: "two" } as AgentAccount,
    { id: "cod-1", agent: "codex", label: "codex one" } as AgentAccount,
    { id: "cod-default", agent: "codex", label: "codex default" } as AgentAccount
  ];
  const parent = await f.service.createSession(
    { kind: "agent-chat", refId: "claude", accountId: "acc-1", projectPath: "/w/p", cwd: "/w/p", title: "Plan" },
    0
  );
  return Object.assign(f, { parent, gitReads });
}

const CODEX_MODEL = { model: "gpt-5-codex", options: [{ id: "effort", value: "high" }] };

test("a fork continued in another agent runs on that agent, account and model, with a transcript handoff", async () => {
  const f = await continuationFixture();
  const handoff = { carried: 23, total: 41, bytes: 59_000 };
  f.forkAnswer = {
    status: 200,
    body: {
      head: { id: "x" },
      strategy: "transcript",
      lineage: { parentThreadId: f.parent.id, relation: "fork", forkedFrom: { messageId: "msg-7", turnId: "t1" }, createdAt: "c", sourceAgent: "claude", sourceModel: "opus" },
      handoff
    }
  };
  const result = await f.service.forkSession(
    f.parent.id,
    { messageId: "msg-7", refId: "codex", accountId: "cod-1", modelSelection: CODEX_MODEL },
    3
  );
  const { body } = f.forks[0]!;
  assert.equal(body.refId, "codex");
  assert.equal(body.accountId, "cod-1");
  assert.equal(body.home, "account");
  assert.deepEqual(body.modelSelection, CODEX_MODEL);
  assert.deepEqual(body.continuation, { gitStatus: " M src/app.ts" }, "the working tree rides along");
  assert.deepEqual(f.gitReads, ["/w/p"]);
  assert.deepEqual(body.fork, { messageId: "msg-7" });
  assert.equal(result.strategy, "transcript");
  assert.deepEqual(result.handoff, handoff);
  assert.equal(result.session.refId, "codex");
  assert.equal(result.session.accountId, "cod-1");
  assert.equal(result.session.title, "Plan (in Codex)");
  assert.equal(result.lineage.relation, "fork");
  assert.equal(result.lineage.sourceAgent, "claude", "lineage records the source agent");
  assert.deepEqual(f.service.chat.get(result.session.id)?.lineage, result.lineage);

  // Another agent with no account named: that agent's default account.
  const byDefault = await f.service.forkSession(f.parent.id, { refId: "codex", modelSelection: CODEX_MODEL }, 4);
  assert.equal(f.forks[1]!.body.accountId, "cod-default");
  assert.equal(byDefault.session.accountId, "cod-default");
  await f.cleanup();
});

test("the same agent under another account continues by transcript; same agent and account stays an ordinary fork", async () => {
  const f = await continuationFixture();
  await f.service.forkSession(f.parent.id, { accountId: "acc-2" }, 1);
  assert.equal(f.forks[0]!.body.refId, "claude");
  assert.equal(f.forks[0]!.body.accountId, "acc-2");
  assert.deepEqual(f.forks[0]!.body.continuation, { gitStatus: " M src/app.ts" });
  assert.equal(f.forks[0]!.body.modelSelection, undefined, "the same agent keeps the parent's model");

  // Naming the parent's own account, or a model alone, is today's fork: native, no handoff.
  await f.service.forkSession(f.parent.id, { accountId: "acc-1" }, 2);
  await f.service.forkSession(f.parent.id, { modelSelection: { model: "claude-sonnet" } }, 3);
  assert.equal("continuation" in f.forks[1]!.body, false);
  assert.equal("continuation" in f.forks[2]!.body, false);
  assert.deepEqual(f.forks[2]!.body.modelSelection, { model: "claude-sonnet" });
  assert.equal(f.forks[2]!.body.accountId, "acc-1");
  assert.equal(f.gitReads.length, 1, "only a continuation reads the working tree");
  await f.cleanup();
});

test("a continuation is validated before anything is created", async () => {
  const f = await continuationFixture();
  const refused = (code: string, pattern: RegExp) => (error: unknown) =>
    error instanceof ChatSessionError && error.code === code && pattern.test(error.message);
  await assert.rejects(f.service.forkSession(f.parent.id, { refId: "codex" }, 1), refused("INVALID_COMMAND", /modelSelection is required/));
  await assert.rejects(
    f.service.forkSession(f.parent.id, { refId: "nope", modelSelection: CODEX_MODEL }, 1),
    refused("INVALID_COMMAND", /not available to continue in/)
  );
  await assert.rejects(
    f.service.forkSession(f.parent.id, { refId: "off", modelSelection: CODEX_MODEL }, 1),
    refused("INVALID_COMMAND", /not available to continue in/)
  );
  await assert.rejects(
    f.service.forkSession(f.parent.id, { refId: "codex", accountId: "acc-2", modelSelection: CODEX_MODEL }, 1),
    refused("INVALID_COMMAND", /cannot run "Codex"/),
    "an account of another family"
  );
  await assert.rejects(
    f.service.forkSession(f.parent.id, { refId: "codex", modelSelection: { model: "" } } as never, 1),
    refused("INVALID_COMMAND", /modelSelection must name a model/)
  );
  await assert.rejects(
    f.service.forkSession(f.parent.id, { refId: "codex", modelSelection: { model: "m", options: [{ id: "x", value: 3 }] } } as never, 1),
    refused("INVALID_COMMAND", /modelSelection/)
  );
  assert.equal(f.forks.length, 0, "the host was never asked");
  assert.equal(f.service.chat.list("/w/p").length, 1, "no tab was left behind");
  await f.cleanup();
});

test("a host without cross-agent forks refuses a continuation, never forks it natively", async () => {
  const f = await continuationFixture({ capabilities: { sessionProfiles: 1 } });
  await assert.rejects(
    f.service.forkSession(f.parent.id, { refId: "codex", modelSelection: CODEX_MODEL }, 1),
    (error: unknown) => error instanceof ChatSessionError && error.code === "COMMAND_REJECTED" && /updated agent host/.test(error.message)
  );
  await assert.rejects(f.service.forkSession(f.parent.id, { accountId: "acc-2" }, 1), /updated agent host/);
  assert.equal(f.forks.length, 0);
  // An ordinary fork still goes.
  assert.equal((await f.service.forkSession(f.parent.id, {}, 1)).strategy, "native");
  await f.cleanup();
});

test("a fork key aimed at another agent is another fork: COMMAND_ID_CONFLICT", async () => {
  const f = await continuationFixture();
  const first = await f.service.forkSession(f.parent.id, { commandId: "k", messageId: "m", refId: "codex", modelSelection: CODEX_MODEL }, 1);
  const again = await f.service.forkSession(f.parent.id, { commandId: "k", messageId: "m", refId: "codex", modelSelection: CODEX_MODEL }, 1);
  assert.equal(again.session.id, first.session.id, "a repeat is the same fork");
  await assert.rejects(
    f.service.forkSession(f.parent.id, { commandId: "k", messageId: "m" }, 2),
    (error: unknown) => error instanceof ChatSessionError && error.code === "COMMAND_ID_CONFLICT"
  );
  await f.cleanup();
});

test("a delegate or opened chat names a parent in any project; any other relation is refused", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  const child = await f.service.createSession(
    {
      kind: "agent-chat",
      refId: "claude",
      projectPath: "/w/p",
      chat: { modelSelection: { model: "" }, lineage: { parentThreadId: parent.id, relation: "delegate" } }
    },
    1
  );
  assert.equal(child.lineage?.parentThreadId, parent.id);
  assert.equal(child.lineage?.relation, "delegate");
  assert.equal(f.created.at(-1)?.lineage?.relation, "delegate", "the host records it too");
  // Unified MCP design 2026-10-15 §4.1: create_session opens chats in any project.
  const elsewhere = await f.service.createSession(
    {
      kind: "agent-chat",
      refId: "claude",
      projectPath: "/w/other",
      chat: { modelSelection: { model: "" }, lineage: { parentThreadId: parent.id, relation: "delegate" } }
    },
    2
  );
  assert.equal(elsewhere.projectPath, "/w/other");
  assert.equal(elsewhere.lineage?.parentThreadId, parent.id);
  await assert.rejects(
    f.service.createSession(
      {
        kind: "agent-chat",
        refId: "claude",
        projectPath: "/w/p",
        chat: { modelSelection: { model: "" }, lineage: { parentThreadId: parent.id, relation: "fork" as never } }
      },
      2
    ),
    /relation "delegate"/
  );
  await f.cleanup();
});

test("a fork's commandId makes it idempotent: a double submit, or a repeat after a restart, is one tab", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  const [one, two] = await Promise.all([
    f.service.forkSession(parent.id, { commandId: "click-1" }, 1),
    f.service.forkSession(parent.id, { commandId: "click-1" }, 1)
  ]);
  assert.equal(one.session.id, two.session.id);
  assert.equal(f.forks.length, 1, "the in-flight repeat shares the first answer");
  // After the first landed (a restart forgot it): the same tab, the host asked again for its answer.
  const again = await f.service.forkSession(parent.id, { commandId: "click-1" }, 2);
  assert.equal(again.session.id, one.session.id);
  assert.equal(f.service.chat.list("/w/p").length, 2, "parent + one fork");
  assert.equal(f.forks.at(-1)!.body.threadId, one.session.id);
  // Another key is another fork.
  const other = await f.service.forkSession(parent.id, { commandId: "click-2" }, 3);
  assert.notEqual(other.session.id, one.session.id);
  await f.cleanup();
});

test("a delegate's lineage records its delegation depth, a fork carries its parent's, and closing the middle keeps it", async () => {
  const f = await makeFixture(CLAUDE, null);
  const top = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  const delegate = (parentId: string, order: number) =>
    f.service.createSession(
      { kind: "agent-chat", refId: "claude", projectPath: "/w/p", chat: { modelSelection: { model: "" }, lineage: { parentThreadId: parentId, relation: "delegate" } } },
      order
    );
  const d1 = await delegate(top.id, 1);
  assert.equal(d1.lineage?.delegationDepth, 1);
  const d2 = await delegate(d1.id, 2);
  assert.equal(d2.lineage?.delegationDepth, 2);
  assert.equal(f.created.at(-1)?.lineage?.delegationDepth, 2, "the host records it too");
  assert.equal(top.lineage, undefined);
  // A fork of a depth-1 task carries depth 1 (its relation is fork); a fork of a top thread none.
  const fork = await f.service.forkSession(d1.id, {}, 3);
  assert.equal(fork.lineage.delegationDepth, 1);
  assert.equal(fork.session.lineage?.delegationDepth, 1);
  assert.equal((await f.service.forkSession(top.id, {}, 4)).lineage.delegationDepth, undefined);
  // The middle thread closes: its children keep their depth, and a new one under d2 is 3.
  f.service.chat.close(d1.id);
  assert.equal(f.service.delegationDepthOf({ lineage: d2.lineage! }), 2);
  const d3 = await delegate(d2.id, 5);
  assert.equal(d3.lineage?.delegationDepth, 3);
  await f.cleanup();
});

test("opened and delegate links: agentCreated is stamped as given, and only agent-made links deepen delegationDepth (§13 c)", async () => {
  const f = await makeFixture(CLAUDE, null);
  const top = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  const open = (parentId: string, relation: "opened" | "delegate", agentCreated: boolean, order: number) =>
    f.service.createSession(
      {
        kind: "agent-chat",
        refId: "claude",
        projectPath: "/w/q",
        chat: { modelSelection: { model: "" }, lineage: { parentThreadId: parentId, relation, ...(agentCreated ? { agentCreated: true as const } : {}) } }
      },
      order
    );
  const byUser = await open(top.id, "opened", false, 1);
  assert.equal(byUser.lineage?.relation, "opened");
  assert.equal(byUser.lineage?.agentCreated, undefined, "an opened chat the user (or an external client) made is nobody's child");
  assert.equal(byUser.lineage?.delegationDepth, 0, "recorded even at 0");
  const byAgent = await open(top.id, "opened", true, 2);
  assert.equal(byAgent.lineage?.agentCreated, true);
  assert.equal(byAgent.lineage?.delegationDepth, 1);
  assert.equal(f.created.at(-1)?.lineage?.agentCreated, true, "the host records it too");
  assert.equal(f.created.at(-1)?.lineage?.relation, "opened");
  const task = await open(byAgent.id, "delegate", true, 3);
  assert.equal(task.lineage?.delegationDepth, 2, "an agent's opened chat delegating: two links");
  // Kept on the tab record across a reload of the records.
  assert.equal(f.service.chat.get(byAgent.id)?.lineage?.agentCreated, true);
  // A record from before the recorded depth is counted by the same rule.
  assert.equal(f.service.delegationDepthOf({ lineage: { parentThreadId: "gone", relation: "opened", createdAt: "" } }), 0);
  assert.equal(f.service.delegationDepthOf({ lineage: { parentThreadId: "gone", relation: "opened", createdAt: "", agentCreated: true } }), 1);
  assert.equal(f.service.delegationDepthOf({ lineage: { parentThreadId: "gone", relation: "delegate", createdAt: "" } }), 1);
  await f.cleanup();
});

test("a fork records agentCreated only when the (gated) request carries it, and keeps it on a keyed repeat", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  const byAgent = await f.service.forkSession(parent.id, { commandId: "a", agentCreated: true }, 1);
  assert.equal(byAgent.lineage.agentCreated, true);
  assert.equal(byAgent.session.lineage?.agentCreated, true);
  assert.equal(byAgent.lineage.relation, "fork");
  const repeat = await f.service.forkSession(parent.id, { commandId: "a" }, 1);
  assert.equal(repeat.lineage.agentCreated, true, "the first answer's record stands");
  const byUser = await f.service.forkSession(parent.id, {}, 2);
  assert.equal(byUser.lineage.agentCreated, undefined, "a GUI fork is nobody's child");
  await f.cleanup();
});

test("workflowOwned is stamped at creation from a workflow-owned creator (or a marked one), through delegate, opened and fork, and survives the creator closing (§5.4)", async () => {
  const f = await makeFixture(OPENCODE, null);
  const owner = { kind: "workflow" as const, workflowId: "wf-1", runId: "run-1", nodeId: "node-1" };
  const owned = await f.service.createSession({ kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p", owner }, 0);
  const free = await f.service.createSession({ kind: "agent-chat", refId: "opencode", projectPath: "/w/p", cwd: "/w/p" }, 1);
  const child = (parentId: string, relation: "opened" | "delegate", order: number) =>
    f.service.createSession(
      { kind: "agent-chat", refId: "opencode", projectPath: "/w/p", chat: { modelSelection: { model: "" }, lineage: { parentThreadId: parentId, relation, agentCreated: true } } },
      order
    );
  const delegate = await child(owned.id, "delegate", 2);
  assert.equal(delegate.lineage?.workflowOwned, true, "the creator is owned by a workflow");
  const grandchild = await child(delegate.id, "opened", 3);
  assert.equal(grandchild.lineage?.workflowOwned, true, "a descendant of an owned chat inherits it");
  const fork = await f.service.forkSession(delegate.id, {}, 4);
  assert.equal(fork.lineage.workflowOwned, true, "a fork of an owned descendant too (the daemon's stamp, not the host's)");
  assert.equal(fork.session.lineage?.workflowOwned, true);
  assert.equal((await child(free.id, "opened", 5)).lineage?.workflowOwned, undefined, "a free creator stamps nothing");
  assert.equal((await f.service.forkSession(free.id, {}, 6)).lineage.workflowOwned, undefined);

  // The owned chat and its delegate close: the marked chat still makes owned children, and the
  // marker rides sessions.json through a restart.
  f.service.chat.close(owned.id);
  f.service.chat.close(delegate.id);
  assert.equal((await child(grandchild.id, "delegate", 7)).lineage?.workflowOwned, true, "the marker alone proves it");
  const reloaded = new ChatSessionManager();
  reloaded.adopt(parseSessionsConfig({ version: 1, sessions: f.service.chat.records() }).sessions);
  assert.equal(reloaded.get(grandchild.id)?.lineage?.workflowOwned, true);
  assert.equal(reloaded.get(fork.session.id)?.lineage?.workflowOwned, true);
  await f.cleanup();
});

test("a delegate's project is compared resolved, and the child groups under the parent's spelling", async () => {
  const f = await makeFixture(CLAUDE, null);
  const projectPath = join(f.appdir, "ws", "proj");
  await mkdir(projectPath, { recursive: true });
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath }, 0);
  const child = await f.service.createSession(
    {
      kind: "agent-chat",
      refId: "claude",
      projectPath: `${f.appdir}/ws/./proj/`,
      chat: { modelSelection: { model: "" }, lineage: { parentThreadId: parent.id, relation: "delegate" } }
    },
    1
  );
  assert.equal(child.projectPath, parent.projectPath);
  assert.equal(child.lineage?.relation, "delegate");
  await f.cleanup();
});

test("a reused fork commandId with another fork point, or after its fork was closed, is COMMAND_ID_CONFLICT", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  const first = await f.service.forkSession(parent.id, { commandId: "k", messageId: "msg-1" }, 1);
  const conflict = (error: unknown) => error instanceof ChatSessionError && error.code === "COMMAND_ID_CONFLICT";
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "msg-2" }, 2), conflict);
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k" }, 2), conflict);
  assert.equal(f.forks.length, 1, "nothing reached the host");

  // After a restart forgot the key, the tab's own fork point still tells them apart.
  await f.restart();
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "msg-2" }, 2), conflict);
  assert.equal((await f.service.forkSession(parent.id, { commandId: "k", messageId: "msg-1" }, 2)).session.id, first.session.id);

  // The user closes the fork: its key never brings it (or a stand-in) back.
  f.service.chat.close(first.session.id);
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "msg-1" }, 2), conflict);
  assert.equal(f.service.chat.has(first.session.id), false);
  await f.cleanup();
});

test("a fork the host refused rolls its tab back without a host delete, so the same key forks again", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.forkAnswer = { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "That reply is still being written." } } };
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1), /still being written/);
  const id = f.forks[0]!.body.threadId;
  assert.equal(f.service.chat.has(id), false, "the tab is rolled back");
  assert.equal(f.service.chat.pendingThreadDeletes().includes(id), false, "nothing to delete on the host");
  // The turn finished: the same key (a route caller's retry) now forks, no COMMAND_ID_CONFLICT.
  f.forkAnswer = null;
  const forked = await f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1);
  assert.equal(forked.session.id, id);
  await f.cleanup();
});

test("a fork whose answer was lost keeps its tab, and the same key's retry converges on it", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkAnswer = true;
  await assert.rejects(
    f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1),
    (error: unknown) => error instanceof ChatSessionError && error.code === "HOST_UNAVAILABLE"
  );
  const id = f.forks[0]!.body.threadId;
  assert.equal(f.service.chat.has(id), true, "the host may hold the child: the tab stays");
  assert.equal(f.service.chat.pendingThreadDeletes().includes(id), false, "no delete that could kill it later");
  // The retry (MCP's HOST_UNAVAILABLE re-post) — the host answers for the child it has.
  const again = await f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1);
  assert.equal(again.session.id, id);
  assert.deepEqual(f.forks.map((fork) => fork.body.threadId), [id, id]);
  assert.equal(f.service.chat.list("/w/p").filter((tab) => tab.id === id).length, 1, "one live tab");

  // Without a key nothing can retry: a lost answer takes the tab down everywhere.
  f.dropForkAnswer = true;
  await assert.rejects(f.service.forkSession(parent.id, { messageId: "m" }, 2));
  const unkeyed = f.forks.at(-1)!.body.threadId;
  assert.equal(f.service.chat.has(unkeyed), false);
  assert.equal(f.service.chat.pendingThreadDeletes().includes(unkeyed), true);
  await f.cleanup();
});

test("a 200 fork answer without the child's head is an unknown outcome, never a refusal", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.forkAnswer = { status: 200, body: {} };
  const unavailable = (error: unknown) => error instanceof ChatSessionError && error.code === "HOST_UNAVAILABLE";
  // Keyed: the host may hold the child, so the tab stays for the retry to converge on.
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1), unavailable);
  const keyed = f.forks[0]!.body.threadId;
  assert.equal(f.service.chat.has(keyed), true);
  assert.equal(f.service.chat.pendingThreadDeletes().includes(keyed), false);
  assert.deepEqual(f.service.chat.unconfirmedForks(), [keyed]);
  // Unkeyed: nothing can retry, so the tab goes and the host's child is deleted with it.
  await assert.rejects(f.service.forkSession(parent.id, { messageId: "m" }, 2), unavailable);
  const unkeyed = f.forks.at(-1)!.body.threadId;
  assert.equal(f.service.chat.has(unkeyed), false);
  assert.equal(f.service.chat.pendingThreadDeletes().includes(unkeyed), true, "no orphan left on the host");
  await f.cleanup();
});

test("a fork tab whose answer was lost is confirmed once the host answers, its fork point set", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkAnswer = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "msg-4" }, 1));
  const id = f.forks[0]!.body.threadId;
  assert.equal(f.service.chat.get(id)?.lineage?.forkedFrom, undefined, "provisional: no fork point yet");
  await f.service.reconcileForks();
  const confirm = f.forks.at(-1)!.body;
  assert.equal(confirm.confirmOnly, true, "the reconcile never asks the host to create anything");
  assert.equal(confirm.threadId, id);
  assert.deepEqual(f.service.chat.get(id)?.lineage?.forkedFrom, { messageId: "msg-4", turnId: "t1" });
  assert.deepEqual(f.service.chat.unconfirmedForks(), []);
  // Confirmed for good: it survives sessions.json without the mark.
  const reread = parseSessionsConfig({ version: 1, sessions: f.service.chat.records() });
  assert.equal(reread.sessions.find((record) => record.id === id)?.chat?.forkUnconfirmed, undefined);
  await f.cleanup();
});

test("a fork tab the host never created is taken back by the reconcile, and its key forks again", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkUncreated = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1));
  const id = f.forks[0]!.body.threadId;
  assert.equal(f.service.chat.has(id), true, "unknown yet: kept");
  // The flag rides sessions.json, so a daemon restart still reconciles it.
  const reread = parseSessionsConfig({ version: 1, sessions: f.service.chat.records() });
  assert.equal(reread.sessions.find((record) => record.id === id)?.chat?.forkUnconfirmed, true);
  const closed: Array<{ id: string; rolledBack?: boolean }> = [];
  f.service.chat.lifecycle.on("closed", (payload: { id: string; rolledBack?: boolean }) => closed.push(payload));
  await f.service.reconcileForks();
  assert.equal(f.service.chat.has(id), false, "the stray tab is gone");
  assert.deepEqual(closed, [{ id, rolledBack: true }]);
  assert.equal(f.service.chat.pendingThreadDeletes().includes(id), false, "nothing to delete on the host");
  // A retry of the same key (the GUI re-sends it) forks afresh — no COMMAND_ID_CONFLICT.
  const again = await f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1);
  assert.equal(again.session.id, id);
  assert.deepEqual(again.session.lineage?.forkedFrom, { messageId: "m", turnId: "t1" });
  await f.cleanup();
});

test("the reconcile never deletes a child the host did create, and leaves a fork in flight alone", async (t) => {
  const f = await makeFixture(CLAUDE, null);
  t.after(() => f.cleanup());
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkUncreated = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1));
  const id = f.forks[0]!.body.threadId;
  // Hold the retry at the host boundary so reconciliation really sees it in flight.
  const client = f.service.routeDeps().client;
  const send = client.json.bind(client);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  t.mock.method(client, "json", async (...args: Parameters<typeof client.json>) => {
    if (args[0] === "POST" && args[1] === `/threads/${parent.id}/fork` &&
        (args[2] as ForkHostThreadRequest | undefined)?.confirmOnly !== true) {
      entered();
      await held;
    }
    return send(...args);
  });
  const retry = f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1);
  try {
    await started;
    await f.service.reconcileForks();
    assert.equal(f.service.chat.has(id), true, "an in-flight retry owns its provisional tab");
    assert.equal(f.service.chat.pendingThreadDeletes().includes(id), false);
  } finally {
    release();
    await retry;
  }
  assert.equal(f.service.chat.has(id), true);
  assert.deepEqual(f.service.chat.unconfirmedForks(), []);
  assert.equal(f.service.chat.pendingThreadDeletes().includes(id), false);
});

test("a new chat is announced as pending until the host has its thread, then confirmed with an update", async () => {
  const f = await makeFixture(CLAUDE, null);
  const events: Array<[string, boolean | undefined]> = [];
  f.service.chat.lifecycle.on("created", (s: { chatPending?: boolean }) => events.push(["created", s.chatPending]));
  f.service.chat.lifecycle.on("updated", (s: { chatPending?: boolean }) => events.push(["updated", s.chatPending]));
  // What a grid cell mounted on `session.created` sees: pending — so a THREAD_NOT_FOUND on its
  // stream is "starting", never "gone" — and then the update its view reconnects on.
  const created = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  assert.deepEqual(events, [["created", true], ["updated", false]]);
  assert.equal(created.chatPending, false);
  // A fork the same way: pending at creation, confirmed once the host answered.
  events.length = 0;
  const fork = await f.service.forkSession(created.id, { messageId: "m" }, 1);
  assert.deepEqual(events, [["created", true], ["updated", false]]);
  assert.equal(fork.session.chatPending, false);
  await f.cleanup();
});

test("a fork whose answer was lost stays pending, also across a restart, until the reconcile confirms it", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkAnswer = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "msg-4" }, 1));
  const id = f.forks[0]!.body.threadId;
  assert.equal(f.service.chat.get(id)?.chatPending, true);
  const reloaded = new ChatSessionManager();
  reloaded.adopt(parseSessionsConfig({ version: 1, sessions: f.service.chat.records() }).sessions);
  assert.equal(reloaded.get(id)?.chatPending, true, "a restarted daemon still says it is pending");
  await f.service.reconcileForks();
  assert.equal(f.service.chat.get(id)?.chatPending, false);
  await f.cleanup();
});

test("a plain create a daemon restart interrupted stays pending, then is confirmed or taken back (D-T2)", async () => {
  const f = await makeFixture(CLAUDE, null);
  const made = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  // While its create is in flight the record says so, persisted; once confirmed it does not.
  assert.equal(f.service.chat.records().find((record) => record.id === made.id)?.chat?.createUnconfirmed, undefined);
  const template = f.service.chat.records().find((record) => record.id === made.id)!;
  // Two tabs a restart left mid-create: the host got one of them, not the other.
  const interrupted = (id: string) => ({ ...template, id, chat: { ...template.chat!, threadId: id, createUnconfirmed: true as const } });
  const reloaded = parseSessionsConfig({ version: 1, sessions: [interrupted("held-1"), interrupted("lost-1")] }).sessions;
  f.service.chat.adopt(reloaded);
  assert.equal(f.service.chat.get("held-1")?.chatPending, true, "starting, never gone, after the restart");
  assert.equal(f.service.chat.get("lost-1")?.chatPending, true);
  f.snapshots["held-1"] = { status: 200, body: { kind: "snapshot", thread: {} } };
  f.snapshots["lost-1"] = { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "Thread 'lost-1' was not found." } } };
  await f.service.reconcileForks();
  assert.equal(f.service.chat.get("held-1")?.chatPending, false, "confirmed");
  assert.equal(f.service.chat.records().find((record) => record.id === "held-1")?.chat?.createUnconfirmed, undefined);
  assert.equal(f.service.chat.has("lost-1"), false, "taken back");
  await f.cleanup();
});

test("the reconcile re-sends the lost fork's whole request — cut and launch environment — with confirmOnly", async () => {
  const f = await makeFixture(CLAUDE, { env: { CLAUDE_CONFIG_DIR: "/homes/acc-1" }, unset: ["ANTHROPIC_API_KEY"], accountId: "acc-1" });
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkAnswer = true;
  // Unkeyed and keyed alike record their cut.
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", turnId: "t3", role: "user" }, 1));
  const original = f.forks.at(-1)!.body;
  await f.service.reconcileForks();
  const confirm = f.forks.at(-1)!.body;
  assert.equal(confirm.confirmOnly, true);
  assert.deepEqual(confirm.fork, { turnId: "t3", role: "user" }, "the cut the lost request asked for");
  assert.deepEqual(confirm.launchEnv, original.launchEnv);
  assert.deepEqual(confirm.unsetEnv, original.unsetEnv);
  assert.equal(confirm.homePath, "/homes/acc-1");
  assert.equal(confirm.accountId, "acc-1");
  await f.cleanup();
});

test("only the host's 'no such thread' takes a stray fork tab back; any other refusal keeps it for later", async () => {
  let now = 1_000_000;
  const f = await makeFixture(CLAUDE, null, { now: () => now });
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkUncreated = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1));
  const id = f.forks[0]!.body.threadId;
  for (const refusal of [
    { status: 400, body: { error: { code: "INVALID_COMMAND", message: `Thread '${id}' was deleted.` } } },
    { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "busy" } } },
    { status: 500, body: { error: { code: "COMMAND_REJECTED", message: "boom" } } }
  ]) {
    f.confirmAnswer = refusal;
    // Each answer asked fresh: the refusal backoff has its own test.
    now += FORK_CONFIRM_MAX_BACKOFF_MS;
    await f.service.reconcileForks();
    assert.equal(f.service.chat.has(id), true, `${refusal.status}: kept`);
    assert.deepEqual(f.service.chat.unconfirmedForks(), [id], `${refusal.status}: still to reconcile`);
  }
  // An older host's route miss is a "no such thread" too: it never had a fork route to create one.
  now += FORK_CONFIRM_MAX_BACKOFF_MS;
  f.confirmAnswer = { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No route for POST /threads/x/fork." } } };
  await f.service.reconcileForks();
  assert.equal(f.service.chat.has(id), false);
  await f.cleanup();
});

test("a fork the host keeps refusing to confirm is asked with a doubling backoff, then taken back (D-T2)", async () => {
  let now = 1_000_000;
  const f = await makeFixture(CLAUDE, null, { now: () => now });
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkUncreated = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1));
  const id = f.forks[0]!.body.threadId;
  f.confirmAnswer = { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "still being deleted" } } };
  const asked = () => f.forks.filter((fork) => fork.body.confirmOnly === true).length;
  await f.service.reconcileForks();
  assert.equal(asked(), 1);
  // The next tick is too soon: not asked.
  now += 5_000;
  await f.service.reconcileForks();
  assert.equal(asked(), 1, "backed off");
  // Past each doubling backoff it is asked again, until it gives up.
  for (let refusal = 2; refusal <= FORK_CONFIRM_MAX_REFUSALS; refusal += 1) {
    now += FORK_CONFIRM_MAX_BACKOFF_MS;
    await f.service.reconcileForks();
    assert.equal(asked(), refusal);
  }
  assert.equal(f.service.chat.has(id), false, "taken back");
  assert.deepEqual(f.service.chat.unconfirmedForks(), []);
  // Deliberately no host delete: a child the host may hold is left on the host, tabless.
  assert.equal(f.service.chat.pendingThreadDeletes().includes(id), false);
  await f.cleanup();
});

test("a stopped service reconciles nothing", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  f.dropForkUncreated = true;
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "k", messageId: "m" }, 1));
  const asked = f.forks.length;
  await f.service.stop();
  await f.service.reconcileForks();
  assert.equal(f.forks.length, asked, "no host request after stop()");
  assert.equal(f.service.chat.has(f.forks[0]!.body.threadId), true);
  await f.cleanup();
});

test("after a restart, a keyed fork's recorded request tells a repeat from a reuse exactly", async () => {
  const f = await makeFixture(CLAUDE, null);
  const parent = await f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/p" }, 0);
  const conflict = (error: unknown) => error instanceof ChatSessionError && error.code === "COMMAND_ID_CONFLICT";
  // The fake host resolves no fork point for a turn-only request: only the recorded request can tell.
  f.forkAnswer = {
    status: 200,
    body: { head: { id: "x" }, strategy: "native", lineage: { parentThreadId: parent.id, relation: "fork", createdAt: "t" } }
  };
  const turnFork = await f.service.forkSession(parent.id, { commandId: "t", turnId: "t1", role: "assistant" }, 1);
  await f.service.forkSession(parent.id, { commandId: "latest" }, 2);
  await f.restart();
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "t", turnId: "t1", role: "user" }, 3), conflict, "another role");
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "t", turnId: "t2", role: "assistant" }, 3), conflict, "another turn");
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "t" }, 3), conflict, "latest is another point");
  await assert.rejects(f.service.forkSession(parent.id, { commandId: "latest", turnId: "t1" }, 3), conflict);
  await f.service.forkSession(parent.id, { commandId: "t", turnId: "t1", role: "assistant" }, 3);
  await f.service.forkSession(parent.id, { commandId: "latest" }, 3);
  // It survives the record's round trip through sessions.json.
  const reread = parseSessionsConfig({ version: 1, sessions: f.service.chat.records() });
  const tab = reread.sessions.find((record) => record.id === turnFork.session.id);
  assert.equal(typeof tab?.chat?.forkFingerprint, "string");
  await f.cleanup();
});

const SHOT = { data: "iVBORw0KGgo=", mimeType: "image/png" as const, width: 728, height: 120 };

/** A page renderer that records what it is asked and answers what it is told. */
function fakeRenderer(answers: { heights?: Array<[number, number]> } = {}) {
  const calls: { measure: Array<{ html: string; widths: readonly number[]; urlFragment: string; signal?: AbortSignal }>; capture: Array<{ html: string; width: number; urlFragment: string }> } = {
    measure: [],
    capture: []
  };
  const renderer: HtmlPageRenderer = {
    available: () => true,
    measure: async (input) => {
      calls.measure.push(input);
      return answers.heights;
    },
    capture: async (input) => {
      // As the real browser: the page is made only once it has its slot.
      const html = typeof input.html === "string" ? input.html : await input.html();
      calls.capture.push({ ...input, html });
      return { screenshot: SHOT, contentHeight: 120, capturedHeight: 120, consoleMessages: [{ level: "log", text: "hi" }] };
    }
  };
  return { renderer, calls };
}

test("publishHtmlRender measures the PREPARED page at every client width and publishes the heights", async (t) => {
  const { renderer, calls } = fakeRenderer({ heights: [[1144, 200], [320, 480]] });
  const f = await makeFixture(CLAUDE, { env: {} }, { htmlPreview: renderer });
  t.after(() => f.cleanup());
  const id = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
  f.refuseUploadAfterBody = { status: 200, body: { type: "file", id, name: "Chart.html", sizeBytes: 1 } };
  const controller = new AbortController();
  const reference = await f.service.publishHtmlRender({
    threadId: "thread-1",
    html: "<p>chart</p>",
    title: "Chart",
    height: 300,
    signal: controller.signal
  });
  // Ascending, through the shared reader.
  assert.deepEqual(reference, { attachmentId: id, title: "Chart", height: 300, heights: [[320, 480], [1144, 200]] });
  assert.equal(calls.measure.length, 1);
  const measured = calls.measure[0]!;
  assert.ok(measured.html.includes('<style id="orq-theme">') && measured.html.endsWith("<p>chart</p>"), "the page as stored");
  assert.deepEqual(measured.widths, HTML_RENDER_MEASURE_WIDTHS);
  assert.ok(measured.urlFragment.startsWith("#orq-theme="));
  assert.equal(measured.signal, controller.signal);
});

test("publishHtmlRender publishes without heights when nothing could measure", async (t) => {
  const { renderer } = fakeRenderer({});
  const f = await makeFixture(CLAUDE, { env: {} }, { htmlPreview: renderer });
  t.after(() => f.cleanup());
  const id = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
  f.refuseUploadAfterBody = { status: 200, body: { type: "file", id, name: "Chart.html", sizeBytes: 1 } };
  const reference = await f.service.publishHtmlRender({ threadId: "thread-1", html: "<p>x</p>", title: "Chart", height: 300 });
  assert.deepEqual(reference, { attachmentId: id, title: "Chart", height: 300 });
});

test("previewHtmlRender screenshots the bootstrapped page with the stock theme of the appearance asked", async (t) => {
  const { renderer, calls } = fakeRenderer();
  const f = await makeFixture(CLAUDE, { env: {} }, { htmlPreview: renderer });
  t.after(() => f.cleanup());
  const preview = await f.service.previewHtmlRender({ threadId: "thread-1", html: "<p>x</p>", appearance: "light" });
  assert.deepEqual(preview, {
    screenshot: SHOT,
    width: HTML_RENDER_COLUMN_WIDTH,
    contentHeight: 120,
    capturedHeight: 120,
    consoleMessages: [{ level: "log", text: "hi" }]
  });
  const captured = calls.capture[0]!;
  assert.ok(captured.html.includes('<style id="orq-theme">'));
  assert.equal(captured.width, HTML_RENDER_COLUMN_WIDTH);
  assert.equal(captured.urlFragment, htmlRenderThemeFragment(htmlRenderStockTheme("light", HTML_RENDER_MEASURE_FONTS)));
});

test("previewHtmlRender without a page browser says so", async (t) => {
  const f = await makeFixture(CLAUDE, { env: {} });
  t.after(() => f.cleanup());
  await assert.rejects(
    f.service.previewHtmlRender({ threadId: "thread-1", html: "<p>x</p>" }),
    (error: unknown) => error instanceof HtmlPreviewError && error.code === "browser-unavailable"
  );
});
