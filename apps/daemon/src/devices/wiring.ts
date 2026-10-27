/**
 * Devices in the running daemon (devices spec §2 goal 1): the device service exists only while
 * the "Device simulators" plugin is on. This module follows the plugin switch — building the
 * service (its stores, the host factories, the action executor) when it turns on, and when it turns
 * off releasing every lease (nothing of the plugin keeps running) and dropping the service — and
 * gives `index.ts` what it wires:
 *
 * 1. {@link createDaemonDevices} — once the plugins, the box wiring and the agent chat exist.
 * 2. `start()` — after `plugins.start()`: follows the plugin from then on.
 * 3. Routes, per transport: `registerRoutes(app, mode)` and `registerWsRoutes(instance, …)`.
 * 4. `chatClosed(id)` — a chat tab closed: its leases end.
 * 5. `toolsAvailable()` / `onToolsChange` — the session-tools manifest advertises the `devices`
 *    toolset while it is true.
 * 6. `stop()` at shutdown: the service stops (devices keep running; a restart reattaches).
 *
 * The host factories and the action executor are built here from the seams their work packages
 * own (`hosts/`, `toolchain/`, `agent-device.ts`, `actions.ts`, `hub-proxy.ts`).
 */

import { mkdir } from "node:fs/promises";

import { DEVICES_CHANNEL, DEVICES_PLUGIN_ID, type DevicesEventType, type PluginsResponse } from "@orquester/api";
import { deviceLeasesPath, devicePoolPath, deviceScreenshotsDir, devicesDir, devicesSettingsPath } from "@orquester/config";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { Broadcaster } from "../broadcaster.ts";
import type { DaemonBoxes } from "../boxes/wiring.ts";
import type { PluginsService } from "../plugins/plugins-service.ts";
import { createDeviceActionExecutor, type DeviceActionExecutor } from "./actions.ts";
import { createAgentDeviceClient } from "./agent-device.ts";
import type { DeviceHostFactory } from "./host.ts";
import { createBoxHostFactory } from "./hosts/box-host.ts";
import { createLocalAndroidHostFactory } from "./hosts/local-android.ts";
import { createVphoneHostFactory } from "./hosts/vphone/factory.ts";
import { registerDeviceHttpRoutes } from "./http-routes.ts";
import { createHubProxy, type HubProxy } from "./hub-proxy.ts";
import { DeviceScreenshots } from "./screenshots.ts";
import { DeviceService } from "./service.ts";
import { DeviceLeaseStore, DevicePoolStore, DeviceSettingsStore } from "./store.ts";
import type { DeviceCacheWarmer } from "./pool-actor.ts";
import { deviceHostSpend } from "./hosts/box/rental.ts";
import { createDeviceToolchain, type DeviceToolchain } from "./toolchain/index.ts";
import { registerDeviceWsRoutes } from "./ws-routes.ts";

export interface DaemonDevicesDeps {
  /** The appdir base. */
  baseDir: string;
  env: NodeJS.ProcessEnv;
  plugins: Pick<PluginsService, "isEnabled" | "events">;
  broadcaster: Pick<Broadcaster, "publish">;
  /** The Ephemeral AI VMs wiring (Mac device hosts are boxes); null while unavailable. */
  boxes: () => Pick<DaemonBoxes, "service" | "registry" | "hub"> | null;
  /** A chat's tab title, project root and existence (the agent chat's tab records). */
  threadTitle(threadId: string): string | null;
  threadProject(threadId: string): string | null;
  threadExists(threadId: string): boolean;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Tests: the host factories instead of the real ones. */
  factories?: (toolchain: DeviceToolchain) => DeviceHostFactory[];
  /** Tests: the action executor instead of the real one. */
  actions?: DeviceActionExecutor;
  /** Tests: no idle timer. */
  idleTimer?: boolean;
}

export interface DaemonDevices {
  /** The running service, or null while the plugin is off. */
  service(): DeviceService | null;
  /** Follow the plugin from now on (after `plugins.start()`). */
  start(): Promise<void>;
  /** Shutdown: stop following the plugin and stop the service (devices keep running). */
  stop(): Promise<void>;
  /** A chat tab closed: its leases end (a lease of a chat closed while the plugin was off ends at the next start). */
  chatClosed(threadId: string): void;
  /** Whether the `devices` toolset is advertised now. */
  toolsAvailable(): boolean;
  /** The toolset's availability may have changed. Returns the unsubscribe. */
  onToolsChange(listener: () => void): () => void;
  /** Resolves once a pending plugin switch has been applied (tests, and routes that must see it). */
  settled(): Promise<void>;
  registerRoutes(app: FastifyInstance, mode: "local" | "remote"): void;
  registerWsRoutes(app: FastifyInstance, deps: { authorize(token: string | undefined, socket: WebSocket): boolean }): Promise<void>;
}

/** The box service's device-cache runs, while the box wiring is there. */
function boxCacheWarmer(boxes: Pick<DaemonBoxes, "service"> | null): DeviceCacheWarmer | null {
  if (!boxes) return null;
  return {
    dispatch: async (request) => {
      const run = await boxes.service.dispatchDeviceCacheWarm(request);
      return { runId: run.runId, htmlUrl: run.htmlUrl };
    },
    status: async (runId) => {
      const status = await boxes.service.deviceCacheWarmStatus(runId);
      return { state: status.state, conclusion: status.conclusion, htmlUrl: status.htmlUrl };
    }
  };
}

