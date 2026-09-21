/**
 * Agent host — the provider snapshot registry (spec §3.2, §4.1, §6.3, §4.6.4).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/makeManagedServerProvider.ts:64,129-152,174-179,207-283`
 * (the interval loop, the one-permit refresh semaphore, the identical-settings
 * short circuit and the demand gate) and
 * `apps/server/src/provider/providerStatusCache.ts:108-123` (the on-disk cache,
 * with identity carried *inside* the file because "the filename alone is not
 * trusted as a routing key").
 *
 * Snapshots refresh on a slow interval, **not per request**: computed on
 * demand, cached, re-probed in the background every few minutes, and only while
 * something is actually watching provider status.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  AgentAdapterId,
  ProviderSnapshot,
  ProviderUsageWindow,
  RuntimeEvent,
  WorkspaceSnapshot
} from "@orquester/api/agent-chat";

import type { AdapterLogger } from "../adapter.ts";
import type { ProviderSnapshotRegistry } from "../services.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../support/deadline.ts";
import { ADAPTER_IDS, isAgentAdapterId } from "../adapters/index.ts";
import type { Clock } from "./runtime-seams.ts";
import { systemClock } from "./runtime-seams.ts";

/** T3's default is five minutes and user-configurable; Orquester pins it. */
export const PROVIDER_SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60_000;

/** At most this many per-cwd overlays are retained per provider (§4.6.4). */
export const MAX_WORKSPACE_SNAPSHOTS = 16;

export interface ProviderProbe {
  id: AgentAdapterId;
  refresh(input?: { cwd?: string }): Promise<ProviderSnapshot>;
}

