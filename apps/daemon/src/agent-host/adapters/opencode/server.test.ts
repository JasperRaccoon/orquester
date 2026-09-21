/**
 * Server-pool tests against a **scripted mock peer** (spec §9): a tiny Node
 * script written into a temp dir and launched through the *same*
 * `spawnProviderChild` path the real `opencode serve` uses. It prints the real
 * readiness line, serves `/global/health`, and can be told to misbehave.
 *
 * That means the spawn, the stdout scrape, the 30 s handshake deadline, the
 * auth header, the version gate and the process-group kill are all exercised
 * without an account, a network call or the real CLI.
 *
 * Nothing here waits on a timer: every assertion waits on a readiness line, a
 * health response or a child exit.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterLogger } from "../../adapter.ts";
import { OpenCodeServerPool, parseServerUrl, probeFreePort } from "./server.ts";
import { basicAuthHeader } from "./http.ts";
import { MINIMUM_OPENCODE_VERSION } from "./semver.ts";

const silentLogger: AdapterLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/**
 * The mock peer. `MOCK_MODE` selects the misbehaviour:
 *   `ok`          — ready line, then a healthy server on the requested port
 *   `old`         — healthy, but a version below the §4.1 minimum
 *   `unhealthy`   — `{healthy:false}`
 *   `silent`      — binds nothing and prints nothing (handshake deadline)
 *   `die`         — exits 3 before printing anything
 *   `noisy`       — prints the `OPENCODE_SERVER_PASSWORD` warning FIRST
 */
const PEER_SOURCE = `
import { createServer } from "node:http";

const mode = process.env.MOCK_MODE ?? "ok";
const version = process.env.MOCK_VERSION ?? "${MINIMUM_OPENCODE_VERSION}";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const portArg = process.argv.find((a) => a.startsWith("--port="));
const hostArg = process.argv.find((a) => a.startsWith("--hostname="));
const port = Number(portArg?.slice("--port=".length) ?? "0");
const host = hostArg?.slice("--hostname=".length) ?? "127.0.0.1";

if (mode === "die") {
  process.stderr.write("mock peer: fatal error\\n");
  process.exit(3);
}
if (mode === "silent") {
  setInterval(() => {}, 1000);
} else {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (password !== undefined && auth !== "Basic " + Buffer.from("opencode:" + password).toString("base64")) {
      res.writeHead(401).end();
      return;
    }
    if (req.url?.startsWith("/global/health")) {
      const body = mode === "unhealthy"
        ? { healthy: false }
        : { healthy: true, version: mode === "old" ? "1.10.0" : version };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  server.listen(port, host, () => {
    if (mode === "noisy") {
      process.stdout.write("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\\n");
    }
    process.stdout.write("opencode server listening on http://" + host + ":" + server.address().port + "\\n");
  });
}
`;

interface Peer {
  dir: string;
  /** A shell shim named `opencode`, exactly as §9 describes the mock peer. */
  bin: string;
  cleanup: () => void;
}

function makePeer(): Peer {
  const dir = mkdtempSync(join(tmpdir(), "orq-opencode-peer-"));
  const script = join(dir, "peer.mjs");
  writeFileSync(script, PEER_SOURCE, "utf8");
  // The shim swallows the `serve` subcommand and forwards the flags, so the
  // pool's real argv (`serve --hostname=… --port=…`) reaches the peer
  // unchanged.
  const bin = join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/bin/sh\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { encoding: "utf8", mode: 0o755 }
  );
  return { dir, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makePool(
  peer: Peer,
  extraEnv: Record<string, string>,
  controller: AbortController,
  overrides: { serverPassword?: string | null } = {}
): OpenCodeServerPool {
  return new OpenCodeServerPool({
    logger: silentLogger,
    resolveBin: async () => peer.bin,
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      ...extraEnv
    }),
    signal: controller.signal,
    idleCloseMs: 10,
    ...(overrides.serverPassword !== undefined
      ? { serverPassword: overrides.serverPassword }
      : {})
  });
}

// The pool spawns `<bin> serve --hostname=… --port=…`; the peer is a Node
// script, so `serve` is simply an argument it ignores — which is exactly how
// the real binary's own subcommand reaches it.

test("the readiness scrape stays line-oriented past the unsecured-server warning", () => {
  const output =
    "Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n" +
    "opencode server listening on http://127.0.0.1:4096\n";
  assert.equal(parseServerUrl(output), "http://127.0.0.1:4096");
});

test("the scrape ignores a line that merely mentions the phrase", () => {
  assert.equal(
    parseServerUrl("failed to connect: opencode server listening on http://x was expected\n"),
    null
  );
  assert.equal(parseServerUrl("nothing here\n"), null);
});

test("the probed port is free and is not the well-known 4096", async () => {
  const port = await probeFreePort("127.0.0.1");
  assert.ok(port > 0 && port < 65_536);
  // `--port 0` binds 4096 when free; a probed port never silently lands there
  // unless the OS genuinely handed it out, which it will not twice in a row.
  const second = await probeFreePort("127.0.0.1");
  assert.notEqual(port, second);
});

