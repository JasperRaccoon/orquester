/**
 * E9 — the cold snapshot budget.
 *
 * The defect, measured on a real host: the first
 * `POST /api/agent/providers/opencode/refresh` answered an error after
 * **10 435 ms**, because the host wrapped the whole probe in the 10 s auth
 * window while the probe had to *start* an `opencode serve` (seconds) before it
 * could read a 4.3 MB catalogue (more seconds). The same call warm takes
 * ~474 ms → ~34 ms. So the user's first visit to Settings showed no OpenCode at
 * all and had to retry blind.
 *
 * The fix is two-phase and budgeted as such: wait for readiness, then read the
 * catalogue, with the host's ceiling for this one probe covering both
 * ({@link OPENCODE_SNAPSHOT_TIMEOUT_MS}). These tests drive the real adapter
 * against the scripted mock peer in `testing/peer.ts`, whose `slow` mode binds
 * its port and *then* holds the readiness line — exactly the window the budget
 * used to be spent in — until the test signals it.
 *
 * Nothing here waits on a clock: the ceiling arithmetic is checked as
 * arithmetic, the registry's ceiling on the registry's own timer, injected and
 * fired by the test, and the behaviour against a peer whose start ends when
 * the test says so. (A degraded probe's time is bounded from above — it must
 * not spend the budget — but nothing waits for that bound.)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProviderSnapshot } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import {
  createProviderSnapshotRegistry,
  type ProviderProbe
} from "../../orchestration/provider-snapshots.ts";
import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import { SNAPSHOT_TIMEOUTS_MS } from "../index.ts";
import { OPENCODE_SNAPSHOT_TIMEOUT_MS, createOpenCodeAdapter } from "./index.ts";
import { makePeer, type Peer } from "./testing/peer.ts";

function peerCtx(
  peer: Peer,
  env: Record<string, string>,
  onWarn: (message: string, fields?: unknown) => void = () => undefined
): AdapterContext {
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: onWarn,
      error: () => undefined
    },
    clock: { now: () => new Date(0), nowIso: () => "2026-09-21T00:00:00.000Z" },
    ids: { eventId: () => "e", messageId: (p) => p, uuid: () => "u" },
    resolveAttachmentPath: async () => join(peer.dir, "a"),
    attachmentsDir: () => peer.dir,
    logRawFrame: () => undefined,
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      ...env
    }),
    resolveBin: async () => peer.bin,
    sessionPath: () => "/usr/bin",
    tmpDir: () => peer.dir,
    signal: new AbortController().signal
  } as AdapterContext;
}

// ---------------------------------------------------------------------------
// The ceiling itself
// ---------------------------------------------------------------------------

test("E9: the cold ceiling covers BOTH phases, not just the catalogue read", () => {
  // Readiness (`handshakeMs` + the `/global/health` gate) happens before the
  // first catalogue byte. A ceiling that only covers the read is the bug.
  const phases =
    AGENT_HOST_DEADLINES.handshakeMs +
    AGENT_HOST_DEADLINES.healthMs +
    AGENT_HOST_DEADLINES.authProbeMs;
  assert.ok(
    OPENCODE_SNAPSHOT_TIMEOUT_MS >= phases,
    `cold ceiling ${OPENCODE_SNAPSHOT_TIMEOUT_MS}ms must cover ${phases}ms of phases`
  );
  // And it is genuinely more than the window that failed in production.
  assert.ok(OPENCODE_SNAPSHOT_TIMEOUT_MS > AGENT_HOST_DEADLINES.authProbeMs);
});

test("E9: only OpenCode gets the longer leash", () => {
  // One slow provider must not buy the others a longer window — a stuck Codex
  // or Claude probe should still be cut at the tight auth deadline.
  assert.equal(SNAPSHOT_TIMEOUTS_MS.opencode, OPENCODE_SNAPSHOT_TIMEOUT_MS);
  assert.deepEqual(Object.keys(SNAPSHOT_TIMEOUTS_MS), ["opencode"]);
});

test("E9: the registry honours a probe's own ceiling", async () => {
  // The seam the ceiling rides on. A probe that declares 60 ms is cut at 60 ms
  // rather than at the 10 s default, which is the same mechanism that lets
  // OpenCode declare 45 s. The registry's own timer, injected, is the clock:
  // the test sees which ceiling is armed, and fires it.
  const stateDir = mkdtempSync(join(tmpdir(), "orq-snapshot-budget-"));
  const probe: ProviderProbe = {
    id: "opencode",
    timeoutMs: 60,
    // A probe that never answers: only the ceiling can end the refresh.
    refresh: (): Promise<ProviderSnapshot> => new Promise<ProviderSnapshot>(() => undefined)
  };
  const armed: { ms: number; fire: () => void }[] = [];
  const registry = createProviderSnapshotRegistry({
    probes: [probe],
    stateDir,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    setTimer: (fire, ms) => armed.push({ ms, fire }) - 1,
    clearTimer: () => undefined
  });
  try {
    const refreshing = registry.refresh("opencode");
    await nextTurn();
    assert.deepEqual(
      armed.map((timer) => timer.ms),
      [60],
      "the probe's own ceiling, not the default"
    );
    armed[0]!.fire();
    await assert.rejects(refreshing, /timed out after 60ms/);
  } finally {
    registry.stop?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The behaviour, against a slow-starting peer
// ---------------------------------------------------------------------------

/**
 * The slow peers a test's adapter starts, as they say on stderr (which the
 * pool logs as a warning) that they are bound and not ready: `bound(n)`
 * settles with the n-th one's pid, which `ready` signals to announce.
 */
