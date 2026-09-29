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

import type { AdapterLogger } from "../../adapter.ts";
import {
  OpenCodeServerPool,
  parseServerUrl,
  trimToLastLines
} from "./server.ts";
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
  controller: AbortController
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
    signal: controller.signal
  });
}

test("the scrape ignores a line that merely mentions the phrase", () => {
  assert.equal(
    parseServerUrl("failed to connect: opencode server listening on http://x was expected\n"),
    null
  );
  assert.equal(parseServerUrl("nothing here\n"), null);
});

test("a healthy peer is adopted, and the URL comes off stdout", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "noisy", MOCK_VERSION: "1.18.5" }, controller);
  try {
    const handle = await pool.acquire(peer.dir);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(handle.version, "1.18.5");
    assert.ok(handle.pid !== undefined);
    handle.release();
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("recycle (agent profile §4.8) stops only an unheld server, and the next start waits for the old child to be gone", async () => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller);
  try {
    const first = await pool.acquire(peer.dir);
    assert.equal(pool.recycle(peer.dir), null, "a held server is never recycled");
    assert.equal(first.hasExited(), false);
    first.release();

    const stopped = pool.recycle(peer.dir);
    assert.ok(stopped !== null, "an unheld server is stopped now, idle timer or not");
    assert.equal(pool.isWarm(peer.dir), false, "and is never handed out again");
    const second = await pool.acquire(peer.dir);
    assert.equal(first.hasExited(), true, "the fresh server started only once the old one was gone");
    assert.notEqual(second.pid, first.pid);
    await stopped;
    assert.equal(pool.recycle("/no/such/project"), null, "nothing runs there");
    second.release();
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
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller);
  try {
    const handle = await pool.acquire(peer.dir);
    const unauthenticated = await fetch(`${handle.url}/global/health`);
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.arrayBuffer();
    const client = handle.client(peer.dir);
    const health = await client.get<{ healthy: boolean }>("/global/health", { timeoutMs: 2_000 });
    assert.equal(health.healthy, true);
    const authorization = client.headers().authorization!;
    assert.ok(authorization.startsWith("Basic "));
    const credential = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    assert.equal(credential.slice(0, credential.indexOf(":")), "opencode");
    assert.ok(credential.slice(credential.indexOf(":") + 1).length > 0);
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
      assert.match(error.message, /1\.14\.19/);
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
    signal: controller.signal
  });
  try {
    await assert.rejects(pool.acquire(peer.dir), /failed to spawn|ENOENT/);
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("a host abort cancels acquisition of a silent peer", async () => {
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
    // The real window is 30 s (`AGENT_HOST_DEADLINES.handshakeMs`); the test
    // asserts the mechanism, not the number, so the pool is given a signal it
    // can abort instead — once the peer says it is up, so the pool is waiting
    // on its readiness line, never on a clock.
    onStderr: (_projectDir, line) => {
      if (line.text.includes("never ready")) {
        controller.abort();
      }
    }
  });
  try {
    await assert.rejects(pool.acquire(peer.dir));
    assert.equal(controller.signal.aborted, true, "the peer came up and was waited on, never ready");
  } finally {
    await pool.stopAll();
    peer.cleanup();
  }
});

test("threads of one project share one server, ref-counted, closed after the last release", async (t) => {
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller);
  try {
    const first = await pool.acquire(peer.dir);
    const second = await pool.acquire(peer.dir);
    assert.equal(first.pid, second.pid, "one `opencode serve` per project");
    assert.equal(pool.list().length, 1);

    t.mock.timers.enable({ apis: ["setTimeout"] });
    first.release();
    t.mock.timers.tick(30_000);
    assert.equal(second.hasExited(), false, "another thread still owns the server");
    assert.equal(pool.list()[0]?.pid, second.pid);

    const exited = second.exited;
    second.release();
    t.mock.timers.tick(29_999);
    assert.equal(pool.list()[0]?.pid, second.pid);
    t.mock.timers.tick(1);
    await exited;
    assert.equal(pool.list().length, 0);
  } finally {
    await pool.stopAll();
    controller.abort();
    peer.cleanup();
  }
});

test("a re-acquire inside the idle window cancels the close", async (t) => {
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
    signal: controller.signal
  });
  try {
    const first = await pool.acquire(peer.dir);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    first.release();
    t.mock.timers.tick(29_999);
    const second = await pool.acquire(peer.dir);
    t.mock.timers.tick(1);
    assert.equal(second.pid, first.pid, "the parked server was reused");
    assert.equal(pool.list()[0]?.pid, second.pid, "the original idle close was cancelled");
    const health = await second.client(peer.dir).get<{ healthy: boolean }>("/global/health", { timeoutMs: 2_000 });
    assert.equal(health.healthy, true);
    second.release();
    t.mock.timers.tick(30_000);
    await second.exited;
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
    signal: controller.signal
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
  const pool = new OpenCodeServerPool({
    logger: silentLogger,
    resolveBin: async () => peer.bin,
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      MOCK_MODE: "ok"
    }),
    signal: controller.signal
  });
  try {
    const handles = await Promise.all([
      pool.acquire(peer.dir),
      pool.acquire(peer.dir),
      pool.acquire(peer.dir)
    ]);
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
    signal: controller.signal
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

test("startup trimming preserves a ready line without turning a warning into one", () => {
  const ready = "opencode server listening on http://127.0.0.1:12345\n";
  const noise = `${"x".repeat(50)}\n`.repeat(10);
  assert.equal(parseServerUrl(trimToLastLines(noise + ready, 120)), "http://127.0.0.1:12345");
  // Cutting at the character cap must not make a phrase inside a warning
  // look like the server's own readiness announcement.
  assert.equal(parseServerUrl(trimToLastLines(`warning: ${ready}`, ready.length)), null);
});

test("a second stopAll waits for the first's kills: the host's two teardown calls both return only once the servers are gone", async () => {
  // The host calls the adapter's `stopAll()` twice (its abort listener, then
  // its own `stop()`); the pool's second call used to find the entries
  // cleared and return while the first call's kill was still in its grace.
  const peer = makePeer();
  const controller = new AbortController();
  const pool = makePool(peer, { MOCK_MODE: "ok" }, controller);
  const handle = await pool.acquire(peer.dir);
  const first = pool.stopAll();
  await pool.stopAll();
  assert.equal(handle.hasExited(), true, "the second call resolved only once the server was gone");
  await first;
  controller.abort();
  peer.cleanup();
});
