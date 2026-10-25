import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { boxMcpSettingsPath, withRunInBox } from "@orquester/config";

import { claudeProjectMcpServers } from "../../agent-isolation/claude-names.ts";
import { localBoxConnection } from "../../boxes/testing.ts";
import type { AdapterContext, AdapterLogger } from "../adapter.ts";
import type { HostThreadBox } from "../host-protocol.ts";
import { claudeBoxCredentials, prepareClaudeBoxSession } from "../adapters/claude/box-launch.ts";
import { createFakeContext, waitUntil } from "../adapters/codex/testing.ts";
import { renderGrokOverlayConfig } from "../adapters/grok/launch.ts";
import { BoxDaemonCallError } from "./daemon-client.ts";
import { createAgentHostBoxes, BoxLaunchError } from "./index.ts";
import { readMcpBridgeEntry } from "./mcp-bridge-registry.ts";
import { BOX_TOKEN_RENEW_MAX_DELAY_MS, BOX_TOKEN_RESTART_MARGIN_MS } from "./token-policy.ts";
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

test("a launch whose sync loses the box's link runs again once it is back; any other sync failure is the chat's error", async () => {
  const home = await boxHome(["claude"]);
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const failing = (failures: Error[]) => {
    const sync = recordingSync();
    const ensureSynced = sync.ensureSynced;
    sync.ensureSynced = async (boxId, scope, signal) => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      await ensureSynced(boxId, scope, signal);
    };
    return { sync, boxes: createAgentHostBoxes({ appdir: join(home, "appdir"), connector: () => connection, tokens: recordingTokens({ accessToken: "t", expiresAt: null }), sync, logger: quiet }) };
  };
  const input = {
    threadId: "t1",
    agent: "claude" as const,
    box: launchBox(connection),
    home: { kind: "account" as const, accountId: "acct-1", path: "/accounts/claude/acct-1/home" },
    cwd: "/w/p"
  };
  // orq-agent restarted under the launch (the daemon answered 500 BOX_DISCONNECTED).
  const dropped = failing([new BoxDaemonCallError("BOX_DISCONNECTED", "The box is not connected", 500)]);
  const launch = await dropped.boxes.launch(input);
  assert.equal(launch.bin, join(home, ".local", "bin", "claude"));
  assert.deepEqual(
    dropped.sync.calls.map((call) => call.op),
    ["ensureSynced"]
  );
  // Twice in a row is the chat's error, as is a failure that is not the link.
  for (const failures of [
    [new BoxDaemonCallError("BOX_NOT_READY", "The box is not connected.", 409), new BoxDaemonCallError("BOX_NOT_READY", "The box is not connected.", 409)],
    [new BoxDaemonCallError("BOX_SYNC_FAILED", "disk full", 500)]
  ]) {
    const { boxes } = failing(failures);
    await assert.rejects(boxes.launch(input), (error: unknown) => error instanceof BoxLaunchError && error.code === "BOX_SYNC_FAILED");
    assert.equal(failures.length, 0);
  }
});