export function createDaemonDevices(deps: DaemonDevicesDeps): DaemonDevices {
  const { logger } = deps;
  const toolchain = createDeviceToolchain({ appDir: deps.baseDir, env: deps.env, logger });
  const agentDevice = createAgentDeviceClient({ toolchain, env: deps.env, logger });
  const actions = deps.actions ?? createDeviceActionExecutor({ agentDevice, logger });
  const toolListeners = new Set<() => void>();
  const notifyTools = () => {
    for (const listener of [...toolListeners]) listener();
  };

  let service: DeviceService | null = null;
  let stopped = false;
  let following = false;
  /** Plugin switches apply one at a time, in order. */
  let queue: Promise<void> = Promise.resolve();

  const hubProxy: HubProxy = createHubProxy({
    leaseOnDevice: (hostId, deviceParam) => service?.leaseOnDevice(hostId, deviceParam) ?? null,
    userInput: (hostId, deviceParam) => service?.userInput(hostId, deviceParam),
    viewerActive: (leaseId) => service?.viewerActive(leaseId),
    viewersChanged: (hostId, deviceParam, count) => service?.streamViewers(hostId, deviceParam, count),
    logger
  });
  const publish = (type: DevicesEventType, payload: unknown) => deps.broadcaster.publish(DEVICES_CHANNEL, type, payload);

  const build = (): DeviceService => {
    const factories = deps.factories?.(toolchain) ?? [
      createLocalAndroidHostFactory({ appDir: deps.baseDir, env: deps.env, toolchain, logger }),
      createBoxHostFactory({ appDir: deps.baseDir, boxes: deps.boxes, toolchain, logger }),
      createVphoneHostFactory({ appDir: deps.baseDir, boxes: deps.boxes, logger })
    ];
    const built = new DeviceService({
      settingsStore: new DeviceSettingsStore({ file: devicesSettingsPath(deps.baseDir), logger }),
      leaseStore: new DeviceLeaseStore({ file: deviceLeasesPath(deps.baseDir), logger }),
      poolStore: new DevicePoolStore({ file: devicePoolPath(deps.baseDir), logger }),
      factories,
      actions,
      screenshots: new DeviceScreenshots(deviceScreenshotsDir(deps.baseDir), logger),
      publish,
      threadTitle: deps.threadTitle,
      threadProject: deps.threadProject,
      threadExists: deps.threadExists,
      cacheWarmer: () => boxCacheWarmer(deps.boxes()),
      // The box records: the same spend the box host factory's approval reads.
      poolSpend: () => deviceHostSpend(deps.boxes()?.registry.list() ?? [], Date.now()),
      logger,
      ...(deps.idleTimer === false ? { idleTimer: false } : {})
    });
    built.events.on("tools", notifyTools);
    return built;
  };

  const turnOn = async (): Promise<void> => {
    if (service || stopped) return;
    await mkdir(devicesDir(deps.baseDir), { recursive: true, mode: 0o700 }).catch(() => undefined);
    const next = build();
    try {
      await next.start();
    } catch (error) {
      logger.error("[devices] the device service failed to start", error instanceof Error ? error.message : String(error));
      await next.stop().catch(() => undefined);
      return;
    }
    if (stopped) {
      await next.stop().catch(() => undefined);
      return;
    }
    service = next;
    notifyTools();
  };

  /** Off: nothing of the plugin keeps running — every lease ends (its device is turned off), then the service stops. */
  const turnOff = async (): Promise<void> => {
    const current = service;
    if (!current) return;
    service = null;
    notifyTools();
    await current.releaseAll("plugin-off").catch((error) => logger.warn("[devices] releasing leases failed", error instanceof Error ? error.message : String(error)));
    await current.stop().catch(() => undefined);
    current.events.off("tools", notifyTools);
  };

  const follow = (enabled: boolean): Promise<void> => {
    queue = queue.then(() => (enabled ? turnOn() : turnOff())).catch(() => undefined);
    return queue;
  };

  const onPluginsChanged = (response: PluginsResponse): void => {
    if (stopped) return;
    void follow(response.plugins.some((plugin) => plugin.id === DEVICES_PLUGIN_ID && plugin.enabled));
  };

  return {
    service: () => service,

    async start() {
      if (following || stopped) return;
      following = true;
      deps.plugins.events.on("changed", onPluginsChanged);
      await follow(deps.plugins.isEnabled(DEVICES_PLUGIN_ID));
    },

    async stop() {
      stopped = true;
      deps.plugins.events.off("changed", onPluginsChanged);
      await queue;
      const current = service;
      service = null;
      if (current) {
        await current.stop().catch((error) => logger.warn("[devices] the device service failed to stop", error instanceof Error ? error.message : String(error)));
        current.events.off("tools", notifyTools);
      }
    },

    chatClosed(threadId) {
      const current = service;
      if (!current) return;
      void current.releaseThread(threadId).catch((error) => logger.warn("[devices] releasing a closed chat's devices failed", error instanceof Error ? error.message : String(error)));
    },

    toolsAvailable: () => service?.toolsAvailable() ?? false,

    onToolsChange(listener) {
      toolListeners.add(listener);
      return () => void toolListeners.delete(listener);
    },

    settled: () => queue,

    registerRoutes(app, mode) {
      registerDeviceHttpRoutes(app, { devices: () => service, hubProxy: () => hubProxy, logger }, mode);
    },

    registerWsRoutes(app, ws) {
      return registerDeviceWsRoutes(app, { authorize: ws.authorize, devices: () => service, hubProxy: () => hubProxy });
    }
  };
}
