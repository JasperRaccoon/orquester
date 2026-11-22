/**
 * The machines registry in the running daemon (tailnet machines spec §4.1): built after the box
 * wiring, started after the box records loaded, routes on both transports.
 *
 * Discovery needs no plugin: tailnet peers are listed whether or not Ephemeral AI VMs is on; paired
 * machines come from the box records, which load either way. Pairing needs the plugin.
 *
 * The feature ports are wired in by `startDaemon` once they exist: `registry.setPairing`,
 * `registry.setWake`, `registry.setSshAccess`; boxes and devices read `registry` as their
 * {@link MachineAccessPort}.
 */

import { MACHINES_CHANGED_EVENT, MACHINES_CHANNEL, machineOsOfBox } from "@orquester/api";
import { machinesStorePath } from "@orquester/config";
import type { FastifyInstance } from "fastify";

import type { LocalTailscale } from "../boxes/tailscale/local.ts";
import type { DaemonBoxes } from "../boxes/wiring.ts";
import type { Broadcaster } from "../broadcaster.ts";
import type { MachineAccessPort } from "./ports.ts";
import { createMachinePairing } from "./pairing/index.ts";
import { MachineRegistry, type MachineBoxSource } from "./registry.ts";
import { registerMachineRoutes } from "./routes.ts";
import { MachinePolicyStore } from "./store.ts";
import { createTailnetReader } from "./tailscale-peers.ts";

export interface DaemonMachinesDeps {
  baseDir: string;
  boxes: DaemonBoxes;
  broadcaster: Pick<Broadcaster, "publish">;
  /** The daemon's one `LocalTailscale` (read only here): pairing prefers the tailnet HTTPS URL. */
  localTailscale: LocalTailscale | null;
  /**
   * Whether any machine is visible to agents changed: `list_machines` and its instruction line
   * follow it. Called only after {@link DaemonMachines.start} (the daemon's boot refresh covers the start).
   */
  agentToolsChanged?: () => void;
  logger?: Pick<Console, "warn" | "error">;
}

export interface DaemonMachines {
  registry: MachineRegistry;
  /** What boxes, devices and agent tools enforce. */
  access: MachineAccessPort;
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
  // The feature ports: machine-level agent SSH aliases (boxes/agent-ssh) and pair over SSH.
  registry.setSshAccess(deps.boxes.machineSshAccess);
  registry.setPairing(
    createMachinePairing({
      byo: service.byo,
      byoRoute: () => service.settings.route("byo"),
      localTailscale: deps.localTailscale,
      summarize: (machineId) => {
        const summary = registry.get(machineId);
        if (!summary) throw new Error(`unknown machine ${machineId}`);
        return summary;
      },
      linkBox: (machineId, boxId) => registry.linkBox(machineId, boxId),
      logger
    })
  );

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
    async start() {
      await registry.start();
      agentVisible = registry.anyAgentVisible();
      started = true;
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
      registry.setPairing(null);
      registry.setSshAccess(null);
      service.setMachineAccess(null);
      await registry.stop();
    }
  };
}