function slowPeers(): {
  onWarn: (message: string, fields?: unknown) => void;
  bound: (index: number) => Promise<number>;
  ready: (pid: number) => void;
  pids: number[];
} {
  const pids: number[] = [];
  let waiters: { index: number; resolve: (pid: number) => void }[] = [];
  const onWarn = (_message: string, fields?: unknown): void => {
    const line = (fields as { line?: unknown } | undefined)?.line;
    const match = typeof line === "string" ? /bound, not ready \(pid (\d+)\)/.exec(line) : null;
    if (match === null) {
      return;
    }
    pids.push(Number(match[1]));
    waiters = waiters.filter((waiter) => {
      if (pids.length <= waiter.index) {
        return true;
      }
      waiter.resolve(pids[waiter.index]!);
      return false;
    });
  };
  const bound = (index: number): Promise<number> =>
    pids.length > index
      ? Promise.resolve(pids[index]!)
      : new Promise((resolve) => waiters.push({ index, resolve }));
  return { onWarn, bound, ready: (pid) => void process.kill(pid, "SIGUSR2"), pids };
}

/** One turn of the event loop: whatever was queued has run. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("E9: a COLD probe waits for the server to report ready, then reads the catalogue", async () => {
  const peer = makePeer();
  const peers = slowPeers();
  const adapter = await createOpenCodeAdapter(peerCtx(peer, { MOCK_MODE: "slow" }, peers.onWarn));
  try {
    let settled = false;
    const probe = adapter.refreshSnapshot({ cwd: peer.dir }).finally(() => {
      settled = true;
    });
    // The server is up, its port bound, and it has not said it is ready.
    const pid = await peers.bound(0);
    await nextTurn();
    // It waits for the readiness line instead of giving up on the start...
    assert.equal(settled, false, "the probe returned before the peer was ready");
    peers.ready(pid);
    const snapshot = await probe;
    // ...and then actually reads the catalogue off the server it started.
    assert.equal(snapshot.status, "ready");
    assert.deepEqual(
      snapshot.models.map((model) => model.slug),
      ["openrouter/google/gemini-3.1-flash-lite"]
    );
    assert.equal(snapshot.auth.status, "authenticated");
    assert.ok(snapshot.skills.some((skill) => skill.name === "review"));
  } finally {
    await adapter.stopAll();
    peer.cleanup();
  }
});

test("E9: the second probe is warm — the start cost is paid once per project", async () => {
  const peer = makePeer();
  const peers = slowPeers();
  const adapter = await createOpenCodeAdapter(peerCtx(peer, { MOCK_MODE: "slow" }, peers.onWarn));
  try {
    const cold = adapter.refreshSnapshot({ cwd: peer.dir });
    peers.ready(await peers.bound(0));
    await cold;
    // A different spelling of the same project: it must ride the warm server,
    // not start a second one (R4 #6 — the probe keys the pool like a session),
    // which would wait on a readiness line nobody signals.
    const warm = adapter.refreshSnapshot({ cwd: join(peer.dir, ".", "") });
    const anotherStart = peers.bound(1).then((pid) => {
      peers.ready(pid);
      return "started another server" as const;
    });
    const first = await Promise.race([warm.then(() => "warm" as const), anotherStart]);
    assert.equal(first, "warm");
    assert.equal(peers.pids.length, 1, "one server for the project");
    assert.equal((await warm).status, "ready");
  } finally {
    await adapter.stopAll();
    peer.cleanup();
  }
});

test("R4 #7: the cwd-less refresh reads the CLI catalogue and starts NO server", async () => {
  // §4.5 "Catalogue fallbacks". The host's background refresh never carries a
  // cwd, so without this the OpenCode card sat with no models and unknown auth
  // until a thread opened. The CLI and `opencode serve` share one SQLite file,
  // so this path must also not start a server — asserted, not assumed.
  const peer = makePeer();
  const adapter = await createOpenCodeAdapter(peerCtx(peer, { MOCK_MODE: "ok" }));
  try {
    const snapshot = await adapter.refreshSnapshot();
    assert.equal(snapshot.installed, true);
    assert.deepEqual(
      snapshot.models.map((model) => model.slug),
      ["openrouter/google/gemini-3.1-flash-lite"]
    );
    // `connected` is inferred from the models the CLI printed — there is no
    // `opencode auth list` to ask.
    assert.equal(snapshot.auth.status, "authenticated");
    assert.ok(snapshot.skills.some((skill) => skill.name === "review"));
    assert.deepEqual(adapter.listSessions(), []);
  } finally {
    await adapter.stopAll();
    peer.cleanup();
  }
});

test("E9: a catalogue failure degrades the snapshot; it never spends the budget", async () => {
  // Phase two failing is not phase one failing: the server is up, so the probe
  // answers promptly with what it could read rather than burning the ceiling.
  const peer = makePeer();
  const adapter = await createOpenCodeAdapter(
    peerCtx(peer, { MOCK_MODE: "ok", MOCK_PROVIDER_STATUS: "500" })
  );
  try {
    const started = Date.now();
    const snapshot = await adapter.refreshSnapshot({ cwd: peer.dir });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < AGENT_HOST_DEADLINES.authProbeMs, `degraded probe took ${elapsed}ms`);
    // §4.6.4: a failed `/provider` costs the models, never the whole snapshot.
    assert.equal(snapshot.installed, true);
    assert.deepEqual(snapshot.models, []);
    assert.equal(snapshot.status, "degraded");
    assert.ok(snapshot.skills.some((skill) => skill.name === "review"));
  } finally {
    await adapter.stopAll();
    peer.cleanup();
  }
});
