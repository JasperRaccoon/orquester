/**
 * The box service (spec §8, §9, §12, §13): records, registry, lifecycle, reconciler, project
 * integration, settings and routes, behind one `createBoxService(deps)`. The hub, provider
 * adapters, bootstrap, Tailscale, config sync, tooling and the Blacksmith GitHub driver are
 * injected (contracts.ts and the interfaces below).
 *
 * The plugin switch (`EPHEMERAL_VMS_PLUGIN_ID`): while it is off nothing new is created or changed
 * through the routes. Boxes that exist keep running and stay managed: the reconciler keeps running
 * (time limits, destroy retries, gone instances; no setup is resumed) as long as any record is not
 * `destroyed`, the plugin page lists them, and they are destroyed through `DELETE /api/boxes/:id`
 * (temporary boxes), their project's delete, or the programmatic `destroyBox` (chat close, the agent).
 */

import type { FastifyInstance } from "fastify";

import {
  BOX_PROVIDERS_CHANGED_EVENT,
  BOXES_CHANGED_EVENT,
  BOXES_CHANNEL,
  type BoxDestroyedReason,
  type BoxesResponse,
  type BoxKind,
  type BoxProviderId,
  type BoxSummary
} from "@orquester/api";

import type {
  BoxConfigSync,
  BoxHub,
  BoxProviderRegistry,
  BoxToolingProvisioner,
  BuildBootstrap,
  TailscaleKeys
} from "../contracts.ts";
import type { DaemonHttpAddress, LocalTailscale } from "../tailscale/local.ts";
import { BoxSetupLog } from "./box-exec.ts";
import { BoxError, errorLine } from "./errors.ts";
import { BoxLifecycle, systemClock, type BoxAgentClis, type BoxClock, type BoxGitAccess, type ManagedAgentHome } from "./lifecycle.ts";
import { resolvePlacement } from "./placement.ts";
import { BoxProjects } from "./projects.ts";
import { BoxReconciler } from "./reconciler.ts";
import { projectDeleted, StoreBoxRegistry } from "./registry.ts";
import { registerBoxRoutes } from "./routes.ts";
import { BoxSettings, type BlacksmithSetupDriver, type BoxHostingAccounts, type TailscaleCredentials } from "./settings.ts";
import { BoxStore, type BoxRecordStore } from "./store.ts";
import { boxesTotals, isActiveRecord, utcMonthStart } from "./summary.ts";

export { BoxError } from "./errors.ts";
export { sendBoxError } from "./routes.ts";
export { isBoxLocation } from "./projects.ts";
export type { BoxRecordStore } from "./store.ts";
export type { BlacksmithCheck, BlacksmithSetupDriver, BoxHostingAccounts, TailscaleCredentials } from "./settings.ts";
export type { BoxGitAccess, ManagedAgentHome } from "./lifecycle.ts";

export interface BoxServiceDeps {
  baseDir: string;
  providers: BoxProviderRegistry;
  hub: BoxHub;
  buildBootstrap: BuildBootstrap;
  /** A `TailscaleKeys` over the stored Tailscale credentials. */
  tailscale: (credentials: TailscaleCredentials) => TailscaleKeys;
  /** Missing: the `config` setup step is skipped with a message. */
  configSync?: BoxConfigSync;
  /** Missing: the `tooling` setup step is skipped with a message. */
  tooling?: BoxToolingProvisioner;
  accounts: BoxHostingAccounts;
  git: BoxGitAccess;
  /** Every managed agent account home (the `config` step syncs each). */
  managedAgentHomes: () => ManagedAgentHome[];
  /** Missing: the `agents` setup step is skipped with a message. */
  agentClis?: BoxAgentClis;
  blacksmith?: BlacksmithSetupDriver;
  /** The `orq-agent` builds boxes download; a create is refused while there are none. Absent: not checked. */
  agentBuilds?: { current(): Promise<{ version: string } | null> };
  pluginEnabled: () => Promise<boolean>;
  onPluginChange: (listener: (enabled: boolean) => void) => () => void;
  publish: (channel: string, type: string, payload: unknown) => void;
  /** The daemon's configured public origin, when it has one (the default public URL). */
  publicOrigin: () => string | null;
  /** Tailscale on this machine (Connection's status line and "Set up for me"). Absent: not reported. */
  localTailscale?: LocalTailscale;
  /** Where the daemon's HTTP transport listens. */
  daemonHttp?: () => DaemonHttpAddress;
  fetch?: typeof fetch;
  clock?: BoxClock;
  logger?: Pick<Console, "warn" | "error" | "log">;
}

