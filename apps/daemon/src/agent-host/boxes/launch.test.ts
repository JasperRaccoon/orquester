import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { claudeProjectMcpServers } from "../../agent-isolation/claude-names.ts";
import { localBoxConnection } from "../../boxes/testing.ts";
import type { AdapterContext, AdapterLogger } from "../adapter.ts";
import type { HostThreadBox } from "../host-protocol.ts";
import { claudeBoxCredentials, prepareClaudeBoxSession } from "../adapters/claude/box-launch.ts";
import { createFakeContext } from "../adapters/codex/testing.ts";
import { renderGrokOverlayConfig } from "../adapters/grok/launch.ts";
import { createAgentHostBoxes, BoxLaunchError } from "./index.ts";
import { readMcpBridgeEntry } from "./mcp-bridge-registry.ts";
import { BOX_TOKEN_RESTART_MARGIN_MS } from "./token-policy.ts";
import { reattachableBoxConnection, recordingSync, recordingTokens, redirectedBoxConnection, rootedReadsBoxConnection } from "./testing.ts";

const quiet: AdapterLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * A "box" home holding a stand-in CLI in `~/.local/bin`, one of the dirs a box launch looks in,
 * and a login shell (`~/sh`) that reports a PATH without this machine's own agent CLIs.
 */
async function boxHome(bins: string[] = []): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "box-home-"));
  const dir = join(home, ".local", "bin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(home, "sh"), '#!/bin/sh\nprintf "%s" "/usr/bin:/bin"\n', "utf8");
  await chmod(join(home, "sh"), 0o755);
  for (const bin of bins) {
    await writeFile(join(dir, bin), "#!/bin/sh\necho \"9.9.9 (stand-in)\"\n", "utf8");
    await chmod(join(dir, bin), 0o755);
  }
  return home;
}

function launchBox(connection: { boxId: string; sys: HostThreadBox["sys"]; paths: HostThreadBox["paths"] }): HostThreadBox {
  return {
    boxId: connection.boxId,
    socketPath: "/nonexistent/relay.sock",
    sys: connection.sys,
    paths: connection.paths,
    tooling: { pathPrepend: [], env: {}, nodeRequire: [] }
  };
}

test("the System account never launches in a box (spec §7); OpenCode, which has no managed accounts, may", async () => {
  const home = await boxHome(["opencode"]);
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const sync = recordingSync();
  const boxes = createAgentHostBoxes({
    appdir: await mkdtemp(join(tmpdir(), "box-appdir-")),
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync,
    logger: quiet
  });
  await assert.rejects(
    boxes.launch({ threadId: "t1", agent: "claude", box: launchBox(connection), home: { kind: "system", path: "/home/u" }, cwd: "/w/p" }),
    (error: unknown) => error instanceof BoxLaunchError && error.code === "BOX_SYSTEM_ACCOUNT"
  );
  // Nothing was synced or started for the refused launch.
  assert.equal(sync.calls.length, 0);
  const launch = await boxes.launch({ threadId: "t2", agent: "opencode", box: launchBox(connection), home: { kind: "system", path: "/home/u" }, cwd: "/w/p" });
  assert.equal(launch.bin, join(home, ".local", "bin", "opencode"));
});

test("a launch syncs the CLI's config roots first, pushes the transcript of a resume, and resolves the CLI in the box", async () => {
  const home = await boxHome(["claude"]);
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const sync = recordingSync();
  const boxes = createAgentHostBoxes({
    appdir: await mkdtemp(join(tmpdir(), "box-appdir-")),
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync,
    logger: quiet
  });
  const launch = await boxes.launch({
    threadId: "t1",
    agent: "claude",
    box: launchBox(connection),
    home: { kind: "account", accountId: "acct-1", path: "/accounts/claude/acct-1/home" },
    cwd: "/w/p",
    profile: { profileId: "p1", revision: "3", preparedDir: "/profiles/p1/prepared" },
    resumeSessionRef: "session-7"
  });
  assert.deepEqual(
    sync.calls.map((call) => call.op),
    ["ensureSynced", "pushForResume"]
  );
  assert.deepEqual(sync.calls[0]?.detail, {
    agent: "claude",
    configRoots: ["/accounts/claude/acct-1/home", "/profiles/p1/prepared"],
    threadId: "t1"
  });
  assert.deepEqual(sync.calls[1]?.detail, { agent: "claude", configRoot: "/accounts/claude/acct-1/home", cwd: "/w/p", sessionRef: "session-7" });
  assert.equal(launch.bin, join(home, ".local", "bin", "claude"));
  assert.equal(launch.accountId, "acct-1");
  assert.equal(await launch.version(), "9.9.9 (stand-in)");
});

