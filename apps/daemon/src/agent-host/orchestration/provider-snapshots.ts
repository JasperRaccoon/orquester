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
 *
 * **A fresh host answers `GET /providers` immediately, in three layers** —
 * T3's design, adopted whole after a deploy left every launcher showing "Still
 * loading this agent's models" for five minutes:
 *
 * 1. **A pending seed, synchronously at construction**, before any probe and
 *    before the cache file is read: one snapshot per adapter carrying
 *    `status:"unknown"`, `auth:{status:"unknown"}` and the best catalog the
 *    adapter can name without I/O. *T3:
 *    `makeManagedServerProvider.ts:69-73` (`initialSnapshot(settings)`);
 *    `Layers/ClaudeProvider.ts:595-640` (`makePendingClaudeProvider`).*
 * 2. **The on-disk cache, hydrated at boot with an identity correlation
 *    check**: an entry is used only when the identity written beside it still
 *    matches this host and this binary, and a correlated entry **overrides**
 *    the pending seed. *T3: `Layers/ProviderRegistry.ts:292-352` — "old
 *    identity-less payloads are discarded"; `:743-751` — the pending
 *    fallbacks merge UNDER the cached ones; `providerStatusCache.ts:115-160`
 *    — identity lives inside the file because "the filename alone is not
 *    trusted as a routing key".*
 * 3. **A forced probe of every provider kicked by the registry itself at
 *    boot**, off the startup critical path, serialised like every other
 *    refresh. *T3: `makeManagedServerProvider.ts:280-284` —
 *    `applySnapshot(initialSettings, {forceRefresh: true})` under
 *    `Effect.forkScoped`.* The 5-minute interval
 *    ({@link PROVIDER_SNAPSHOT_REFRESH_INTERVAL_MS}) is only a top-up, and
 *    stays demand-gated on a live watcher. *T3:
 *    `packages/contracts/src/settings.ts:921` — the 5-minute default;
 *    `makeManagedServerProvider.ts:214-222` — `hasProviderStatusDemand`.*
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
import { ADAPTER_IDS, ADAPTER_PENDING_SNAPSHOTS, isAgentAdapterId } from "../adapters/index.ts";
import { isPendingSnapshot } from "../adapters/pending.ts";
import { AGENT_HOST_PROTOCOL_VERSION } from "../host-protocol.ts";
import type { Clock } from "./runtime-seams.ts";
import { systemClock } from "./runtime-seams.ts";

/** T3's default is five minutes and user-configurable; Orquester pins it. */
export const PROVIDER_SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60_000;

/** At most this many per-cwd overlays are retained per provider (§4.6.4). */
export const MAX_WORKSPACE_SNAPSHOTS = 16;

export interface ProviderProbe {
  id: AgentAdapterId;
  refresh(input?: { cwd?: string }): Promise<ProviderSnapshot>;
  /**
   * This probe's own ceiling, when {@link AGENT_HOST_DEADLINES.authProbeMs} is
   * not enough (E9). A probe that has to **start a provider server** before it
   * can read a catalogue needs a window covering the start as well as the
   * read; every other probe keeps the tight auth window, so one slow provider
   * never buys the rest a longer leash. Omitted ⇒ `authProbeMs`.
   */
  timeoutMs?: number;
  /**
   * The §3.2 PENDING snapshot for this adapter: what the registry seeds itself
   * with at construction, before `load()` and before any probe. Synchronous by
   * contract — it runs while the host is still wiring itself up.
   *
   * Omitted ⇒ this provider simply has no row until its first probe, which is
   * the pre-adoption behaviour. Every real adapter supplies one via
   * {@link ADAPTER_PENDING_SNAPSHOTS}.
   */
  pending?: (checkedAt: string) => ProviderSnapshot;
  /**
   * What the cached snapshot on disk is CORRELATED against (layer two).
   *
   * The identity is written beside the snapshot and re-read at boot; an entry
   * whose identity no longer matches is discarded rather than rendered, so a
   * payload written by another host, another protocol version, or against a
   * CLI that has since moved never reaches the client. Cheap and synchronous —
   * at most a PATH resolution.
   *
   * *T3: `providerStatusCache.ts:115-160` — "Cache contents must still carry
   * matching `instanceId` + `driver` identity before hydration. The filename
   * alone is not trusted as a routing key."*
   */
  identity?: () => ProviderCacheIdentity;
}

