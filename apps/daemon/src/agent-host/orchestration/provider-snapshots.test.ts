import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  AgentAdapterId,
  ProviderSnapshot,
  RuntimeEvent
} from "@orquester/api/agent-chat";

import { CLAUDE_CAPABILITIES } from "../adapters/claude/index.ts";
import { CODEX_ADAPTER_CAPABILITIES } from "../adapters/codex/index.ts";
import { GROK_CAPABILITIES } from "../adapters/grok/index.ts";
import { ADAPTER_PENDING_SNAPSHOTS } from "../adapters/index.ts";
import {
  createProviderSnapshotRegistry,
  PROVIDER_BIN_CHECK_INTERVAL_MS
} from "./provider-snapshots.ts";
import { createRecordingLogger, createTestClock, createTestTimers } from "./testing/fakes.ts";

function snapshotFor(id: AgentAdapterId, overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id,
    refIds: [id],
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "1970-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    capabilities: {
      sessionModelSwitch: "in-session",
      showPlanModeToggle: true,
      reportsContextWindow: true,
      compaction: { type: "native" }
    },
    ...overrides
  };
}

/** The v2 cache file's shape, as the tests read and write it. */
interface CacheFile {
  version: number;
  providers: Record<
    string,
    {
      identity: {
        adapterId: string;
        hostProtocolVersion: number;
        binPath?: string | null;
        version?: string | null;
        binRealPath?: string | null;
        binMtimeMs?: number | null;
        binSizeBytes?: number | null;
      };
      snapshot: ProviderSnapshot;
    }
  >;
}

function identityFor(
  id: AgentAdapterId,
  overrides: Partial<CacheFile["providers"][string]["identity"]> = {}
): CacheFile["providers"][string]["identity"] {
  return { adapterId: id, hostProtocolVersion: 1, binPath: `/usr/bin/${id}`, ...overrides };
}

async function writeCache(
  stateDir: string,
  providers: CacheFile["providers"],
  version = 2
): Promise<void> {
  await writeFile(
    join(stateDir, "provider-snapshots.json"),
    JSON.stringify({ version, providers })
  );
}

