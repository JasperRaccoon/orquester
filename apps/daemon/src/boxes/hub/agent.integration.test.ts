/**
 * The real `orq-agent` (built from apps/box-agent with Go) against a hub on an
 * ephemeral loopback port. The "box" is this machine. A cuttable TCP proxy sits
 * between them to drop the link on demand. Skipped when Go is not installed.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { after, before, describe, test } from "node:test";

import type { BoxFsChangeEvent } from "@orquester/api";
import { boxSocketPath } from "@orquester/config";

import { spawnBoxChild } from "../../agent-host/boxes/remote-child.ts";
import { connectBoxRelay } from "../client/index.ts";
import type { BoxConnection, BoxProcess } from "../contracts.ts";
import type { BoxAgentBuilds } from "./builds.ts";
import { createBoxHub, type BoxHubServer } from "./hub.ts";
import { MemoryRecords, buildTestAgent, startCuttableProxy, startHubServer } from "./test-helpers.ts";

const BOX_ID = "box-it-000001";
const TIMEOUT = { timeout: 180_000 };

interface Ran {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

function run(proc: BoxProcess, input?: string): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  if (input !== undefined) proc.stdin.end(input);
  return new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => {
      // Let buffered output reach the listeners before resolving.
      setImmediate(() => resolve({ stdout, stderr, code, signal }));
    });
  });
}

function readAll(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    readable.on("data", (chunk: Buffer) => chunks.push(chunk));
    readable.once("end", () => resolve(Buffer.concat(chunks)));
    readable.once("error", reject);
  });
}

/** Resolves once `readable` has produced output containing `text`. */
function waitForText(readable: Readable, text: string): Promise<string> {
  let seen = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString("utf8");
      if (seen.includes(text)) {
        readable.off("data", onData);
        resolve(seen);
      }
    };
    readable.on("data", onData);
    readable.once("error", reject);
  });
}

function waitStatus(connection: BoxConnection, wanted: boolean): Promise<void> {
  return new Promise((resolve) => {
    const off = connection.onStatus((connected) => {
      if (connected === wanted) {
        off();
        resolve();
      }
    });
  });
}

async function echoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => socket.end(payload));
    let got = "";
    socket.on("data", (chunk: Buffer) => (got += chunk.toString("utf8")));
    socket.once("end", () => resolve(got));
    socket.once("error", reject);
  });
}