export interface CreateTemporaryBoxRequest {
  /** The agent-chat thread that rents it (null: the Blacksmith test run). */
  threadId: string | null;
  kind: BoxKind;
  provider?: BoxProviderId;
  size?: string;
  region?: string;
  /** A `BoxImageOffer.id`, when the provider offers a choice for the kind. */
  image?: string;
  lifetimeMinutes: number;
  purposeNote: string;
}

export interface BoxService {
  registry: StoreBoxRegistry;
  /** The record store the hub reads and updates. */
  records: BoxRecordStore;
  projects: BoxProjects;
  settings: BoxSettings;
  enabled(): boolean;
  registerRoutes(app: FastifyInstance): void;
  /** Load the stores, follow the plugin switch; the reconciler runs while it is on or any box is not destroyed. */
  start(): Promise<void>;
  /** Stop timers and setup runs (records stay; the next start resumes them); queued writes land. */
  stop(): Promise<void>;
  boxesResponse(): BoxesResponse;
  setupLog(boxId: string): Promise<string>;
  /**
   * Persist a temporary box's record and start its setup in the background; resolves with its
   * summary once the record exists (readiness and failure arrive as registry changes).
   */
  startTemporaryBox(request: CreateTemporaryBoxRequest): Promise<BoxSummary>;
  /** Create a temporary box and resolve once it is ready (rejects, torn down, when setup fails). Aborting destroys it. */
  createTemporaryBox(request: CreateTemporaryBoxRequest, signal?: AbortSignal): Promise<BoxSummary>;
  destroyBox(boxId: string, reason: BoxDestroyedReason): Promise<BoxSummary>;
  startBlacksmithTest(): Promise<void>;
  reconcileNow(): Promise<void>;
  /** Every background setup and destroy has finished (tests). */
  settled(): Promise<void>;
}

const MAX_PURPOSE_NOTE = 200;