async function withRegistry<T>(
  run: (input: {
    registry: ReturnType<typeof createProviderSnapshotRegistry>;
    probe: { calls: number; next: ProviderSnapshot; lastCwd?: string; gate?: Promise<void> };
    timers: ReturnType<typeof createTestTimers>;
    stateDir: string;
  }) => Promise<T>
): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), "provider-snapshots-"));
  const timers = createTestTimers();
  const probe = { calls: 0, next: snapshotFor("claude") } as {
    calls: number;
    next: ProviderSnapshot;
    lastCwd?: string;
    gate?: Promise<void>;
  };
  const registry = createProviderSnapshotRegistry({
    probes: [
      {
        id: "claude",
        refresh: async (input?: { cwd?: string }) => {
          probe.calls += 1;
          probe.lastCwd = input?.cwd;
          if (probe.gate) await probe.gate;
          return probe.next;
        }
      }
    ],
    stateDir,
    logger: createRecordingLogger(),
    clock: createTestClock(0),
    intervalMs: 1_000,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (handle) => timers.clearTimer(handle)
  });
  try {
    return await run({ registry, probe, timers, stateDir });
  } finally {
    registry.stop();
    await registry.flush();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

describe("provider snapshot registry (§3.2, §6.3)", () => {
  it("caches, notifies on change and short-circuits an identical configuration", async () => {
    await withRegistry(async ({ registry, probe }) => {
      const changed: AgentAdapterId[] = [];
      registry.onChange((id) => changed.push(id));

      await registry.refresh("claude");
      assert.deepEqual(changed, ["claude"]);
      assert.equal(registry.get("claude")?.version, "1.0.0");

      // Same content, later stamp: no change event.
      probe.next = snapshotFor("claude", { checkedAt: "1970-01-02T00:00:00.000Z" });
      await registry.refresh("claude");
      assert.deepEqual(changed, ["claude"]);

      probe.next = snapshotFor("claude", { version: "1.1.0" });
      await registry.refresh("claude");
      assert.deepEqual(changed, ["claude", "claude"]);
    });
  });

  it("serialises refreshes so two clients opening Settings run one probe at a time", async () => {
    await withRegistry(async ({ registry, probe }) => {
      let release: () => void = () => undefined;
      probe.gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const first = registry.refresh("claude");
      const second = registry.refresh("claude");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1, "the second refresh waits on the permit");
      release();
      probe.gate = undefined;
      await Promise.all([first, second]);
      assert.equal(probe.calls, 2);
    });
  });

  it("only runs the background loop while something is watching", async () => {
    await withRegistry(async ({ registry, probe, timers }) => {
      timers.runDue(5_000);
      assert.equal(probe.calls, 0, "no watcher, no probe");

      const release = registry.addWatcher();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1, "the first watcher primes the empty registry at once");
      timers.runDue(6_000);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 2, "then the interval keeps it fresh");

      release();
      timers.runDue(20_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 2, "the loop stops once nothing is watching");
    });
  });

  it("a watcher on an empty registry probes immediately, before the first interval", async () => {
    await withRegistry(async ({ registry, probe, timers }) => {
      assert.deepEqual(registry.all(), [], "nothing cached on a fresh host");
      const release = registry.addWatcher();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1, "primed without any timer firing");
      assert.equal(registry.all().length, 1);
      // A second watcher does not prime again: the snapshot is now held.
      const release2 = registry.addWatcher();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1);
      timers.runDue(0);
      release();
      release2();
    });
  });

  it("a watcher on a registry warmed from the cache does not re-probe at once", async () => {
    await withRegistry(async ({ registry, probe, timers, stateDir }) => {
      await registry.refresh("claude");
      await registry.flush();
      assert.equal(probe.calls, 1);
      const reloaded = createProviderSnapshotRegistry({
        probes: [{ id: "claude", refresh: async () => { probe.calls += 1; return probe.next; } }],
        stateDir,
        logger: createRecordingLogger(),
        clock: createTestClock(0),
        intervalMs: 1_000,
        setTimer: (fn, ms) => timers.setTimer(fn, ms),
        clearTimer: (handle) => timers.clearTimer(handle)
      });
      try {
        await reloaded.load();
        assert.equal(reloaded.all().length, 1, "served from the cache");
        const release = reloaded.addWatcher();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(probe.calls, 1, "the cache satisfies the first read; the interval refreshes it");
        release();
      } finally {
        reloaded.stop();
        await reloaded.flush();
      }
    });
  });

  it("never re-probes a cwd it already holds and collapses concurrent ones", async () => {
    await withRegistry(async ({ registry, probe }) => {
      probe.next = snapshotFor("claude", {
        workspaceSnapshots: [
          { cwd: "/work/p", checkedAt: "1970-01-01T00:00:00.000Z", slashCommands: [], skills: [] }
        ]
      });
      registry.ensureWorkspaceSnapshot("claude", "/work/p");
      registry.ensureWorkspaceSnapshot("claude", "/work/p");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1);
      registry.ensureWorkspaceSnapshot("claude", "/work/p");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1, "a cwd already present is never re-probed");
      assert.equal(probe.lastCwd, "/work/p");
    });
  });

  it("merges a sparse rate-limit update onto the cached snapshot by window id", async () => {
    await withRegistry(async ({ registry }) => {
      await registry.refresh("claude");
      const event = {
        eventId: "e1",
        threadId: "t1",
        createdAt: "1970-01-01T00:00:00.000Z",
        type: "account.rate-limits.updated",
        payload: {
          limits: {
            windows: [
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 42 }
            ]
          }
        }
      } as unknown as RuntimeEvent;
      registry.applyUsageLimits("claude", event);
      assert.equal(registry.get("claude")?.usageLimits?.windows[0]?.usedPercent, 42);

      registry.applyUsageLimits("claude", {
        ...event,
        payload: {
          limits: { windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 91 }] }
        }
      } as unknown as RuntimeEvent);
      assert.equal(registry.get("claude")?.usageLimits?.windows.length, 1);
      assert.equal(registry.get("claude")?.usageLimits?.windows[0]?.usedPercent, 91);
    });
  });

  it("persists the cache keyed by the agent id it was written for, and ignores a mismatch", async () => {
    await withRegistry(async ({ registry, stateDir }) => {
      await registry.refresh("claude");
      // The persist is fire-and-forget; give it a turn of the loop.
      await registry.flush();
      const raw = JSON.parse(
        await readFile(join(stateDir, "provider-snapshots.json"), "utf8")
      ) as CacheFile;
      assert.equal(raw.version, 2);
      assert.equal(raw.providers.claude?.snapshot.id, "claude");
      // Identity lives INSIDE the file, next to the payload it stamps.
      assert.equal(raw.providers.claude?.identity.adapterId, "claude");
      assert.equal(raw.providers.claude?.identity.hostProtocolVersion, 1);

      // The filename alone is not trusted as a routing key.
      await writeCache(stateDir, {
        claude: { identity: identityFor("claude"), snapshot: snapshotFor("codex") }
      });
      const reloaded = createProviderSnapshotRegistry({
        probes: [],
        stateDir,
        logger: createRecordingLogger(),
        clock: createTestClock(0)
      });
      await reloaded.load();
      assert.equal(reloaded.get("claude"), null);
      reloaded.stop();
    });
  });

  it("ignores an unreadable cache rather than failing startup", async () => {
    await withRegistry(async ({ stateDir }) => {
      await writeFile(join(stateDir, "provider-snapshots.json"), "{not json");
      const reloaded = createProviderSnapshotRegistry({
        probes: [],
        stateDir,
        logger: createRecordingLogger(),
        clock: createTestClock(0)
      });
      await reloaded.load();
      assert.deepEqual(reloaded.all(), []);
      reloaded.stop();
    });
  });
});