function startAgent(binary: string, env: Record<string, string>): { child: ChildProcess; logs: () => string; exited: Promise<number | null> } {
  const child = spawn(binary, ["run"], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  child.stderr!.on("data", (chunk: Buffer) => (logs += chunk.toString("utf8")));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return { child, logs: () => logs, exited };
}

describe("orq-agent ↔ hub", { concurrency: false }, () => {
  let root: string;
  let agentBin: string;
  let haveGo = false;
  let records: MemoryRecords;
  let hub: BoxHubServer;
  let stopServer: () => Promise<void>;
  let proxy: Awaited<ReturnType<typeof startCuttableProxy>>;
  let agent: ReturnType<typeof startAgent>;
  let connection: BoxConnection;
  let dataDir: string;
  let work: string;
  let echo: { server: Server; port: number };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "orq-it-"));
    agentBin = join(root, "bin", "orq-agent");
    await mkdir(join(root, "bin"));
    haveGo = await buildTestAgent(agentBin, "it-1");
    if (!haveGo) return;
    records = new MemoryRecords();
    records.add(BOX_ID);
    const builds: BoxAgentBuilds = { current: async () => ({ version: "it-1" }), resolve: async () => null };
    hub = createBoxHub({ appdir: root, records, verifyGithubOidc: async () => ({ ok: false, message: "unused" }), daemonUrls: () => [], builds });
    const server = await startHubServer(hub);
    stopServer = async () => {
      await hub.close();
      await server.app.close();
    };
    proxy = await startCuttableProxy(server.port);
    dataDir = join(root, "agent-data");
    work = join(root, "work");
    await mkdir(work);
    const tokenFile = join(root, "bootstrap-token");
    await writeFile(tokenFile, await hub.issueBootstrapToken(BOX_ID, 10 * 60_000), { mode: 0o600 });
    echo = await echoServer();
    agent = startAgent(agentBin, {
      ORQ_DAEMON_URL: `http://127.0.0.1:${proxy.port}`,
      ORQ_BOOTSTRAP_TOKEN_FILE: tokenFile,
      ORQ_DATA_DIR: dataDir
    });
    connection = await hub.waitConnected(BOX_ID, { timeoutMs: 120_000 });
  });

  after(async () => {
    if (!haveGo) {
      await rm(root, { recursive: true, force: true });
      return;
    }
    if (agent.child.exitCode === null) agent.child.kill("SIGKILL");
    await proxy.close();
    await stopServer();
    echo.server.close();
    await rm(root, { recursive: true, force: true });
  });

  test("handshake: credential stored 0600, bootstrap file removed, sys info", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    assert.equal(connection.agentVersion, "it-1");
    assert.equal(connection.sys.os, "linux");
    assert.equal(connection.sys.dataDir, dataDir);
    // orq-agent stores the credential before it serves the link: a round trip orders the checks.
    await connection.request("proc.list", {});
    const credential = await stat(join(dataDir, "credential"));
    assert.equal(credential.mode & 0o777, 0o600);
    await assert.rejects(stat(join(root, "bootstrap-token")), { code: "ENOENT" });
    assert.ok(records.get(BOX_ID)?.credentialHash);
    const info = await connection.request("sys.info", {});
    assert.equal(info.agentPath, agentBin);
    const stats = await connection.request("sys.stats", {});
    assert.ok(stats.memTotalBytes > 0 && stats.diskTotalBytes > 0);
    const ports = await connection.request("sys.ports", {});
    assert.ok(ports.some((p) => p.port === echo.port), "the echo server's port is listed");
  });

  test("exec with pipes: stdin, stdout, stderr, exit code, env merge, shell mode, spawn errors", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const piped = await run(connection.exec({ command: "sh", args: ["-c", 'read l; echo "out:$l"; echo err >&2; exit 3'] }), "hi\n");
    assert.deepEqual(piped, { stdout: "out:hi\n", stderr: "err\n", code: 3, signal: null });

    const env = await run(
      connection.exec({
        command: "sh",
        args: ["-c", 'echo "$FOO-${HOME:-none}-$ORQ_BOX_ID-${ORQ_AGENT_PATH:+agent}-${SSH_AUTH_SOCK:+ssh}-${ORQ_BOOTSTRAP_TOKEN_FILE:-scrubbed}"'],
        env: { FOO: "bar" },
        envUnset: ["HOME"],
        cwd: work
      })
    );
    assert.equal(env.stdout, `bar-none-${BOX_ID}-agent-ssh-scrubbed\n`);

    const shell = await run(connection.exec({ command: "echo $((1+2)) && pwd", shell: true, cwd: work }));
    assert.equal(shell.stdout, `3\n${work}\n`);

    const missing = connection.exec({ command: "definitely-not-a-command-orq" });
    const error = await new Promise<Error & { code?: string }>((resolve) => missing.once("error", resolve));
    assert.equal(error.code, "ENOENT");

    const killed = connection.exec({ command: "sleep", args: ["60"] });
    await new Promise((resolve) => killed.once("spawn", () => resolve(undefined)));
    assert.ok(killed.pid);
    assert.equal(killed.kill("SIGTERM"), true);
    const ended = await new Promise<[number | null, string | null]>((resolve) => killed.once("exit", (code, signal) => resolve([code, signal])));
    assert.deepEqual(ended, [null, "SIGTERM"]);
  });

  test("exec with a PTY: terminal size, resize", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const sized = await run(connection.exec({ command: "sh", args: ["-c", "stty size; tty"], pty: { cols: 100, rows: 30 } }));
    assert.match(sized.stdout, /30 100/);
    assert.match(sized.stdout, /\/dev\/pts\//);
    assert.equal(sized.code, 0);

    const proc = connection.exec({ command: "sh", args: ["-c", "echo ready; read x; stty size"], pty: { cols: 80, rows: 24 } });
    const output = waitForText(proc.stdout, "40 120");
    await waitForText(proc.stdout, "ready");
    proc.resize(120, 40);
    // A round trip through the box orders the resize before the input.
    await connection.request("proc.list", {});
    proc.stdin.write("\n");
    assert.match(await output, /40 120/);
  });

  test("detached process survives a dropped link and replays on attach", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const proc = connection.exec({ command: "sh", args: ["-c", 'echo one; read x; echo "two:$x"'], detach: { procId: "p1" } });
    await waitForText(proc.stdout, "one\n");
    const detached = new Promise<void>((resolve) => proc.on("detached", () => resolve()));
    const down = waitStatus(connection, false);
    const up = (async () => {
      await down;
      await waitStatus(connection, true);
    })();
    proxy.cutAll();
    await detached;
    await up;

    const listed = connection.detachedProcs().find((p) => p.procId === "p1");
    assert.ok(listed?.running, "hello.procs reports the running process");
    assert.equal(listed?.outputBytes, 4);

    const again = connection.attach("p1", 0);
    const exited = new Promise<[number | null]>((resolve) => again.once("exit", (c) => resolve([c])));
    const replayed = waitForText(again.stdout, "two:x\n");
    await waitForText(again.stdout, "one\n");
    again.stdin.write("x\n");
    assert.match(await replayed, /^one\ntwo:x\n$/);
    const [code] = await exited;
    assert.equal(code, 0);
    await connection.request("proc.release", { procId: "p1" });
    assert.equal((await connection.request("proc.list", {})).some((p) => p.procId === "p1"), false);

    // A small ring buffer: the process's own viewer cannot follow output that overwrote
    // itself, and ends with an error instead of skipping; attaching from 0 reports the loss.
    // (The process writes only once its viewer is there, on input.)
    const small = connection.exec({ command: "sh", args: ["-c", "read go; echo 0123456789abcdef; read x"], detach: { procId: "p2", bufferBytes: 8 } });
    const overrun = new Promise<Error & { code?: string }>((resolve) => small.once("error", resolve));
    await new Promise<void>((resolve) => small.once("spawn", () => resolve()));
    small.stdin.write("go\n");
    assert.equal((await overrun).code, "OUTPUT_OVERRUN");
    const late = connection.attach("p2", 0);
    const lateExit = new Promise((resolve) => late.once("exit", resolve));
    const tail = await waitForText(late.stdout, "\n");
    assert.equal(tail, "9abcdef\n");
    assert.equal(late.outputOffset, 17);
    await connection.request("proc.signal", { procId: "p2", signal: "SIGKILL" });
    await lateExit;
    await connection.request("proc.release", { procId: "p2" });
  });

  test("fs requests", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const dir = join(work, "fs");
    await connection.request("fs.mkdir", { path: join(dir, "a", "b"), recursive: true });
    await writeFile(join(dir, "a", "f.txt"), "12345");
    const st = await connection.request("fs.stat", { path: join(dir, "a", "f.txt") });
    assert.equal(st?.kind, "file");
    assert.equal(st?.size, 5);
    assert.equal((st!.mode & 0o170000) >>> 0, 0o100000);
    assert.equal(await connection.request("fs.stat", { path: join(dir, "missing") }), null);
    const entries = await connection.request("fs.readdir", { path: join(dir, "a") });
    assert.deepEqual(entries.map((e) => `${e.name}:${e.kind}`).sort(), ["b:dir", "f.txt:file"]);
    await connection.request("fs.rename", { from: join(dir, "a", "f.txt"), to: join(dir, "a", "g.txt") });
    await connection.request("fs.chmod", { path: join(dir, "a", "g.txt"), mode: 0o600 });
    assert.equal((await stat(join(dir, "a", "g.txt"))).mode & 0o777, 0o600);
    await connection.request("fs.symlink", { target: "g.txt", path: join(dir, "a", "link") });
    assert.equal(await readlink(join(dir, "a", "link")), "g.txt");
    assert.equal(await connection.request("fs.realpath", { path: join(dir, "a", "link") }), join(dir, "a", "g.txt"));
    const lst = await connection.request("fs.stat", { path: join(dir, "a", "link"), followSymlinks: false });
    assert.equal(lst?.kind, "symlink");
    await assert.rejects(connection.request("fs.readdir", { path: join(dir, "nope") }), { code: "ENOENT" });
    await assert.rejects(connection.request("fs.rm", { path: join(dir, "a") }), { code: "EISDIR" });
    await connection.request("fs.rm", { path: join(dir, "a"), recursive: true });
    await assert.rejects(stat(join(dir, "a")), { code: "ENOENT" });
    await assert.rejects(connection.requestRaw("nope.method", {}), { code: "UNKNOWN_METHOD" });
  });

  test("fs.watch emits debounced fs.change events (recursive, ignore)", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const dir = join(work, "watched");
    await mkdir(join(dir, "sub"), { recursive: true });
    await mkdir(join(dir, "node_modules"));
    const seen: BoxFsChangeEvent["changes"] = [];
    const target = join(dir, "sub", "f.txt");
    const arrived = new Promise<void>((resolve) => {
      const off = connection.onEvent("fs.change", (data) => {
        const event = data as BoxFsChangeEvent;
        if (event.watchId !== "w1") return;
        seen.push(...event.changes);
        if (seen.some((c) => c.path === target)) {
          off();
          resolve();
        }
      });
    });
    await connection.request("fs.watch", { watchId: "w1", path: dir, recursive: true, ignore: ["node_modules"] });
    await writeFile(join(dir, "node_modules", "x.js"), "ignored");
    await writeFile(target, "hello");
    await arrived;
    assert.ok(seen.some((c) => c.path === target && (c.type === "create" || c.type === "update")));
    assert.equal(seen.some((c) => c.path.includes("node_modules")), false);
    await connection.request("fs.unwatch", { watchId: "w1" });
  });

  test("file write/read: atomic, mkdirs, large with flow control, ranges, failures", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const small = join(work, "files", "deep", "hello.txt");
    await connection.writeFile(small, "hello", { mkdirs: true, mode: 0o640 });
    assert.equal(await readFile(small, "utf8"), "hello");
    assert.equal((await stat(small)).mode & 0o777, 0o640);
    assert.equal((await readAll(await connection.readFile(small))).toString(), "hello");

    const big = randomBytes(3 * 1024 * 1024 + 17);
    const bigPath = join(work, "files", "big.bin");
    const source = new PassThrough();
    const writing = connection.writeFile(bigPath, source);
    for (let i = 0; i < big.length; i += 100_000) source.write(big.subarray(i, i + 100_000));
    source.end();
    await writing;
    assert.ok((await readFile(bigPath)).equals(big));
    assert.ok((await readAll(await connection.readFile(bigPath))).equals(big));
    assert.ok((await readAll(await connection.readFile(bigPath, { offset: 1000, length: 50 }))).equals(big.subarray(1000, 1050)));

    await assert.rejects(connection.writeFile(join(small, "under-a-file"), "x"), (error: Error & { code?: string }) => error.code === "ENOTDIR" || error.code === "ENOENT");
    await assert.rejects(connection.readFile(join(work, "files", "missing")), { code: "ENOENT" });
  });

  test("tar both ways", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const local = join(root, "tar-src", "proj");
    await mkdir(join(local, "src"), { recursive: true });
    await writeFile(join(local, "src", "a.txt"), "A");
    await writeFile(join(local, "skip.log"), "L");
    await symlink("src/a.txt", join(local, "link"));
    const tar = spawn("tar", ["-cf", "-", "-C", join(root, "tar-src"), "proj"], { stdio: ["ignore", "pipe", "ignore"] });
    await connection.writeTar(join(work, "untarred"), tar.stdout!);
    assert.equal(await readFile(join(work, "untarred", "proj", "src", "a.txt"), "utf8"), "A");
    assert.equal(await readlink(join(work, "untarred", "proj", "link")), "src/a.txt");

    const stream = await connection.readTar(join(work, "untarred", "proj"), { exclude: ["*.log"] });
    const out = join(root, "tar-out");
    await mkdir(out);
    const extract = spawn("tar", ["-xf", "-", "-C", out], { stdio: ["pipe", "ignore", "ignore"] });
    stream.pipe(extract.stdin!);
    await once(extract, "exit");
    assert.equal(await readFile(join(out, "proj", "src", "a.txt"), "utf8"), "A");
    await assert.rejects(stat(join(out, "proj", "skip.log")), { code: "ENOENT" });

    await assert.rejects(connection.readTar(join(work, "no-such-dir")), { code: "ENOENT" });
  });

  test("tcp: host → box, box port on host, and forward.listen to a host target", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const tcp = await connection.openTcp(echo.port);
    tcp.end("ping");
    assert.equal((await readAll(tcp)).toString(), "ping");
    await assert.rejects(connection.openTcp(await freePort()), { code: "ECONNREFUSED" });

    const forward = await connection.forwardToHost(echo.port);
    assert.equal(await roundTrip(forward.hostPort, "via host port"), "via host port");
    await forward.close();

    hub.handleChannel("host-tcp", (_context, spec, stream) => {
      assert.equal(spec.kind, "host-tcp");
      const upstream = createConnection({ port: echo.port, host: "127.0.0.1" });
      stream.pipe(upstream).pipe(stream);
      upstream.on("error", () => stream.destroy());
      stream.on("error", () => upstream.destroy());
    });
    const boxPort = await freePort();
    await connection.request("forward.listen", { boxPort, target: "echo" });
    assert.equal(await roundTrip(boxPort, "box to host"), "box to host");
    await connection.request("forward.unlisten", { boxPort });
  });

  test("ssh-agent and mcp-bridge channels reach the host handlers", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    hub.handleChannel("ssh-agent", (_context, _spec, stream) => {
      stream.once("data", (chunk: Buffer) => stream.end(`agent:${chunk.toString()}`));
    });
    const sock = (await run(connection.exec({ command: "printenv", args: ["SSH_AUTH_SOCK"] }))).stdout.trim();
    assert.ok(sock.length > 0);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(sock, () => socket.write("hello"));
      let got = "";
      socket.on("data", (chunk: Buffer) => (got += chunk.toString()));
      socket.once("end", () => {
        socket.end();
        resolve(got);
      });
      socket.once("error", reject);
    });
    assert.equal(reply, "agent:hello");

    hub.handleChannel("mcp-bridge", (_context, spec, stream) => {
      const serverId = spec.kind === "mcp-bridge" ? spec.serverId : "?";
      stream.on("data", (chunk: Buffer) => stream.write(`${serverId}:${chunk.toString().toUpperCase()}`));
      stream.on("end", () => stream.end());
    });
    const bridged = await run(connection.exec({ command: connection.sys.agentPath, args: ["mcp-bridge", "srv1"] }), "hello\n");
    assert.equal(bridged.code, 0);
    assert.equal(bridged.stdout, "srv1:HELLO\n");
  });

  test("token, git-credential and rpc subcommands round-trip through the control socket", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    hub.handle("token.get", async (context, params) => ({
      accessToken: `tok-${params.agent}-${params.accountId}-${context.boxId}`,
      expiresAt: Date.now() + 3600_000,
      ...(params.agent === "codex" ? { extra: { chatgptAccountId: "org-1" } } : {})
    }));
    hub.handle("git.credential", async (_context, params) => ({
      output: params.operation === "get" && params.input.includes("host=github.com") ? "username=x-access-token\npassword=secret\n" : ""
    }));
    const agentPath = connection.sys.agentPath;

    const grok = await run(connection.exec({ command: agentPath, args: ["token", "grok", "--account", "acc-1"] }));
    assert.equal(grok.code, 0, grok.stderr);
    const grokJson = JSON.parse(grok.stdout) as { access_token: string; expires_in: number };
    assert.equal(grokJson.access_token, `tok-grok-acc-1-${BOX_ID}`);
    assert.ok(grokJson.expires_in > 3500 && grokJson.expires_in <= 3600);

    const codex = await run(connection.exec({ command: agentPath, args: ["token", "codex", "--account", "acc-2"] }));
    const codexJson = JSON.parse(codex.stdout) as { accessToken: string; extra: Record<string, string> };
    assert.equal(codexJson.accessToken, `tok-codex-acc-2-${BOX_ID}`);
    assert.deepEqual(codexJson.extra, { chatgptAccountId: "org-1" });

    const cred = await run(connection.exec({ command: agentPath, args: ["git-credential", "get"] }), "protocol=https\nhost=github.com\n\n");
    assert.equal(cred.stdout, "username=x-access-token\npassword=secret\n");
    const store = await run(connection.exec({ command: agentPath, args: ["git-credential", "store"] }), "protocol=https\n\n");
    assert.deepEqual([store.code, store.stdout], [0, ""]);

    const unknown = await run(connection.exec({ command: agentPath, args: ["rpc", "nope.x", "{}"] }));
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /UNKNOWN_METHOD/);
    const status = await run(connection.exec({ command: agentPath, args: ["status"] }));
    assert.deepEqual(JSON.parse(status.stdout), { connected: true, boxId: BOX_ID, version: "it-1" });
  });

  test("the relay socket gives local processes the same BoxConnection", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const relay = await connectBoxRelay(boxSocketPath(root, BOX_ID), { boxId: BOX_ID });
    try {
      assert.equal(relay.connected, true);
      assert.equal(relay.sys.dataDir, dataDir);
      assert.equal((await relay.request("fs.stat", { path: work }))?.kind, "dir");
      const echoed = await run(relay.exec({ command: "cat" }), "through the relay");
      assert.equal(echoed.stdout, "through the relay");
      const content = randomBytes(600_000);
      await relay.writeFile(join(work, "relay.bin"), content);
      assert.ok((await readAll(await relay.readFile(join(work, "relay.bin")))).equals(content));

      const dir = join(work, "relay-watch");
      await mkdir(dir);
      const target = join(dir, "x");
      const event = new Promise<void>((resolve) => {
        const off = relay.onEvent("fs.change", (data) => {
          const changes = (data as BoxFsChangeEvent).changes;
          if ((data as BoxFsChangeEvent).watchId === "rw" && changes.some((c) => c.path === target)) {
            off();
            resolve();
          }
        });
      });
      await relay.request("fs.watch", { watchId: "rw", path: dir, recursive: true });
      await writeFile(target, "x");
      await event;

      // A dropped box link shows on the relay, and requests wait for the reconnect.
      const down = waitStatus(relay, false);
      const up = waitStatus(relay, true);
      proxy.cutAll();
      await down;
      const waiting = relay.request("fs.stat", { path: work }, { timeoutMs: 60_000 });
      await up;
      assert.equal((await waiting)?.kind, "dir");
    } finally {
      relay.close();
    }
  });

  test("an agent child in the box keeps running across a dropped link and reattaches through the relay", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const relay = await connectBoxRelay(boxSocketPath(root, BOX_ID), { boxId: BOX_ID });
    try {
      const notices: string[] = [];
      const child = spawnBoxChild({
        connection: relay,
        command: "sh",
        args: ["-c", 'echo one; read x; echo "two:$x"'],
        env: {},
        cwd: work,
        detach: { procId: "rc-1" },
        onNotice: (message) => notices.push(message)
      });
      const firstLine = waitForText(child.stdout, "one\n");
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      await firstLine;
      const down = waitStatus(relay, false);
      const up = (async () => {
        await down;
        await waitStatus(relay, true);
      })();
      proxy.cutAll();
      await up;
      child.stdin.write("x\n");
      assert.deepEqual(await child.exited, { kind: "exit", code: 0, signal: null }, notices.join("\n"));
      assert.equal(out, "one\ntwo:x\n");
      assert.ok(notices.some((notice) => notice.includes("reattached at offset 4")), notices.join("\n"));
    } finally {
      relay.close();
    }
  });

  test("an agent child whose output the box dropped while it was away is ended, and its process killed", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const go = join(root, "rc2-go");
    const done = join(root, "rc2-done");
    assert.equal(spawnSync("mkfifo", [go, done]).status, 0);
    const relay = await connectBoxRelay(boxSocketPath(root, BOX_ID), { boxId: BOX_ID });
    try {
      const notices: string[] = [];
      const child = spawnBoxChild({
        connection: relay,
        command: "sh",
        // Waits for the test, writes four times its buffer, reports that locally, then idles.
        args: ["-c", `echo ready; read x < '${go}'; head -c 4096 /dev/zero; echo done > '${done}'; read y`],
        env: {},
        cwd: work,
        detach: { procId: "rc-2", bufferBytes: 1024 },
        onNotice: (message) => notices.push(message)
      });
      await waitForText(child.stdout, "ready\n");
      // The box stays away while the process writes past its buffer.
      const down = waitStatus(relay, false);
      const release = proxy.hold();
      proxy.cutAll();
      await down;
      await writeFile(go, "go\n");
      assert.equal(await readFile(done, "utf8"), "done\n");
      release();
      assert.deepEqual(await child.exited, { kind: "signal", code: null, signal: "SIGKILL" }, notices.join("\n"));
      assert.ok(notices.some((notice) => /dropped/.test(notice)), notices.join("\n"));
      const listed = (await connection.request("proc.list", {})).find((proc) => proc.procId === "rc-2");
      assert.ok(listed === undefined || !listed.running, "the process in the box was killed");
    } finally {
      relay.close();
    }
  });

  test("agent.shutdown ends orq-agent for good", TIMEOUT, async (t) => {
    if (!haveGo) return t.skip("Go toolchain not installed");
    const lost = waitStatus(connection, false);
    await connection.request("agent.shutdown", { reason: "test over" });
    assert.equal(await agent.exited, 0, agent.logs());
    await lost;
  });
});