test("a CLI missing in the box is installed on first use (npm's globals under the home); a failing install is the chat's clear error", async () => {
  const home = await boxHome();
  const connection = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const target = join(home, ".npm-global", "bin", "codex");
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
  // What `npm install -g` does with the prefix the install gets.
  const install = `mkdir -p "$NPM_CONFIG_PREFIX/bin" && printf '#!/bin/sh\\necho codex-cli 0.159.0\\n' > "$NPM_CONFIG_PREFIX/bin/codex" && chmod +x "$NPM_CONFIG_PREFIX/bin/codex"`;
  const launch = await make(install).launch(input);
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

test("Claude's box login is renewed mid-turn: a timer armed for the margin rewrites the file with no turn boundary", async () => {
  const home = await boxHome(["claude"]);
  const root = await mkdtemp(join(tmpdir(), "box-root-"));
  const connection = redirectedBoxConnection(localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } }), root);
  let now = 1_800_000_000_000;
  const timers: { callback: () => void; delayMs: number; done: boolean }[] = [];
  const live = () => timers.filter((timer) => !timer.done);
  const fire = (): void => {
    const [timer] = live();
    assert.ok(timer !== undefined, "a renewal timer is armed");
    timer.done = true;
    now += timer.delayMs;
    timer.callback();
  };
  const tokens = recordingTokens({ accessToken: "access-1", expiresAt: now + 8 * 60 * 60_000 });
  let failRenewal = false;
  const boxes = createAgentHostBoxes({
    appdir: join(root, "appdir"),
    connector: () => connection,
    tokens: {
      getToken: async (request, signal) => {
        if (failRenewal) throw new Error("sign-in service unreachable");
        return tokens.getToken(request, signal);
      }
    },
    sync: recordingSync(),
    logger: quiet,
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    }
  });
  const launch = await boxes.launch({
    threadId: "t1",
    agent: "claude",
    box: launchBox(connection),
    home: { kind: "account", accountId: "acct-1", path: "/accounts/claude/acct-1/home" },
    cwd: "/w/p"
  });
  const path = "/accounts/claude/acct-1/home/.credentials.json";
  const fileToken = async () =>
    (JSON.parse(await readFile(connection.localPathOf(path), "utf8")) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
  await launch.installCredentials((grant) => connection.writeFile(path, JSON.stringify(claudeBoxCredentials(grant, now)), { mode: 0o600 }));
  // Armed for the moment the token enters the 30-minute margin — at most 6 hours ahead, then
  // looked at again without asking for anything.
  assert.equal(live().length, 1);
  assert.equal(live()[0]?.delayMs, BOX_TOKEN_RENEW_MAX_DELAY_MS);
  fire();
  await waitUntil(() => live().length === 1, "the timer re-armed for the rest");
  assert.equal(tokens.requests.length, 1);
  assert.equal(live()[0]?.delayMs, 8 * 60 * 60_000 - BOX_TOKEN_RENEW_MAX_DELAY_MS - BOX_TOKEN_RESTART_MARGIN_MS + 1);

  // A turn is running (no turn boundary in sight) when the moment comes: the file is rewritten.
  tokens.grant = { accessToken: "access-2", expiresAt: now + live()[0]!.delayMs + 4 * 60 * 60_000 };
  fire();
  await waitUntil(() => live().length === 1, "the timer re-armed after the renewal");
  assert.equal(await fileToken(), "access-2");
  assert.equal(tokens.requests.length, 2);
  // Re-armed for the NEW token's margin.
  assert.equal(live()[0]?.delayMs, 4 * 60 * 60_000 - BOX_TOKEN_RESTART_MARGIN_MS + 1);

  // A renewal that fails while the token is still good is retried a minute later, not dropped.
  failRenewal = true;
  fire();
  await waitUntil(() => live().length === 1, "the retry armed");
  assert.equal(live()[0]?.delayMs, 60_000);
  assert.equal(await fileToken(), "access-2");
  failRenewal = false;
  tokens.grant = { accessToken: "access-3", expiresAt: now + 60_000 + 8 * 60 * 60_000 };
  fire();
  await waitUntil(() => live().length === 1, "the timer re-armed after the retry");
  assert.equal(await fileToken(), "access-3");

  // Closing the launch cancels the timer.
  await launch.close();
  assert.equal(live().length, 0);
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

test("a turn's start is marked in the daemon in turn order per thread, and a failing mark holds nothing up", async () => {
  const sync = recordingSync();
  const warnings: string[] = [];
  const logger: AdapterLogger = { ...quiet, warn: (message: string) => void warnings.push(message) };
  const boxes = createAgentHostBoxes({ appdir: "/nonexistent", connector: null, tokens: recordingTokens({ accessToken: "t", expiresAt: null }), sync, logger });
  const box = launchBox(localBoxConnection());
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };
  const endReached = deferred();
  const endGate = deferred();
  const otherThreadMarked = deferred();
  const secondStart = deferred();
  const original = { turnStarted: sync.turnStarted, turnEnded: sync.turnEnded };
  let starts = 0;
  sync.turnStarted = async (boxId, threadId) => {
    await original.turnStarted(boxId, threadId);
    if (threadId === "t2") return otherThreadMarked.resolve();
    starts += 1;
    // The first mark fails the way a daemon that predates the op answers.
    if (starts === 1) throw Object.assign(new Error("Not a box sync request."), { code: "INVALID_ARGUMENT" });
    secondStart.resolve();
  };
  sync.turnEnded = async (boxId, threadId) => {
    endReached.resolve();
    await endGate.promise;
    await original.turnEnded(boxId, threadId);
  };
  const ops = (): string[] => sync.calls.map((call) => `${call.op} ${call.detail === null || typeof call.detail === "string" ? call.detail : "…"}`);

  boxes.turnStarted({ threadId: "t1", box });
  boxes.turnEnded({ threadId: "t1", adapter: "codex", cwd: "/w/p", box, homePath: "/accounts/codex/a/home", resumeCursor: null });
  // The next turn starts while the first one's end is still with the daemon.
  boxes.turnStarted({ threadId: "t1", box });
  await endReached.promise;
  // Another thread's mark does not wait for t1's calls.
  boxes.turnStarted({ threadId: "t2", box });
  await otherThreadMarked.promise;
  assert.deepEqual(ops(), ["turnStarted t1", "pullAfterTurn …", "turnStarted t2"]);
  assert.equal(warnings.length, 1, "the failed mark is logged");
  assert.match(warnings[0]!, /start of a turn of t1/);

  endGate.resolve();
  await secondStart.promise;
  // The second start's mark lands after the first turn's end, so that end cannot clear it.
  assert.deepEqual(ops(), ["turnStarted t1", "pullAfterTurn …", "turnStarted t2", "turnEnded t1", "turnStarted t1"]);
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
  assert.equal(leftover.exitCode, null);
  // What the sync seams saw of the box when each was called.
  const sync = recordingSync();
  const seenAtSync: { op: string; released: string[] }[] = [];
  const ensureSynced = sync.ensureSynced;
  const pushForResume = sync.pushForResume;
  sync.ensureSynced = async (...args) => {
    seenAtSync.push({ op: "ensureSynced", released: [...connection.releases] });
    return ensureSynced(...args);
  };
  sync.pushForResume = async (...args) => {
    seenAtSync.push({ op: "pushForResume", released: [...connection.releases] });
    return pushForResume(...args);
  };
  const boxes = createAgentHostBoxes({
    appdir: join(home, "appdir"),
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync,
    logger: quiet
  });
  try {
    await boxes.launch({
      threadId: "t9",
      agent: "claude",
      box: launchBox(connection),
      home: { kind: "account", accountId: "a", path: "/accounts/claude/a/home" },
      cwd: "/w/p",
      resumeSessionRef: "session-9"
    });
    // Stopped, its exit awaited, and only then released (the box refuses a running one: BUSY) —
    // all before the config sync and the transcript push, which the leftover would race.
    assert.deepEqual(seenAtSync, [
      { op: "ensureSynced", released: ["agent-claude-t9-old-1"] },
      { op: "pushForResume", released: ["agent-claude-t9-old-1"] }
    ]);
    assert.equal(
      (await connection.request("proc.list", {})).some((proc) => proc.procId === "agent-claude-t9-old-1"),
      false
    );
    // Another thread's process is not this launch's to stop.
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
  } finally {
    await connection.killAll();
  }
});

