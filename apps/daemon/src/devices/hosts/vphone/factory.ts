/**
 * Adopts bring-your-own Macs as vphone research hosts (phase 3 §2.3): a box with provider `byo`,
 * macOS, "Use for device simulators" on (`BoxSummary.deviceHost`) and "Virtual iPhones (research)"
 * on in Settings → Devices (`settings.research.vphoneHosts[boxId].enabled`). Follows the box
 * registry, the box links and the settings; a machine that stops qualifying loses its host (its
 * leases end lost; its VMs keep running until the owner deletes them).
 */

import { join } from "node:path";

import { BYO_PROVIDER_ID, type BoxSummary, type DevicesSettings, type DevicesVphoneHostSettings } from "@orquester/api";
import { devicesRuntimeDir } from "@orquester/config";

import type { DaemonBoxes } from "../../../boxes/wiring.ts";
import type { DeviceHostFactory, DeviceHostFactoryContext } from "../../host.ts";
import { VphoneDeviceHost, vphoneHostId, type VphoneBoxLink, type VphoneHostDeps } from "./host.ts";

interface VphoneHostFactoryDeps {
  appDir: string;
  /** The box wiring (registry and hub); null while the boxes plugin is unavailable. */
  boxes: () => Pick<DaemonBoxes, "registry" | "hub"> | null;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Tests: host timings and stream tuning. */
  hostOptions?: Pick<VphoneHostDeps, "timing" | "tuning" | "newToken">;
}

const OFF: DevicesVphoneHostSettings = { enabled: false, iphoneSource: null, cloudosSource: null };

/** Whether a box is a Mac the owner turned research iPhones on for. */
export function isVphoneCandidate(box: BoxSummary, settings: DevicesSettings): boolean {
  return (
    box.provider === BYO_PROVIDER_ID &&
    box.deviceHost === true &&
    (box.kind === "macos" || box.os === "darwin") &&
    box.state !== "destroyed" &&
    box.state !== "pairing" &&
    settings.research.vphoneHosts[box.id]?.enabled === true
  );
}

export function createVphoneHostFactory(deps: VphoneHostFactoryDeps): DeviceHostFactory {
  let ctx: DeviceHostFactoryContext | null = null;
  const hosts = new Map<string, VphoneDeviceHost>();
  const unsubscribes: (() => void)[] = [];
  let subscribedTo: Pick<DaemonBoxes, "registry" | "hub"> | null = null;

  const subscribe = (): Pick<DaemonBoxes, "registry" | "hub"> | null => {
    const boxes = deps.boxes();
    if (boxes && boxes !== subscribedTo) {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      subscribedTo = boxes;
      unsubscribes.push(boxes.registry.onChange(() => sync()));
      unsubscribes.push(boxes.hub.onConnectionChange((boxId) => hosts.get(boxId)?.linkChanged()));
    }
    return boxes;
  };

  const sync = (): void => {
    if (!ctx) return;
    const context = ctx;
    const boxes = subscribe();
    const settings = context.settings();
    const wanted = new Map<string, BoxSummary>();
    for (const record of boxes?.registry.list() ?? []) {
      const summary = boxes!.registry.summary(record.id);
      if (summary && isVphoneCandidate(summary, settings)) wanted.set(summary.id, summary);
    }
    for (const [boxId, host] of [...hosts]) {
      if (wanted.has(boxId)) continue;
      hosts.delete(boxId);
      context.removeHost(host.id);
      void host.dispose();
    }
    for (const [boxId, summary] of wanted) {
      const existing = hosts.get(boxId);
      if (existing) {
        existing.linkChanged();
        continue;
      }
      const runtime = join(devicesRuntimeDir(deps.appDir), "vphone");
      const hostId = vphoneHostId(boxId);
      const host = new VphoneDeviceHost({
        boxId,
        machineName: summary.byo?.name ?? boxId,
        link: () => (deps.boxes()?.hub.get(boxId) as VphoneBoxLink | undefined) ?? null,
        box: () => {
          const current = deps.boxes()?.registry.summary(boxId) ?? summary;
          return { boxId, provider: current.provider, hourlyUsd: 0, startedAt: current.readyAt ?? current.createdAt, deadlineAt: null };
        },
        settings: () => ctx?.settings().research.vphoneHosts[boxId] ?? OFF,
        activeLeases: () => ctx?.activeLeases(hostId) ?? [],
        stateDir: join(runtime, boxId),
        uploadsDir: join(runtime, "uploads"),
        logger: deps.logger,
        ...deps.hostOptions
      });
      hosts.set(boxId, host);
      context.addHost(host);
      void host.start().catch((error) => deps.logger.warn(`[devices] the research host on ${host.label} did not start`, error instanceof Error ? error.message : String(error)));
    }
  };

  return {
    kind: "byo",
    platforms: ["ios"],
    async start(context) {
      ctx = context;
      sync();
    },
    settingsChanged() {
      sync();
    },
    async stop() {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      subscribedTo = null;
      const context = ctx;
      ctx = null;
      for (const host of hosts.values()) {
        context?.removeHost(host.id);
        await host.dispose().catch(() => undefined);
      }
      hosts.clear();
    }
  };
}