/**
 * The client's own gate, restated (`agent-chat/providers.ts`'s
 * `authErrorMessage` in the UI package). That package is not a daemon
 * dependency, so this is the one honest way to pin the CONTRACT rather than the
 * producer: the fix wave shipped both halves and they disagreed, and both
 * sides' tests passed because each asserted only its own half.
 */
function clientWouldToast(snapshot: ProviderSnapshot): boolean {
  if (snapshot.auth.status === "unauthenticated") return true;
  return snapshot.status === "error" && snapshot.auth.status !== "authenticated";
}

describe("R8-M4: an auth.status error is written in the shape the toast reads", () => {
  it("stores `error`, not `degraded`, so the client actually raises it", async () => {
    await withRegistry(async ({ registry, probe }) => {
      probe.next = snapshotFor("claude");
      await registry.refresh("claude");
      assert.equal(clientWouldToast(registry.get("claude")!), false, "a healthy provider is quiet");

      registry.applyAuthStatus?.("claude", {
        eventId: "auth-1",
        threadId: "thread-1",
        createdAt: "1970-01-01T00:00:01.000Z",
        type: "auth.status",
        payload: { error: "Session expired, run /login" }
      } as unknown as RuntimeEvent);

      const after = registry.get("claude")!;
      // `degraded` is what this wrote before, and it is NOT the toast's input:
      // the probes set `degraded` for reasons that have nothing to do with auth,
      // so the client deliberately ignores it.
      assert.equal(after.status, "error");
      assert.equal(after.auth.status, "unknown");
      assert.equal(after.message, "Session expired, run /login");
      assert.equal(clientWouldToast(after), true, "the whole point of the chain");
    });
  });

  it("clears back to ready on a clean auth.status", async () => {
    await withRegistry(async ({ registry }) => {
      await registry.refresh("claude");
      registry.applyAuthStatus?.("claude", {
        eventId: "auth-1",
        threadId: "thread-1",
        createdAt: "1970-01-01T00:00:01.000Z",
        type: "auth.status",
        payload: { error: "Session expired" }
      } as unknown as RuntimeEvent);
      assert.equal(registry.get("claude")?.status, "error");

      registry.applyAuthStatus?.("claude", {
        eventId: "auth-2",
        threadId: "thread-1",
        createdAt: "1970-01-01T00:00:02.000Z",
        type: "auth.status",
        payload: {}
      } as unknown as RuntimeEvent);

      const cleared = registry.get("claude")!;
      assert.equal(cleared.status, "ready");
      assert.equal(cleared.message, undefined);
      assert.equal(clientWouldToast(cleared), false);
    });
  });
});

// ---------------------------------------------------------------------------
// §3.2 — a fresh host never answers `GET /providers` with `[]`
// ---------------------------------------------------------------------------

/**
 * The three layers, each pinned where it can fail on its own.
 *
 * *T3: `makeManagedServerProvider.ts:69-73` (the pending seed), `:280-284`
 * (the forced boot probe), `Layers/ProviderRegistry.ts:292-352` + `:743-751`
 * (the correlated cache hydrated over the seed).*
 */
