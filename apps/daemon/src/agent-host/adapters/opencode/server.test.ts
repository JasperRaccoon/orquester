/**
 * Server-pool tests against the **scripted mock peer** of `testing/peer.ts`
 * (spec §9), launched through the *same* `spawnProviderChild` path the real
 * `opencode serve` uses. That means the spawn, the stdout scrape, the
 * handshake deadline, the auth header, the version gate and the refcounted
 * lifecycle are all exercised without an account, a network call or the real
 * CLI. What the peer does and does not model is documented there.
 *
 * Nothing here waits on a timer: every assertion waits on a readiness line, a
 * health response or a child exit.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { AdapterLogger, StartSessionInput } from "../../adapter.ts";
import { projectDirFor } from "./index.ts";
import {
  OpenCodeServerPool,
  parseServerUrl,
  probeFreePort,
  trimToLastLines
} from "./server.ts";
import { basicAuthHeader } from "./http.ts";
import { MINIMUM_OPENCODE_VERSION } from "./semver.ts";
import { makePeer, type Peer } from "./testing/peer.ts";

const silentLogger: AdapterLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

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

test("§3.2: two threads in ONE project share one server, keyed by projectPath", async () => {
  // The end-to-end half of R4 #6: `projectDirFor` collapses both threads to
  // the project root, and the pool must then hand out the same child — one
  // `opencode serve`, one port, one catalogue probe. Before the fix these were
  // two servers.
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller);
  const seen: string[] = [];
  try {
    const rootThread = projectDirFor({
      threadId: "t1",
      cwd: peer.dir,
      projectPath: peer.dir,
      home: { kind: "system", path: peer.dir },
      modelSelection: { model: "openrouter/x" },
      runtimeMode: "approval-required"
    } as StartSessionInput);
    const subdirThread = projectDirFor({
      threadId: "t2",
      // A thread opened on a subdirectory of the same checkout.
      cwd: join(peer.dir, "packages", "ui"),
      projectPath: peer.dir,
      home: { kind: "system", path: peer.dir },
      modelSelection: { model: "openrouter/x" },
      runtimeMode: "approval-required"
    } as StartSessionInput);
    assert.equal(rootThread, subdirThread, "both threads resolve to the project root");

    const a = await pool.acquire(rootThread);
    seen.push(a.url);
    const b = await pool.acquire(subdirThread);
    seen.push(b.url);

    assert.equal(a.pid, b.pid, "one `opencode serve` for the project");
    assert.equal(a.url, b.url, "one port");
    assert.equal(pool.list().length, 1);
    a.release();
    b.release();
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
  assert.equal(new Set(seen).size, 1);
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

test("a dead server is not reported as live by pool.list()", async () => {
  // R4 #22: `list()` read `entry.started` unconditionally, so between the
  // child's exit and the next `acquire` host diagnostics showed a dead pid.
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
    // Long idle window: the reference is still held, so only the child's death
    // can clear the entry.
    idleCloseMs: 60_000
  });
  try {
    const handle = await pool.acquire(peer.dir);
    assert.equal(pool.list().length, 1);
    // Kill it out from under the pool, as a crash would. The whole group,
    // because the shim's `sh` is the direct child.
    process.kill(-handle.pid!, "SIGKILL");
    await handle.exited;
    assert.deepEqual(pool.list(), [], "a dead child must not be listed as live");
    handle.release();
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("the startup buffer is trimmed on a LINE boundary", () => {
  // R4 #23: front-truncating mid-line makes the line-oriented scrape skip a
  // real readiness line, and a healthy server is then killed at the deadline.
  const noiseLine = "x".repeat(50);
  const noise = `${noiseLine}\n`.repeat(10);
  const ready = "opencode server listening on http://127.0.0.1:12345\n";
  const full = noise + ready;
  const trimmed = trimToLastLines(full, 120);
  assert.ok(trimmed.length < full.length, "it really did trim");
  assert.equal(
    parseServerUrl(trimmed),
    "http://127.0.0.1:12345",
    "the readiness line survives intact"
  );
  // The invariant: the head is never a PARTIAL line. Every retained line is a
  // whole one, so the first is either a complete noise line or the ready line.
  for (const line of trimmed.split("\n").slice(0, -1)) {
    assert.ok(
      line === noiseLine || line === ready.trimEnd(),
      `retained a partial line: ${JSON.stringify(line)}`
    );
  }

  // With the old front-slice the scrape would have missed it entirely.
  const naive = full.slice(-120);
  assert.equal(parseServerUrl(naive), "http://127.0.0.1:12345");
  // …and one character further in, the naive slice severs the ready line.
  assert.equal(parseServerUrl(full.slice(-30)), null, "the bug this guards against");
});

test("trimToLastLines keeps short text untouched and never returns a partial head", () => {
  assert.equal(trimToLastLines("short\n", 100), "short\n");
  const trimmed = trimToLastLines("aaaa\nbbbb\ncccc\n", 6);
  assert.ok(["cccc\n", "bbbb\ncccc\n"].includes(trimmed), `got ${JSON.stringify(trimmed)}`);
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