test("a CLI missing in the box is installed on first use; a failing install is the chat's clear error", async () => {
  const home = await boxHome();
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const target = join(home, ".local", "bin", "codex");
  const make = (installCommand: string) =>
    createAgentHostBoxes({
      appdir: join(home, "appdir"),
      connector: () => connection,
      tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
      sync: recordingSync(),
      logger: quiet,
      installCommands: { codex: installCommand }
    });
  const input = {
    threadId: "t1",
    agent: "codex" as const,
    box: launchBox(connection),
    home: { kind: "account" as const, accountId: "a", path: "/accounts/codex/a/home" },
    cwd: "/w/p"
  };
  await assert.rejects(
    make("echo 'npm ERR! network' >&2; exit 1").launch(input),
    (error: unknown) => error instanceof BoxLaunchError && error.code === "BOX_CLI_INSTALL_FAILED" && /npm ERR! network/.test(error.message)
  );
  const launch = await make(`printf '#!/bin/sh\\necho codex-cli 0.159.0\\n' > '${target}' && chmod +x '${target}'`).launch(input);
  assert.equal(launch.bin, target);
});

test("Claude's box login: a refresh-token-free credentials file, rewritten only when the token runs short", async () => {
  const home = await boxHome(["claude"]);
  const root = await mkdtemp(join(tmpdir(), "box-root-"));
  const connection = redirectedBoxConnection(localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } }), root);
  let now = 1_800_000_000_000;
  const tokens = recordingTokens({
    accessToken: "access-1",
    expiresAt: now + 8 * 60 * 60_000,
    extra: { scopes: "user:inference user:profile", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }
  });
  const boxes = createAgentHostBoxes({ appdir: join(root, "appdir"), connector: () => connection, tokens, sync: recordingSync(), logger: quiet, now: () => now });
  const launch = await boxes.launch({
    threadId: "t1",
    agent: "claude",
    box: launchBox(connection),
    home: { kind: "account", accountId: "acct-1", path: "/accounts/claude/acct-1/home" },
    cwd: "/w/p"
  });
  const path = "/accounts/claude/acct-1/home/.credentials.json";
  await launch.installCredentials((grant) => connection.writeFile(path, JSON.stringify(claudeBoxCredentials(grant, now)), { mode: 0o600 }));
  const written = JSON.parse(await readFile(connection.localPathOf(path), "utf8")) as { claudeAiOauth: Record<string, unknown> };
  assert.deepEqual(written, {
    claudeAiOauth: {
      accessToken: "access-1",
      expiresAt: now + 8 * 60 * 60_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x"
    }
  });
  assert.equal("refreshToken" in written.claudeAiOauth, false);
  assert.deepEqual(tokens.requests[0], { boxId: connection.boxId, agent: "claude", accountId: "acct-1", minValidSeconds: 2700 });

  // Plenty of life left: nothing is asked or written.
  now += 60 * 60_000;
  tokens.grant = { accessToken: "access-2", expiresAt: now + 8 * 60 * 60_000 };
  await launch.refreshCredentials();
  assert.equal(tokens.requests.length, 1);
  // Inside the 30-minute margin: a fresh grant, the file rewritten, no restart involved.
  now = 1_800_000_000_000 + 8 * 60 * 60_000 - BOX_TOKEN_RESTART_MARGIN_MS + 1;
  await launch.refreshCredentials();
  assert.equal(tokens.requests.length, 2);
  assert.equal((JSON.parse(await readFile(connection.localPathOf(path), "utf8")) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, "access-2");
  // The new token is good for hours again: the next turn asks nothing.
  await launch.refreshCredentials();
  assert.equal(tokens.requests.length, 2);
  // A closed launch renews nothing.
  await launch.close();
  now += 9 * 60 * 60_000;
  await launch.refreshCredentials();
  assert.equal(tokens.requests.length, 2);
});