/**
 * The correlation stamp written next to each cached snapshot.
 *
 * `binPath` is the CLI the snapshot describes: a `npm install -g` that moves
 * the binary, or a launcher whose bin disappeared, invalidates the cache the
 * same boot rather than showing a version and a model list belonging to a
 * binary that is no longer there. `version` is the CLI version the probe read,
 * kept for diagnosis and for the (rare) case where the path is stable across a
 * reinstall.
 */
export interface ProviderCacheIdentity {
  /** The CLI this snapshot was probed against, absolute, or `null` for none. */
  binPath?: string | null;
  /** The CLI version the probe read, when it read one. */
  version?: string | null;
}

/** The identity as it is persisted — adapter + protocol + probe identity. */
interface PersistedIdentity extends ProviderCacheIdentity {
  adapterId: AgentAdapterId;
  hostProtocolVersion: number;
}

/** The current on-disk cache format. v1 carried no identity and is discarded. */
export const PROVIDER_SNAPSHOT_CACHE_VERSION = 2;

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
  /**
   * Layer two: load the persisted cache over the pending seed, keeping only
   * entries whose identity still correlates with this host. Never throws — a
   * bad, foreign or identity-less file is simply ignored.
   */
  load(): Promise<void>;
  /**
   * Layer three: kick one forced probe of every provider. **Fire-and-forget** —
   * it returns immediately and must never be awaited on a startup path, since
   * a probe's deadline is seconds and readiness must not wait on it.
   * Idempotent; a second call while the first pass runs does nothing.
   */
  startBootRefresh(): void;
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

/** One cached row as it sits on disk: identity first, snapshot second. */
interface CachedEntry {
  identity: PersistedIdentity;
  snapshot: ProviderSnapshot;
}

