import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { localBoxConnection } from "../../boxes/testing.ts";
import { createFakeContext } from "../adapters/codex/testing.ts";
import { prepareOpenCodeBoxServer } from "../adapters/opencode/box-launch.ts";
import { OpenCodeServerPool } from "../adapters/opencode/server.ts";
import { makePeer } from "../adapters/opencode/testing/peer.ts";
import type { HostThreadBox } from "../host-protocol.ts";
import { BoxLaunchError, createAgentHostBoxes } from "./index.ts";
import { readMcpBridgeEntry } from "./mcp-bridge-registry.ts";
import { recordingSync, recordingTokens } from "./testing.ts";

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function setup(t: TestContext, auth: Record<string, unknown>) {
  const home = await mkdtemp(join(tmpdir(), "opencode-box-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(join(home, "sh"), '#!/bin/sh\nprintf "%s" "/usr/bin:/bin"\n', "utf8");
  await chmod(join(home, "sh"), 0o755);
  const peer = makePeer();
  await symlink(peer.bin, join(home, ".local", "bin", "opencode"));
  // The host's own OpenCode config and logins (the source of truth; never synced).
  const xdg = await mkdtemp(join(tmpdir(), "opencode-box-xdg-"));
  t.after(() => rm(xdg, { recursive: true, force: true }));
  await mkdir(join(xdg, "config", "opencode"), { recursive: true });
  await mkdir(join(xdg, "data", "opencode"), { recursive: true });
  await writeFile(
    join(xdg, "config", "opencode", "opencode.json"),
    JSON.stringify({ mcp: { github: { type: "local", command: ["gh-mcp", "--stdio"], environment: { GITHUB_TOKEN: "ghp_host_secret" } } } }),
    "utf8"
  );
  await writeFile(join(xdg, "data", "opencode", "auth.json"), JSON.stringify(auth), "utf8");
  const appdir = await mkdtemp(join(tmpdir(), "opencode-box-appdir-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const boxes = createAgentHostBoxes({
    appdir,
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "unused", expiresAt: null }),
    sync: recordingSync(),
    logger: quiet
  });
  const fake = createFakeContext({ boxes, tmpDir: () => join(appdir, "tmp") });
  const box: HostThreadBox = {
    boxId: connection.boxId,
    socketPath: "/nonexistent/relay.sock",
    sys: connection.sys,
    paths: connection.paths,
    tooling: { pathPrepend: [], env: {}, nodeRequire: [] }
  };
  const hostEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(xdg, "config"),
    XDG_DATA_HOME: join(xdg, "data"),
    MOCK_REPORT_ENV: "OPENCODE_CONFIG_CONTENT"
  };
  return { peer, appdir, connection, fake, box, hostEnv };
}

test("OpenCode in a box refuses a host whose OpenCode is signed in with OAuth (spec §7, §17)", async (t) => {
  const { peer, fake, box, hostEnv } = await setup(t, { anthropic: { type: "oauth", refresh: "never-leaves", access: "x", expires: 0 } });
  try {
    await assert.rejects(
      prepareOpenCodeBoxServer({
        context: fake.context,
        start: { threadId: "t1", home: { kind: "system", path: hostEnv.HOME }, cwd: "/w/p", box },
        hostEnv
      }),
      (error: unknown) => error instanceof BoxLaunchError && error.code === "BOX_UNSUPPORTED" && /anthropic/.test(error.message)
    );
  } finally {
    peer.cleanup();
  }
});

test("opencode serve runs in the box, reached through a forwarded port; API keys and bridged servers ride its config content", async (t) => {
  const { peer, appdir, connection, fake, box, hostEnv } = await setup(t, { openrouter: { type: "api", key: "sk-or-host-key" } });
  const project = await mkdtemp(join(tmpdir(), "opencode-box-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const abort = new AbortController();
  const pool = new OpenCodeServerPool({
    logger: quiet,
    resolveBin: () => Promise.reject(new Error("a box server never resolves the host's binary")),
    buildEnv: () => {
      throw new Error("a box server never builds the host's env");
    },
    signal: abort.signal
  });
  try {
    const server = await prepareOpenCodeBoxServer({
      context: fake.context,
      start: { threadId: "t1", home: { kind: "system", path: hostEnv.HOME }, cwd: project, box },
      hostEnv
    });
    let released!: () => void;
    const registrationsReleased = new Promise<void>((resolve) => { released = resolve; });
    const configContent = server.configContent;
    server.configContent = async () => {
      const config = await configContent();
      return { ...config, release: async () => { await config.release(); released(); } };
    };
    const handle = await pool.acquire(project, undefined, server);
    assert.equal(handle.pid, undefined);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    // The health check already passed through the forward; the peer reports the env it got.
    const reported = await handle.client(project).get<{ OPENCODE_CONFIG_CONTENT: string }>("/__peer/env", { label: "peer env", timeoutMs: 10_000 });
    const content = JSON.parse(reported?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, { options: { apiKey: string } }>;
      mcp?: Record<string, { type: string; command: string[]; environment: Record<string, string> }>;
    };
    assert.equal(content.provider?.openrouter?.options.apiKey, "sk-or-host-key");
    const github = content.mcp?.github;
    assert.equal(github?.type, "local");
    assert.deepEqual(github?.command.slice(0, 2), ["/opt/orq-agent", "mcp-bridge"]);
    assert.deepEqual(github?.environment, { GITHUB_TOKEN: "" });
    const entry = await readMcpBridgeEntry(appdir, connection.boxId, github!.command[2]!);
    assert.deepEqual(entry?.target, { transport: "stdio", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "ghp_host_secret" } });
    handle.release();
    await pool.stopAll();
    // The server's bridge registrations went with it.
    const serverId = github!.command[2]!;
    await registrationsReleased;
    assert.equal(await readMcpBridgeEntry(appdir, connection.boxId, serverId), null);
  } finally {
    abort.abort();
    await pool.stopAll();
    peer.cleanup();
  }
});