test("a turn's attachments are copied into the box at their mapped path and named by it", async () => {
  const home = await boxHome(["claude"]);
  const root = await mkdtemp(join(tmpdir(), "box-root-"));
  const windows = localBoxConnection({
    sys: { home, shell: join(home, "sh"), agentPath: "C:\\orq\\agent\\orq-agent.exe" },
    paths: { kind: "windows-prefix", prefix: "C:\\orq" }
  });
  const connection = redirectedBoxConnection(windows, root);
  const boxes = createAgentHostBoxes({
    appdir: join(root, "appdir"),
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync: recordingSync(),
    logger: quiet
  });
  const launch = await boxes.launch({
    threadId: "t1",
    agent: "claude",
    box: launchBox(connection),
    home: { kind: "account", accountId: "a", path: "/accounts/claude/a/home" },
    cwd: "/w/p"
  });
  const attachments = await mkdtemp(join(tmpdir(), "box-attachments-"));
  const file = join(attachments, "notes-txt");
  await writeFile(file, "the attachment's bytes", "utf8");
  const host = { resolveAttachmentPath: async () => file, attachmentsDir: () => attachments } as unknown as AdapterContext;
  const context = launch.adapterContext(host);
  const named = await context.resolveAttachmentPath("t1", "notes-txt");
  const expected = `C:\\orq${file.replace(/\//g, "\\")}`;
  assert.equal(named, expected);
  assert.equal(context.attachmentsDir("t1"), `C:\\orq${attachments.replace(/\//g, "\\")}`);
  assert.deepEqual(connection.writes, [expected]);
  assert.equal(await readFile(connection.localPathOf(expected), "utf8"), "the attachment's bytes");
});