function normaliseIdentityField(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * The cache file is read back field-wise with a fallback, never trusted raw —
 * an old bundle's payload outlives a deploy (AGENTS.md) and §8 makes the host's
 * own state outlive a rollback.
 *
 * A row survives parsing only with an identity block, and only when the
 * adapter id appears in **three** places that agree: the map key, the
 * identity's own `adapterId`, and the snapshot's `id`. Anything else — a v1
 * payload with no identity at all, a protocol version from another deploy, a
 * hand-edited file — is dropped here and the boot probe of layer three
 * repopulates it.
 *
 * *T3: `Layers/ProviderRegistry.ts:292-352` — "old identity-less payloads are
 * discarded and the awaited refresh below repopulates the cache".*
 */
function parseCachedSnapshots(raw: unknown): Map<AgentAdapterId, CachedEntry> {
  const parsed = new Map<AgentAdapterId, CachedEntry>();
  if (!isRecord(raw)) {
    return parsed;
  }
  const providers = raw.providers;
  if (!isRecord(providers)) {
    return parsed;
  }
  for (const [key, row] of Object.entries(providers)) {
    if (!isAgentAdapterId(key) || !isRecord(row)) {
      continue;
    }
    const identity = row.identity;
    const snapshot = row.snapshot;
    if (!isRecord(identity) || !isRecord(snapshot)) {
      // v1 wrote the bare snapshot under the key and carried no identity.
      continue;
    }
    // Identity lives INSIDE the file: the key alone is not a routing key.
    if (identity.adapterId !== key || snapshot.id !== key) {
      continue;
    }
    if (identity.hostProtocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
      continue;
    }
    if (typeof snapshot.installed !== "boolean" || !isRecord(snapshot.capabilities)) {
      continue;
    }
    parsed.set(key, {
      identity: {
        adapterId: key,
        hostProtocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        binPath: normaliseIdentityField(identity.binPath),
        version: normaliseIdentityField(identity.version)
      },
      snapshot: snapshot as unknown as ProviderSnapshot
    });
  }
  return parsed;
}

/**
 * Is a cached row still describing THIS host's installation?
 *
 * Only a field both sides actually know is compared: a `binPath` the current
 * probe cannot name (no identity resolver, or a resolver that answered
 * `undefined`) is not evidence of a mismatch and must not throw away a good
 * cache. A `null` on both sides — "no such binary, then and now" — correlates.
 *
 * *T3: `Layers/ProviderRegistry.ts:330-346` (`isCachedProviderCorrelated`).*
 */
function isCachedEntryCorrelated(
  cached: PersistedIdentity,
  current: ProviderCacheIdentity | undefined
): boolean {
  if (current === undefined) {
    return true;
  }
  if (current.binPath !== undefined && cached.binPath !== undefined) {
    return current.binPath === cached.binPath;
  }
  return true;
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
  /** The identity each stored snapshot was produced under (layer two). */
  const identities = new Map<AgentAdapterId, ProviderCacheIdentity>();

  const identityOf = (adapterId: AgentAdapterId): ProviderCacheIdentity | undefined => {
    const probe = probes.get(adapterId);
    if (probe?.identity === undefined) {
      return undefined;
    }
    try {
      return probe.identity();
    } catch (error) {
      // An identity that cannot be read is "unknown", never a mismatch: it must
      // not be able to throw away a good cache or fail a refresh.
      options.logger.warn(`provider identity failed for ${adapterId}`, error);
      return undefined;
    }
  };

  // ---- layer 1: the pending seed, before load() and before any probe -------
  // *T3: `makeManagedServerProvider.ts:69-73` — `initialSnapshot(settings)` is
  // resolved at construction; the provider is never snapshot-less.*
  // Seeded WITHOUT notifying or persisting: nothing has changed, nobody has
  // subscribed yet, and writing a pending row to disk would let it be hydrated
  // as if it were a probe result on the next boot.
  for (const probe of options.probes) {
    if (probe.pending === undefined) continue;
    snapshots.set(probe.id, probe.pending(clock.nowIso()));
  }

  // One permit, so two clients opening Settings cannot run two probes.
  let refreshChain: Promise<unknown> = Promise.resolve();
  // Concurrent `ensureWorkspaceSnapshot` calls for one (adapter, cwd) collapse.
  const inFlightWorkspaces = new Map<string, Promise<void>>();

  let changeCount = 0;
  let watchers = 0;
  /**
   * Adapters holding something better than a pending seed — a correlated
   * cached snapshot or a live probe result. The watcher's priming (below) is a
   * no-op once every probe is in here.
   */
  const probed = new Set<AgentAdapterId>();
  let primed = false;
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
        const providers: Record<string, { identity: PersistedIdentity; snapshot: ProviderSnapshot }> =
          {};
        for (const [id, snapshot] of snapshots) {
          // A pending seed is NOT cacheable: it is the absence of a probe, and
          // hydrating it next boot would masquerade as one.
          if (isPendingSnapshot(snapshot)) continue;
          const identity = identities.get(id) ?? {};
          providers[id] = {
            identity: {
              adapterId: id,
              hostProtocolVersion: AGENT_HOST_PROTOCOL_VERSION,
              ...(identity.binPath !== undefined ? { binPath: identity.binPath } : {}),
              version: snapshot.version
            },
            snapshot
          };
        }
        const body = JSON.stringify(
          { version: PROVIDER_SNAPSHOT_CACHE_VERSION, providers },
          null,
          2
        );
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
    // NOTE: the cache identity is NOT resolved here. `store` is also the path
    // `applyUsageLimits`/`applyAuthStatus` take, which run per turn, and
    // resolving a binary against PATH on each would put a handful of stats on
    // a hot path for a value that only a probe can change. `refreshOne` stamps
    // it instead, right beside the probe that produced the snapshot.
    // An identical configuration short-circuits: no change event, no rewrite.
    // A PENDING previous is never "identical" in practice (a probe always
    // reaches an `installed` verdict), but the guard is explicit so a probe
    // that somehow answers the pending shape still counts as the first real
    // result rather than being swallowed.
    if (!isPendingSnapshot(previous ?? snapshot) && snapshotsEqual(previous, snapshot)) {
      snapshots.set(snapshot.id, snapshot);
      return false;
    }
    snapshots.set(snapshot.id, snapshot);
    probed.add(snapshot.id);
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
      timeoutMs: probe.timeoutMs ?? AGENT_HOST_DEADLINES.authProbeMs,
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
    // The identity this probe ran under, recorded before the store so the cache
    // it writes can be correlated on the next boot (layer two).
    const identity = identityOf(adapterId);
    if (identity !== undefined) {
      identities.set(adapterId, identity);
    } else {
      identities.delete(adapterId);
    }
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
          // R8-M4: `error`, not `degraded`. The client's `authErrorMessage`
          // (§7.7's toast) fires for `auth.status === "unauthenticated"` or
          // `status === "error"`, and deliberately not for `degraded` — which
          // `codex/probe.ts` and `opencode/index.ts` set for reasons that have
          // nothing to do with auth. Writing `degraded` here meant the whole
          // chain ran and the toast could never appear.
          status: "error",
          message: error,
          // The probe decides `authenticated` vs `unauthenticated`; a turn-time
          // failure only says the credential did not work just now, so the
          // enum moves to `unknown` rather than claiming a verdict the probe
          // has not reached. The toast's second arm asks only for "not
          // authenticated", so `unknown` still reaches it.
          auth: { ...snapshot.auth, status: "unknown" },
          checkedAt: clock.nowIso()
        });
        return;
      }
      // A clean `auth.status` clears a previously reported error. Both spellings
      // are accepted so a snapshot stored by a pre-R8-M4 host still clears.
      if (
        (snapshot.status === "error" || snapshot.status === "degraded") &&
        snapshot.message !== undefined
      ) {
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
      // The pre-adoption stopgap, kept as a **belt-and-braces no-op**: with
      // layers one to three in place every provider already holds either a
      // correlated cached snapshot or a live probe result by the time a client
      // subscribes, so `probed` is full and this does nothing. It still fires
      // on the one path that skips `startBootRefresh()` — a host built without
      // it, as several unit tests are — rather than leaving a provider with
      // nothing but its pending seed until the interval elapses.
      if (!primed && ADAPTER_IDS.some((id) => probes.has(id) && !probed.has(id))) {
        primed = true;
        void refreshAllNow();
      }
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

    /**
     * Layer two: hydrate the on-disk cache over the pending seed.
     *
     * A cached entry is used **only when it correlates** with this host's
     * current identity for that adapter; an uncorrelated one is dropped and
     * the boot probe repopulates it. A correlated entry overrides the pending
     * seed — that direction is the whole point: "on-disk state wins where
     * present and pending fallbacks fill the gaps".
     *
     * *T3: `Layers/ProviderRegistry.ts:292-352` and `:743-751`.*
     *
     * Never throws, and never persists: hydration is a read.
     */
    async load(): Promise<void> {
      let entries: Map<AgentAdapterId, CachedEntry>;
      try {
        const raw = await readFile(cachePath, "utf8");
        entries = parseCachedSnapshots(JSON.parse(raw) as unknown);
      } catch {
        // No cache, or an unreadable one: the first live probe fills it.
        return;
      }
      for (const [id, entry] of entries) {
        if (!probes.has(id)) {
          // A snapshot for an adapter this host does not serve.
          continue;
        }
        const current = identityOf(id);
        if (!isCachedEntryCorrelated(entry.identity, current)) {
          options.logger.warn("provider status cache identity mismatch, ignoring", {
            adapterId: id,
            cachedBinPath: entry.identity.binPath ?? null,
            binPath: current?.binPath ?? null
          });
          continue;
        }
        if (isPendingSnapshot(entry.snapshot)) {
          // Defensive: a pending row is never written, and hydrating one would
          // claim a probe that never happened.
          continue;
        }
        snapshots.set(id, entry.snapshot);
        identities.set(id, {
          ...(entry.identity.binPath !== undefined ? { binPath: entry.identity.binPath } : {}),
          ...(entry.identity.version !== undefined ? { version: entry.identity.version } : {})
        });
        probed.add(id);
      }
    },

    /**
     * Layer three: force one probe of every provider, now, off the critical
     * path.
     *
     * Fire-and-forget by contract — the caller must never await it. The HTTP
     * socket is already bound and the readiness gate is already open when this
     * runs; a probe that hangs for its whole deadline must not be able to keep
     * a client waiting for `GET /providers`, which answers from the pending
     * seed meanwhile.
     *
     * Serialised through the same one-permit chain as every other refresh, so
     * it cannot race a client's manual `POST …/refresh`, and idempotent: a
     * second call while the first pass is running does nothing.
     *
     * *T3: `makeManagedServerProvider.ts:280-284` —
     * `applySnapshot(initialSettings, {forceRefresh: true})` under
     * `Effect.forkScoped`, i.e. forked by the provider itself at construction
     * rather than waited on by whatever builds it.*
     */
    startBootRefresh(): void {
      if (stopped || primed) {
        return;
      }
      primed = true;
      void refreshAllNow();
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
