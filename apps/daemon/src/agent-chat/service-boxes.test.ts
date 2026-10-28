/**
 * Agent chats of box projects on the daemon side (spec 2026-10-19 §7, §8.5): the create sends the
 * host the box launch field (relay socket, the box's facts, its tooling); the System account, a
 * host without box support, a box that never connected and a destroyed box are refused before
 * anything is created; a host project's chat is unchanged. Also the socket-only sync route the
 * agent host calls around a box CLI's life.
 */

import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { boxPathMapFor, type RegistryEntry } from "@orquester/api";
import { agentHostSocketPath, agentHostTokenPath, boxSocketPath } from "@orquester/config";

import { agentHostAuthValue, daemonRoutesForHost, type CreateHostThreadRequest } from "../agent-host/host-protocol.ts";
import type { BoxConfigSync, BoxTranscriptSync, ProjectLocation } from "../boxes/contracts.ts";
import { localBoxConnection } from "../boxes/testing.ts";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { registerBoxHostRoutes } from "./box-host-routes.ts";
import { registerAgentChatRoutes } from "./proxy-routes.ts";
import { ChatSessionError } from "./chat-sessions.ts";
import { AgentChatService, type ChatLaunchEnv } from "./service.ts";

const CLAUDE: RegistryEntry = {
  id: "claude",
  name: "Claude Code",
  kind: "agent",
  bin: ["claude"],
  resolvedBin: "/usr/bin/claude",
  enabled: true,
  installState: "idle",
  env: {},
  chat: { adapter: "claude" }
};

interface Fixture {
  appdir: string;
  service: AgentChatService;
  created: CreateHostThreadRequest[];
  cleanup(): Promise<void>;
}

async function makeFixture(options: { boxesCapability?: boolean; location?: (path: string) => ProjectLocation } = {}): Promise<Fixture> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-chat-boxes-"));
  const socketPath = agentHostSocketPath(appdir, "linux");
  await mkdir(join(appdir, "daemon"), { recursive: true });
  await writeFile(agentHostTokenPath(appdir), "test-token\n", { mode: 0o600 });
  const created: CreateHostThreadRequest[] = [];
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const host = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (url === "/health") {
        return send(res, 200, {
          ok: true,
          protocolVersion: 1,
          hostInstanceId: "host-1",
          liveThreadIds: [],
          activeTurnThreadIds: [],
          pid: 111,
          startedAt: "2026-10-20T00:00:00.000Z",
          capabilities: { sessionProfiles: 1, ...(options.boxesCapability === false ? {} : { boxes: 1 }) }
        });
      }
      if (url === "/threads" && req.method === "POST") {
        created.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as CreateHostThreadRequest);
        return send(res, 200, {});
      }
      return send(res, 200, {});
    });
  });
  host.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => host.listen(socketPath, resolve));
  const service = new AgentChatService({
    baseDir: appdir,
    daemonDir: join(appdir, "daemon"),
    platform: "linux",
    cwd: appdir,
    sessionPath: "/usr/bin",
    env: {},
    tmux: {
      hasServiceSession: async () => false,
      killServiceSession: async () => {
        throw new Error("the fixture must never kill a host");
      },
      newServiceSession: async () => {
        throw new Error("the fixture must adopt the fake host");
      }
    },
    broadcaster: { publish: () => undefined },
    push: { notifyStructural: async () => undefined },
    registryEntry: (refId) => (refId === CLAUDE.id ? CLAUDE : undefined),
    resolveLaunchEnv: async (_entry, ctx): Promise<ChatLaunchEnv | null> => {
      const accountId = ctx.accountId === "system" ? undefined : (ctx.accountId ?? "acc-1");
      return accountId ? { env: { CLAUDE_CONFIG_DIR: `/accounts/${accountId}` }, accountId } : { env: {} };
    },
    systemClaudeConfigFile: () => join(appdir, ".claude.json"),
    resolveTrustedProjectDir: async () => null,
    sendAttachment: async (reply) => reply
  });
  service.setBoxes({
    registry: { locate: options.location ?? ((): ProjectLocation => ({ kind: "host" })) },
    tooling: { contribution: () => ({ pathPrepend: ["/var/lib/orq-agent/tools/bin"], env: {}, nodeRequire: [] }) }
  });
  await service.init();
  return {
    appdir,
    service,
    created,
    cleanup: async () => {
      await service.stop();
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await rm(appdir, { recursive: true, force: true });
    }
  };
}

const connection = localBoxConnection({ boxId: "box-1", sys: { os: "linux", home: "/root", agentPath: "/usr/local/bin/orq-agent" } });
const inBox = (state = "ready", connected: boolean = true) => (path: string): ProjectLocation =>
  path.startsWith("/w/boxed")
    ? { kind: "box", boxId: "box-1", record: { id: "box-1", state } as never, connection: connected ? connection : undefined }
    : { kind: "host" };