test("bridged MCP servers are registered for the box and go with the launch; secrets stay in the host registry", async () => {
  const home = await boxHome(["claude"]);
  const appdir = await mkdtemp(join(tmpdir(), "box-appdir-"));
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const boxes = createAgentHostBoxes({ appdir, connector: () => connection, tokens: recordingTokens({ accessToken: "t", expiresAt: null }), sync: recordingSync(), logger: quiet });
  const launch = await boxes.launch({
    threadId: "t1",
    agent: "claude",
    box: launchBox(connection),
    home: { kind: "account", accountId: "a", path: "/accounts/claude/a/home" },
    cwd: "/w/p"
  });
  const plan = await launch.bridgeMcpServers([
    { name: "github", transport: "stdio", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "ghp_secret" } },
    { name: "local-http", transport: "http", url: "http://127.0.0.1:7777/mcp", headers: {} },
    { name: "public", transport: "http", url: "https://mcp.example.com/mcp", headers: {} }
  ]);
  assert.deepEqual(plan.bridged.map((server) => server.name), ["github", "local-http"]);
  assert.deepEqual(plan.direct.map((server) => server.name), ["public"]);
  const github = plan.bridged[0]!;
  assert.deepEqual([github.command, ...github.args], ["/opt/orq-agent", "mcp-bridge", github.serverId]);
  const entry = await readMcpBridgeEntry(appdir, connection.boxId, github.serverId);
  assert.deepEqual(entry?.target, { transport: "stdio", command: "gh-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: "ghp_secret" } });
  // Another box cannot name it.
  assert.equal(await readMcpBridgeEntry(appdir, "another-box", github.serverId), null);
  await launch.close();
  assert.equal(await readMcpBridgeEntry(appdir, connection.boxId, github.serverId), null);
  assert.deepEqual(await readdir(join(appdir, "daemon", "boxes", "mcp-bridge", connection.boxId)), []);
});

test("a turn's end mirrors the transcript back and closes the turn's config-change set", async () => {
  const sync = recordingSync();
  const boxes = createAgentHostBoxes({ appdir: "/nonexistent", connector: null, tokens: recordingTokens({ accessToken: "t", expiresAt: null }), sync, logger: quiet });
  const connection = localBoxConnection();
  const done = new Promise<void>((resolve) => {
    const original = sync.turnEnded;
    sync.turnEnded = async (boxId, threadId) => {
      await original(boxId, threadId);
      resolve();
    };
  });
  boxes.turnEnded({
    threadId: "t1",
    adapter: "codex",
    cwd: "/w/p",
    box: launchBox(connection),
    profile: { profileId: "p", revision: "1", preparedDir: "/profiles/p/prepared/codex" },
    homePath: "/accounts/codex/a/home",
    resumeCursor: { threadId: "codex-thread-9" }
  });
  await done;
  assert.deepEqual(sync.calls, [
    {
      op: "pullAfterTurn",
      boxId: connection.boxId,
      // A Codex profile chat's sessions live in its prepared home.
      detail: { agent: "codex", configRoot: "/profiles/p/prepared/codex", cwd: "/w/p", sessionRef: "codex-thread-9" }
    },
    { op: "turnEnded", boxId: connection.boxId, detail: "t1" }
  ]);
});

test("Grok's box overlay carries the login command; the command is quoted for the box's shell", async () => {
  const home = await boxHome(["grok"]);
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/var/lib/orq agent/orq-agent" } });
  const boxes = createAgentHostBoxes({ appdir: join(home, "appdir"), connector: () => connection, tokens: recordingTokens({ accessToken: "t", expiresAt: null }), sync: recordingSync(), logger: quiet });
  const launch = await boxes.launch({
    threadId: "t1",
    agent: "grok",
    box: launchBox(connection),
    home: { kind: "account", accountId: "acct-7", path: "/accounts/grok/acct-7/home" },
    cwd: "/w/p"
  });
  const command = launch.grokAuthCommand();
  assert.equal(command, "'/var/lib/orq agent/orq-agent' token grok --account acct-7");
  const overlay = renderGrokOverlayConfig({ authProviderCommand: command });
  assert.match(overlay, /\[features\]\nsupport_permission = true/);
  assert.match(overlay, /\[auth\]\nauth_provider_command = "'\/var\/lib\/orq agent\/orq-agent' token grok --account acct-7"/);
  // A host launch's overlay has no [auth] table.
  assert.doesNotMatch(renderGrokOverlayConfig(), /\[auth\]/);
});

test("a thread's process an earlier host left running in the box is stopped before its CLI starts again", async () => {
  const home = await boxHome(["claude"]);
  const connection = reattachableBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const leftover = connection.exec({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    detach: { procId: "agent-claude-t9-old-1" }
  });
  const other = connection.exec({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    detach: { procId: "agent-claude-t10-old-1" }
  });
  const leftoverExit = new Promise<string | null>((resolve) => leftover.once("exit", (_code, signal) => resolve(signal)));
  const boxes = createAgentHostBoxes({
    appdir: join(home, "appdir"),
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync: recordingSync(),
    logger: quiet
  });
  try {
    await boxes.launch({
      threadId: "t9",
      agent: "claude",
      box: launchBox(connection),
      home: { kind: "account", accountId: "a", path: "/accounts/claude/a/home" },
      cwd: "/w/p"
    });
    assert.equal(await leftoverExit, "SIGKILL");
    // Another thread's process is not this launch's to stop.
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
  } finally {
    await connection.killAll();
  }
});

test("a Claude box start loads the profile launch through the box: the project's files are the box's, the walk stops at the box's home", async () => {
  const home = await boxHome(["claude"]);
  const root = await mkdtemp(join(tmpdir(), "box-root-"));
  const boxFiles = join(root, "box");
  // The project's `.mcp.json` exists only in the box; the host path `/w/p` holds nothing.
  await mkdir(join(boxFiles, "w", "p"), { recursive: true });
  await writeFile(join(boxFiles, "w", "p", ".mcp.json"), JSON.stringify({ mcpServers: { "box-only": { command: "srv" } } }));
  const local = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const connection = redirectedBoxConnection(rootedReadsBoxConnection(local, boxFiles), join(root, "writes"));
  const boxes = createAgentHostBoxes({
    appdir: join(root, "appdir"),
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync: recordingSync(),
    logger: quiet
  });
  const { context } = createFakeContext({ boxes, attachmentsDir: (threadId) => join(root, "attachments", threadId) });
  const seen: { servers: string[]; home: string }[] = [];
  const session = await prepareClaudeBoxSession({
    context,
    start: {
      threadId: "t1",
      cwd: "/w/p",
      projectPath: "/w/p",
      home: { kind: "account", accountId: "acct-1", path: "/accounts/claude/acct-1/home" },
      box: launchBox(connection),
      modelSelection: { model: "opus" },
      runtimeMode: "approval-required"
    },
    hostEnv: { CLAUDE_CONFIG_DIR: "/accounts/claude/acct-1/home", HOME: "/var/lib/orquester" },
    resumeSessionId: undefined,
    loadProfileLaunch: async ({ projectFs, home: walkHome }) => {
      seen.push({ servers: Object.keys(await claudeProjectMcpServers("/w/p", projectFs)), home: walkHome });
      return null;
    }
  });
  try {
    assert.deepEqual(seen, [{ servers: ["box-only"], home }]);
    assert.equal(session.profileLaunch, undefined, "a Global thread has none");
  } finally {
    await session.launch.close();
  }
});