test("a box that cannot list its processes fails the start before anything is synced", async () => {
  const home = await boxHome(["claude"]);
  const base = localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const request = base.request.bind(base) as (method: string, params: unknown) => Promise<unknown>;
  const connection = Object.assign(Object.create(base) as object, {
    request: (method: string, params: unknown) =>
      method === "proc.list" ? Promise.reject(new Error("link dropped")) : request(method, params)
  }) as typeof base;
  const sync = recordingSync();
  const boxes = createAgentHostBoxes({
    appdir: join(home, "appdir"),
    connector: () => connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync,
    logger: quiet
  });
  await assert.rejects(
    boxes.launch({
      threadId: "t9",
      agent: "claude",
      box: launchBox(connection),
      home: { kind: "account", accountId: "a", path: "/accounts/claude/a/home" },
      cwd: "/w/p",
      resumeSessionRef: "session-9"
    }),
    (error: unknown) => error instanceof BoxLaunchError && error.code === "BOX_UNAVAILABLE" && /link dropped/.test(error.message)
  );
  assert.equal(sync.calls.length, 0);
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

test("a Claude Global box start gives a \"Run in box\" server its secrets from the host's definition, in the CLI's env only", async () => {
  const home = await boxHome(["claude"]);
  const root = await mkdtemp(join(tmpdir(), "box-root-"));
  const appdir = join(root, "appdir");
  // The account's own `.claude.json` on the host (the source of truth; the box's copy has every
  // env value blanked): one server switched to "Run in box", one bridged.
  const configDir = join(root, "accounts", "claude", "acct-1", "home");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "local-db": { type: "stdio", command: "db-mcp", args: [], env: { DB_PASSWORD: "db-host-secret" } },
        remote: { type: "stdio", command: "remote-mcp", args: [], env: { REMOTE_TOKEN: "remote-host-secret" } }
      }
    })
  );
  await mkdir(dirname(boxMcpSettingsPath(appdir)), { recursive: true });
  await writeFile(boxMcpSettingsPath(appdir), JSON.stringify(withRunInBox({}, "claude", "local-db", true)));
  const connection = redirectedBoxConnection(localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } }), join(root, "box"));
  const boxes = createAgentHostBoxes({ appdir, connector: () => connection, tokens: recordingTokens({ accessToken: "t", expiresAt: null }), sync: recordingSync(), logger: quiet });
  const { context } = createFakeContext({ boxes, attachmentsDir: (threadId) => join(root, "attachments", threadId) });
  const session = await prepareClaudeBoxSession({
    context,
    start: {
      threadId: "t1",
      cwd: "/w/p",
      projectPath: "/w/p",
      home: { kind: "account", accountId: "acct-1", path: configDir },
      box: launchBox(connection),
      modelSelection: { model: "opus" },
      runtimeMode: "approval-required"
    },
    hostEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: "/var/lib/orquester" },
    resumeSessionId: undefined,
    loadProfileLaunch: async () => null
  });
  try {
    // The in-box server replaces the box copy's blanked one; its value is a `${VAR}` reference
    // the CLI expands from its own env — never in the config it is handed.
    const localDb = session.mcpServers["local-db"] as { command: string; env: Record<string, string> };
    assert.equal(localDb.command, "db-mcp");
    const [reference] = Object.values(localDb.env);
    const variable = /^\$\{(ORQ_MCP_\d+_E_DB_PASSWORD)\}$/.exec(reference ?? "")?.[1];
    assert.ok(variable !== undefined, `a \${VAR} reference, got ${reference}`);
    assert.equal(session.env[variable], "db-host-secret");
    assert.equal(JSON.stringify(session.mcpServers).includes("db-host-secret"), false);
    // The bridged one is `orq-agent mcp-bridge`; its secret stays in the host registry.
    const remote = session.mcpServers.remote as { command: string; args: string[] };
    assert.deepEqual([remote.command, remote.args[0]], ["/opt/orq-agent", "mcp-bridge"]);
    assert.equal(JSON.stringify(session.env).includes("remote-host-secret"), false);
  } finally {
    await session.launch.close();
  }
});