export function createBoxService(deps: BoxServiceDeps): BoxService {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? console;
  const store = new BoxStore({ baseDir: deps.baseDir, logger, now: () => clock.now() });
  const registry = new StoreBoxRegistry(store, deps.hub, deps.providers, () => clock.now());
  const setupLog = new BoxSetupLog(deps.baseDir, logger);
  let enabled = false;

  // Clients get the whole list after any change, coalesced per tick.
  let boxesQueued = false;
  const publishBoxes = () => {
    if (boxesQueued) return;
    boxesQueued = true;
    setImmediate(() => {
      boxesQueued = false;
      deps.publish(BOXES_CHANNEL, BOXES_CHANGED_EVENT, service.boxesResponse());
    });
  };
  let providersQueued = false;
  const publishProviders = () => {
    if (providersQueued) return;
    providersQueued = true;
    setImmediate(() => {
      providersQueued = false;
      deps.publish(BOXES_CHANNEL, BOX_PROVIDERS_CHANGED_EVENT, settings.providersResponse());
    });
  };

  const settings = new BoxSettings({
    store,
    providers: deps.providers,
    tailscale: deps.tailscale,
    accounts: deps.accounts,
    ...(deps.blacksmith ? { blacksmith: deps.blacksmith } : {}),
    publicOrigin: deps.publicOrigin,
    ...(deps.localTailscale ? { localTailscale: deps.localTailscale } : {}),
    ...(deps.daemonHttp ? { daemonHttp: deps.daemonHttp } : {}),
    clock,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    logger,
    providersChanged: publishProviders
  });
  let reconciler: BoxReconciler;
  const lifecycle = new BoxLifecycle({
    baseDir: deps.baseDir,
    store,
    providers: deps.providers,
    hub: deps.hub,
    buildBootstrap: deps.buildBootstrap,
    connectivity: settings,
    ...(deps.configSync ? { configSync: deps.configSync } : {}),
    ...(deps.tooling ? { tooling: deps.tooling } : {}),
    git: deps.git,
    managedAgentHomes: deps.managedAgentHomes,
    ...(deps.agentClis ? { agentClis: deps.agentClis } : {}),
    setupLog,
    clock,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    logger,
    onProviderError: () => void reconciler.requestRun(),
    ...(deps.agentBuilds ? { agentBuilds: deps.agentBuilds } : {})
  });
  reconciler = new BoxReconciler({
    store,
    providers: deps.providers,
    hub: deps.hub,
    lifecycle,
    connectivity: settings,
    clock,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    logger,
    enabled: () => enabled,
    publishChanged: publishBoxes
  });
  const projects = new BoxProjects({ store, registry, lifecycle, settings, accounts: deps.accounts, enabled: () => enabled, now: () => clock.now() });

  const unsubscribers: (() => void)[] = [];
  let blacksmithTest: Promise<void> | null = null;
  const background = new Set<Promise<unknown>>();
  let started = false;

  /** The reconciler runs while the plugin is on, or while any box may still bill: no box is left unmanaged. */
  const followActivity = () => {
    if (started && (enabled || store.list().some(isActiveRecord))) reconciler.start();
    else reconciler.stop();
  };

  const setEnabled = (next: boolean) => {
    if (next === enabled) return;
    enabled = next;
    followActivity();
    publishBoxes();
    publishProviders();
  };

  const destroyBox = async (boxId: string, reason: BoxDestroyedReason): Promise<BoxSummary> => {
    if (!store.get(boxId)) throw new BoxError(404, "BOX_NOT_FOUND", "No such box.");
    const record = await lifecycle.destroy(boxId, reason);
    const summary = registry.summarize(record);
    if (!summary) throw new BoxError(500, "BOXES_UNAVAILABLE", "The destroyed box's record cannot be shown.");
    return summary;
  };

  const startTemporaryBox = async (request: CreateTemporaryBoxRequest): Promise<BoxSummary> => {
    if (!enabled) throw new BoxError(409, "BOXES_DISABLED", "Ephemeral AI VMs is turned off in Settings → Plugins.");
    if (request.threadId !== null && (typeof request.threadId !== "string" || request.threadId.length === 0)) {
      throw new BoxError(400, "BOX_INVALID_REQUEST", "`threadId` must be the chat's id.");
    }
    const note = typeof request.purposeNote === "string" ? request.purposeNote.trim().replace(/\s+/g, " ") : "";
    if (note.length === 0) throw new BoxError(400, "BOX_INVALID_REQUEST", "Say in a few words what the box is for.");
    const placement = await resolvePlacement(settings, {
      kind: request.kind,
      provider: request.provider,
      size: request.size,
      region: request.region,
      image: request.image,
      lifetimeMinutes: request.lifetimeMinutes,
      explicit: false,
      lifetimeRequired: true
    });
    const record = await lifecycle.create({
      purpose: "temporary",
      kind: placement.kind,
      provider: placement.adapter.id,
      size: placement.size.id,
      sizeLabel: placement.size.label,
      region: placement.region.id,
      regionLabel: placement.region.label,
      image: placement.image,
      hourlyUsd: placement.size.hourlyUsd,
      lifetimeMinutes: placement.lifetimeMinutes,
      project: null,
      threadId: request.threadId,
      purposeNote: note.slice(0, MAX_PURPOSE_NOTE)
    });
    const summary = registry.summarize(record);
    if (!summary) throw new BoxError(500, "BOXES_UNAVAILABLE", "The new box's record cannot be shown.");
    return summary;
  };

  const createTemporaryBox = async (request: CreateTemporaryBoxRequest, signal?: AbortSignal): Promise<BoxSummary> => {
    signal?.throwIfAborted();
    const record = await startTemporaryBox(request);
    const onAbort = () => void lifecycle.destroy(record.id, "agent").catch(() => undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await lifecycle.whenProvisioned(record.id);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.throwIfAborted();
    const final = store.get(record.id);
    if (final?.state !== "ready") {
      throw new BoxError(502, "BOX_PROVIDER_ERROR", final?.stateReason ?? "The box could not be set up.");
    }
    return registry.summarize(final)!;
  };

  const service: BoxService = {
    registry,
    records: store,
    projects,
    settings,
    enabled: () => enabled,
    registerRoutes: (app) => registerBoxRoutes(app, service),

    async start() {
      await store.load();
      await pruneOldRecords();
      unsubscribers.push(
        registry.onChange(() => {
          publishBoxes();
          followActivity();
          reconciler.armDeadline();
        }),
        deps.hub.onConnectionChange((boxId, connected) => {
          reconciler.connectionChanged(boxId, connected);
          void lifecycle.connectionChanged(boxId, connected).catch((error) => logger.warn(`Box ${boxId}: could not record the connection change`, errorLine(error)));
        }),
        deps.onPluginChange(setEnabled)
      );
      started = true;
      enabled = await deps.pluginEnabled().catch(() => false);
      followActivity();
      publishBoxes();
      publishProviders();
    },

    async stop() {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      started = false;
      reconciler.stop();
      lifecycle.stop();
      enabled = false;
      await store.flush();
      await setupLog.flush();
    },

    boxesResponse(): BoxesResponse {
      return { boxes: registry.summaries(), totals: boxesTotals(store.list(), clock.now()) };
    },

    setupLog: (boxId) => setupLog.read(boxId),
    startTemporaryBox,
    createTemporaryBox,
    destroyBox,

    async startBlacksmithTest() {
      if (!settings.blacksmithReady()) throw new BoxError(409, "BOX_PROVIDER_NOT_CONFIGURED", "Finish the Blacksmith setup steps first.");
      if (blacksmithTest) throw new BoxError(409, "BOX_INVALID_REQUEST", "A test run is already in progress.");
      await settings.setBlacksmithStep("test", { state: "running", message: "Starting a test macOS box…", actionUrl: null });
      const run = (async () => {
        try {
          const box = await createTemporaryBox({
            threadId: null,
            kind: "macos",
            provider: "blacksmith",
            lifetimeMinutes: 30,
            purposeNote: "Blacksmith setup test run"
          });
          await destroyBox(box.id, "deleted");
          const at = new Date(clock.now()).toISOString();
          await store.updateBlacksmith((setup) => void (setup.testedAt = at));
          await settings.setBlacksmithStep("test", { state: "ok", message: "orq-agent connected from the runner; the test box was destroyed.", actionUrl: null });
        } catch (error) {
          await settings.setBlacksmithStep("test", { state: "failed", message: errorLine(error), actionUrl: null }).catch(() => undefined);
        }
      })().finally(() => {
        blacksmithTest = null;
      });
      blacksmithTest = run;
      track(run);
    },

    reconcileNow: async () => {
      await reconciler.runOnce();
    },

    async settled() {
      for (;;) {
        await Promise.allSettled([...background]);
        await lifecycle.settled();
        await reconciler.settled();
        await settings.blacksmithChecksSettled();
        await store.flush();
        await setupLog.flush();
        if (background.size === 0) return;
      }
    }
  };

  function track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => background.delete(tracked));
    background.add(tracked);
  }

  /** Destroyed boxes from before last month whose project (if any) is gone too: no total counts them any more. */
  async function pruneOldRecords(): Promise<void> {
    const now = clock.now();
    const lastMonth = utcMonthStart(utcMonthStart(now) - 1);
    const old = store.list().filter((record) => {
      if (record.state !== "destroyed" || !record.destroyedAt) return false;
      const at = Date.parse(record.destroyedAt);
      return Number.isFinite(at) && at < lastMonth && (record.purpose !== "project" || projectDeleted(record));
    });
    await store.remove(old.map((record) => record.id)).catch((error) => logger.warn("Could not prune old box records", errorLine(error)));
  }

  return service;
}