export interface ProviderSnapshotRegistryOptions {
  probes: ProviderProbe[];
  /** `<appdir>/daemon/agent` — the cache lands beside the thread store. */
  stateDir: string;
  logger: AdapterLogger;
  clock?: Clock;
  intervalMs?: number;
  /** Injectable so the background cadence is testable without elapsed time (§9). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ManagedProviderSnapshotRegistry extends ProviderSnapshotRegistry {
  /**
   * Fold an `auth.status` runtime event onto the cached snapshot (§7.7).
   *
   * A turn that hits an expired credential emits `auth.status {error}`, and
   * that is the only fast signal there is — the periodic probe's
   * `unauthenticated` verdict is minutes behind. Without this the event is
   * dropped and the user sees only a failed turn with no explanation.
   */
  applyAuthStatus(adapterId: AgentAdapterId, event: RuntimeEvent): void;
  /** Ref-counted demand: the background loop only runs while something watches. */
  addWatcher(): () => void;
  /** Load the persisted cache. Never throws — a bad file is simply ignored. */
  load(): Promise<void>;
  /**
   * Like {@link ProviderSnapshotRegistry.refresh}, but also says whether
   * anything actually changed — `agent.providers.changed` is gated on it
   * (§6.3), and an identical configuration must not raise it.
   */
  refreshDetailed(
    adapterId: AgentAdapterId,
    input?: { cwd?: string }
  ): Promise<{ snapshot: ProviderSnapshot; changed: boolean }>;
  /** Run one background pass now, respecting the refresh semaphore. */
  refreshAllNow(): Promise<void>;
  /** Await the in-flight cache write. The drain seam a test waits on (§9). */
  flush(): Promise<void>;
  /**
   * Bumped on every snapshot change, so a host-triggered one — a CLI upgraded
   * under the host, a login going stale, an `auth.status` error — is visible
   * to the daemon without it having to diff the whole snapshot list. `onChange`
   * fires inside the host process only; this is what crosses the socket.
   */
  changeCount(): number;
  stop(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The cache file is read back field-wise with a fallback, never trusted raw —
 * an old bundle's payload outlives a deploy (AGENTS.md) and §8 makes the host's
 * own state outlive a rollback.
 */
function parseCachedSnapshots(raw: unknown): Map<AgentAdapterId, ProviderSnapshot> {
  const parsed = new Map<AgentAdapterId, ProviderSnapshot>();
  if (!isRecord(raw)) {
    return parsed;
  }
  const providers = raw.providers;
  if (!isRecord(providers)) {
    return parsed;
  }
  for (const [key, value] of Object.entries(providers)) {
    if (!isAgentAdapterId(key) || !isRecord(value)) {
      continue;
    }
    // Identity lives INSIDE the file: the filename (here, the key) alone is not
    // trusted as a routing key.
    if (value.id !== key) {
      continue;
    }
    if (typeof value.installed !== "boolean" || !isRecord(value.capabilities)) {
      continue;
    }
    parsed.set(key, value as unknown as ProviderSnapshot);
  }
  return parsed;
}

function mergeUsageWindows(
  current: ProviderUsageWindow[],
  update: ProviderUsageWindow[]
): ProviderUsageWindow[] {
  // `id` is stable per provider, so a sparse turn-driven update lands on the
  // same row the probe produced (§4.1).
  const byId = new Map(current.map((window) => [window.id, window]));
  for (const window of update) {
    byId.set(window.id, { ...byId.get(window.id), ...window });
  }
  return [...byId.values()];
}

function snapshotsEqual(left: ProviderSnapshot | undefined, right: ProviderSnapshot): boolean {
  if (!left) return false;
  // `checkedAt` moves on every probe and is not a change the client cares about.
  const strip = (snapshot: ProviderSnapshot): string =>
    JSON.stringify({ ...snapshot, checkedAt: "" });
  return strip(left) === strip(right);
}

export function createProviderSnapshotRegistry(
  options: ProviderSnapshotRegistryOptions
): ManagedProviderSnapshotRegistry {
  const clock = options.clock ?? systemClock;
  const intervalMs = options.intervalMs ?? PROVIDER_SNAPSHOT_REFRESH_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const cachePath = join(options.stateDir, "provider-snapshots.json");

  const probes = new Map<AgentAdapterId, ProviderProbe>(
    options.probes.map((probe) => [probe.id, probe])
  );
  const snapshots = new Map<AgentAdapterId, ProviderSnapshot>();
  const listeners = new Set<(adapterId: AgentAdapterId) => void>();

  // One permit, so two clients opening Settings cannot run two probes.
  let refreshChain: Promise<unknown> = Promise.resolve();
  // Concurrent `ensureWorkspaceSnapshot` calls for one (adapter, cwd) collapse.
  const inFlightWorkspaces = new Map<string, Promise<void>>();

  let changeCount = 0;
  let watchers = 0;
  let timerHandle: unknown = null;
  let stopped = false;
  let persistChain: Promise<unknown> = Promise.resolve();

  const notify = (adapterId: AgentAdapterId): void => {
    for (const listener of [...listeners]) {
      try {
        listener(adapterId);
      } catch (error) {
        options.logger.warn("provider snapshot listener failed", error);
      }
    }
  };

  const persist = (): void => {
    persistChain = persistChain
      .then(async () => {
        const providers: Record<string, ProviderSnapshot> = {};
        for (const [id, snapshot] of snapshots) {
          providers[id] = snapshot;
        }
        const body = JSON.stringify({ version: 1, providers }, null, 2);
        await mkdir(dirname(cachePath), { recursive: true });
        const tmp = `${cachePath}.tmp`;
        await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, cachePath);
      })
      .catch((error: unknown) => {
        // Diagnostics never block the host.
        options.logger.warn("failed to persist provider snapshots", error);
      });
  };

  const store = (snapshot: ProviderSnapshot): boolean => {
    const previous = snapshots.get(snapshot.id);
    // An identical configuration short-circuits: no change event, no rewrite.
    if (snapshotsEqual(previous, snapshot)) {
      snapshots.set(snapshot.id, snapshot);
      return false;
    }
    snapshots.set(snapshot.id, snapshot);
    changeCount += 1;
    persist();
    notify(snapshot.id);
    return true;
  };

  const serialise = <T>(task: () => Promise<T>): Promise<T> => {
    const result = refreshChain.then(task, task);
    refreshChain = result.catch(() => undefined);
    return result;
  };

  const probeOnce = async (
    probe: ProviderProbe,
    input?: { cwd?: string }
  ): Promise<ProviderSnapshot> =>
    withDeadline(() => probe.refresh(input), {
      timeoutMs: AGENT_HOST_DEADLINES.authProbeMs,
      label: `provider-snapshot:${probe.id}`
    });

  const refreshOne = async (
    adapterId: AgentAdapterId,
    input?: { cwd?: string }
  ): Promise<{ snapshot: ProviderSnapshot; changed: boolean }> => {
    const probe = probes.get(adapterId);
    if (!probe) {
      throw new Error(`No adapter registered for '${adapterId}'.`);
    }
    const fresh = await probeOnce(probe, input);
    const merged = mergeWorkspaceOverlay(snapshots.get(adapterId), fresh, input?.cwd);
    const changed = store(merged);
    return { snapshot: merged, changed };
  };

  /** A per-cwd probe refreshes just that overlay, never the machine catalog. */
  /**
   * §4.6.4: "a probe that comes back empty never blanks a non-empty cached
   * list". Per array and independently — a transient `EACCES` on a skills dir
   * or a `skills/list` timeout recovers to `[]` while the command list is
   * still good, so a combined `commands.length === 0 && skills.length === 0`
   * guard lets exactly that case through.
   */
  const keepNonEmpty = <T>(next: readonly T[], previous: readonly T[] | undefined): T[] =>
    next.length === 0 && previous !== undefined && previous.length > 0
      ? [...previous]
      : [...next];

  const mergeWorkspaceOverlay = (
    previous: ProviderSnapshot | undefined,
    fresh: ProviderSnapshot,
    cwd: string | undefined
  ): ProviderSnapshot => {
    if (cwd === undefined) {
      // A machine-level probe replaces the catalog — but an empty list in it
      // must not blank a good cached one either.
      const merged: ProviderSnapshot = {
        ...fresh,
        slashCommands: keepNonEmpty(fresh.slashCommands, previous?.slashCommands),
        skills: keepNonEmpty(fresh.skills, previous?.skills)
      };
      // A full probe keeps whatever overlays we already hold unless it brought
      // its own.
      if (fresh.workspaceSnapshots === undefined && previous?.workspaceSnapshots !== undefined) {
        return { ...merged, workspaceSnapshots: previous.workspaceSnapshots };
      }
      return merged;
    }
    const base = previous ?? fresh;
    const overlay = fresh.workspaceSnapshots?.find((entry) => entry.cwd === cwd) ?? {
      cwd,
      checkedAt: fresh.checkedAt,
      slashCommands: fresh.slashCommands,
      skills: fresh.skills
    };
    const kept = (base.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd);
    const previousOverlay = (previous?.workspaceSnapshots ?? []).find(
      (entry) => entry.cwd === cwd
    );
    const effective: WorkspaceSnapshot = {
      ...overlay,
      slashCommands: keepNonEmpty(overlay.slashCommands, previousOverlay?.slashCommands),
      skills: keepNonEmpty(overlay.skills, previousOverlay?.skills)
    };
    return {
      ...base,
      // Machine-level fields always come from the freshest full probe we hold.
      ...(previous === undefined ? fresh : {}),
      workspaceSnapshots: [effective, ...kept].slice(0, MAX_WORKSPACE_SNAPSHOTS)
    };
  };

  const scheduleNext = (): void => {
    if (stopped || watchers === 0 || timerHandle !== null) {
      return;
    }
    timerHandle = setTimer(() => {
      timerHandle = null;
      void refreshAllNow().finally(() => {
        scheduleNext();
      });
    }, intervalMs);
  };

  const refreshAllNow = async (): Promise<void> => {
    for (const adapterId of ADAPTER_IDS) {
      if (!probes.has(adapterId)) continue;
      try {
        await serialise(() => refreshOne(adapterId));
      } catch (error) {
        // A probe failure keeps the last good snapshot; it never fails the loop.
        options.logger.warn(`provider snapshot refresh failed for ${adapterId}`, error);
      }
    }
  };

  return {
    all(): ProviderSnapshot[] {
      return ADAPTER_IDS.map((id) => snapshots.get(id)).filter(
        (snapshot): snapshot is ProviderSnapshot => snapshot !== undefined
      );
    },

    get(adapterId: AgentAdapterId): ProviderSnapshot | null {
      return snapshots.get(adapterId) ?? null;
    },

    async refresh(adapterId: AgentAdapterId, input?: { cwd?: string }): Promise<ProviderSnapshot> {
      const { snapshot } = await serialise(() => refreshOne(adapterId, input));
      return snapshot;
    },

    refreshDetailed(adapterId: AgentAdapterId, input?: { cwd?: string }) {
      return serialise(() => refreshOne(adapterId, input));
    },

    ensureWorkspaceSnapshot(adapterId: AgentAdapterId, cwd: string): void {
      const key = `${adapterId}\u0000${cwd}`;
      if (inFlightWorkspaces.has(key)) {
        return;
      }
      const existing = snapshots.get(adapterId);
      if (existing?.workspaceSnapshots?.some((entry) => entry.cwd === cwd)) {
        // Never re-probe a cwd we already hold.
        return;
      }
      const task = serialise(() => refreshOne(adapterId, { cwd }))
        .then(() => undefined)
        .catch((error: unknown) => {
          options.logger.warn(`workspace snapshot refresh failed for ${adapterId}`, error);
        })
        .finally(() => {
          inFlightWorkspaces.delete(key);
        });
      inFlightWorkspaces.set(key, task);
    },

    applyUsageLimits(adapterId: AgentAdapterId, event: RuntimeEvent): void {
      if (event.type !== "account.rate-limits.updated") {
        return;
      }
      const snapshot = snapshots.get(adapterId);
      if (!snapshot) {
        return;
      }
      const update = event.payload.limits;
      const next: ProviderSnapshot = {
        ...snapshot,
        usageLimits: {
          checkedAt: clock.nowIso(),
          windows: mergeUsageWindows(snapshot.usageLimits?.windows ?? [], update.windows),
          ...(snapshot.usageLimits?.unavailable !== undefined
            ? { unavailable: snapshot.usageLimits.unavailable }
            : {})
        }
      };
      store(next);
    },

    applyAuthStatus(adapterId: AgentAdapterId, event: RuntimeEvent): void {
      if (event.type !== "auth.status") {
        return;
      }
      const snapshot = snapshots.get(adapterId);
      if (!snapshot) {
        return;
      }
      const error = event.payload.error;
      if (typeof error === "string" && error.length > 0) {
        store({
          ...snapshot,
          status: "degraded",
          message: error,
          // The probe decides `authenticated` vs `unauthenticated`; a turn-time
          // failure only says the credential did not work just now, so the
          // enum moves to `unknown` rather than claiming a verdict the probe
          // has not reached.
          auth: { ...snapshot.auth, status: "unknown" },
          checkedAt: clock.nowIso()
        });
        return;
      }
      // A clean `auth.status` clears a previously reported error.
      if (snapshot.status === "degraded" && snapshot.message !== undefined) {
        const { message: _cleared, ...rest } = snapshot;
        void _cleared;
        store({ ...rest, status: "ready", checkedAt: clock.nowIso() });
      }
    },

    onChange(listener: (adapterId: AgentAdapterId) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    addWatcher(): () => void {
      watchers += 1;
      scheduleNext();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        watchers = Math.max(0, watchers - 1);
        if (watchers === 0 && timerHandle !== null) {
          clearTimer(timerHandle);
          timerHandle = null;
        }
      };
    },

    async load(): Promise<void> {
      try {
        const raw = await readFile(cachePath, "utf8");
        for (const [id, snapshot] of parseCachedSnapshots(JSON.parse(raw) as unknown)) {
          snapshots.set(id, snapshot);
        }
      } catch {
        // No cache, or an unreadable one: the first live probe fills it.
      }
    },

    refreshAllNow,

    async flush(): Promise<void> {
      await persistChain.catch(() => undefined);
    },

    changeCount(): number {
      return changeCount;
    },

    stop(): void {
      stopped = true;
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      listeners.clear();
    }
  };
}