test("a healthy peer is adopted, and the URL comes off stdout", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "noisy" }, controller);
  try {
    const handle = await pool.acquire(peer.dir);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(handle.version, MINIMUM_OPENCODE_VERSION);
    assert.ok(handle.pid !== undefined);
    handle.release();
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("`/global/health` is reached WITH the credential, as the real server demands", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  // The peer 401s anything whose Authorization is not the exact Basic form.
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller, {
    serverPassword: "fixture-password"
  });
  try {
    const handle = await pool.acquire(peer.dir);
    assert.equal(handle.serverPassword, "fixture-password");
    const client = handle.client(peer.dir);
    const health = await client.get<{ healthy: boolean }>("/global/health", { timeoutMs: 2_000 });
    assert.equal(health.healthy, true);
    assert.equal(
      client.headers().authorization,
      basicAuthHeader("fixture-password"),
      "the literal `opencode` username is load-bearing"
    );
    handle.release();
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("a server below the minimum is REFUSED with the required version in the message", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "old" }, controller);
  try {
    await assert.rejects(pool.acquire(peer.dir), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /1\.10\.0 is too old/);
      assert.match(error.message, new RegExp(MINIMUM_OPENCODE_VERSION.replace(/\./g, "\\.")));
      return true;
    });
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("an unhealthy server is refused rather than adopted", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "unhealthy" }, controller);
  try {
    await assert.rejects(pool.acquire(peer.dir), /invalid health response/);
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("a peer that dies before printing a ready line fails with its stderr excerpt", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "die" }, controller);
  try {
    await assert.rejects(pool.acquire(peer.dir), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited with code 3/);
      assert.match(error.message, /mock peer: fatal error/);
      return true;
    });
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("a bad binary fails the acquire instead of hanging", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = new OpenCodeServerPool({
    logger: silentLogger,
    resolveBin: async () => join(peer.dir, "definitely-not-here"),
    buildEnv: () => ({ PATH: "", HOME: peer.dir, TMPDIR: peer.dir }),
    signal: controller.signal,
    idleCloseMs: 10
  });
  try {
    await assert.rejects(pool.acquire(peer.dir), /failed to spawn|ENOENT/);
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("a silent peer hits the handshake deadline and the child is killed", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = new OpenCodeServerPool({
    logger: silentLogger,
    resolveBin: async () => peer.bin,
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      MOCK_MODE: "silent"
    }),
    signal: controller.signal,
    idleCloseMs: 10,
    // The real window is 30 s (`AGENT_HOST_DEADLINES.handshakeMs`); the test
    // asserts the mechanism, not the number, so the pool is given a signal it
    // can abort instead.
    serverPassword: null
  });
  const abortSoon = setTimeout(() => controller.abort(), 250);
  try {
    await assert.rejects(pool.acquire(peer.dir));
  } finally {
    clearTimeout(abortSoon);
    await pool.stopAll();
    peer.cleanup();
  }
});

test("threads of one project share one server, ref-counted, closed after the last release", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller);
  try {
    const first = await pool.acquire(peer.dir);
    const second = await pool.acquire(peer.dir);
    assert.equal(first.pid, second.pid, "one `opencode serve` per project");
    assert.equal(pool.list().length, 1);

    first.release();
    // One reference is still held: the server must stay up.
    assert.equal(second.hasExited(), false);

    const exited = second.exited;
    second.release();
    await exited;
    assert.equal(pool.list().length, 0);
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("a re-acquire inside the idle window cancels the close", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = new OpenCodeServerPool({
    logger: silentLogger,
    resolveBin: async () => peer.bin,
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      MOCK_MODE: "ok"
    }),
    signal: controller.signal,
    // A manual timer, so the test drives the close rather than waiting on it.
    idleCloseMs: 60_000
  });
  try {
    const first = await pool.acquire(peer.dir);
    first.release();
    const second = await pool.acquire(peer.dir);
    assert.equal(second.pid, first.pid, "the parked server was reused");
    assert.equal(second.hasExited(), false);
    second.release();
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("two projects get two servers", async () => {
  const peerA = makePeer();
  const peerB = makePeer();
  const controller = new AbortController();
  const pool = new OpenCodeServerPool({
    logger: silentLogger,
    resolveBin: async () => peerA.bin,
    buildEnv: ({ projectDir }) => ({
      PATH: process.env.PATH ?? "",
      HOME: projectDir,
      TMPDIR: projectDir,
      MOCK_MODE: "ok"
    }),
    signal: controller.signal,
    idleCloseMs: 10
  });
  try {
    const a = await pool.acquire(peerA.dir);
    const b = await pool.acquire(peerB.dir);
    assert.notEqual(a.pid, b.pid);
    assert.notEqual(a.url, b.url);
    assert.equal(pool.list().length, 2);
    a.release();
    b.release();
  } finally {
    await pool.stopAll();
    controller.abort();
    peerA.cleanup();
    peerB.cleanup();
  }
});

test("concurrent acquires for one project collapse onto a single start", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  let starts = 0;
  const pool = new OpenCodeServerPool({
    logger: silentLogger,
    resolveBin: async () => {
      starts += 1;
      return peer.bin;
    },
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      MOCK_MODE: "ok"
    }),
    signal: controller.signal,
    idleCloseMs: 10
  });
  try {
    const handles = await Promise.all([
      pool.acquire(peer.dir),
      pool.acquire(peer.dir),
      pool.acquire(peer.dir)
    ]);
    assert.equal(starts, 1);
    assert.equal(new Set(handles.map((handle) => handle.pid)).size, 1);
    for (const handle of handles) {
      handle.release();
    }
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("stopAll kills every server, refcount notwithstanding", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller);
  const handle = await pool.acquire(peer.dir);
  const exited = handle.exited;
  await pool.stopAll();
  await exited;
  assert.equal(handle.hasExited(), true);
  controller.abort();
  peer.cleanup();
});
