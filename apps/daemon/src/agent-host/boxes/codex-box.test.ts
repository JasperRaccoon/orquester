import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentTokenGrant } from "../../boxes/contracts.ts";
import { boxMcpSettingsPath, withRunInBox } from "@orquester/config";

import { localBoxConnection } from "../../boxes/testing.ts";
import { createCodexAdapter } from "../adapters/codex/index.ts";
import { createFakeContext, EventCollector } from "../adapters/codex/testing.ts";
import type { HostThreadBox } from "../host-protocol.ts";
import { RawFrameLog } from "../store/raw-log.ts";
import { createAgentHostBoxes } from "./index.ts";
import { readMcpBridgeEntry } from "./mcp-bridge-registry.ts";
import { recordingSync, writeReplayPeer } from "./testing.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/codex/01-initialize-thread-start-text-turn.ndjson");

interface Frame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

test("Codex in a box: app-server spawned there, logged in with chatgptAuthTokens, refresh answered by the broker, MCP bridged (fixture 01 replayed)", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-box-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(join(home, "sh"), '#!/bin/sh\nprintf "%s" "/usr/bin:/bin"\n', "utf8");
  await chmod(join(home, "sh"), 0o755);
  const appdir = await mkdtemp(join(tmpdir(), "codex-box-appdir-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  // The box's `codex`: a peer answering every request with fixture 01's recorded frames; the
  // login and the refresh request it raises right after are the frames the spikes doc records
  // (spike 2: `{type: "chatgptAuthTokens"}`, then `{reason: "unauthorized", previousAccountId}`).
  const peer = writeReplayPeer(FIXTURE, {
    version: "codex-cli 0.159.0",
    results: {
      "account/login/start": { type: "chatgptAuthTokens" },
      "thread/turns/list": { data: [], nextCursor: null },
      // The box's effective config: its copy of the account's `config.toml`, every secret blanked
      // by the sync (boxes/sync/codecs.ts).
      "config/read": {
        config: {
          mcp_servers: {
            github: { command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "" } },
            "local-db": { command: "db-mcp", args: [], env: { DB_PASSWORD: "" } }
          }
        },
        origins: {},
        layers: null
      }
    },
    after: {
      "account/login/start": [
        { id: "next", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "ws-1" } }
      ]
    }
  });
  t.after(() => rm(peer.dir, { recursive: true, force: true }));
  await symlink(peer.bin, join(home, ".local", "bin", "codex"));

  // The host's `config.toml` (the source of truth) holds the real values; `local-db` is switched
  // to "Run in box".
  const accountHome = join(appdir, "accounts", "codex", "acct-1", "home");
  await mkdir(accountHome, { recursive: true });
  await writeFile(
    join(accountHome, "config.toml"),
    '[mcp_servers.github]\ncommand = "gh-mcp"\nargs = ["--stdio"]\nenv = { GITHUB_TOKEN = "ghp_host_secret" }\n\n[mcp_servers.local-db]\ncommand = "db-mcp"\nenv = { DB_PASSWORD = "db-host-secret" }\n',
    "utf8"
  );
  await mkdir(dirname(boxMcpSettingsPath(appdir)), { recursive: true });
  await writeFile(boxMcpSettingsPath(appdir), JSON.stringify(withRunInBox({}, "codex", "local-db", true)), "utf8");
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const grants: AgentTokenGrant[] = [
    { accessToken: "access-1", expiresAt: null, extra: { chatgptAccountId: "ws-1" } },
    { accessToken: "access-2", expiresAt: null, extra: { chatgptAccountId: "ws-1" } }
  ];
  const asked: string[] = [];
  const sync = recordingSync();
  const boxes = createAgentHostBoxes({
    appdir,
    connector: () => connection,
    tokens: {
      getToken: async (request) => {
        asked.push(`${request.agent}:${request.accountId}:${request.rejectedAccessToken ?? "-"}`);
        return grants.shift() ?? { accessToken: "access-n", expiresAt: null, extra: { chatgptAccountId: "ws-1" } };
      }
    },
    sync,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
  });
  const fake = createFakeContext({
    boxes,
    tmpDir: () => join(appdir, "tmp"),
    buildEnv: () => ({ PATH: "/host/bin", HOME: "/var/lib/orquester", OPENAI_API_KEY: "sk-host", ORQUESTER_SESSION_ID: "t1" })
  });
  let refreshWritten!: () => void;
  const refreshSent = new Promise<void>((resolve) => { refreshWritten = resolve; });
  const logRawFrame = fake.context.logRawFrame;
  fake.context.logRawFrame = (threadId, raw) => {
    logRawFrame(threadId, raw);
    const { direction, frame } = raw as { direction: string; frame: Frame };
    if (direction === "send" && frame.id === 1000 && frame.method === undefined) refreshWritten();
  };
  const adapter = await createCodexAdapter(fake.context);
  const events = new EventCollector(adapter.events);
  const box: HostThreadBox = {
    boxId: connection.boxId,
    socketPath: "/nonexistent/relay.sock",
    sys: connection.sys,
    paths: connection.paths,
    tooling: { pathPrepend: [], env: {}, nodeRequire: [] }
  };
  const cwd = await mkdtemp(join(tmpdir(), "codex-box-project-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  try {
    await adapter.startSession({
      threadId: "t1",
      cwd,
      projectPath: cwd,
      home: { kind: "account", accountId: "acct-1", path: accountHome },
      box,
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required"
    });
    await adapter.sendTurn({ threadId: "t1", input: "What is 17*23? Reply with just the number.", attachments: [], interactionMode: "default" });
    await events.waitFor((event) => event.type === "turn.completed", "turn.completed");

    const received = (await readFile(peer.logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Frame);
    const methods = received.filter((frame) => frame.method !== undefined).map((frame) => frame.method);
    assert.deepEqual(methods.slice(0, 5), ["initialize", "initialized", "account/login/start", "config/read", "thread/start"]);
    const login = received.find((frame) => frame.method === "account/login/start");
    assert.deepEqual(login?.params, { type: "chatgptAuthTokens", accessToken: "access-1", chatgptAccountId: "ws-1", chatgptPlanType: null });
    // The refresh request was answered with the broker's NEXT token, as the binding shapes it.
    await refreshSent;
    // The next native reply proves the peer consumed the refresh answer before its log is read.
    await adapter.readThread("t1");
    const refreshAnswer = (await readFile(peer.logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Frame)
      .find((frame) => frame.id === 1000 && frame.method === undefined);
    assert.deepEqual(refreshAnswer?.result, { accessToken: "access-2", chatgptAccountId: "ws-1", chatgptPlanType: null });
    // Neither brokered token reaches the raw frame log: the login and the refresh answer are
    // logged with their credential replaced.
    const logged = fake.rawFrames.map((entry) => entry.frame as { direction: string; frame: Frame });
    const loggedLogin = logged.find((entry) => entry.frame.method === "account/login/start");
    assert.deepEqual(loggedLogin?.frame.params, { type: "chatgptAuthTokens", accessToken: "[redacted]", chatgptAccountId: "ws-1", chatgptPlanType: null });
    const loggedAnswer = logged.find((entry) => entry.direction === "send" && entry.frame.id === 1000 && entry.frame.method === undefined);
    assert.deepEqual(loggedAnswer?.frame.result, { accessToken: "[redacted]", chatgptAccountId: "ws-1", chatgptPlanType: null });
    assert.equal(/access-[12n]/.test(JSON.stringify(fake.rawFrames)), false);
    // The refresh names the token the app-server was logged in with, so the broker renews it.
    assert.deepEqual(asked, ["codex:acct-1:-", "codex:acct-1:access-1"]);
    // The user's stdio server is replaced, under its own name, by the bridge; its secret stays here.
    const start = received.find((frame) => frame.method === "thread/start");
    const config = (start?.params?.config ?? {}) as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    const github = config["mcp_servers.github"];
    assert.equal(github?.command, "/opt/orq-agent");
    assert.equal(github?.args[0], "mcp-bridge");
    assert.deepEqual(github?.env, { GITHUB_TOKEN: "" });
    assert.equal(JSON.stringify(start).includes("ghp_host_secret"), false);
    // Its definition is the HOST's: the box's blanked copy would start it without its secret.
    const entry = await readMcpBridgeEntry(appdir, connection.boxId, github!.args[1]!);
    assert.deepEqual(entry?.target, { transport: "stdio", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "ghp_host_secret" } });
    // The "Run in box" server keeps running in the box; its blanked env value is merged back from
    // the host's definition through the thread's config (stdio), never a box file.
    assert.deepEqual(config["mcp_servers.local-db"], { env: { DB_PASSWORD: "db-host-secret" } });
    // …and the raw frame log keeps none of it (the session's frames through the real writer).
    const rawPath = join(appdir, "raw.ndjson");
    const rawLog = new RawFrameLog({ filePath: rawPath });
    for (const entry of fake.rawFrames) rawLog.write(entry.frame);
    rawLog.close();
    const rawText = await readFile(rawPath, "utf8");
    assert.ok(rawText.includes("mcp_servers.local-db"));
    assert.equal(/db-host-secret|access-[12n]/.test(rawText), false);
    // The launch synced the account home first.
    assert.equal(sync.calls[0]?.op, "ensureSynced");
  } finally {
    await adapter.stopAll();
  }
});