test("a Claude box start as root says the box is a sandbox (IS_SANDBOX=1), so Full access may skip permissions; not as a user", async () => {
  for (const isRoot of [true, false]) {
    const home = await boxHome(["claude"]);
    const root = await mkdtemp(join(tmpdir(), "box-root-"));
    const configDir = join(root, "accounts", "claude", "acct-1", "home");
    await mkdir(configDir, { recursive: true });
    const connection = redirectedBoxConnection(
      localBoxConnection({ sys: { home, shell: join(home, "sh"), agentPath: "/opt/orq-agent", isRoot } }),
      join(root, "box")
    );
    const boxes = createAgentHostBoxes({
      appdir: join(root, "appdir"),
      connector: () => connection,
      tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
      sync: recordingSync(),
      logger: quiet
    });
    const { context } = createFakeContext({ boxes, attachmentsDir: (threadId) => join(root, "attachments", threadId) });
    const session = await prepareClaudeBoxSession({
      context,
      start: {
        threadId: "t1",
        cwd: "/w/p",
        projectPath: "/w/p",
        home: { kind: "account", accountId: "acct-1", path: configDir },
        box: launchBox(connection),
        modelSelection: { model: "opus" },
        runtimeMode: "full-access"
      },
      hostEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: "/var/lib/orquester" },
      resumeSessionId: undefined,
      loadProfileLaunch: async () => null
    });
    try {
      assert.equal(session.env.IS_SANDBOX, isRoot ? "1" : undefined, `isRoot ${isRoot}`);
    } finally {
      await session.launch.close();
    }
  }
});
