/**
 * The machines registry in the running daemon (tailnet machines spec §4.1): built after the box
 * wiring, started after the box records loaded, routes on both transports.
 *
 * Discovery needs no plugin: tailnet peers are listed whether or not Ephemeral AI VMs is on; paired
 * machines come from the box records, which load either way. Pairing needs the plugin.
 *
 * The feature ports are wired in by `startDaemon` once they exist: `registry.setPairing`,
 * `registry.setSshAccess`; boxes and devices read `registry` as their {@link MachineAccessPort}.
 * Wake-on-LAN is wired here (`registry.setWake`, `wake.ts`): it needs only the box links, whose
 * NIC reports (hello, then `sys.nics`) are kept in each paired machine's record.
 */

import { BOX_NICS_EVENT, MACHINES_CHANGED_EVENT, MACHINES_CHANNEL, machineOsOfBox } from "@orquester/api";
import { machinesStorePath } from "@orquester/config";
import type { FastifyInstance } from "fastify";

import type { DaemonBoxes } from "../boxes/wiring.ts";
import type { MachineWakeToolPort } from "../mcp/daemon-api.ts";
import type { Broadcaster } from "../broadcaster.ts";
import type { MachineAccessPort } from "./ports.ts";
import { MachineRegistry, type MachineBoxSource } from "./registry.ts";
import { registerMachineRoutes, wakeApprovedForAgent } from "./routes.ts";
import { MachinePolicyStore } from "./store.ts";
import { createTailnetReader } from "./tailscale-peers.ts";
import { createLocalWakeSender, MachineWake, type LocalWakeSender } from "./wake.ts";

export interface DaemonMachinesDeps {
  baseDir: string;
  boxes: DaemonBoxes;
  broadcaster: Pick<Broadcaster, "publish">;
  /**
   * Whether any machine is visible to agents changed: `list_machines` and its instruction line
   * follow it. Called only after {@link DaemonMachines.start} (the daemon's boot refresh covers the start).
   */
  agentToolsChanged?: () => void;
  /** The daemon's own host as a Wake-on-LAN sender (default: its real network interfaces). */
  localWake?: LocalWakeSender;
  logger?: Pick<Console, "warn" | "error">;
}

export interface DaemonMachines {
  registry: MachineRegistry;
  /** What boxes, devices and agent tools enforce. */
  access: MachineAccessPort;
  /** `wake_machine`'s wake of an Ask-first machine after its card (`DaemonApi.machineWakeApproved`). */
  wakeTools: MachineWakeToolPort;
  /** After the box records loaded (`DaemonBoxes.start`). */
  start(): Promise<void>;
  registerRoutes(app: FastifyInstance): void;
  stop(): Promise<void>;
}

export function createDaemonMachines(deps: DaemonMachinesDeps): DaemonMachines {
  const logger = deps.logger ?? console;
  const { service, hub } = deps.boxes;
  const source: MachineBoxSource = {
    byoRecords: () => service.registry.list().filter((record) => record.provider === "byo"),
    connection: (boxId) => {
      const connection = hub.get(boxId);
      if (!connection) return null;
      const sys = connection.sys;
      return { connected: connection.connected, hostname: sys.hostname, os: machineOsOfBox(sys.os), elevated: sys.canElevate || sys.isRoot };
    },
    summary: (boxId) => service.registry.summary(boxId),
    onChange: (listener) => {
      const offRecords = service.registry.onChange(() => listener());
      const offLinks = hub.onConnectionChange(() => listener());
      return () => {
        offRecords();
        offLinks();
      };
    },
    setDeviceHost: async (boxId, deviceHost) => {
      await service.byo.update(boxId, { deviceHost });
    },
    // One of the owner's machines lent to a chat is given back, never destroyed.
    release: async (boxId) => {
      await service.destroyBox(boxId, "deleted");
    }
  };
  const registry = new MachineRegistry({
    store: new MachinePolicyStore({ path: machinesStorePath(deps.baseDir), logger }),
    boxes: source,
    readTailnet: createTailnetReader(),
    publish: (payload) => deps.broadcaster.publish(MACHINES_CHANNEL, MACHINES_CHANGED_EVENT, payload),
    logger
  });
  service.setMachineAccess(registry);
  registry.setWake(
    new MachineWake({
      machines: () => registry.wakeMachines(),
      connection: (boxId) => hub.get(boxId) ?? null,
      local: deps.localWake ?? createLocalWakeSender()
    })
  );

  // Wake-on-LAN: each paired machine's NIC reports go into its record (one listener per box link,
  // which stays valid across reconnects); the registry ignores boxes that are not paired machines.
  const nicListeners = new Map<string, () => void>();
  const recordNics = (boxId: string): void => {
    const nics = hub.get(boxId)?.nics;
    if (nics) void registry.recordNics(boxId, nics);
  };
  const watchNics = (boxId: string): void => {
    const connection = hub.get(boxId);
    if (!connection) return;
    if (!nicListeners.has(boxId)) nicListeners.set(boxId, connection.onEvent(BOX_NICS_EVENT, () => recordNics(boxId)));
    recordNics(boxId);
  };
  const offNicLinks = hub.onConnectionChange((boxId, connected) => {
    if (connected) watchNics(boxId);
  });

  let started = false;
  let agentVisible = false;
  const offAccess = registry.onChange(() => {
    if (!started) return;
    const now = registry.anyAgentVisible();
    if (now === agentVisible) return;
    agentVisible = now;
    deps.agentToolsChanged?.();
  });

  return {
    registry,
    access: registry,
    wakeTools: { wakeApproved: (machineId, threadId) => wakeApprovedForAgent(registry, machineId, threadId) },
    async start() {
      await registry.start();
      agentVisible = registry.anyAgentVisible();
      started = true;
      // Machines that connected before the registry read machines.json.
      for (const record of source.byoRecords()) if (hub.get(record.id)?.connected) watchNics(record.id);
    },
    registerRoutes(app) {
      registerMachineRoutes(app, {
        registry,
        boxes: {
          removeBox: (boxId) => service.byo.remove(boxId),
          byoBoxIds: () => service.registry.list().filter((record) => record.provider === "byo").map((record) => record.id),
          pairingEnabled: () => service.enabled()
        },
        logger
      });
    },
    async stop() {
      offAccess();
      offNicLinks();
      for (const off of nicListeners.values()) off();
      nicListeners.clear();
      service.setMachineAccess(null);
      await registry.stop();
    }
  };
}