const create = (f: Fixture, extra: Record<string, unknown> = {}) =>
  f.service.createSession({ kind: "agent-chat", refId: "claude", projectPath: "/w/boxed", cwd: "/w/boxed", accountId: "acc-1", ...extra } as never, 0);

test("a chat of a box project tells the host where its CLI runs: relay socket, the box's facts, its tooling", async () => {
  const f = await makeFixture({ location: inBox() });
  try {
    await create(f);
    const box = f.created[0]?.box;
    assert.equal(box?.boxId, "box-1");
    assert.equal(box?.socketPath, boxSocketPath(f.appdir, "box-1"));
    assert.equal(box?.sys.agentPath, "/usr/local/bin/orq-agent");
    assert.deepEqual(box?.paths, { kind: "identity" });
    assert.deepEqual(box?.tooling.pathPrepend, ["/var/lib/orq-agent/tools/bin"]);
    // A host project's chat carries none.
    await create(f, { projectPath: "/w/host", cwd: "/w/host" });
    assert.equal("box" in f.created[1]!, false);
  } finally {
    await f.cleanup();
  }
});

test("a box chat is refused, and no tab is created, for the System account, an old host, an unconnected or destroyed box", async () => {
  const cases: { options: Parameters<typeof makeFixture>[0]; extra: Record<string, unknown>; code: string }[] = [
    { options: { location: inBox() }, extra: { accountId: "system" }, code: "BOX_SYSTEM_ACCOUNT" },
    { options: { location: inBox(), boxesCapability: false }, extra: {}, code: "COMMAND_REJECTED" },
    { options: { location: inBox("provisioning", false) }, extra: {}, code: "BOX_NOT_READY" },
    { options: { location: inBox("destroyed") }, extra: {}, code: "BOX_DESTROYED" }
  ];
  for (const { options, extra, code } of cases) {
    const f = await makeFixture(options);
    try {
      await assert.rejects(create(f, extra), (error: unknown) => error instanceof ChatSessionError && error.code === code);
      assert.equal(f.created.length, 0);
      assert.equal(f.service.chat.records().length, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("a turn in a chat whose box was destroyed since is refused (409), never forwarded to wait for a CLI that cannot start", async () => {
  let state = "ready";
  const f = await makeFixture({ location: (path) => inBox(state)(path) });
  const app = Fastify();
  try {
    registerAgentChatRoutes(app, f.service.routeDeps());
    const tab = (await create(f)) as { id: string };
    const turn = (commandId: string) =>
      app.inject({ method: "POST", url: agentChatRoutes.turn(tab.id), payload: { commandId, input: "hello" } });
    assert.equal((await turn("6b0f7a4c-1d2e-4f3a-9b8c-7d6e5f4a3b21")).statusCode, 200, "a live box's chat is forwarded");
    state = "destroyed";
    const refused = await turn("6b0f7a4c-1d2e-4f3a-9b8c-7d6e5f4a3b22");
    assert.equal(refused.statusCode, 409);
    const body = (refused.json() as { error: { code: string; message: string } }).error;
    assert.equal(body.code, "COMMAND_REJECTED");
    assert.match(body.message, /box was destroyed/);
    const compact = await app.inject({ method: "POST", url: agentChatRoutes.compact(tab.id), payload: { commandId: "6b0f7a4c-1d2e-4f3a-9b8c-7d6e5f4a3b23" } });
    assert.equal(compact.statusCode, 409);
    // Reading the chat (and other commands) stays possible.
    const interrupt = await app.inject({ method: "POST", url: agentChatRoutes.interrupt(tab.id), payload: { commandId: "6b0f7a4c-1d2e-4f3a-9b8c-7d6e5f4a3b24" } });
    assert.notEqual(interrupt.statusCode, 409);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("a session-tool call from a Windows box chat carries the box's path map (from its record while it is not connected); a POSIX box or host chat carries none", async () => {
  const windows = localBoxConnection({ boxId: "box-1", sys: { os: "win32" }, paths: boxPathMapFor("win32") });
  let location: ProjectLocation = { kind: "box", boxId: "box-1", record: { id: "box-1", state: "ready", kind: "windows" } as never, connection: windows };
  const f = await makeFixture({ location: (path) => (path.startsWith("/w/boxed") ? location : inBox()(path)) });
  try {
    const tab = (await create(f)) as { id: string };
    assert.deepEqual(f.service.sessionToolThread(tab.id)?.boxPaths, boxPathMapFor("win32"));
    location = { ...location, connection: undefined };
    assert.deepEqual(f.service.sessionToolThread(tab.id)?.boxPaths, boxPathMapFor("win32"), "a dropped box still maps its chat's paths");
    location = inBox()("/w/boxed");
    assert.equal(f.service.sessionToolThread(tab.id)?.boxPaths, undefined, "a POSIX box's paths are the host's");
    const host = (await create(f, { projectPath: "/w/host", cwd: "/w/host" })) as { id: string };
    assert.equal(f.service.sessionToolThread(host.id)?.boxPaths, undefined);
  } finally {
    await f.cleanup();
  }
});

test("the agent host's box sync route: its bearer only, field-wise bodies, each op to its seam", async () => {
  const calls: string[] = [];
  const sync: BoxConfigSync = {
    ensureSynced: async (boxId, scope) => {
      calls.push(`ensureSynced ${boxId} ${scope.agent} ${scope.configRoots.join(",")} ${scope.threadId}`);
    },
    watch: () => () => undefined,
    turnEnded: async (boxId, threadId) => {
      calls.push(`turnEnded ${boxId} ${threadId}`);
    },
    turnStarted: (boxId, threadId) => {
      calls.push(`turnStarted ${boxId} ${threadId}`);
    }
  };
  const transcripts: BoxTranscriptSync = {
    pushForResume: async (boxId, request) => {
      calls.push(`pushForResume ${boxId} ${request.sessionRef}`);
    },
    pullAfterTurn: async (boxId, request) => {
      if (request.sessionRef === "fails") throw Object.assign(new Error("the box is gone"), { code: "BOX_NOT_READY" });
      calls.push(`pullAfterTurn ${boxId} ${request.sessionRef}`);
    }
  };
  const app = Fastify();
  registerBoxHostRoutes(app, { authorizeHost: (value) => value === agentHostAuthValue("host-token"), sync, transcripts });
  const post = (body: unknown, token = "host-token") =>
    app.inject({ method: "POST", url: daemonRoutesForHost.boxSync, headers: { authorization: agentHostAuthValue(token) }, payload: body as object });
  try {
    assert.equal((await post({ op: "turnEnded", boxId: "b1", threadId: "t1" }, "other")).statusCode, 401);
    assert.equal((await post({ op: "ensureSynced", boxId: "b1", scope: { agent: "claude", configRoots: ["relative"], threadId: null } })).statusCode, 400);
    assert.equal((await post({ op: "ensureSynced", boxId: "b1", scope: { agent: "claude", configRoots: ["/a/home"], threadId: "t1" } })).statusCode, 204);
    const transcript = { agent: "claude", configRoot: "/a/home", cwd: "/w/p", sessionRef: "s1" };
    assert.equal((await post({ op: "pushForResume", boxId: "b1", transcript })).statusCode, 204);
    assert.equal((await post({ op: "turnStarted", boxId: "b1", threadId: "t1" })).statusCode, 204);
    assert.equal((await post({ op: "turnStarted", boxId: "b1", threadId: "" })).statusCode, 400);
    assert.equal((await post({ op: "turnStarted", boxId: "b1" })).statusCode, 400);
    assert.equal((await post({ op: "turnStarted", boxId: "b1", threadId: "t1" }, "other")).statusCode, 401);
    assert.equal((await post({ op: "pullAfterTurn", boxId: "b1", transcript })).statusCode, 204);
    assert.equal((await post({ op: "turnEnded", boxId: "b1", threadId: "t1" })).statusCode, 204);
    const failed = await post({ op: "pullAfterTurn", boxId: "b1", transcript: { ...transcript, sessionRef: "fails" } });
    assert.equal(failed.statusCode, 409);
    assert.equal((failed.json() as { code: string }).code, "BOX_NOT_READY");
    assert.deepEqual(calls, ["ensureSynced b1 claude /a/home t1", "pushForResume b1 s1", "turnStarted b1 t1", "pullAfterTurn b1 s1", "turnEnded b1 t1"]);
  } finally {
    await app.close();
  }
});

test("the box sync route's turnStarted: a sync without the optional hook still answers 204", async () => {
  const sync: BoxConfigSync = { ensureSynced: async () => undefined, watch: () => () => undefined, turnEnded: async () => undefined };
  const transcripts: BoxTranscriptSync = { pushForResume: async () => undefined, pullAfterTurn: async () => undefined };
  const app = Fastify();
  registerBoxHostRoutes(app, { authorizeHost: (value) => value === agentHostAuthValue("host-token"), sync, transcripts });
  try {
    const answer = await app.inject({
      method: "POST",
      url: daemonRoutesForHost.boxSync,
      headers: { authorization: agentHostAuthValue("host-token") },
      payload: { op: "turnStarted", boxId: "b1", threadId: "t1" }
    });
    assert.equal(answer.statusCode, 204);
  } finally {
    await app.close();
  }
});
