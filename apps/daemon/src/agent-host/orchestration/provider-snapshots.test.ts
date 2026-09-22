import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  AgentAdapterId,
  ProviderSnapshot,
  RuntimeEvent
} from "@orquester/api/agent-chat";

import { createProviderSnapshotRegistry } from "./provider-snapshots.ts";
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
      timers.runDue(6_000);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1);

      release();
      timers.runDue(20_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probe.calls, 1, "the loop stops once nothing is watching");
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
      ) as { providers: Record<string, ProviderSnapshot> };
      assert.equal(raw.providers.claude?.id, "claude");

      // The filename alone is not trusted as a routing key.
      await writeFile(
        join(stateDir, "provider-snapshots.json"),
        JSON.stringify({ version: 1, providers: { claude: { ...snapshotFor("claude"), id: "codex" } } })
      );
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