describe("§3.2 boot: pending seed, correlated cache, forced boot probe", () => {
  const pendingClaude = (checkedAt: string): ProviderSnapshot =>
    snapshotFor("claude", {
      installed: false,
      version: null,
      status: "unknown",
      message: "Claude provider status has not been checked in this session yet.",
      auth: { status: "unknown" },
      checkedAt,
      models: [{ slug: "opus", name: "Opus", isDefault: true, capabilities: null }]
    });

  interface Harness {
    registry: ReturnType<typeof createProviderSnapshotRegistry>;
    probe: {
      calls: number;
      next: ProviderSnapshot;
      gate?: { promise: Promise<void>; open(): void } | undefined;
    };
    stateDir: string;
  }

  async function withSeeded<T>(
    run: (input: Harness) => Promise<T>,
    options: { binPath?: string | null; stateDir?: string; pending?: boolean } = {}
  ): Promise<T> {
    const stateDir = options.stateDir ?? (await mkdtemp(join(tmpdir(), "provider-pending-")));
    const probe: Harness["probe"] = { calls: 0, next: snapshotFor("claude") };
    const registry = createProviderSnapshotRegistry({
      probes: [
        {
          id: "claude",
          ...(options.pending === false ? {} : { pending: pendingClaude }),
          identity: () => ({
            binPath: options.binPath === undefined ? "/usr/bin/claude" : options.binPath
          }),
          refresh: async () => {
            probe.calls += 1;
            if (probe.gate) await probe.gate.promise;
            return probe.next;
          }
        }
      ],
      stateDir,
      logger: createRecordingLogger(),
      clock: createTestClock(0),
      intervalMs: 1_000,
      setTimer: () => null,
      clearTimer: () => undefined
    });
    try {
      return await run({ registry, probe, stateDir });
    } finally {
      registry.stop();
      await registry.flush();
      if (options.stateDir === undefined) {
        await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }

  it("layer 1: seeds a pending snapshot at construction, before load() and before any probe", async () => {
    await withSeeded(async ({ registry, probe }) => {
      // Nothing was awaited between construction and this line.
      const seeded = registry.get("claude");
      assert.ok(seeded, "GET /providers must never answer []");
      assert.equal(probe.calls, 0, "the seed costs no probe");
      assert.equal(seeded.status, "unknown");
      assert.equal(seeded.auth.status, "unknown");
      assert.equal(seeded.installed, false);
      assert.match(seeded.message ?? "", /has not been checked in this session yet/);
      // The whole point: a pending row is still LAUNCHABLE.
      assert.equal(seeded.models.length, 1);
      assert.deepEqual(
        registry.all().map((row) => row.id),
        ["claude"]
      );
    });
  });

  it("layer 1: a pending snapshot never raises the client's auth toast", async () => {
    await withSeeded(async ({ registry }) => {
      assert.equal(clientWouldToast(registry.get("claude")!), false);
    });
  });

  it("layer 1: a pending seed is never written to the cache file", async () => {
    await withSeeded(async ({ registry, stateDir }) => {
      await registry.flush();
      await assert.rejects(readFile(join(stateDir, "provider-snapshots.json"), "utf8"));
    });
  });

  it("layer 2: a correlated cached snapshot overrides the pending seed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-pending-"));
    try {
      await writeCache(stateDir, {
        claude: {
          identity: identityFor("claude", { binPath: "/usr/bin/claude" }),
          snapshot: snapshotFor("claude", { version: "2.1.210" })
        }
      });
      await withSeeded(
        async ({ registry, probe }) => {
          assert.equal(registry.get("claude")?.status, "unknown", "pending before load()");
          await registry.load();
          const hydrated = registry.get("claude")!;
          assert.equal(hydrated.status, "ready", "on-disk state wins where present");
          assert.equal(hydrated.version, "2.1.210");
          assert.equal(probe.calls, 0, "hydration is a read");
        },
        { stateDir, binPath: "/usr/bin/claude" }
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("layer 2: an uncorrelated cached snapshot is discarded and the pending seed stands", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-pending-"));
    try {
      // The binary moved under us — an `npm install -g` into a different prefix.
      await writeCache(stateDir, {
        claude: {
          identity: identityFor("claude", { binPath: "/old/prefix/bin/claude" }),
          snapshot: snapshotFor("claude", { version: "1.0.0" })
        }
      });
      await withSeeded(
        async ({ registry }) => {
          await registry.load();
          const after = registry.get("claude")!;
          assert.equal(after.status, "unknown", "the stale payload never reaches a client");
          assert.equal(after.version, null);
        },
        { stateDir, binPath: "/new/prefix/bin/claude" }
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("layer 2: a v1 identity-less payload is discarded", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-pending-"));
    try {
      await writeFile(
        join(stateDir, "provider-snapshots.json"),
        JSON.stringify({ version: 1, providers: { claude: snapshotFor("claude") } })
      );
      await withSeeded(
        async ({ registry }) => {
          await registry.load();
          assert.equal(registry.get("claude")?.status, "unknown");
        },
        { stateDir }
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("layer 2: a payload from another protocol version is discarded", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-pending-"));
    try {
      await writeCache(stateDir, {
        claude: {
          identity: identityFor("claude", { hostProtocolVersion: 99 }),
          snapshot: snapshotFor("claude")
        }
      });
      await withSeeded(
        async ({ registry }) => {
          await registry.load();
          assert.equal(registry.get("claude")?.status, "unknown");
        },
        { stateDir }
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("layer 3: startBootRefresh probes every provider, returns synchronously, and is idempotent", async () => {
    await withSeeded(async ({ registry, probe }) => {
      let gateOpen = (): void => undefined;
      probe.gate = {
        promise: new Promise<void>((resolve) => {
          gateOpen = resolve;
        }),
        open: () => gateOpen()
      };

      registry.startBootRefresh();
      // Fire-and-forget: it returned without awaiting the (still-blocked) probe.
      assert.equal(registry.get("claude")?.status, "unknown", "the seed serves meanwhile");

      // A second call while the first pass runs does nothing.
      registry.startBootRefresh();

      probe.next = snapshotFor("claude", { version: "2.1.210" });
      probe.gate.open();
      probe.gate = undefined;
      await registry.refreshAllNow();
      await registry.flush();

      assert.equal(registry.get("claude")?.status, "ready");
      assert.equal(registry.get("claude")?.version, "2.1.210");
      assert.equal(probe.calls, 2, "one boot pass plus the explicit one above");
    });
  });

  it("layer 3: a correlated cache makes boot refresh a no-op", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-pending-"));
    try {
      await writeCache(stateDir, {
        claude: {
          identity: identityFor("claude", { binPath: "/usr/bin/claude" }),
          snapshot: snapshotFor("claude", { version: "2.1.210" })
        }
      });
      await withSeeded(
        async ({ registry, probe }) => {
          await registry.load();
          registry.startBootRefresh();
          await new Promise<void>((resolve) => setImmediate(resolve));

          assert.equal(probe.calls, 0, "boot must serve the correlated cache without a live probe");
          await registry.refreshAllNow();
          assert.equal(probe.calls, 1, "an explicit refresh still probes the provider");
        },
        { stateDir, binPath: "/usr/bin/claude" }
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("layer 3: the boot probe's result is written to the cache WITH its identity", async () => {
    await withSeeded(async ({ registry, stateDir }) => {
      registry.startBootRefresh();
      await registry.refreshAllNow();
      await registry.flush();
      const raw = JSON.parse(
        await readFile(join(stateDir, "provider-snapshots.json"), "utf8")
      ) as CacheFile;
      assert.equal(raw.providers.claude?.identity.binPath, "/usr/bin/claude");
      assert.equal(raw.providers.claude?.identity.adapterId, "claude");
      assert.equal(raw.providers.claude?.snapshot.status, "ready");
    });
  });

  it("the first watcher's priming is a no-op once the boot probe has run", async () => {
    await withSeeded(async ({ registry, probe }) => {
      registry.startBootRefresh();
      await registry.refreshAllNow();
      const after = probe.calls;
      const release = registry.addWatcher();
      await registry.refreshAllNow();
      // The watcher itself added no extra pass; only the explicit one above.
      assert.equal(probe.calls, after + 1);
      release();
    });
  });

  it("the first watcher still primes a registry nobody kicked at boot", async () => {
    await withSeeded(async ({ registry, probe }) => {
      assert.equal(probe.calls, 0);
      const release = registry.addWatcher();
      await registry.refreshAllNow();
      assert.ok(probe.calls >= 1, "the stopgap is kept as a fallback");
      release();
    });
  });
});

// ---------------------------------------------------------------------------
// §3.2 — a MOVED binary re-probes itself on the next read
// ---------------------------------------------------------------------------

/**
 * The owner incident: `claude` was updated from Settings → Agents from 2.1.278
 * to 2.1.280 (which resolves the `opus` alias to a newer model) and a chat
 * opened two hours later still offered the OLD alias, because the host's
 * in-memory snapshot was the one probed under 2.1.278 and nothing ever told it
 * the CLI had changed. The registry-resolved bin is the native installer's
 * SYMLINK (`~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`), so
 * `binPath` alone never moves — only what it points at does, which is exactly
 * why the identity has to carry the stat and not just the path.
 */
describe("§3.2: a moved CLI binary re-probes itself on the next read", () => {
  const pendingClaudeSnapshot = (checkedAt: string): ProviderSnapshot =>
    snapshotFor("claude", {
      installed: false,
      version: null,
      status: "unknown",
      message: "Claude provider status has not been checked in this session yet.",
      auth: { status: "unknown" },
      checkedAt,
      models: [{ slug: "opus", name: "Opus", isDefault: true, capabilities: null }]
    });

  interface BinHarness {
    registry: ReturnType<typeof createProviderSnapshotRegistry>;
    probe: { calls: number; next: ProviderSnapshot };
    clock: ReturnType<typeof createTestClock>;
    stateDir: string;
    /** The stable path the probe resolves — a symlink, as on the real host. */
    binPath: string;
    /** Point the symlink at another installed version; answers the target. */
    installVersion(version: string): Promise<string>;
  }

  async function withMovableBin<T>(run: (input: BinHarness) => Promise<T>): Promise<T> {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-moved-bin-"));
    const binPath = join(stateDir, "bin", "claude");
    await mkdir(join(stateDir, "bin"), { recursive: true });
    const installVersion = async (version: string): Promise<string> => {
      const dir = join(stateDir, "versions", version);
      await mkdir(dir, { recursive: true });
      const target = join(dir, "claude");
      // The size differs per version, so a filesystem with a coarse mtime still
      // sees a different binary.
      await writeFile(target, `#!/bin/sh\necho ${version}${"x".repeat(version.length)}\n`);
      await rm(binPath, { force: true });
      await symlink(target, binPath);
      return target;
    };
    await installVersion("2.1.278");
    const probe = { calls: 0, next: snapshotFor("claude", { version: "2.1.278" }) };
    const clock = createTestClock(0);
    const registry = createProviderSnapshotRegistry({
      probes: [
        {
          id: "claude",
          pending: pendingClaudeSnapshot,
          identity: () => ({ binPath }),
          refresh: async () => {
            probe.calls += 1;
            return probe.next;
          }
        }
      ],
      stateDir,
      logger: createRecordingLogger(),
      clock,
      intervalMs: 1_000,
      setTimer: () => null,
      clearTimer: () => undefined
    });
    try {
      return await run({ registry, probe, clock, stateDir, binPath, installVersion });
    } finally {
      registry.stop();
      await registry.flush();
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  /** Resolves on the next snapshot change — never on elapsed time (§9). */
  function nextChange(registry: ReturnType<typeof createProviderSnapshotRegistry>): Promise<void> {
    return new Promise<void>((resolve) => {
      const off = registry.onChange(() => {
        off();
        resolve();
      });
    });
  }

  it("a read schedules exactly ONE background refresh, and the rate limit holds the next off", async () => {
    await withMovableBin(async ({ registry, probe, clock, installVersion }) => {
      await registry.refresh("claude");
      assert.equal(probe.calls, 1);

      // A read with the binary untouched must cost nothing.
      registry.all();
      registry.all();
      assert.equal(probe.calls, 1, "an unchanged binary never schedules a refresh");

      // The update: the symlink now points at a different install.
      await installVersion("2.1.280");
      probe.next = snapshotFor("claude", { version: "2.1.280" });

      // Still inside the rate-limit window opened by the reads above: a busy
      // client polling `/providers` cannot turn every poll into a stat.
      registry.all();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1, "a read within the window is not even stat'ed");

      clock.advance(PROVIDER_BIN_CHECK_INTERVAL_MS);
      const changed = nextChange(registry);
      const served = registry.all();
      assert.equal(
        served[0]?.version,
        "2.1.278",
        "the current snapshot is served meanwhile; a read never awaits the refresh"
      );
      // Idempotent: a busy client polling `/providers` gets one refresh, not one
      // per request.
      registry.all();
      registry.all();
      await changed;
      assert.equal(probe.calls, 2, "exactly one background refresh");
      assert.equal(registry.get("claude")?.version, "2.1.280");

      // A THIRD install inside the rate-limit window is not even stat'ed.
      await installVersion("2.1.281");
      probe.next = snapshotFor("claude", { version: "2.1.281" });
      registry.all();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 2, "a second read within the window schedules none");

      // Past the window it is picked up.
      clock.advance(PROVIDER_BIN_CHECK_INTERVAL_MS);
      const again = nextChange(registry);
      registry.all();
      await again;
      assert.equal(probe.calls, 3);
      assert.equal(registry.get("claude")?.version, "2.1.281");
    });
  });

  it("the refreshed snapshot is cached under the NEW bin identity", async () => {
    await withMovableBin(async ({ registry, probe, stateDir, binPath, installVersion }) => {
      await registry.refresh("claude");
      await registry.flush();
      const before = JSON.parse(
        await readFile(join(stateDir, "provider-snapshots.json"), "utf8")
      ) as CacheFile;
      assert.equal(before.providers.claude?.identity.binPath, binPath);
      const firstReal = before.providers.claude?.identity.binRealPath;
      assert.ok(firstReal, "the stat identity is written beside the snapshot");

      const target = await installVersion("2.1.280");
      probe.next = snapshotFor("claude", { version: "2.1.280" });
      const changed = nextChange(registry);
      registry.all();
      await changed;
      await registry.flush();

      const after = JSON.parse(
        await readFile(join(stateDir, "provider-snapshots.json"), "utf8")
      ) as CacheFile;
      assert.equal(after.providers.claude?.identity.binPath, binPath, "the symlink never moved");
      assert.equal(after.providers.claude?.identity.binRealPath, target, "what it points at did");
      assert.notEqual(after.providers.claude?.identity.binRealPath, firstReal);
      assert.equal(after.providers.claude?.snapshot.version, "2.1.280");
    });
  });

  it("the disk cache refuses to hydrate a row whose bin identity moved", async () => {
    await withMovableBin(async ({ registry, stateDir, binPath, installVersion }) => {
      // A cache written while the symlink still pointed at the old install …
      await writeCache(stateDir, {
        claude: {
          identity: {
            adapterId: "claude",
            hostProtocolVersion: 1,
            binPath,
            binRealPath: join(stateDir, "versions", "2.1.278", "claude"),
            binMtimeMs: 1,
            binSizeBytes: 1
          },
          snapshot: snapshotFor("claude", { version: "2.1.278" })
        }
      });
      // … and an update that moved it since.
      await installVersion("2.1.280");

      await registry.load();
      const after = registry.get("claude")!;
      assert.equal(after.status, "unknown", "the stale payload never reaches a client");
      assert.equal(after.version, null);
    });
  });
});

// ---------------------------------------------------------------------------
// goals §5.4 — every served row carries the adapter's CURRENT capabilities
// ---------------------------------------------------------------------------

/**
 * A cached row is written by whichever host probed it last, so after a deploy
 * that adds a capability (`goals`) the correlated cache — which layer two
 * serves WITHOUT a probe — still describes the old adapter. Capabilities are
 * the adapter's, not the probe's: every row is served with today's.
 */
describe("goals §5.4: capabilities are the adapter's, not the cache's", () => {
  const withGoals = {
    sessionModelSwitch: "in-session" as const,
    showPlanModeToggle: true,
    reportsContextWindow: true,
    compaction: { type: "native" as const },
    goals: {
      command: "provider" as const,
      actions: ["continue", "clear"] as const,
      continuesAcrossTurns: false
    }
  };
  const pendingWithGoals = (checkedAt: string): ProviderSnapshot =>
    snapshotFor("claude", {
      installed: false,
      version: null,
      status: "unknown",
      message: "Claude provider status has not been checked in this session yet.",
      auth: { status: "unknown" },
      checkedAt,
      capabilities: withGoals
    });

  async function withCurrentAdapter<T>(
    run: (input: {
      registry: ReturnType<typeof createProviderSnapshotRegistry>;
      probe: { calls: number; next: ProviderSnapshot };
      stateDir: string;
    }) => Promise<T>,
    stateDir: string
  ): Promise<T> {
    const probe = { calls: 0, next: snapshotFor("claude", { capabilities: withGoals }) };
    const registry = createProviderSnapshotRegistry({
      probes: [
        {
          id: "claude",
          pending: pendingWithGoals,
          identity: () => ({ binPath: "/usr/bin/claude" }),
          refresh: async () => {
            probe.calls += 1;
            return probe.next;
          }
        }
      ],
      stateDir,
      logger: createRecordingLogger(),
      clock: createTestClock(0),
      intervalMs: 1_000,
      setTimer: () => null,
      clearTimer: () => undefined
    });
    try {
      return await run({ registry, probe, stateDir });
    } finally {
      registry.stop();
      await registry.flush();
    }
  }

  it("a correlated cached row from before `goals` existed is served with today's capabilities", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-capabilities-"));
    try {
      // Written by the previous host: a good, correlated row — minus `goals`.
      await writeCache(stateDir, {
        claude: {
          identity: identityFor("claude", { binPath: "/usr/bin/claude" }),
          snapshot: snapshotFor("claude", { version: "2.1.280" })
        }
      });
      await withCurrentAdapter(async ({ registry, probe }) => {
        await registry.load();
        const served = registry.get("claude")!;
        assert.equal(served.version, "2.1.280", "the cached row is still the one served");
        assert.equal(served.status, "ready");
        assert.deepEqual(served.capabilities, withGoals, "…with the adapter's capabilities");
        assert.deepEqual(registry.all()[0]?.capabilities, withGoals);
        assert.equal(probe.calls, 0, "no probe was needed to get there");

        // Everything derived from the row keeps them: a turn-time rate-limit
        // update rebuilds the snapshot from the stored one.
        registry.applyUsageLimits("claude", {
          eventId: "e",
          threadId: "t",
          createdAt: "1970-01-01T00:00:00.000Z",
          type: "account.rate-limits.updated",
          payload: { limits: { windows: [{ id: "weekly", kind: "weekly", label: "W", usedPercent: 5 }] } }
        } as unknown as RuntimeEvent);
        assert.deepEqual(registry.get("claude")?.capabilities, withGoals);
      }, stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("the pending seed and a live probe's own row serve the adapter's capabilities too", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-capabilities-"));
    try {
      await withCurrentAdapter(async ({ registry, probe }) => {
        assert.deepEqual(registry.get("claude")?.capabilities, withGoals, "pending");
        const refreshed = await registry.refresh("claude");
        assert.equal(probe.calls, 1);
        assert.deepEqual(refreshed.capabilities, withGoals, "the refresh answer");
        assert.deepEqual(registry.get("claude")?.capabilities, withGoals, "probed");
      }, stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("the freshest live statement wins: a probe's capabilities replace the seed's", async () => {
    // The probe asks the running adapter itself, so what it reports is the
    // adapter's current word — and a cached row hydrated after it gets that.
    const stateDir = await mkdtemp(join(tmpdir(), "provider-capabilities-"));
    try {
      const probed = {
        ...withGoals,
        goals: { command: "host" as const, actions: ["pause"] as const, continuesAcrossTurns: true }
      };
      await withCurrentAdapter(async ({ registry, probe }) => {
        probe.next = snapshotFor("claude", { version: "2.1.281", capabilities: probed });
        await registry.refresh("claude");
        assert.deepEqual(registry.get("claude")?.capabilities, probed);

        await writeCache(stateDir, {
          claude: {
            identity: identityFor("claude", { binPath: "/usr/bin/claude" }),
            snapshot: snapshotFor("claude", { version: "2.1.280" })
          }
        });
        await registry.load();
        assert.deepEqual(registry.get("claude")?.capabilities, probed);
      }, stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("the cache file itself is rewritten with the current capabilities", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "provider-capabilities-"));
    try {
      await withCurrentAdapter(async ({ registry }) => {
        await registry.refresh("claude");
        await registry.flush();
        const raw = JSON.parse(
          await readFile(join(stateDir, "provider-snapshots.json"), "utf8")
        ) as CacheFile;
        assert.deepEqual(raw.providers.claude?.snapshot.capabilities, withGoals);
      }, stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

/**
 * The overlay's source is each adapter's PENDING seed, so the whole of goals
 * §5.4 rests on one equality nothing else enforces: the seed carries the very
 * capability constant the adapter itself serves. Pinned here for every adapter
 * with a goal surface — a seed that built its own block would silently strip
 * or fake `goals` on every row the registry serves.
 */
describe("goals §5.4: each goal adapter's pending seed carries the adapter's own capabilities", () => {
  const cases = [
    ["claude", CLAUDE_CAPABILITIES, "provider", false],
    ["codex", CODEX_ADAPTER_CAPABILITIES, "host", true],
    ["grok", GROK_CAPABILITIES, "provider", false]
  ] as const;
  for (const [id, constant, command, continuesAcrossTurns] of cases) {
    it(id, () => {
      const seed = ADAPTER_PENDING_SNAPSHOTS[id]("1970-01-01T00:00:00.000Z");
      assert.equal(seed.capabilities, constant, "the same object, not a copy that can drift");
      // The two fields the host itself keys on: who parses `/goal`, and who
      // starts the goal's turns.
      assert.equal(constant.goals?.command, command);
      assert.equal(constant.goals?.continuesAcrossTurns, continuesAcrossTurns);
    });
  }
});