describe("orq-agent version handshake", { concurrency: false }, () => {
  test("an outdated agent downloads the current build, verifies it, replaces itself and reconnects", TIMEOUT, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orq-up-"));
    try {
      const oldBin = join(root, "bin", "orq-agent");
      const newBin = join(root, "builds", "orq-agent");
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "builds"));
      if (!(await buildTestAgent(oldBin, "it-old"))) return t.skip("Go toolchain not installed");
      await buildTestAgent(newBin, "it-new");
      const bytes = await readFile(newBin);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const builds: BoxAgentBuilds = {
        current: async () => ({ version: "it-new" }),
        resolve: async (platform) => ({ platform, version: "it-new", path: newBin, sha256, size: bytes.length })
      };
      const records = new MemoryRecords();
      records.add("box-up-000001");
      const hub = createBoxHub({ appdir: root, records, verifyGithubOidc: async () => ({ ok: false, message: "unused" }), daemonUrls: () => [], builds, relay: false });
      const server = await startHubServer(hub);
      const tokenFile = join(root, "token");
      await writeFile(tokenFile, await hub.issueBootstrapToken("box-up-000001", 60_000), { mode: 0o600 });
      const agent = startAgent(oldBin, { ORQ_DAEMON_URL: server.url, ORQ_BOOTSTRAP_TOKEN_FILE: tokenFile, ORQ_DATA_DIR: join(root, "data") });
      try {
        const connection = await hub.waitConnected("box-up-000001", { timeoutMs: 120_000 });
        assert.equal(connection.agentVersion, "it-new", agent.logs());
        assert.ok((await readFile(oldBin)).equals(bytes), "the executable was replaced in place");
        assert.equal(agent.child.exitCode, null, "re-exec keeps the same process");
        await connection.request("agent.shutdown", { reason: "done" });
        assert.equal(await agent.exited, 0);
      } finally {
        if (agent.child.exitCode === null) agent.child.kill("SIGKILL");
        await hub.close();
        await server.app.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

