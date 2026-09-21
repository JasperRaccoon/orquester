import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RegistryEntry } from "@orquester/api";
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
  const socketPath = join(appdir, "agent-host.sock");
  const state: Fixture = {
    created: [],
    refuse: null,
    appdir,
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
    nodeBin: "/usr/bin/node",
    sleep: async () => undefined
  });
  await state.service.supervisor.init();
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
  await f.service.createSession(
    { kind: "agent-chat", refId: "claude", projectPath: "/w/p", cwd: "/w/p" },
    0
  );
  const config = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
  assert.equal(
    (config.projects as Record<string, Record<string, unknown>>)["/w/p"].hasTrustDialogAccepted,
    true
  );
  await rm(dir, { recursive: true, force: true });
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
