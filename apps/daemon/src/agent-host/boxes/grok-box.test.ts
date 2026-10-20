import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { localBoxConnection } from "../../boxes/testing.ts";
import { createGrokAdapter } from "../adapters/grok/index.ts";
import { createFakeContext, EventCollector } from "../adapters/codex/testing.ts";
import type { HostThreadBox } from "../host-protocol.ts";
import { createAgentHostBoxes } from "./index.ts";
import { readMcpBridgeEntry } from "./mcp-bridge-registry.ts";
import { recordingSync, recordingTokens, writeReplayPeer } from "./testing.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/grok/02-prompt-plain-text.ndjson");

interface Frame {
  method?: string;
  params?: Record<string, unknown>;
}

test("Grok in a box: signed in through grok.com's auth provider, its config overlay in the box, host servers bridged (fixture 02 replayed)", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-box-home-"));
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(join(home, "sh"), '#!/bin/sh\nprintf "%s" "/usr/bin:/bin"\n', "utf8");
  await chmod(join(home, "sh"), 0o755);
  const appdir = await mkdtemp(join(tmpdir(), "grok-box-appdir-"));
  // The account's own Claude-compat config, which Grok loads its servers from (host copy).
  const claudeJson = join(appdir, "claude.json");
  await writeFile(claudeJson, JSON.stringify({ mcpServers: { github: { command: "gh-mcp", args: [], env: { GITHUB_TOKEN: "ghp_host_secret" } } } }), "utf8");
  const peer = writeReplayPeer(FIXTURE, {
    inspect: { mcpServers: [{ name: "github", transport: "stdio", target: "gh-mcp", source: { type: "claudeJson", path: claudeJson } }] }
  });
  await symlink(peer.bin, join(home, ".local", "bin", "grok"));

  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const boxes = createAgentHostBoxes({
    appdir,
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "unused", expiresAt: null }),
    sync: recordingSync(),
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
  });
  const fake = createFakeContext({
    boxes,
    buildEnv: () => ({ PATH: "/host/bin", HOME: "/var/lib/orquester", XAI_API_KEY: "xai-host", GROK_HOME: join(appdir, "grok-home") })
  });
  const adapter = await createGrokAdapter(fake.context);
  const events = new EventCollector(adapter.events);
  const box: HostThreadBox = {
    boxId: connection.boxId,
    socketPath: "/nonexistent/relay.sock",
    sys: connection.sys,
    paths: connection.paths,
    tooling: { pathPrepend: [], env: {}, nodeRequire: [] }
  };
  const cwd = await mkdtemp(join(tmpdir(), "grok-box-project-"));
  try {
    await adapter.startSession({
      threadId: "t1",
      cwd,
      projectPath: cwd,
      home: { kind: "account", accountId: "acct-7", path: join(appdir, "grok-home") },
      box,
      modelSelection: { model: "grok-4.6" },
      runtimeMode: "approval-required"
    });
    await adapter.sendTurn({ threadId: "t1", input: "Say hi.", attachments: [], interactionMode: "default" });
    await events.waitFor((event) => event.type === "turn.completed", "turn.completed");

    const received = (await readFile(peer.logPath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Frame);
    // Spikes doc (c): `authenticate` with `grok.com` runs the auth provider before `session/new`.
    const methods = received.filter((frame) => frame.method !== undefined).map((frame) => frame.method);
    assert.deepEqual(methods.slice(0, 3), ["initialize", "authenticate", "session/new"]);
    assert.deepEqual(received[1]?.params, { methodId: "grok.com" });
    const servers = (received[2]?.params?.mcpServers ?? []) as { name: string; command: string; args: string[]; env: unknown[] }[];
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "github");
    assert.equal(servers[0]?.command, "/opt/orq-agent");
    assert.deepEqual(servers[0]?.env, []);
    const entry = await readMcpBridgeEntry(appdir, connection.boxId, servers[0]!.args[1]!);
    assert.deepEqual(entry?.target, { transport: "stdio", command: "gh-mcp", args: [], env: { GITHUB_TOKEN: "ghp_host_secret" } });
    // The overlay the box's Grok reads carries the login command.
    const overlay = await readFile(join(fake.context.tmpDir(), "grok-config", "t1", "orquester-grok.toml"), "utf8");
    assert.match(overlay, /\[auth\]\nauth_provider_command = '\/opt\/orq-agent' token grok --account acct-7|auth_provider_command = "'\/opt\/orq-agent' token grok --account acct-7"/);
  } finally {
    await adapter.stopAll();
  }
});
